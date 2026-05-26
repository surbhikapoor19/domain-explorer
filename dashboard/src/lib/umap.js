import { UMAP } from 'umap-js';
import { kmeans } from 'ml-kmeans';

export function computeCosineDistanceMatrix(features) {
  const n = features.length;
  const dist = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const a = features[i];
    const normA = Math.sqrt(a.reduce((s, v) => s + v * v, 0)) || 1;
    for (let j = i + 1; j < n; j++) {
      const b = features[j];
      const normB = Math.sqrt(b.reduce((s, v) => s + v * v, 0)) || 1;
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
      const cosine = 1 - dot / (normA * normB);
      dist[i][j] = cosine;
      dist[j][i] = cosine;
    }
  }
  return dist;
}

export function buildWeightedFeatures(tfidfMatrices, descEmbeddings, weights) {
  const n = descEmbeddings.length;
  const parts = [];
  for (const [col, weight] of Object.entries(weights)) {
    if (weight === 0) continue;
    const sqrtW = Math.sqrt(weight);
    if (col === 'Description') {
      parts.push(descEmbeddings.map(row => row.map(v => v * sqrtW)));
      continue;
    }
    const matrix = tfidfMatrices[col];
    if (!matrix) continue;
    parts.push(matrix.map(row => row.map(v => v * sqrtW)));
  }
  return Array.from({ length: n }, (_, i) =>
    parts.reduce((acc, part) => acc.concat(part[i]), [])
  );
}

export function runUmap(features, { nNeighbors = 15, minDist = 0.1 } = {}) {
  const n = features.length;
  if (n <= 1) return [[0, 0]];
  if (n <= 3) return features.map((_, i) => [i * 2 - (n - 1), 0]);
  const adjustedNeighbors = Math.min(nNeighbors, Math.max(2, n - 1));
  const umap = new UMAP({ nNeighbors: adjustedNeighbors, minDist, nComponents: 2 });
  return umap.fit(features);
}

export function runKmeans(features, k) {
  if (features.length <= k) return features.map((_, i) => i);
  const result = kmeans(features, k, { initialization: 'kmeans++' });
  return result.clusters;
}

export function recomputeUmap(tfidfMatrices, descEmbeddings, weights, methods, defaultK) {
  const features = buildWeightedFeatures(tfidfMatrices, descEmbeddings, weights);
  const coords = runUmap(features);
  const k = Math.max(2, Math.min(defaultK, Math.floor(features.length / 3)));
  const labels = runKmeans(features, k);
  return methods.map((method, i) => ({
    ...method,
    x: coords[i][0],
    y: coords[i][1],
    cluster: labels[i],
  }));
}
