// Maps a natural-language query to the relevant benchmark leaderboard(s) and
// renders the ranked, evidence-graded, source-linked rows for the copilot's LLM
// prompt — so "best method on simulated scenes" answers with verified numbers.

// Fallback keyword maps (grasp-planning) used ONLY when the benchmark data does
// not carry a domain-derived `copilot` block. For any domain built by the
// current pipeline, build_benchmarks.py emits benchmarkData.copilot.{metric,
// condition}_keywords derived from that domain's benchmark config aliases, so
// the query→leaderboard routing is automatically domain-correct.
const DEFAULT_METRIC_KEYWORDS = {
  success_rate:     ['success rate', 'success', 'grasp success', 'gsr', 'performance', 'best ', 'highest', 'top ', 'accuracy', 'how well', 'most effective', 'state of the art', 'sota'],
  declutter_rate:   ['declutter', 'clutter removal', 'clearance', 'clear the', 'declutter rate'],
  latency:          ['latency', 'speed', 'fast', 'fastest', 'inference time', 'runtime', 'real-time', 'real time', 'efficient', 'quick'],
  average_precision:['average precision', ' ap ', ' map ', 'precision'],
  completion_rate:  ['completion rate', 'scene completion'],
};
const DEFAULT_CONDITION_KEYWORDS = {
  sim:    ['simulat', ' sim ', 'in simulation'],
  real:   ['real-world', 'real world', 'physical', ' real '],
  packed: ['packed'],
  pile:   ['pile', 'piled', 'cluttered', 'clutter '],
};

export function buildBenchmarkContext(query, benchmarkData) {
  if (!benchmarkData || !benchmarkData.leaderboards) return '';
  // Domain-derived keyword maps when present (emitted by build_benchmarks.py from
  // the domain's metric/condition aliases); else the grasp fallback above. When a
  // copilot block exists, its condition map governs even if empty — don't bleed
  // grasp conditions into another domain.
  const cp = benchmarkData.copilot;
  // Use the domain-derived keyword maps only when they're actually populated;
  // an absent OR empty `copilot` block (e.g. data built before the feature, or a
  // precompute-only refresh that didn't re-run the benchmark step) falls back to
  // the grasp defaults so grounding still fires.
  const hasCopilot = cp && cp.metric_keywords && Object.keys(cp.metric_keywords).length > 0;
  const metricKeywords = hasCopilot ? cp.metric_keywords : DEFAULT_METRIC_KEYWORDS;
  const conditionKeywords = hasCopilot ? (cp.condition_keywords || {}) : DEFAULT_CONDITION_KEYWORDS;
  const q = ' ' + (query || '').toLowerCase() + ' ';
  // Score each metric by its most SPECIFIC matched keyword: a long alias
  // ("path length") outranks a short directional word ("shortest"), so
  // "shortest path length" routes to path_length, not the primary cost metric.
  // Hit-count breaks length ties.
  let metric = null, bestScore = 0;
  for (const [mid, kws] of Object.entries(metricKeywords)) {
    let hits = 0, maxLen = 0;
    for (const k of kws) { if (k && q.includes(k)) { hits++; if (k.length > maxLen) maxLen = k.length; } }
    if (!hits) continue;
    const score = maxLen * 100 + hits;
    if (score > bestScore) { bestScore = score; metric = mid; }
  }
  if (!metric) return '';                       // not a quantitative/ranking query
  let condition = null;
  for (const [cid, kws] of Object.entries(conditionKeywords)) {
    if (kws.some(k => q.includes(k))) { condition = cid; break; }
  }
  let lbs = Object.values(benchmarkData.leaderboards).filter(lb => lb.metric_id === metric);
  if (!lbs.length) return '';
  if (condition) {
    const cm = lbs.filter(lb => (lb.condition || '').toLowerCase().includes(condition));
    if (cm.length) lbs = cm;
  }
  lbs = lbs.sort((a, b) => (b.entries?.length || 0) - (a.entries?.length || 0)).slice(0, 2);
  const blocks = lbs.map(lb => {
    const head = `${lb.metric_label}${lb.condition ? ' — ' + lb.condition : ''}` +
                 `${lb.higher_is_better === false ? ' (lower is better)' : ''}`;
    const rows = (lb.entries || []).slice(0, 6).map((e, i) => {
      const src = (e.source_papers || []).join(', ');
      return `  ${i + 1}. ${e.method} = ${e.value}  [grade ${e.grade}, ${e.n_reports} paper${e.n_reports !== 1 ? 's' : ''}${src ? ', source: ' + src : ''}]`;
    }).join('\n');
    return `${head}:\n${rows}`;
  });
  return blocks.join('\n\n');
}
