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
  },
  copilot: {
    metric_keywords: {
      planning_time: ['planning time', 'computation time', 'runtime', 'time', 'fastest', 'lowest', 'shortest', 'quickest'],
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

test('without a copilot block, a motion-only "fastest" query finds no grasp latency board', () => {
  const noCopilot = { leaderboards: MOTION_BENCH.leaderboards };   // falls back to grasp defaults
  // grasp default maps "fastest" → latency; MOTION_BENCH has no latency board → ''
  expect(buildBenchmarkContext('fastest planner?', noCopilot)).toBe('');
});
