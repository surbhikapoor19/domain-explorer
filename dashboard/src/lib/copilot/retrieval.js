// Copilot chunk retrieval (UNIT #15) — HYBRID neural + lexical with a hard BM25
// fallback. Lexically: BM25 over the chunks, scoped by query intent. Neurally:
// the query is embedded client-side with Xenova/all-MiniLM-L6-v2 (same model as
// the stored chunk vectors) and matched by cosine via searchChunks().
//
// The neural path is best-effort: if the embedder is unavailable (offline, model
// load fails, import fails) retrieveChunks returns EXACTLY the BM25 result, so
// behaviour degrades gracefully and never breaks formatRagContext.
import { classifyIntent, initChunks, searchChunks, INTENT_LAYERS } from '../rag-search';
import { embedQuery as defaultEmbedQuery } from './query-embed';

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'is',
  'are', 'as', 'by', 'how', 'what', 'which', 'that', 'this', 'do', 'does', 'can', 'using',
  'use', 'used', 'their', 'its', 'from', 'at', 'or', 'be', 'has', 'have']);

// Small domain-vocabulary expansion so lexically-different phrasings of the same
// concept still match ("gripper" vs "end-effector", "fast" vs "latency"). Each
// group is symmetric: any member of a group expands the query with the others.
const SYNONYM_GROUPS = [
  ['gripper', 'end-effector', 'hand'],
  ['fast', 'speed', 'latency', 'runtime', 'time'],
  ['accuracy', 'success', 'precision'],
  ['clutter', 'cluttered', 'pile', 'piled'],
  ['sim', 'simulation', 'simulated'],
  ['real', 'physical', 'real-world'],
  ['grasp', 'grasping'],
  ['plan', 'planner', 'planning'],
];
const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const w of group) SYNONYMS.set(w, group.filter(x => x !== w));
}
export function expandQueryTerms(terms) {
  const out = new Set(terms);
  for (const t of terms) (SYNONYMS.get(t) || []).forEach(s => out.add(s));
  return [...out];
}

// Real lexical retrieval (BM25) over the chunks. The query intent BOOSTS its
// preferred layers rather than hard-filtering to them — a hard filter starved
// e.g. broad queries down to the coarse layer only (a quarter of the corpus)
// and missed relevant mid/fine evidence entirely.
export function bm25Search(query, ragChunks, { topK = 10 } = {}) {
  const intent = classifyIntent(query);
  const targetLayers = new Set(INTENT_LAYERS[intent] || ['coarse', 'mid', 'fine']);
  const LAYER_BOOST = 1.15;   // gentle preference, never exclusion
  const baseTerms = [...new Set((query.toLowerCase().match(/[a-z0-9-]+/g) || []))]
    .filter(w => w.length > 2 && !STOP.has(w));
  const qTerms = expandQueryTerms(baseTerms);
  const toks = (c) => (c._toks || (c._toks = (c.text.toLowerCase().match(/[a-z0-9-]+/g) || [])));
  const pool = ragChunks.filter(c => c.text);
  const df = {};
  pool.forEach(c => { const seen = new Set(); toks(c).forEach(t => { if (!seen.has(t)) { seen.add(t); df[t] = (df[t] || 0) + 1; } }); });
  const N = pool.length || 1;
  const avgdl = pool.reduce((s, c) => s + toks(c).length, 0) / N || 1;
  const k1 = 1.5, b = 0.75;
  return pool.map(c => {
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
    if (s > 0 && targetLayers.has(c.metadata?.layer)) s *= LAYER_BOOST;
    return { ...c, score: s };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
}

// Near-duplicate suppression: multi-granularity chunking stores the same passage
// at several layers; without this, the top-K evidence slots fill with copies of
// one paragraph. Key = first 240 normalized chars.
export function dedupeChunks(chunks) {
  const seen = new Set();
  const out = [];
  for (const c of (chunks || [])) {
    const key = (c.text || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Min-max normalize a list's `.score` into [0,1]. A degenerate (all-equal or
// single-element) list normalizes to 1 so a lone strong hit isn't zeroed out.
function normScores(list) {
  if (!list.length) return new Map();
  const scores = list.map(c => (typeof c.score === 'number' ? c.score : 0));
  const min = Math.min(...scores), max = Math.max(...scores);
  const span = max - min;
  const out = new Map();
  list.forEach((c, i) => out.set(c.id, span > 0 ? (scores[i] - min) / span : 1));
  return out;
}

// Public entry point used by ai-pipeline. HYBRID: BM25 always runs; the cosine
// branch runs only when a usable query embedding is produced. On any embed
// failure (null/empty vector, throw, reject) it returns EXACTLY the BM25 result.
//
// opts.embedQuery defaults to the real client-side embedder; opts.searchFn
// defaults to the cosine searchChunks. Both are injectable so tests never need a
// real model. Returns an array of chunks each carrying a numeric `.score`, so
// formatRagContext keeps working unchanged.
export async function retrieveChunks(query, ragChunks, opts = {}) {
  const {
    topK = 10,
    embedQuery = defaultEmbedQuery,
    searchFn = searchChunks,
  } = opts;

  initChunks(ragChunks);
  const intent = classifyIntent(query);
  const bm25 = bm25Search(query, ragChunks, { topK });

  // Best-effort neural branch. ANY failure (including a synchronously-throwing
  // embedQuery) degrades to the pure BM25 result — never throws, never calls
  // searchFn.
  let qvec = null;
  try {
    qvec = await embedQuery(query);
  } catch (err) {
    return bm25;
  }
  if (!Array.isArray(qvec) || qvec.length === 0) {
    return bm25;
  }

  let cosine = [];
  try {
    cosine = searchFn(qvec, { topK, intent }) || [];
  } catch (err) {
    return bm25;
  }

  // Merge BM25 + cosine on a common [0,1] scale as a WEIGHTED SUM (0.55 neural +
  // 0.45 lexical) — not a max. A chunk both retrievers agree on outranks a chunk
  // only one found, which max() failed to reward. Then suppress near-duplicate
  // passages (multi-granularity chunking stores the same text at several layers).
  const bm25Norm = normScores(bm25);
  const cosNorm = normScores(cosine);
  const merged = new Map();
  const consider = (c) => { if (!merged.has(c.id)) merged.set(c.id, c); };
  bm25.forEach(consider);
  cosine.forEach(consider);

  const scored = [...merged.values()].map(c => ({
    ...c,
    score: 0.55 * (cosNorm.get(c.id) ?? 0) + 0.45 * (bm25Norm.get(c.id) ?? 0),
  }));

  return dedupeChunks(scored.sort((a, b) => b.score - a.score)).slice(0, topK);
}
