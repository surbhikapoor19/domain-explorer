// Client-side query embedding for the copilot HYBRID retriever (UNIT #15).
//
// The stored chunk vectors in public/data-*/rag-chunks.json were produced by
// sentence-transformers all-MiniLM-L6-v2 (384-dim, mean-pooled + L2-normalized).
// The browser-loadable port `Xenova/all-MiniLM-L6-v2` is the SAME model, so a
// query embedded here with { pooling: 'mean', normalize: true } is directly
// cosine-comparable to those stored vectors.
//
// The transformers.js import is LAZY (dynamic import) so the (large) library and
// its WASM runtime stay OUT of the main bundle — it only loads the first time a
// query is actually embedded. Every failure path (import error, model download
// failure, offline, runtime error) returns null and NEVER throws, so the caller
// (retrieveChunks) can fall through to its BM25 path unharmed.

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// Module-cached pipeline promise. We cache the in-flight PROMISE (not just the
// resolved pipeline) so concurrent first-callers share a single model load.
let embedderPromise = null;

async function getEmbedder() {
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async () => {
    // Dynamic import keeps @xenova/transformers out of the main bundle.
    const { pipeline, env } = await import('@xenova/transformers');
    // Prefer remote model files (no bundled local model assets in this app).
    if (env) {
      env.allowLocalModels = false;
    }
    return pipeline('feature-extraction', MODEL_ID);
  })();
  return embedderPromise;
}

/**
 * Embed a query string into a 384-dim, mean-pooled + L2-normalized vector that
 * matches the stored chunk embeddings.
 *
 * @param {string} text
 * @returns {Promise<number[]|null>} plain JS array of 384 numbers, or null on ANY failure.
 */
export async function embedQuery(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const extractor = await getEmbedder();
    // pooling=mean + normalize=true => same space as the stored vectors.
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    // transformers.js returns a Tensor; .data is a TypedArray (Float32Array).
    const data = output && output.data ? output.data : output;
    if (!data || typeof data.length !== 'number' || data.length === 0) return null;
    return Array.from(data);
  } catch (err) {
    // import failed / model load failed / offline / runtime error — degrade to BM25.
    // A failed load should not poison the cache for a later (online) retry.
    embedderPromise = null;
    return null;
  }
}

/**
 * Test hook: clear the module-cached pipeline so a fresh load happens next call.
 * (Production code never needs this; tests inject opts.embedQuery and never load
 * a real model, but this keeps the cache resettable.)
 */
export function resetEmbedderForTest() {
  embedderPromise = null;
}
