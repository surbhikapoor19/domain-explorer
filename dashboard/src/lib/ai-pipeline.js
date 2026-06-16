import { chat as llmChat } from './llm-client';
import { loadRagChunks, loadKgFull, loadBenchmarkComparisons } from './data-loader';
import { buildBenchmarkContext } from './benchmark-context';
import { runQueryPipeline } from './query-engine';
import { spellCorrectQuery } from './spell-correct';
import { GRASP_DEFAULTS } from '../DomainContext';
import { buildMethodSummaries, formatRagContext } from './copilot/rag-context';
import { retrieveChunks } from './copilot/retrieval';
import { buildKgContext } from './copilot/kg-context';
import { buildInsightPrompt } from './copilot/prompt-builder';

// buildMethodSummaries is re-exported for backward compatibility — a test imports
// it from ./ai-pipeline; the implementation now lives in ./copilot/rag-context.
export { buildMethodSummaries };

function runGroundingCheck(insightText, methods, kgNodes) {
  const grounded = [];
  const ungrounded = [];

  const allKnown = new Set();
  methods.forEach(m => allKnown.add(m.name.replace(/\u{1F916}\s*/gu, '').trim().toLowerCase()));
  if (kgNodes) {
    kgNodes.forEach(n => {
      if (n.label) allKnown.add(n.label.toLowerCase());
    });
  }

  const mentions = new Set();
  // CamelCase or hyphenated method names
  const camelRe = /\b([A-Z][a-z]+(?:[-]?[A-Z][a-z]+)+(?:\+\+)?(?:\s*\([^)]+\))?)\b/g;
  let match;
  while ((match = camelRe.exec(insightText)) !== null) mentions.add(match[1]);
  // ALLCAPS acronyms
  const acroRe = /\b([A-Z]{2,6}(?:-[A-Z]+)?)\b/g;
  const skip = new Set(['RGB', 'RGBD', 'CNN', 'GNN', 'MLP', 'LLM', 'DOF', 'SAM', 'GPU',
    'CPU', 'PDF', 'API', 'IOU', 'MAP', 'BCE', 'MSE', 'SGD', 'IEEE',
    'ICRA', 'IROS', 'RSS', 'CVPR', 'ICLR', 'RAG', 'KG', 'HGT', 'RL', 'IL', 'SE', 'TSDF', 'BPS', 'FPS', 'NMS']);
  while ((match = acroRe.exec(insightText)) !== null) {
    if (!skip.has(match[1])) mentions.add(match[1]);
  }

  // Whole-word matching so "GraspNet" is no longer counted as grounded merely
  // because some known label contains "Net" (the old loose substring test).
  const knownPadded = [...allKnown].filter(k => k.length >= 4)
    .map(k => ' ' + k.replace(/[^a-z0-9]+/g, ' ').trim() + ' ');
  for (const mention of mentions) {
    const lower = mention.toLowerCase();
    const lw = ' ' + lower.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const found = knownPadded.some(kw => lw.includes(kw) || (lower.length >= 5 && kw.includes(lw)));
    if (found) grounded.push(mention);
    else ungrounded.push(mention);
  }

  return { grounded, ungrounded };
}

export async function runAIQuery(query, allMethods, queryKeywords, domainOpts = {}) {
  const DEFAULT_WEIGHTS = domainOpts.defaultWeights || GRASP_DEFAULTS.defaultWeights;
  const domainBranding = domainOpts.branding || GRASP_DEFAULTS.branding;
  // Defensive: the contract is "never throws, always returns the documented
  // shape", so normalize a nullish allMethods before the pre-pipeline map/filter
  // (which sit outside the per-step try/catches) can throw.
  allMethods = Array.isArray(allMethods) ? allMethods : [];
  // Step 0: Spell correction
  const methodNames = allMethods.map(m => m.name);
  const { text: correctedQuery, corrected: wasSpellCorrected } = await spellCorrectQuery(query, queryKeywords, methodNames);
  const effectiveQuery = correctedQuery;

  // Step 1: Deterministic pipeline
  const { weights: newWeights, colorBy: newColorBy, filterMethods } =
    runQueryPipeline(effectiveQuery, DEFAULT_WEIGHTS, allMethods, queryKeywords);

  // Step 2: Resolve the query's method subset for highlighting/filtering.
  // The copilot does NO clustering — it neither re-clusters nor reasons over
  // clusters. The scatter keeps its default HDBSCAN colours and layout (clustering
  // is an Explorer concern, not a copilot one), so each method passes through with
  // its existing `cluster`/x/y untouched.
  const subset = filterMethods
    ? allMethods.filter(m => filterMethods.includes(m.name))
    : allMethods;
  const responseData = subset.length ? subset : allMethods;

  const highlightMethods = filterMethods || responseData.slice(0, 8).map(m => m.name);
  // Float the query-relevant methods to the front and cap the dump so the prompt
  // leads with what matters instead of an unranked wall of all methods.
  const methodSummaries = buildMethodSummaries(responseData, {
    summaryColumns: domainOpts.summaryColumns,
    shortNames: domainOpts.shortNames,
    prioritize: highlightMethods,
    limit: 12,
  });

  // Step 3: RAG retrieval (client-side)
  let ragText = '';
  let ragCitations = [];
  let ragAnalytics = {};
  try {
    const ragChunks = await loadRagChunks();
    if (ragChunks.length) {
      const scored = await retrieveChunks(effectiveQuery, ragChunks);
      const formatted = formatRagContext(scored);
      ragText = formatted.ragText;
      ragCitations = formatted.ragCitations;

      const paperSet = new Set(scored.map(c => c.metadata?.paper_id).filter(Boolean));
      ragAnalytics = { papers: [...paperSet], totalChunks: scored.length };
    }
  } catch (e) {
    console.warn('RAG retrieval failed:', e);
  }

  // Step 4: KG context. Load the full KG ONCE here and reuse it for the
  // grounding check below (it was previously loaded twice per query). The
  // method->paper resolution + subgraph serialization now live in
  // ./copilot/kg-context (buildKgContext).
  let kgData = null;
  let kgContext = '';
  let kgTraversal = [];
  try {
    kgData = await loadKgFull();
    // Seed the subgraph from the RAG-retrieved papers when the query's methods
    // don't resolve (broad queries), so the KG context matches the question
    // instead of arbitrary array-order methods.
    const kg = buildKgContext(kgData, highlightMethods, { seedPaperIds: ragAnalytics.papers || [] });
    kgContext = kg.kgContext;
    kgTraversal = kg.kgTraversal;
  } catch (e) {
    console.warn('KG context failed:', e);
  }

  // Step 5: LLM insight — ground it in the verified benchmark leaderboards when
  // the query is about performance/rankings/comparisons.
  let benchmarkText = '';
  try {
    const bench = await loadBenchmarkComparisons();
    // knownMethods lets the benchmark grounding fire on comparison intent
    // ("compare GPD and VGN") even when no metric keyword is present.
    benchmarkText = buildBenchmarkContext(effectiveQuery, bench, { knownMethods: methodNames });
  } catch (e) { /* benchmarks optional */ }

  let insightText = '';
  let grounding = { grounded: [], ungrounded: [] };
  try {
    const prompt = buildInsightPrompt(
      effectiveQuery, highlightMethods, ragText, kgContext,
      methodSummaries, domainBranding, benchmarkText
    );
    insightText = await llmChat([{ role: 'user', content: prompt }]);
    if (insightText.startsWith('```')) {
      const lines = insightText.split('\n');
      insightText = lines.slice(1, -1).join('\n');
    }

    // Guardrail: validate entity mentions (reuse the KG already loaded in step 4).
    try {
      grounding = runGroundingCheck(insightText, allMethods, (kgData && kgData.nodes) || []);
    } catch (e) {}
  } catch (llmErr) {
    insightText = `- Query processed. ${responseData.length} methods shown.${filterMethods ? `\n- Filtered to: ${filterMethods.join(', ')}.` : ''}\n- (LLM unavailable: ${llmErr.message})`;
  }

  // Step 6: Traversal narrative
  let traversalNarrative = '';
  if (kgContext && kgTraversal.length) {
    try {
      const stepSummaries = kgTraversal
        .filter(s => s.step !== 'summary' && s.step !== 'query_intent' && s.edges?.length > 0)
        .map(s => `${s.description} (${s.detail})`);

      if (stepSummaries.length) {
        const narratePrompt =
          `A researcher asked: "${effectiveQuery}"\n\n` +
          `The knowledge graph traversal found:\n` +
          stepSummaries.map(s => `- ${s}`).join('\n') + '\n\n' +
          `Structured facts found:\n${kgContext}\n\n` +
          `Write 2-3 sentences explaining what the graph found and WHY it matters ` +
          `for the researcher's question. Be specific about paper names and techniques. ` +
          `Do not repeat the question. Start with the most important finding.\n\n` +
          `IMPORTANT: Do NOT use markdown formatting like **bold** or *italic*. ` +
          `Write plain text only. The interface has its own highlighting system.`;

        traversalNarrative = await llmChat(
          [{ role: 'user', content: narratePrompt }],
          { maxTokens: 300, temperature: 0.2 }
        );
      }
    } catch (e) {}
  }

  // Build method relevance scores
  const methodRelevance = responseData.slice(0, 10).map(m => ({
    name: m.name,
    score: highlightMethods.includes(m.name) ? 0.9 : 0.5,
  }));

  return {
    success: true,
    umapData: responseData,
    weights: newWeights,
    colorBy: newColorBy,
    filterMethods,
    highlightMethods,
    insight: insightText,
    grounding,
    ragCitations,
    ragAnalytics,
    methodRelevance,
    kgContext,
    kgTraversal,
    traversalNarrative: traversalNarrative || undefined,
    paperRelevance: methodRelevance,
    spellCorrection: wasSpellCorrected ? { original: query, corrected: effectiveQuery } : null,
  };
}
