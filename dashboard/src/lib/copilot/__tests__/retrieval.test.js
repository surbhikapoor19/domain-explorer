/* Copilot HYBRID retrieval — AUTHORED BY ORCHESTRATOR (TEST AUTHOR). Implementers must NOT modify.
 *
 * Encodes the CONTRACT for src/lib/copilot/retrieval.js (UNIT #15):
 *
 *   retrieveChunks(query, ragChunks, opts={}) is HYBRID with a graceful BM25 fallback.
 *     - opts.embedQuery defaults to the real embedQuery from ./query-embed (NEVER invoked here —
 *       every test injects opts.embedQuery so NO real model is ever downloaded).
 *     - opts.searchFn  defaults to searchChunks from ../rag-search.
 *     - It always computes the BM25 top-K via the existing bm25Search.
 *     - It then `await`s qvec = opts.embedQuery(query). If qvec is a NON-EMPTY array, it calls
 *       opts.searchFn(qvec, {topK, intent}) for cosine hits, MERGES the BM25 + cosine lists,
 *       DEDUPES by chunk id, and returns a reranked top-K where BOTH BM25-surfaced and
 *       cosine-surfaced chunks are represented, each carrying a numeric .score.
 *     - If qvec is null/empty, OR opts.embedQuery throws/rejects, it returns EXACTLY the BM25
 *       result (behaviour-preserving fallback). It is async and never throws on embed failure.
 *     - The dead keyphrase boost (+0.6 on c.metadata.keyphrases) is DELETED; fixtures here carry
 *       no keyphrases field, so BM25 ranking is identical with or without that (now-removed) code.
 *
 * formatRagContext compatibility: the return shape stays an array of chunks each with a .score.
 *
 * This file is EXPECTED TO FAIL until the hybrid signature lands (TDD). Do not weaken.
 */
import { retrieveChunks, bm25Search } from '../retrieval';

// ---- synthetic, in-memory ragChunks ---------------------------------------
// Built fresh per call so the bm25Search `_toks` cache and any score mutation on
// one path can never leak into another path's deep-equal reference.
//
// Layering is deliberate: the query 'grasp planning approach' classifies as BROAD,
// whose INTENT_LAYERS is ['coarse']. So BM25 only ever pools the COARSE chunks
// (c1..c3, since the pool is >= 0 and the <5 fallback would re-include all but the
// fine/mid chunks lack the query terms anyway). The fine-layer chunk c5 is a chunk
// that BM25 will NOT surface — the perfect probe for "cosine added something new".
const QUERY = 'grasp planning approach';

const makeChunks = () => [
  { id: 'c1', text: 'grasp planning with antipodal contact points', metadata: { layer: 'coarse' }, embedding: new Array(384).fill(0.11) },
  { id: 'c2', text: 'grasp synthesis using force closure analysis',   metadata: { layer: 'coarse' }, embedding: new Array(384).fill(0.22) },
  { id: 'c3', text: 'motion planning trajectory optimization sampling', metadata: { layer: 'coarse' }, embedding: new Array(384).fill(0.33) },
  { id: 'c4', text: 'deep learning neural network feature extraction',  metadata: { layer: 'mid' },    embedding: new Array(384).fill(0.44) },
  { id: 'c5', text: 'reinforcement learning policy gradient reward signals', metadata: { layer: 'fine' }, embedding: new Array(384).fill(0.55) },
];

// A fixed 384-dim query vector for the cosine path. Its exact values are irrelevant
// because opts.searchFn is stubbed; we only assert it is forwarded and that a truthy
// non-empty array activates the cosine branch.
const FIXED_QVEC = new Array(384).fill(0.5);

const idsOf = (list) => list.map((c) => c.id);

// ===========================================================================
// CONTRACT (a): embedder resolves null  →  EXACT BM25 fallback
// ===========================================================================

describe('retrieveChunks — graceful fallback when the embedder yields null', () => {
  test('returns EXACTLY the BM25 ranking (deep-equal to bm25Search output)', async () => {
    const reference = bm25Search(QUERY, makeChunks(), { topK: 10 });
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => null, // model unavailable / offline
    });
    // Same chunks, same order, same scores — the cosine branch must not run.
    expect(result).toEqual(reference);
  });

  test('an empty-array embedding is treated as no-embedding (still pure BM25)', async () => {
    const reference = bm25Search(QUERY, makeChunks(), { topK: 10 });
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => [], // non-null but empty → not usable
    });
    expect(result).toEqual(reference);
  });

  test('fallback never invokes opts.searchFn when there is no usable embedding', async () => {
    const searchFn = jest.fn(() => [{ id: 'should-not-appear', text: 'x', metadata: { layer: 'coarse' }, score: 99 }]);
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => null,
      searchFn,
    });
    expect(searchFn).not.toHaveBeenCalled();
    expect(idsOf(result)).not.toContain('should-not-appear');
  });

  test('the BM25 fallback does NOT surface the fine-layer chunk c5 (baseline for hybrid test)', async () => {
    const result = await retrieveChunks(QUERY, makeChunks(), { topK: 10, embedQuery: async () => null });
    expect(idsOf(result)).not.toContain('c5');
    // And every returned chunk carries a numeric score.
    result.forEach((c) => expect(typeof c.score).toBe('number'));
  });
});

// ===========================================================================
// CONTRACT (b): embedder resolves a real vector + searchFn returns a chunk
//               BM25 would NOT surface  →  HYBRID merge, deduped
// ===========================================================================

describe('retrieveChunks — hybrid merge when the embedder yields a vector', () => {
  test('a fixed 384-vector activates the cosine branch and forwards it to opts.searchFn', async () => {
    const searchFn = jest.fn(() => []); // no cosine hits; just observe the call
    const embedQuery = jest.fn(async () => FIXED_QVEC);
    await retrieveChunks(QUERY, makeChunks(), { topK: 10, embedQuery, searchFn });

    expect(embedQuery).toHaveBeenCalledWith(QUERY);
    expect(searchFn).toHaveBeenCalledTimes(1);
    const [passedVec, passedOpts] = searchFn.mock.calls[0];
    expect(Array.isArray(passedVec)).toBe(true);
    expect(passedVec).toHaveLength(384);
    // intent must be derived from the query and threaded through to the cosine search.
    expect(passedOpts).toEqual(expect.objectContaining({ topK: 10, intent: expect.any(String) }));
  });

  test('hybrid result INCLUDES a cosine-only chunk that BM25 would never surface', async () => {
    // Stub returns c5 (fine layer) — never in the BM25 BROAD/coarse pool for this query.
    const searchFn = () => [{ id: 'c5', text: 'reinforcement learning policy gradient reward signals', metadata: { layer: 'fine' }, score: 0.97 }];
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => FIXED_QVEC,
      searchFn,
    });

    const ids = idsOf(result);
    // The cosine-surfaced chunk is now represented...
    expect(ids).toContain('c5');
    // ...and the BM25-surfaced chunks are STILL represented (both lists merged, not replaced).
    expect(ids).toContain('c1');
  });

  test('the merged result contains NO duplicate chunk ids', async () => {
    // searchFn returns BOTH an overlapping id (c1, also a strong BM25 hit) and a fresh id (c5).
    const searchFn = () => [
      { id: 'c1', text: 'grasp planning with antipodal contact points', metadata: { layer: 'coarse' }, score: 0.99 },
      { id: 'c5', text: 'reinforcement learning policy gradient reward signals', metadata: { layer: 'fine' }, score: 0.95 },
    ];
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => FIXED_QVEC,
      searchFn,
    });

    const ids = idsOf(result);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length); // dedupe by id
    expect(ids).toContain('c1'); // the overlapping id appears exactly once
    expect(ids).toContain('c5');
  });

  test('every chunk in the hybrid result carries a numeric .score (so formatRagContext keeps working)', async () => {
    const searchFn = () => [{ id: 'c5', text: 'reinforcement learning policy gradient reward signals', metadata: { layer: 'fine' }, score: 0.9 }];
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => FIXED_QVEC,
      searchFn,
    });
    expect(result.length).toBeGreaterThan(0);
    result.forEach((c) => {
      expect(typeof c.score).toBe('number');
      expect(Number.isFinite(c.score)).toBe(true);
    });
  });

  test('hybrid output is reranked top-K: respects opts.topK after the merge', async () => {
    // BM25 surfaces c1,c2,c3 (coarse); cosine adds c4 and c5 — five distinct candidates.
    const searchFn = () => [
      { id: 'c4', text: 'deep learning neural network feature extraction', metadata: { layer: 'mid' }, score: 0.96 },
      { id: 'c5', text: 'reinforcement learning policy gradient reward signals', metadata: { layer: 'fine' }, score: 0.94 },
    ];
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 2, // tight cap forces a real rerank-and-trim across the merged pool
      embedQuery: async () => FIXED_QVEC,
      searchFn,
    });
    expect(result.length).toBeLessThanOrEqual(2);
    // No duplicates even after the trim.
    const ids = idsOf(result);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ===========================================================================
// CONTRACT (c): embedder REJECTS / throws  →  no throw, EXACT BM25 fallback
// ===========================================================================

describe('retrieveChunks — embedder failure is swallowed (no throw)', () => {
  test('a rejecting embedQuery does NOT propagate; returns the BM25 ranking', async () => {
    const reference = bm25Search(QUERY, makeChunks(), { topK: 10 });
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => { throw new Error('model load failed'); },
    });
    expect(result).toEqual(reference);
  });

  test('a synchronously-throwing embedQuery also falls back to BM25 without throwing', async () => {
    const reference = bm25Search(QUERY, makeChunks(), { topK: 10 });
    await expect(
      retrieveChunks(QUERY, makeChunks(), {
        topK: 10,
        embedQuery: () => { throw new Error('boom'); }, // throws before returning a promise
      })
    ).resolves.toEqual(reference);
  });

  test('when the embedder throws, opts.searchFn is never reached', async () => {
    const searchFn = jest.fn(() => [{ id: 'c5', text: 'x', metadata: { layer: 'fine' }, score: 1 }]);
    const result = await retrieveChunks(QUERY, makeChunks(), {
      topK: 10,
      embedQuery: async () => { throw new Error('nope'); },
      searchFn,
    });
    expect(searchFn).not.toHaveBeenCalled();
    expect(idsOf(result)).not.toContain('c5');
  });
});

// ===========================================================================
// REGRESSION GUARD: the dead keyphrase boost is gone
// ===========================================================================

describe('bm25Search — keyphrase boost removed (dead-field cleanup)', () => {
  test('a metadata.keyphrases field exerts NO influence on ranking', () => {
    // Two otherwise-identical coarse chunks; one carries keyphrases that echo the query.
    // With the +0.6 boost deleted, scores must be EQUAL — keyphrases is ignored.
    const base = (id, extra = {}) => ({
      id,
      text: 'grasp planning with antipodal contact points',
      metadata: { layer: 'coarse', ...extra },
      embedding: new Array(384).fill(0.1),
    });
    const withKp = bm25Search(QUERY, [base('a', { keyphrases: ['grasp', 'planning', 'approach'] }), base('b')], { topK: 10 });
    const byId = Object.fromEntries(withKp.map((c) => [c.id, c.score]));
    expect(byId.a).toBeCloseTo(byId.b, 10); // identical text ⇒ identical BM25, keyphrases ignored
  });
});
