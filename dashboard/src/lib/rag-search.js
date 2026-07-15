let chunks = [];

export function initChunks(ragChunks) { chunks = ragChunks; }

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export const INTENT_LAYERS = {
  BROAD: ['coarse'], TECHNICAL: ['mid', 'fine'], EVALUATION: ['mid', 'fine'],
  COMPARISON: ['coarse', 'mid'], LIMITATION: ['mid'], PEOPLE: ['coarse'],
};

export function classifyIntent(query) {
  const q = query.toLowerCase();
  if (q.match(/compar|versus|vs\b|better|worse|differ/)) return 'COMPARISON';
  if (q.match(/limit|weakness|fail|problem|gap/)) return 'LIMITATION';
  if (q.match(/benchmark|evaluat|result|metric|accuracy|f1|precision/)) return 'EVALUATION';
  if (q.match(/equation|formula|loss|gradient|architecture|backbone|attention/)) return 'TECHNICAL';
  if (q.match(/who|author|lab|institution|team/)) return 'PEOPLE';
  return 'BROAD';
}

// The intent's preferred layers are a SOFT BOOST, not a hard filter. A hard
// filter here starved most queries down to their preferred layer(s) only — a
// BROAD query (the default classification) never saw anything but the coarse
// quarter of the corpus, missing the mid/fine layers (2070 fine chunks) entirely.
const LAYER_BOOST = 0.1; // additive, small — never enough to invert a real match

export function searchChunks(queryEmbedding, { topK = 10, intent = 'BROAD' } = {}) {
  if (!chunks.length || !queryEmbedding?.length) return [];
  const targetLayers = new Set(INTENT_LAYERS[intent] || ['coarse', 'mid', 'fine']);

  return chunks
    .filter(c => c.embedding?.length)
    .map(c => {
      const base = cosineSimilarity(queryEmbedding, c.embedding);
      const score = targetLayers.has(c.metadata?.layer) ? base + LAYER_BOOST : base;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
