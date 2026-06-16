const cache = {};

let _dataPrefix = '/data';

export function setDataPrefix(prefix) {
  _dataPrefix = prefix;
}

async function loadJSON(path) {
  if (cache[path]) return cache[path];
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const data = await res.json();
  cache[path] = data;
  return data;
}

function dataPath(filename) {
  return `${_dataPrefix}/${filename}`;
}

export const loadMethods = () => loadJSON(dataPath('methods.json'));
export const loadTfidfMatrices = () => loadJSON(dataPath('tfidf-matrices.json'));
export const loadDescriptionEmbeddings = () => loadJSON(dataPath('description-embeddings.json'));
export const loadUmapDefault = () => loadJSON(dataPath('umap-default.json'));
export const loadKgMacro = () => loadJSON(dataPath('kg-macro.json'));
export const loadKgLanding = () => loadJSON(dataPath('kg-landing.json'));
export const loadKgFull = () => loadJSON(dataPath('kg-full.json'));
export const loadKgPredictions = () => loadJSON(dataPath('kg-predictions.json'));
export const loadKgContradictions = () => loadJSON(dataPath('kg-contradictions.json'));
export const loadHgtMetrics = () => loadJSON(dataPath('hgt-metrics.json'));
export const loadRagChunks = () => loadJSON(dataPath('rag-chunks.json'));
export const loadBenchmarkComparisons = () => loadJSON(dataPath('benchmark-comparisons.json'));
export const loadTermDictionary = () => loadJSON(dataPath('term-dictionary.json'));
export const loadPapersIndex = () => loadJSON(dataPath('papers-index.json'));
export const loadQueryKeywords = () => loadJSON(dataPath('query-keywords.json'));

export async function loadDomainConfig() {
  try {
    return await loadJSON(dataPath('domain-config.json'));
  } catch (_) {
    return null;
  }
}

export async function loadClusterInsight() {
  try {
    return await loadJSON(dataPath('cluster-insight.json'));
  } catch (_) {
    return null;
  }
}

export async function loadAllData() {
  const [umapDefault, termDictionary, queryKeywords, domainConfig, clusterInsight] = await Promise.all([
    loadUmapDefault(),
    loadTermDictionary(),
    loadQueryKeywords(),
    loadDomainConfig(),
    loadClusterInsight(),
  ]);
  return { umapDefault, termDictionary, queryKeywords, domainConfig, clusterInsight };
}
