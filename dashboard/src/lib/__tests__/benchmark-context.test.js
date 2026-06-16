/* Copilot benchmark grounding — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * A performance/ranking query must surface the matching leaderboard with exact
 * values, grades, and source papers; a non-quantitative query gets nothing. */
import { buildBenchmarkContext } from '../benchmark-context';

const BENCH = {
  leaderboards: {
    'success_rate||sim': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'sim', higher_is_better: true,
      entries: [
        { method: 'AnyGrasp', value: 86.9, grade: 'A', n_reports: 3, source_papers: ['anygrasp', 'giga'] },
        { method: 'GIGA', value: 80.1, grade: 'B', n_reports: 1, source_papers: ['giga'] },
      ],
    },
    'success_rate||real': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'real', higher_is_better: true,
      entries: [{ method: 'Contact-GraspNet', value: 70.0, grade: 'B', n_reports: 1, source_papers: ['cgn'] }],
    },
    'latency||': {
      metric_id: 'latency', metric_label: 'Latency (ms)', condition: null, higher_is_better: false,
      entries: [{ method: 'VGN', value: 9, grade: 'B', n_reports: 1, source_papers: ['vgn'] }],
    },
  },
};

test('grounds a performance + simulated query in the success_rate / sim leaderboard', () => {
  const out = buildBenchmarkContext('method for simulated scenes with highest performance?', BENCH);
  expect(out).toContain('Success Rate');
  expect(out).toContain('AnyGrasp = 86.9');
  expect(out).toContain('grade A');
  expect(out).toContain('anygrasp');          // source cited
  expect(out).not.toContain('Latency');        // not a latency query
});

test('matches latency / "fastest" queries to the latency board (lower is better)', () => {
  const out = buildBenchmarkContext('which method is fastest?', BENCH);
  expect(out).toContain('Latency');
  expect(out).toContain('lower is better');
  expect(out).toContain('VGN = 9');
});

test('returns empty for a non-quantitative question', () => {
  expect(buildBenchmarkContext('how does diffusion-based grasping work?', BENCH)).toBe('');
});

test('returns empty when there is no benchmark data', () => {
  expect(buildBenchmarkContext('best method?', null)).toBe('');
});

// ── Domain-derived keyword routing (motion planning) ──────────────────────────
// build_benchmarks.py emits benchmarkData.copilot.{metric,condition}_keywords from
// the domain's benchmark-config aliases. The grasp fallback maps would NOT route
// these motion queries (e.g. "fastest" → latency, which motion lacks → ''), so a
// correct match proves the domain-derived copilot map is what's being used.
const MOTION_BENCH = {
  leaderboards: {
    'planning_time||narrow_passage': {
      metric_id: 'planning_time', metric_label: 'Planning Time (s)', condition: 'narrow_passage', higher_is_better: false,
      entries: [
        { method: 'RRT-Connect', value: 0.8, grade: 'A', n_reports: 2, source_papers: ['ompl', 'vamp'] },
        { method: 'PRM', value: 2.4, grade: 'B', n_reports: 1, source_papers: ['ompl'] },
      ],
    },
    'success_rate||cluttered': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'cluttered', higher_is_better: true,
      entries: [{ method: 'cuRobo', value: 98.0, grade: 'A', n_reports: 2, source_papers: ['curobo', 'vamp'] }],
    },
    'path_length||narrow_passage': {
      metric_id: 'path_length', metric_label: 'Path Length (m)', condition: 'narrow_passage', higher_is_better: false,
      entries: [{ method: 'BIT*', value: 3.1, grade: 'B', n_reports: 1, source_papers: ['bit'] }],
    },
  },
  copilot: {
    metric_keywords: {
      // planning_time is the primary cost metric → owns the bare directional words
      planning_time: ['planning time', 'computation time', 'runtime', 'time', 'fastest', 'lowest', 'shortest', 'quickest'],
      // path_length carries only its specific aliases (longest-match must win on "path length")
      path_length: ['path length', 'trajectory length'],
      success_rate: ['success rate', 'solve rate', 'sr', 'best', 'highest', 'top', 'performance'],
    },
    condition_keywords: {
      narrow_passage: ['narrow passage', 'narrow', 'bug trap'],
      cluttered: ['cluttered', 'clutter'],
    },
  },
};

test('uses the domain-derived copilot map to route a motion timing query', () => {
  const out = buildBenchmarkContext('fastest planner in a narrow passage?', MOTION_BENCH);
  expect(out).toContain('Planning Time');
  expect(out).toContain('narrow_passage');
  expect(out).toContain('RRT-Connect = 0.8');
  expect(out).toContain('lower is better');
});

test('routes a motion success-rate query via the copilot map (grasp default lacks these planners)', () => {
  const out = buildBenchmarkContext('which algorithm has the best success rate in cluttered scenes?', MOTION_BENCH);
  expect(out).toContain('Success Rate');
  expect(out).toContain('cuRobo = 98');
});

test('specific alias outranks a directional word: "shortest path length" → path_length, not planning_time', () => {
  // planning_time owns the bare word "shortest"; path_length owns "path length".
  // Longest-match must pick path_length (alias len 11 > "shortest" len 8).
  const out = buildBenchmarkContext('which planner gives the shortest path length?', MOTION_BENCH);
  expect(out).toContain('Path Length');
  expect(out).toContain('BIT* = 3.1');
  expect(out).not.toContain('Planning Time');
});

test('without a copilot block, a motion-only "fastest" query finds no grasp latency board', () => {
  const noCopilot = { leaderboards: MOTION_BENCH.leaderboards };   // falls back to grasp defaults
  // grasp default maps "fastest" → latency; MOTION_BENCH has no latency board → ''
  expect(buildBenchmarkContext('fastest planner?', noCopilot)).toBe('');
});

test('an EMPTY copilot block falls back to the grasp defaults (data built before the feature)', () => {
  // grasp's benchmark-comparisons.json carries copilot:{metric_keywords:{}} — an
  // empty block must NOT suppress grounding; it should use the grasp defaults.
  const emptyCopilot = { leaderboards: BENCH.leaderboards, copilot: { metric_keywords: {}, condition_keywords: {} } };
  const out = buildBenchmarkContext('which method has the highest success rate in simulation?', emptyCopilot);
  expect(out).toContain('Success Rate');
  expect(out).toContain('AnyGrasp = 86.9');
});

// ── APPENDED: comparison-intent path + motion-gap (CONTRACT extension) ────────
// New optional 3rd arg opts.knownMethods. The comparison path fires when the
// query carries comparison intent (compare / vs / versus / better than /
// head-to-head) OR names 2+ knownMethods, AND no metric keyword matched. The
// pre-existing metric-keyword path with longest-match scoring is untouched —
// every test above must still pass.

test('comparison intent grounds when 2+ knownMethods are named even with no metric word', () => {
  // "compare AnyGrasp and GIGA" has the explicit "compare" verb AND names two
  // dataset methods, but carries NO metric/ranking keyword. Old behaviour: the
  // metric loop finds nothing → return ''. New behaviour: surface the relevant
  // leaderboard(s) that include those methods (success_rate||sim has both).
  const out = buildBenchmarkContext('compare AnyGrasp and GIGA', BENCH, { knownMethods: ['AnyGrasp', 'GIGA'] });
  expect(out).not.toBe('');                       // no longer silently empty
  // Either it names both methods, or it surfaces the success_rate board that
  // contains them — the contract allows either form of grounding.
  expect(/AnyGrasp/.test(out) && /GIGA/.test(out)).toBe(true);
  expect(out).toContain('Success Rate');          // the board that lists both
});

test('comparison verb "vs" with no metric word still surfaces a board for the named methods', () => {
  // "vs" alone is comparison intent; AnyGrasp + GIGA co-occur on success_rate||sim.
  const out = buildBenchmarkContext('AnyGrasp vs GIGA', BENCH, { knownMethods: ['AnyGrasp', 'GIGA'] });
  expect(out).not.toBe('');
  expect(out).toContain('AnyGrasp = 86.9');       // exact leaderboard value, not a bare echo
  expect(out).toContain('GIGA');
});

test('comparison path does NOT hijack a genuine metric query (existing scoring wins)', () => {
  // A query that DOES carry a metric keyword must still route through the
  // untouched metric path, even when knownMethods are supplied — the comparison
  // branch only fires when no metric matched.
  const out = buildBenchmarkContext('which has the highest success rate in simulation, AnyGrasp or GIGA?', BENCH, { knownMethods: ['AnyGrasp', 'GIGA'] });
  expect(out).toContain('Success Rate');
  expect(out).toContain('AnyGrasp = 86.9');
  expect(out).not.toContain('Latency');           // metric routing unchanged
});

test('comparison intent without knownMethods and without a metric word stays empty', () => {
  // No metric keyword, no comparison verb, and no knownMethods to count → nothing
  // to ground on. Guards against the comparison branch firing too eagerly.
  expect(buildBenchmarkContext('tell me about grasping', BENCH, {})).toBe('');
  expect(buildBenchmarkContext('tell me about grasping', BENCH)).toBe('');
});

test('comparison path prefers explicit head-to-head comparison rows when present', () => {
  // When benchmarkData.comparisons carries head-to-head rows for the named pair,
  // the comparison branch surfaces those rather than returning empty.
  const withComparisons = {
    leaderboards: BENCH.leaderboards,
    comparisons: [
      { method_a: 'AnyGrasp', method_b: 'GIGA', metric_label: 'Success Rate (%)', a_value: 86.9, b_value: 80.1, source_papers: ['anygrasp'] },
    ],
  };
  const out = buildBenchmarkContext('head-to-head AnyGrasp GIGA', withComparisons, { knownMethods: ['AnyGrasp', 'GIGA'] });
  expect(out).not.toBe('');
  expect(out).toContain('AnyGrasp');
  expect(out).toContain('GIGA');
});

test('motion-gap: a routed metric with no leaderboard entries returns the explicit no-rows line', () => {
  // The metric keyword routes (success_rate), but every matching leaderboard has
  // an empty entries array → must return the explicit single-line note instead of
  // empty, so the copilot can say so rather than hallucinate.
  const EMPTY_BOARD = {
    leaderboards: {
      'success_rate||sim': {
        metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'sim', higher_is_better: true,
        entries: [],
      },
    },
  };
  const out = buildBenchmarkContext('which method has the highest success rate?', EMPTY_BOARD);
  expect(out).not.toBe('');
  expect(out).toContain('No leaderboard rows for that metric in this domain.');
});
