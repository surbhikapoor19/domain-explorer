import { chat as llmChat } from './llm-client';
import { loadRagChunks, loadKgFull, loadBenchmarkComparisons } from './data-loader';
import { buildBenchmarkContext, benchmarkPageRef } from './benchmark-context';
import { runQueryPipeline } from './query-engine';
import { spellCorrectQuery } from './spell-correct';
import { GRASP_DEFAULTS } from '../DomainContext';
import { buildMethodSummaries, formatRagContext, DEFAULT_SUMMARY_COLUMNS, DEFAULT_SHORT_NAMES } from './copilot/rag-context';
import { retrieveChunks } from './copilot/retrieval';
import { buildKgContext } from './copilot/kg-context';
import { buildAnswerPrompt } from './copilot/prompt-builder';
import { rankCandidates, parseStructuredAnswer, resolveMethods } from './copilot/answer-synthesis';

// Deterministic FORMAT intent from the query (mirrors the answer-engine router):
// chooses the answer's shape (table vs ranked list vs bullets) before generation.
function classifyFormatIntent(q) {
  const s = (q || '').toLowerCase();
  if (/\b(vs\.?|versus|compare|comparison|difference between|trade-?offs?)\b/.test(s)) return 'comparison';
  if (/\b(best|fastest|highest|top|rank(ing)?|outperform|state[- ]of[- ]the[- ]art|sota|success rate|accuracy|fastest)\b/.test(s)) return 'ranking';
  if (/\b(which|recommend|methods? for|approaches? for|list|options?|suitable|suited|good for|use for)\b/.test(s)) return 'recommendation';
  return 'default';
}

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

  // Pre-synthesis default highlight set (overridden after synthesis by the
  // methods the model actually discusses — see finalHighlight below).
  const highlightMethods = filterMethods || responseData.slice(0, 8).map(m => m.name);

  // Step 3: RAG retrieval (client-side). Tag each retrieved PAPER with a stable
  // [P#] id so the answer can cite it inline and the UI can render a chip.
  let ragText = '';
  let ragCitations = [];
  let ragAnalytics = {};
  let papersById = [];
  try {
    const ragChunks = await loadRagChunks();
    if (ragChunks.length) {
      const scored = await retrieveChunks(effectiveQuery, ragChunks);
      ragCitations = formatRagContext(scored).ragCitations;
      const seen = new Map();
      scored.forEach(chunk => {
        const pid = chunk.metadata?.paper_id || chunk.metadata?.paper_title || 'unknown';
        if (!seen.has(pid) && seen.size < 6) {
          seen.set(pid, {
            tag: `P${seen.size + 1}`, paper_id: pid,
            paper_title: chunk.metadata?.paper_title || pid, chunks: [],
          });
        }
        if (seen.has(pid)) seen.get(pid).chunks.push(chunk);
      });
      papersById = [...seen.values()];
      ragText = papersById.map(p => {
        const text = p.chunks.map(c => (c.text || '').slice(0, 1400)).join(' … ').slice(0, 1600);
        return `[${p.tag}] ${p.paper_title}\n${text}`;
      }).join('\n\n');
      ragAnalytics = { papers: [...new Set(scored.map(c => c.metadata?.paper_id).filter(Boolean))], totalChunks: scored.length };
    }
  } catch (e) { console.warn('RAG retrieval failed:', e); }

  // Step 4: Candidate shortlist — rank methods by query relevance (RAG papers +
  // deterministic filter + name/keyword overlap) so the model chooses from
  // RELEVANT methods, not array order. Each carries a stable id used end-to-end.
  const COLS = (domainOpts.summaryColumns && domainOpts.summaryColumns.length) ? domainOpts.summaryColumns : DEFAULT_SUMMARY_COLUMNS;
  const SHORTS = domainOpts.shortNames || DEFAULT_SHORT_NAMES;
  const ranked = rankCandidates(allMethods, {
    filterMethods: filterMethods || [], ragPapers: ragAnalytics.papers || [],
    ragCitations, query: effectiveQuery,
  });
  const candMethods = ranked.slice(0, 14).map(name => allMethods.find(m => m.name === name)).filter(Boolean);
  const candidateBlock = candMethods.map(m => {
    const parts = COLS.map(c => { const v = m.metadata?.[c]; return v ? `${SHORTS[c] || c}=${v}` : null; }).filter(Boolean);
    return `- ${m.name}${parts.length ? ' — ' + parts.join('; ') : ''}`;
  }).join('\n');

  // Step 5: KG context — verbalized relations (no arrow logs), seeded from the
  // candidates + RAG papers. Supplements the paper text; never the sole source.
  let kgData = null;
  let kgContext = '';
  let kgTraversal = [];
  try {
    kgData = await loadKgFull();
    const kg = buildKgContext(kgData, candMethods.slice(0, 5).map(m => m.name), { seedPaperIds: ragAnalytics.papers || [] });
    kgContext = kg.kgContext;
    kgTraversal = kg.kgTraversal;
  } catch (e) { console.warn('KG context failed:', e); }

  // Step 6: Benchmark grounding for quantitative/ranking queries.
  let benchmarkText = '';
  let bmPageRef = null;
  try {
    const bench = await loadBenchmarkComparisons();
    benchmarkText = buildBenchmarkContext(effectiveQuery, bench, { knownMethods: methodNames });
    bmPageRef = benchmarkPageRef(effectiveQuery, bench, { knownMethods: methodNames, methods: allMethods });
  } catch (e) { /* benchmarks optional */ }

  // Step 7: SINGLE structured synthesis — answer markdown + the methods it
  // discusses (by id) + citations, in ONE JSON object. The discussed ids are the
  // SOLE selector for the comparison table, so prose and table cannot diverge.
  const intent = classifyFormatIntent(effectiveQuery);
  let parsed = null;
  let insightText = '';
  try {
    const { system, user } = buildAnswerPrompt({
      query: effectiveQuery, ragText, kgContext, benchmarkText,
      candidateBlock, intent, branding: domainBranding,
    });
    const msgs = [{ role: 'system', content: system }, { role: 'user', content: user }];
    let raw = '';
    try {
      // Strict JSON mode is reliable WHEN it fits; but Groq hard-400s
      // (json_validate_failed) if the model truncates at max_tokens. Give ample
      // budget, then fall back to free-form (parseStructuredAnswer is robust).
      raw = await llmChat(msgs, { maxTokens: 1400, temperature: 0.2, responseFormat: 'json_object' });
    } catch (jsonErr) {
      raw = await llmChat(msgs, { maxTokens: 1400, temperature: 0.2 });
    }
    parsed = parseStructuredAnswer(raw);
    insightText = parsed
      ? parsed.answer
      : String(raw || '').replace(/^```(?:json|markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();
  } catch (llmErr) {
    insightText = `The copilot is temporarily unavailable (${llmErr.message}). ${responseData.length} methods are shown below.`;
  }

  // Resolve the discussed method NAMES against the candidate set (fuzzy, tolerant
  // of minor renames). Fall back to the top-ranked candidates. This is the SOLE
  // selector for the comparison table, so prose and table stay in lock-step.
  const discussedRaw = parsed ? (parsed.discussed || []).map(d => d.id) : [];
  let discussedNames = resolveMethods(discussedRaw, candMethods);
  if (discussedNames.length < 2) {
    discussedNames = candMethods.slice(0, 4).map(m => m.name);
  }
  const discussed = discussedNames.map(name => ({ name }));

  // Citations the answer renders as chips: the [P#]-tagged papers (ground truth).
  const citations = papersById.map((p, i) => ({
    marker: p.tag, paper_id: p.paper_id, paper_title: p.paper_title, index: i + 1,
  }));

  // Grounding guardrail on the ANSWER (surfaced in the provenance drawer, not the body).
  let grounding = { grounded: [], ungrounded: [] };
  try {
    grounding = runGroundingCheck(insightText, allMethods, (kgData && kgData.nodes) || []);
  } catch (e) {}

  // methodRelevance: the discussed methods, in order — the SINGLE source the
  // comparison table + chips read, so they match the prose exactly.
  const methodRelevance = discussed.map((d, i) => ({
    name: d.name, score: Math.max(0.5, 1 - i * 0.08), why: d.why,
  }));
  const finalHighlight = discussedNames.length ? discussedNames : highlightMethods;

  return {
    success: true,
    umapData: responseData,
    weights: newWeights,
    colorBy: newColorBy,
    filterMethods,
    highlightMethods: finalHighlight,
    insight: insightText,
    grounding,
    ragCitations,
    ragAnalytics,
    citations,
    benchmarkPageRef: bmPageRef,
    methodRelevance,
    paperRelevance: methodRelevance,
    kgContext,
    kgTraversal,
    spellCorrection: wasSpellCorrected ? { original: query, corrected: effectiveQuery } : null,
  };
}
