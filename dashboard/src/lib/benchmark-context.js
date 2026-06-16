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

export function buildBenchmarkContext(query, benchmarkData, opts = {}) {
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
  if (!metric) {
    // No metric/ranking keyword matched. Fall through to the comparison-intent
    // path before giving up — a "compare A and B" / "A vs B" query carries no
    // metric word but should still surface the relevant board(s).
    return buildComparisonContext(q, benchmarkData, opts);
  }
  let condition = null;
  for (const [cid, kws] of Object.entries(conditionKeywords)) {
    if (kws.some(k => q.includes(k))) { condition = cid; break; }
  }
  let lbs = Object.values(benchmarkData.leaderboards).filter(lb => lb.metric_id === metric);
  if (!lbs.length) return '';                    // metric maps to no board in this domain
  // The metric routed and board(s) exist, but every one is empty (a metric defined
  // in config yet never populated) — say so explicitly so the copilot reports the
  // gap instead of hallucinating numbers.
  if (!lbs.some(lb => (lb.entries || []).length > 0)) {
    return 'No leaderboard rows for that metric in this domain.';
  }
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

// Comparison-intent grounding. Fires only when the metric path matched nothing.
// `q` is the already-padded, lowercased query (leading/trailing space). The
// comparison branch surfaces grounding when the query carries an explicit
// comparison verb (compare / vs / versus / better than / head-to-head) OR names
// 2+ of opts.knownMethods. It prefers explicit head-to-head comparison rows when
// benchmarkData.comparisons has them for the named pair, else falls back to the
// most relevant leaderboard(s) that include those methods.
const COMPARISON_VERBS = [' compare ', ' compares ', ' comparison ', ' vs ', ' vs. ', ' versus ', ' better than ', ' head-to-head ', ' head to head '];

function buildComparisonContext(q, benchmarkData, opts) {
  const knownMethods = Array.isArray(opts && opts.knownMethods) ? opts.knownMethods : [];
  // Which known dataset methods are named in the query? (q is space-padded)
  const named = knownMethods.filter(m => m && q.includes(m.toLowerCase()));
  const hasVerb = COMPARISON_VERBS.some(v => q.includes(v));
  // Intent fires on an explicit comparison verb OR on 2+ named dataset methods.
  if (!hasVerb && named.length < 2) return '';

  const namedLower = named.map(m => m.toLowerCase());
  const mentionsMethod = (name) => namedLower.includes((name || '').toLowerCase());

  // Prefer explicit head-to-head comparison rows for the named pair, when present.
  const comparisons = Array.isArray(benchmarkData.comparisons) ? benchmarkData.comparisons : [];
  if (comparisons.length) {
    const rows = comparisons.filter(c => {
      // If we know which methods were named, require both to appear in the row;
      // otherwise surface any comparison row (verb-only intent).
      if (named.length >= 2) return mentionsMethod(c.method_a) && mentionsMethod(c.method_b);
      return true;
    });
    if (rows.length) {
      const blocks = rows.slice(0, 3).map(c => {
        const src = (c.source_papers || []).join(', ');
        const label = c.metric_label || c.metric_id || 'Comparison';
        return `${label} — head-to-head:\n` +
               `  ${c.method_a} = ${c.a_value}  vs  ${c.method_b} = ${c.b_value}` +
               `${src ? '  [source: ' + src + ']' : ''}`;
      });
      return blocks.join('\n\n');
    }
  }

  // Otherwise surface the most relevant leaderboard(s) that include the named
  // methods — boards where the most named methods co-occur rank first.
  const all = Object.values(benchmarkData.leaderboards);
  const scored = all
    .map(lb => {
      const entries = lb.entries || [];
      const hits = named.length
        ? entries.filter(e => mentionsMethod(e.method)).length
        : entries.length;     // verb-only intent with no named methods: rank by size
      return { lb, hits };
    })
    .filter(x => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || (b.lb.entries?.length || 0) - (a.lb.entries?.length || 0));

  if (!scored.length) return '';
  const lbs = scored.slice(0, 2).map(x => x.lb);
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
