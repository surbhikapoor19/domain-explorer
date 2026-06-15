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

export function searchChunks(queryEmbedding, { topK = 10, intent = 'BROAD' } = {}) {
  if (!chunks.length || !queryEmbedding?.length) return [];
  const targetLayers = new Set(INTENT_LAYERS[intent] || ['coarse', 'mid', 'fine']);

  const scored = chunks
    .filter(c => c.embedding?.length && targetLayers.has(c.metadata?.layer))
    .map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (scored.length === 0) {
    return chunks
      .filter(c => c.embedding?.length)
      .map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  return scored;
}
