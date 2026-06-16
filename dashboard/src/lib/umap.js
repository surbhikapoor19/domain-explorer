import { UMAP } from 'umap-js';
import { kmeans } from 'ml-kmeans';

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
  const fullFeatures = buildWeightedFeatures(tfidfMatrices, descEmbeddings, weights);
  // Slice the feature matrix to the rows the (possibly FILTERED) methods occupy
  // in the full corpus, so features / coords / labels / methods share the same
  // length AND order. Each method carries `_row` = its index into the full
  // matrices. Without this, a filtered view assigned coords[i]/labels[i] of
  // UNRELATED corpus items to the i-th filtered method — every dot mis-placed.
  const rows = methods.map(m => m._row);
  const useRows = rows.every(r => Number.isInteger(r) && r >= 0 && r < fullFeatures.length);
  const features = useRows ? rows.map(r => fullFeatures[r]) : fullFeatures;
  const coords = runUmap(features);
  const k = Math.max(2, Math.min(defaultK, Math.floor(features.length / 3)));
  const labels = runKmeans(features, k);
  return methods.map((method, i) => {
    const { _row, ...rest } = method;
    return { ...rest, x: coords[i][0], y: coords[i][1], cluster: labels[i] };
  });
}
