import { chat as llmChat } from './llm-client';
import { loadRagChunks, loadKgFull, loadBenchmarkComparisons } from './data-loader';
import { buildBenchmarkContext } from './benchmark-context';
import { classifyIntent, initChunks, INTENT_LAYERS } from './rag-search';
import { initGraph, extractSubgraph } from './kg-graph';
import { runQueryPipeline } from './query-engine';
import { spellCorrectQuery } from './spell-correct';
import { GRASP_DEFAULTS } from '../DomainContext';

// Grasp fallbacks, used only when the domain config supplies no summary columns
// (a new domain provides these via domain-config.json priorityDims / shortNames).
const DEFAULT_SUMMARY_COLUMNS = [
  'Planning Method', 'End-effector Hardware', 'Input Data',
  'Training Data', 'Object Configuration',
];
const DEFAULT_SHORT_NAMES = {
  'Planning Method': 'Plan', 'Training Data': 'Train', 'End-effector Hardware': 'Gripper',
  'Object Configuration': 'Objects', 'Input Data': 'Input', 'Output Pose': 'Output',
  'Corresponding Dataset (see repository linked above)': 'Dataset',
  'Simulator (see repository linked above)': 'Sim', 'Backbone': 'Backbone',
  'Metric(s) Used ': 'Metrics', 'Camera Position(s)': 'Camera', 'Language': 'Lang',
  'Description': 'Desc',
};

// Summarize each method over the domain's most meaningful columns for the LLM
// prompt. `summaryColumns`/`shortNames` come from the active domain config
// (priorityDims + shortNames); for grasp with no config they fall back above.
export function buildMethodSummaries(methods, { summaryColumns, shortNames } = {}) {
  const cols = (summaryColumns && summaryColumns.length) ? summaryColumns : DEFAULT_SUMMARY_COLUMNS;
  const shorts = shortNames || DEFAULT_SHORT_NAMES;
  return methods.map(m => {
    const parts = cols.map(col => {
      const val = m.metadata?.[col] || '';
      if (!val) return null;
      const short = shorts[col] || col;
      return `${short}=${val}`;
    }).filter(Boolean);
    return `- ${m.name}: ${parts.join('; ')}`;
  }).join('\n');
}

function buildInsightPrompt(query, highlightMethods, ragText, kgContext, methodSummaries, branding = {}, benchmarkText = '') {
  const subject = branding.productSubject || 'grasp planning';

  return `You are an expert research assistant for a robotic ${subject} visualization tool. A researcher has queried the system and you have access to real data from academic papers.

RESEARCHER'S QUESTION: "${query}"

EVIDENCE FROM PAPERS:
${ragText || '(No paper excerpts available for this query)'}

KNOWLEDGE GRAPH INSIGHTS:
${kgContext || '(No structured knowledge available)'}

VERIFIED BENCHMARK EVIDENCE (extracted from the corpus' result tables, ranked; every row carries an evidence grade — A = corroborated by multiple papers, B = single solid source, C = low-confidence/disputed — and the source paper(s)):
${benchmarkText || '(No benchmark leaderboard matched this query)'}

RELEVANT METHODS IN THE DATASET:
${methodSummaries}

Highlighted methods (most relevant to query): ${highlightMethods.slice(0, 6).join(', ')}

INSTRUCTIONS:
Write exactly 3-5 bullet points that answer the researcher's question. Each bullet must start with "- ".

Rules:
0. If the question is about performance, rankings, "best/highest/fastest", or any quantitative comparison, LEAD with the VERIFIED BENCHMARK EVIDENCE: state the ranking with the EXACT values, name the evidence grade (A/B/C) and the source paper(s), and prefer grade A/B (explicitly flag grade C as low-confidence). Never invent a number that is not in that block; if the block says none matched, say the benchmark data doesn't cover it rather than guessing.
1. Lead with evidence from the paper excerpts. Quote specific techniques, equations, or results by paper name (e.g., "Contact-GraspNet uses a binary cross-entropy loss on predicted contact points").
2. When no paper excerpt covers a point, draw on the method metadata (planning approach, gripper type, etc.) to provide grounded analysis.
3. Be specific and technical. Avoid generic statements like "various methods use different approaches."
4. Always use the exact method names as provided in the data (e.g., "Grasp Pose Detection (GPD)" not just "GPD", "Volumetric Grasping Network (VGN)" not just "VGN"). This ensures methods are correctly linked in the interface.
5. Do NOT use markdown formatting like **bold** or *italic*. Write plain text only. The interface has its own highlighting system that automatically color-codes technique names, method names, and domain terms.

Respond with ONLY the bullet points, nothing else.`;
}

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

function formatRagContext(chunks) {
  if (!chunks || !chunks.length) return { ragText: '', ragCitations: [] };

  const ragCitations = chunks.map((chunk, i) => ({
    rank: i + 1,
    paper_id: chunk.metadata?.paper_id || '',
    paper_title: chunk.metadata?.paper_title || chunk.metadata?.paper_id || '',
    section: chunk.metadata?.section || '',
    layer: chunk.metadata?.layer || '',
    content_type: chunk.metadata?.content_type || '',
    rhetorical_role: chunk.metadata?.rhetorical_role || '',
    snippet: (chunk.text || '').slice(0, 200),
    full_text: chunk.text || '',
    score: chunk.score || 0,
  }));

  const ragText = chunks.slice(0, 6).map((chunk, i) => {
    const paper = chunk.metadata?.paper_title || chunk.metadata?.paper_id || 'Unknown';
    const section = chunk.metadata?.section || '';
    const text = (chunk.text || '').slice(0, 400);
    return `[${paper}${section ? ' - ' + section : ''}] (relevance: ${(chunk.score || 0).toFixed(3)})\n${text}`;
  }).join('\n\n');

  return { ragText, ragCitations };
}

export async function runAIQuery(query, allMethods, queryKeywords, domainOpts = {}) {
  const DEFAULT_WEIGHTS = domainOpts.defaultWeights || GRASP_DEFAULTS.defaultWeights;
  const domainBranding = domainOpts.branding || GRASP_DEFAULTS.branding;
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
  const methodSummaries = buildMethodSummaries(responseData, {
    summaryColumns: domainOpts.summaryColumns,
    shortNames: domainOpts.shortNames,
  });

  // Step 3: RAG retrieval (client-side)
  let ragText = '';
  let ragCitations = [];
  let ragAnalytics = {};
  try {
    const ragChunks = await loadRagChunks();
    if (ragChunks.length) {
      initChunks(ragChunks);
      // Real lexical retrieval (BM25) over the chunks, scoped by query intent.
      // (Replaces the previous +1-per-substring count, which ranked common words
      // as highly as discriminating ones.) A neural query-embedding upgrade can
      // later swap this for searchChunks() over c.embedding.
      const intent = classifyIntent(effectiveQuery);
      const targetLayers = new Set(INTENT_LAYERS[intent] || ['coarse', 'mid', 'fine']);
      const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'is',
        'are', 'as', 'by', 'how', 'what', 'which', 'that', 'this', 'do', 'does', 'can', 'using',
        'use', 'used', 'their', 'its', 'from', 'at', 'or', 'be', 'has', 'have']);
      const qTerms = [...new Set((effectiveQuery.toLowerCase().match(/[a-z0-9-]+/g) || []))]
        .filter(w => w.length > 2 && !STOP.has(w));
      const toks = (c) => (c._toks || (c._toks = (c.text.toLowerCase().match(/[a-z0-9-]+/g) || [])));
      let pool = ragChunks.filter(c => c.text && targetLayers.has(c.metadata?.layer));
      if (pool.length < 5) pool = ragChunks.filter(c => c.text);   // fall back across layers
      const df = {};
      pool.forEach(c => { const seen = new Set(); toks(c).forEach(t => { if (!seen.has(t)) { seen.add(t); df[t] = (df[t] || 0) + 1; } }); });
      const N = pool.length || 1;
      const avgdl = pool.reduce((s, c) => s + toks(c).length, 0) / N || 1;
      const k1 = 1.5, b = 0.75;
      const scored = pool.map(c => {
        const t = toks(c), dl = t.length || 1, tf = {};
        t.forEach(x => { tf[x] = (tf[x] || 0) + 1; });
        let s = 0;
        qTerms.forEach(q => {
          const f = tf[q];
          if (f) {
            const idf = Math.log(1 + (N - (df[q] || 0) + 0.5) / ((df[q] || 0) + 0.5));
            s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
          }
        });
        const kp = ((c.metadata && c.metadata.keyphrases) || []).join(' ').toLowerCase();
        qTerms.forEach(q => { if (kp.includes(q)) s += 0.6; });   // keyphrase field boost
        return { ...c, score: s };
      }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);

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
  // grounding check below (it was previously loaded twice per query).
  let kgData = null;
  let kgContext = '';
  let kgTraversal = [];
  try {
    kgData = await loadKgFull();
    if (kgData && kgData.nodes && kgData.nodes.length) {
      initGraph(kgData);
      // Resolve the query's methods to their papers via method -> described_in ->
      // paper edges (precise), instead of a letters-only label substring that
      // mis-linked short names / acronyms. Fall back to a TIGHTENED (>=4 char)
      // label match only if no edge is found.
      const methodNames = highlightMethods.slice(0, 5);
      const wanted = new Set(methodNames.map(m => m.toLowerCase().trim()));
      const sid = l => (l.source && l.source.id) || l.source;
      const tid = l => (l.target && l.target.id) || l.target;
      const methodNodeIds = new Set(
        kgData.nodes.filter(n => n.type === 'method' && wanted.has((n.label || '').toLowerCase().trim())).map(n => n.id)
      );
      let paperIds = (kgData.links || [])
        .filter(l => l.type === 'described_in' && methodNodeIds.has(sid(l)))
        .map(l => tid(l));
      if (!paperIds.length) {
        paperIds = kgData.nodes.filter(n => n.type === 'paper' && methodNames.some(m => {
          const c = m.toLowerCase().replace(/[^a-z0-9]/g, '');
          return c.length >= 4 && (n.label || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(c);
        })).map(n => n.id);
      }

      if (paperIds.length > 0) {
        const subgraph = extractSubgraph(paperIds);
        kgTraversal = [{
          step: 'subgraph',
          description: `Extracted subgraph around ${paperIds.length} papers`,
          detail: `${subgraph.nodes.length} nodes, ${subgraph.links.length} edges`,
          edges: subgraph.links,
          nodes: subgraph.nodes,
        }];

        // Build structured KG context
        const edgesByType = {};
        subgraph.links.forEach(e => {
          if (!edgesByType[e.type]) edgesByType[e.type] = [];
          edgesByType[e.type].push(e);
        });
        const contextParts = Object.entries(edgesByType).map(([type, edges]) =>
          `${type}: ${edges.length} relationships`
        );
        kgContext = contextParts.join('\n');
      }
    }
  } catch (e) {
    console.warn('KG context failed:', e);
  }

  // Step 5: LLM insight — ground it in the verified benchmark leaderboards when
  // the query is about performance/rankings/comparisons.
  let benchmarkText = '';
  try {
    const bench = await loadBenchmarkComparisons();
    benchmarkText = buildBenchmarkContext(effectiveQuery, bench);
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
