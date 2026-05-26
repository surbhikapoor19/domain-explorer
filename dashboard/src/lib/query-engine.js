export function computeQueryWeights(query, defaultWeights, columnKeywords) {
  const queryLower = query.toLowerCase();
  const weights = { ...defaultWeights };
  const scores = {};
  for (const [col, keywords] of Object.entries(columnKeywords)) {
    let score = 0;
    for (const kw of keywords) {
      if (queryLower.includes(kw.toLowerCase())) score++;
    }
    scores[col] = score;
  }
  const hasMatch = Object.values(scores).some(s => s > 0);
  if (!hasMatch) return weights;
  for (const [col, score] of Object.entries(scores)) {
    if (score > 0) {
      weights[col] = Math.min(16, (defaultWeights[col] || 5) + Math.min(score * 2, 6));
    } else {
      weights[col] = Math.max(2, Math.round((defaultWeights[col] || 5) * 0.7));
    }
  }
  return weights;
}

export function pickColorBy(query, colorByKeywords) {
  const queryLower = query.toLowerCase();
  let bestCol = 'cluster';
  let bestScore = 0;
  for (const [col, keywords] of Object.entries(colorByKeywords)) {
    let score = 0;
    for (const kw of keywords) {
      if (queryLower.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) { bestScore = score; bestCol = col; }
  }
  return bestCol;
}

export function attributeFilter(query, methods, attributeTerms) {
  const queryLower = query.toLowerCase();
  const matchedCols = {};
  // attributeTerms format: {column: {term: [values]}} from Python export
  for (const [col, termMap] of Object.entries(attributeTerms)) {
    if (typeof termMap !== 'object') continue;
    for (const [term, values] of Object.entries(termMap)) {
      if (queryLower.includes(term.toLowerCase())) {
        if (!matchedCols[col]) matchedCols[col] = new Set();
        (Array.isArray(values) ? values : [values]).forEach(v => matchedCols[col].add(v));
      }
    }
  }
  if (Object.keys(matchedCols).length === 0) return null;
  const filtered = methods.filter(m => {
    for (const [col, values] of Object.entries(matchedCols)) {
      const cellVal = m.metadata?.[col] || m[col] || '';
      const hasMatch = [...values].some(v => cellVal.toLowerCase().includes(v.toLowerCase()));
      if (!hasMatch) return false;
    }
    return true;
  });
  return filtered.length >= 2 ? filtered.map(m => m.name) : null;
}

const NO_FILTER_SIGNALS = [
  'compare', 'comparison', 'overview', 'trend', 'landscape',
  'all methods', 'every method', 'general', 'broadly',
];

export function shouldFilter(query) {
  const lower = query.toLowerCase();
  return !NO_FILTER_SIGNALS.some(sig => lower.includes(sig));
}

export function runQueryPipeline(query, defaultWeights, methods, queryKeywords) {
  const { columnKeywords, colorByKeywords, attributeTerms } = queryKeywords;
  const weights = computeQueryWeights(query, defaultWeights, columnKeywords || {});
  const colorBy = pickColorBy(query, colorByKeywords || {});
  let filterMethods = null;
  if (shouldFilter(query) && attributeTerms) {
    filterMethods = attributeFilter(query, methods, attributeTerms);
  }
  return { weights, colorBy, filterMethods };
}
