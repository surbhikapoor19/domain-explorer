// Corpus-level derived facts for the copilot.
//
// The LLM answers ONLY from the supplied context, so it cannot resolve a
// reference like "the top-cited method" — nothing in the paper excerpts states
// which item that is. This module DERIVES those superlatives deterministically
// from data the pipeline already loads (the knowledge graph's precomputed node
// metrics + `cites` edges, the methods' release years, and the benchmark
// leaderboards) and formats them into a compact block the prompt injects. That
// turns "the top-cited item is not specified" into a real, sourced answer.
//
// Pure + unit-testable. No network, no LLM.

function paperMethodName(node) {
  if (node && Array.isArray(node.methods) && node.methods.length) return node.methods[0];
  return (node && (node.label || node.paper_id || node.id)) || 'unknown';
}

/**
 * computeCorpusFacts({ methods, kg, benchmarks }) -> { facts, factsText }
 * Each fact is null-safe; absent inputs simply omit that fact.
 */
export function computeCorpusFacts({ methods = [], kg = null, benchmarks = null } = {}) {
  const facts = {};

  if (kg && Array.isArray(kg.nodes)) {
    const papers = kg.nodes.filter(n => n && n.type === 'paper');
    const byId = new Map();
    papers.forEach(p => {
      if (p.id) byId.set(p.id, p);
      if (p.paper_id) byId.set('paper:' + p.paper_id, p);
    });

    // Most-cited WITHIN the corpus: count incoming `cites` edges (paper→paper).
    const citeIn = new Map();
    (kg.links || []).forEach(l => {
      if (l && l.type === 'cites' && l.target) citeIn.set(l.target, (citeIn.get(l.target) || 0) + 1);
    });
    let mostCited = null;
    citeIn.forEach((count, tid) => {
      const p = byId.get(tid);
      if (p && (!mostCited || count > mostCited.count)) mostCited = { name: paperMethodName(p), count };
    });
    if (mostCited) facts.mostCited = mostCited;

    // Most central/influential: precomputed PageRank on the paper subgraph.
    let mostInfluential = null;
    papers.forEach(p => {
      if (typeof p.pagerank === 'number' && (!mostInfluential || p.pagerank > mostInfluential.score)) {
        mostInfluential = { name: paperMethodName(p), score: p.pagerank };
      }
    });
    if (mostInfluential) facts.mostInfluential = mostInfluential;

    // Most used as a comparison baseline: precomputed n_comparisons.
    let mostCompared = null;
    papers.forEach(p => {
      const n = p.n_comparisons || 0;
      if (n > 0 && (!mostCompared || n > mostCompared.count)) mostCompared = { name: paperMethodName(p), count: n };
    });
    if (mostCompared) facts.mostCompared = mostCompared;
  }

  // Newest / oldest by release year (from method metadata).
  const yearOf = (m) => {
    const raw = (m.metadata && (m.metadata['Year (Initial Release)'] || m.metadata.Year)) || m.year;
    const y = parseInt(raw, 10);
    return Number.isFinite(y) ? y : null;
  };
  const withYear = methods.map(m => { const y = yearOf(m); return y ? { name: m.name, year: y } : null; }).filter(Boolean);
  if (withYear.length) {
    facts.newest = withYear.reduce((a, b) => (b.year > a.year ? b : a));
    facts.oldest = withYear.reduce((a, b) => (b.year < a.year ? b : a));
  }

  // Most-benchmarked: most leaderboard entries across all (metric × protocol) cells.
  if (benchmarks && benchmarks.leaderboards) {
    const cnt = new Map();
    Object.values(benchmarks.leaderboards).forEach(lb => {
      (lb.entries || []).forEach(e => { if (e && e.method) cnt.set(e.method, (cnt.get(e.method) || 0) + 1); });
    });
    let mostBench = null;
    cnt.forEach((count, name) => { if (!mostBench || count > mostBench.count) mostBench = { name, count }; });
    if (mostBench) facts.mostBenchmarked = mostBench;
  }

  return { facts, factsText: formatCorpusFacts(facts) };
}

export function formatCorpusFacts(facts = {}) {
  const lines = [];
  if (facts.mostCited) lines.push(`- Top-cited within this corpus: ${facts.mostCited.name} (cited by ${facts.mostCited.count} other paper${facts.mostCited.count === 1 ? '' : 's'} here).`);
  if (facts.mostInfluential) lines.push(`- Most central/influential (knowledge-graph PageRank): ${facts.mostInfluential.name}.`);
  if (facts.mostCompared) lines.push(`- Most used as a comparison baseline: ${facts.mostCompared.name} (${facts.mostCompared.count} comparisons).`);
  if (facts.mostBenchmarked) lines.push(`- Most-benchmarked (most reported result rows): ${facts.mostBenchmarked.name} (${facts.mostBenchmarked.count} entries).`);
  if (facts.newest) lines.push(`- Newest method: ${facts.newest.name} (${facts.newest.year}).`);
  if (facts.oldest) lines.push(`- Oldest method: ${facts.oldest.name} (${facts.oldest.year}).`);
  return lines.join('\n');
}
