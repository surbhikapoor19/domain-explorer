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

// Real lexical retrieval (BM25) over the chunks, scoped by query intent.
// (Replaces the previous +1-per-substring count, which ranked common words
// as highly as discriminating ones.) Returns the top-`topK` scored chunks.
export function bm25Search(query, ragChunks, { topK = 10 } = {}) {
  const intent = classifyIntent(query);
  const targetLayers = new Set(INTENT_LAYERS[intent] || ['coarse', 'mid', 'fine']);
  const qTerms = [...new Set((query.toLowerCase().match(/[a-z0-9-]+/g) || []))]
    .filter(w => w.length > 2 && !STOP.has(w));
  const toks = (c) => (c._toks || (c._toks = (c.text.toLowerCase().match(/[a-z0-9-]+/g) || [])));
  let pool = ragChunks.filter(c => c.text && targetLayers.has(c.metadata?.layer));
  if (pool.length < 5) pool = ragChunks.filter(c => c.text);   // fall back across layers
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
    return { ...c, score: s };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
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

  // Merge BM25 + cosine, dedupe by id, blend on independently-normalized scores
  // so both surfacing methods are represented on a common [0,1] scale. A chunk
  // found by either path is kept; its blended score is the max of its (possibly
  // absent) BM25 and cosine contributions.
  const bm25Norm = normScores(bm25);
  const cosNorm = normScores(cosine);
  const merged = new Map();
  const consider = (c, norm) => {
    const n = norm.get(c.id) ?? 0;
    const existing = merged.get(c.id);
    if (existing) {
      existing.score = Math.max(existing.score, n);
    } else {
      merged.set(c.id, { ...c, score: n });
    }
  };
  bm25.forEach(c => consider(c, bm25Norm));
  cosine.forEach(c => consider(c, cosNorm));

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
