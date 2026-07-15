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

// Light suffix stemmer (not Porter — a length-guarded strip of the common
// English inflections) so "grasping"/"grasped"/"grasps" all collapse onto
// "grasp" for matching. Applied uniformly to BOTH query terms and chunk tokens,
// so exact-term BM25 stops missing morphological variants of the same word.
export function stem(word) {
  const w = String(word || '');
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// Domain-vocabulary expansion sourced from the shipped term-dictionary.json
// (acronym <-> its own long-form `definition`) and query-keywords.json's
// attributeTerms (alias -> canonical attribute value(s), e.g. "dexterous" ->
// ["Multi-finger","Three-finger"]). Both are OPTIONAL — callers that don't pass
// them get no expansion, so this is purely additive. Returned terms are scored
// at half-weight in bm25Search (they're a looser match than the literal query).
export function domainSynonymTerms(baseTerms, termDictionary, attributeTerms) {
  const baseSet = new Set(baseTerms || []);
  const out = new Set();

  const terms = (termDictionary && Array.isArray(termDictionary.terms)) ? termDictionary.terms : [];
  terms.forEach(t => {
    if (!t || t.type !== 'acronym' || !t.definition) return;
    const acro = String(t.term || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const defWords = (String(t.definition).toLowerCase().match(/[a-z0-9-]+/g) || []).filter(w => w.length > 2);
    if (!acro || !defWords.length) return;
    if (baseSet.has(acro)) defWords.forEach(w => out.add(w));
    else if (defWords.some(w => baseSet.has(w))) out.add(acro);
  });

  if (attributeTerms) {
    Object.values(attributeTerms).forEach(termMap => {
      Object.entries(termMap || {}).forEach(([alias, vals]) => {
        const values = Array.isArray(vals) ? vals : [vals];
        const words = new Set(
          [alias, ...values]
            .flatMap(v => (String(v).toLowerCase().match(/[a-z0-9-]+/g) || []))
            .filter(w => w.length > 2)
        );
        if ([...words].some(w => baseSet.has(w))) words.forEach(w => out.add(w));
      });
    });
  }

  return [...out].filter(w => !baseSet.has(w));
}

// Real lexical retrieval (BM25) over the chunks. The query intent BOOSTS its
// preferred layers rather than hard-filtering to them — a hard filter starved
// e.g. broad queries down to the coarse layer only (a quarter of the corpus)
// and missed relevant mid/fine evidence entirely.
//
// opts.termDictionary / opts.attributeTerms (both optional) feed
// domainSynonymTerms() for additional half-weight query expansion.
export function bm25Search(query, ragChunks, { topK = 10, termDictionary, attributeTerms } = {}) {
  const intent = classifyIntent(query);
  const targetLayers = new Set(INTENT_LAYERS[intent] || ['coarse', 'mid', 'fine']);
  const LAYER_BOOST = 1.15;   // gentle preference, never exclusion
  const baseTerms = [...new Set((query.toLowerCase().match(/[a-z0-9-]+/g) || []))]
    .filter(w => w.length > 2 && !STOP.has(w));
  const qTerms = expandQueryTerms(baseTerms);
  // Extra half-weight terms: stemmed forms of qTerms not already present, plus
  // domain-dictionary/attribute synonyms — both are a looser signal than an
  // exact/synonym-group match, so they never outrank one.
  const expandedTerms = [...new Set([
    ...qTerms.map(stem).filter(t => !qTerms.includes(t)),
    ...domainSynonymTerms(baseTerms, termDictionary, attributeTerms),
  ])];
  const toks = (c) => (c._toks || (c._toks = (c.text.toLowerCase().match(/[a-z0-9-]+/g) || [])));
  const stemToks = (c) => (c._stemToks || (c._stemToks = toks(c).map(stem)));
  const pool = ragChunks.filter(c => c.text);
  const df = {};
  pool.forEach(c => { const seen = new Set(); toks(c).forEach(t => { if (!seen.has(t)) { seen.add(t); df[t] = (df[t] || 0) + 1; } }); });
  const dfStem = {};
  pool.forEach(c => { const seen = new Set(); stemToks(c).forEach(t => { if (!seen.has(t)) { seen.add(t); dfStem[t] = (dfStem[t] || 0) + 1; } }); });
  const N = pool.length || 1;
  const avgdl = pool.reduce((s, c) => s + toks(c).length, 0) / N || 1;
  const k1 = 1.5, b = 0.75;
  const bm25Term = (f, dfCount, dl) => {
    const idf = Math.log(1 + (N - dfCount + 0.5) / (dfCount + 0.5));
    return idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
  };
  return pool.map(c => {
    const t = toks(c), dl = t.length || 1, tf = {};
    t.forEach(x => { tf[x] = (tf[x] || 0) + 1; });
    let s = 0;
    qTerms.forEach(q => {
      const f = tf[q];
      if (f) s += bm25Term(f, df[q] || 0, dl);
    });
    if (expandedTerms.length) {
      const st = stemToks(c), tfStem = {};
      st.forEach(x => { tfStem[x] = (tfStem[x] || 0) + 1; });
      expandedTerms.forEach(q => {
        const f = tf[q] || tfStem[q];
        if (f) {
          const dfCount = df[q] || dfStem[q] || 0;
          s += 0.5 * bm25Term(f, dfCount, dl);
        }
      });
    }
    if (s > 0 && targetLayers.has(c.metadata?.layer)) s *= LAYER_BOOST;
    return { ...c, score: s };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
}

// Near-duplicate suppression: multi-granularity chunking stores the same
// passage at several layers (and re-chunking produces exact duplicates), so
// without this the top-K evidence slots fill with copies of one paragraph.
// Scoped to the SAME paper (two different papers that happen to share
// boilerplate opening text are not duplicates of each other) — a chunk whose
// normalized first-240-char prefix is contained in (or equal to) an
// already-kept same-paper chunk is dropped, keeping whichever of the two is
// higher-scored (tie-break: the finer-grained layer, the more specific evidence).
const LAYER_RANK = { fine: 3, mid: 2, coarse: 1 };
function prefixKey(c) {
  return (c.text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 240);
}
function paperKeyOf(c) {
  return c.metadata?.paper_id || c.metadata?.paper_title || '';
}
export function dedupeChunks(chunks) {
  const kept = [];
  for (const c of (chunks || [])) {
    const key = prefixKey(c);
    const paper = paperKeyOf(c);
    let dupIdx = -1;
    if (key) {
      for (let i = 0; i < kept.length; i++) {
        if (paperKeyOf(kept[i]) !== paper) continue;
        const kKey = prefixKey(kept[i]);
        if (kKey === key || kKey.includes(key) || key.includes(kKey)) { dupIdx = i; break; }
      }
    }
    if (dupIdx === -1) { kept.push(c); continue; }
    const existing = kept[dupIdx];
    const cScore = typeof c.score === 'number' ? c.score : 0;
    const eScore = typeof existing.score === 'number' ? existing.score : 0;
    const cLayer = LAYER_RANK[c.metadata?.layer] || 0;
    const eLayer = LAYER_RANK[existing.metadata?.layer] || 0;
    if (cScore > eScore || (cScore === eScore && cLayer > eLayer)) kept[dupIdx] = c;
  }
  return kept;
}

// Reciprocal Rank Fusion: score(c) = Σ 1/(60 + rank) over each list the chunk
// appears in (rank is its 0-based position within that list). Two
// independently min-max-normalized lists combined with max() gave a chunk
// found by BOTH retrievers no bonus over one found by only the stronger list;
// RRF's sum rewards agreement without needing the two lists' raw scores to be
// on a comparable scale.
function rrfScores(list) {
  const out = new Map();
  list.forEach((c, i) => out.set(c.id, 1 / (60 + i)));
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
    termDictionary,
    attributeTerms,
  } = opts;

  initChunks(ragChunks);
  const intent = classifyIntent(query);
  const bm25 = bm25Search(query, ragChunks, { topK, termDictionary, attributeTerms });

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

  // Merge BM25 + cosine via RECIPROCAL RANK FUSION (not a max of two
  // independently-normalized [0,1] scales) — a chunk both retrievers surface
  // now naturally outranks one only a single retriever found. Then suppress
  // near-duplicate passages (multi-granularity chunking stores the same text
  // at several layers).
  const bm25Rrf = rrfScores(bm25);
  const cosRrf = rrfScores(cosine);
  const merged = new Map();
  const consider = (c) => { if (!merged.has(c.id)) merged.set(c.id, c); };
  bm25.forEach(consider);
  cosine.forEach(consider);

  const scored = [...merged.values()].map(c => ({
    ...c,
    score: (bm25Rrf.get(c.id) ?? 0) + (cosRrf.get(c.id) ?? 0),
  }));

  return dedupeChunks(scored.sort((a, b) => b.score - a.score)).slice(0, topK);
}
