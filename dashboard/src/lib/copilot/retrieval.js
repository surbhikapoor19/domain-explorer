// Copilot chunk retrieval. Extracted verbatim from ai-pipeline.js step 3
// (behaviour-preserving): lexical BM25 over the chunks, scoped by query intent.
// The neural-hybrid upgrade (embed the query with Xenova/all-MiniLM-L6-v2 and
// merge searchChunks() cosine hits) lands here as a follow-up, behind a lazy
// dynamic import with a graceful fall-through to this BM25 path.
import { classifyIntent, initChunks, INTENT_LAYERS } from '../rag-search';

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
    const kp = ((c.metadata && c.metadata.keyphrases) || []).join(' ').toLowerCase();
    qTerms.forEach(q => { if (kp.includes(q)) s += 0.6; });   // keyphrase field boost
    return { ...c, score: s };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
}

// Public entry point used by ai-pipeline. Currently BM25-only (behaviour
// identical to the previous inline block). `initChunks` primes the shared chunk
// store for the forthcoming neural path.
export async function retrieveChunks(query, ragChunks, opts = {}) {
  initChunks(ragChunks);
  return bm25Search(query, ragChunks, opts);
}
