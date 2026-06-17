/* ALIGNMENT CORE contract — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * benchmark-cells.js is the ONE shared, pure module the Benchmarks page and the
 * copilot both consume. The whole point is that a copilot answer about a cell
 * references the EXACT SAME cell the page renders. These tests pin the shared
 * vocabulary: the canonical cell key, the condition-facet decode, the merged
 * Cell objects, the reproducibility lookup, the matched/nearest finder, the
 * coverage gaps, and the serializable page-ref handshake.
 *
 * Field names below mirror the real public/data-grasp-planning/
 * benchmark-comparisons.json:
 *   leaderboards: map "metric_id||condition" -> { metric_id, metric_label,
 *     condition, higher_is_better, entries:[{method,value,grade,n_reports,cv,
 *     source_papers,sources}] }
 *   cross_validations: [{ method, metric_id, metric_label, condition, mean, cv,
 *     status, grade, n_papers, reports:[...] }]
 *   comparisons: [{ winner, loser, metric_id, condition, winner_value,
 *     loser_value, margin, grade, ... }]
 *
 * This file MUST fail to run until ../benchmark-cells exports the 7 functions
 * (correct TDD — the implementation is written by a later unit).
 */
import {
  CELL_KEY,
  parseConditionFacets,
  buildCells,
  reproducibilityFor,
  findCells,
  coverageGaps,
  pageRef,
} from '../benchmark-cells';

// ── In-memory fixture ────────────────────────────────────────────────────────
// 2 metrics (success_rate, declutter_rate) across 3 conditions (packed, pile,
// real). One cell (declutter_rate||real) has a SINGLE method for the gaps test.
// cross_validations carries one "consistent" + one "high_variance" row.
// comparisons carries one head-to-head winner/loser row inside success_rate||packed.
const BENCH = {
  leaderboards: {
    // multi-method cell: 3 methods, 4 distinct source papers
    'success_rate||packed': {
      metric_id: 'success_rate',
      metric_label: 'Success Rate (%)',
      condition: 'packed',
      higher_is_better: true,
      entries: [
        { method: 'Edge Grasp Network', value: 92.0, grade: 'C', n_reports: 3, cv: 0.189, source_papers: ['edge-grasp-network', 'neugraspnet'] },
        { method: 'GIGA', value: 80.1, grade: 'B', n_reports: 2, cv: 0.04, source_papers: ['giga'] },
        { method: 'Volumetric Grasping Network (VGN)', value: 76.92, grade: 'A', n_reports: 3, cv: 0.04, source_papers: ['vgn'] },
      ],
    },
    // 2-method cell on a different condition
    'success_rate||pile': {
      metric_id: 'success_rate',
      metric_label: 'Success Rate (%)',
      condition: 'pile',
      higher_is_better: true,
      entries: [
        { method: 'NeuGraspNet', value: 86.51, grade: 'B', n_reports: 1, cv: 0.02, source_papers: ['neugraspnet'] },
        { method: 'PointNetGPD', value: 79.79, grade: 'B', n_reports: 1, cv: 0.05, source_papers: ['neugraspnet'] },
      ],
    },
    // 2-method cell, second metric
    'declutter_rate||packed': {
      metric_id: 'declutter_rate',
      metric_label: 'Declutter Rate (%)',
      condition: 'packed',
      higher_is_better: true,
      entries: [
        { method: 'Edge Grasp Network', value: 88.0, grade: 'B', n_reports: 2, cv: 0.05, source_papers: ['edge-grasp-network'] },
        { method: 'GIGA', value: 84.0, grade: 'B', n_reports: 1, cv: 0.03, source_papers: ['giga'] },
      ],
    },
    // SINGLE-method cell → must surface in coverageGaps
    'declutter_rate||real': {
      metric_id: 'declutter_rate',
      metric_label: 'Declutter Rate (%)',
      condition: 'real',
      higher_is_better: true,
      entries: [
        { method: 'Contact-GraspNet', value: 70.0, grade: 'B', n_reports: 1, cv: 0.0, source_papers: ['cgn'] },
      ],
    },
  },
  cross_validations: [
    {
      method: 'Volumetric Grasping Network (VGN)',
      metric_id: 'success_rate',
      metric_label: 'Success Rate (%)',
      condition: 'packed',
      mean: 76.92,
      cv: 0.04,
      status: 'consistent',
      grade: 'A',
      n_papers: 3,
      reports: [
        { paper: 'edge-grasp-network', value: 80.2, value_str: '80.2 ± 1.6', condition: 'packed' },
        { paper: 'giga', value: 73.6, value_str: '73.6', condition: 'packed' },
      ],
    },
    {
      method: 'Edge Grasp Network',
      metric_id: 'success_rate',
      metric_label: 'Success Rate (%)',
      condition: 'packed',
      mean: 73.4,
      cv: 0.189,
      status: 'high_variance',
      grade: 'C',
      n_papers: 3,
      reports: [
        { paper: 'edge-grasp-network', value: 92.0, value_str: '92.0 ± 1.4', condition: 'packed' },
        { paper: 'equivariant-volumetric-grasping', value: 54.1, value_str: '54.1 ± 2.1', condition: 'packed' },
      ],
    },
  ],
  comparisons: [
    {
      winner: 'Edge Grasp Network',
      loser: 'GIGA',
      metric_id: 'success_rate',
      condition: 'packed',
      winner_value: 92.0,
      loser_value: 80.1,
      margin: 11.9,
      grade: 'B',
      confidence: 0.78,
      paper: 'edge-grasp-network',
    },
  ],
  method_index: {},
  stats: {},
  quarantine: [],
};

// ── 1) CELL_KEY ───────────────────────────────────────────────────────────────
describe('CELL_KEY', () => {
  test('builds the canonical key in the leaderboard "metric_id||condition" format', () => {
    expect(CELL_KEY('success_rate', 'packed')).toBe('success_rate||packed');
    // The produced key must literally index the leaderboards map.
    expect(BENCH.leaderboards[CELL_KEY('success_rate', 'packed')]).toBeDefined();
    expect(BENCH.leaderboards[CELL_KEY('declutter_rate', 'real')]).toBeDefined();
  });

  test('an empty/null condition still produces a stable key ending in the separator', () => {
    expect(CELL_KEY('success_rate', '')).toBe('success_rate||');
    expect(CELL_KEY('success_rate', null)).toBe('success_rate||');
    expect(CELL_KEY('success_rate', undefined)).toBe('success_rate||');
  });
});

// ── 2) parseConditionFacets ───────────────────────────────────────────────────
describe('parseConditionFacets', () => {
  test('decodes scene tokens (packed / pile / real) into a scene facet', () => {
    expect(parseConditionFacets('packed').scene).toBe('packed');
    expect(parseConditionFacets('pile').scene).toBe('pile');
    expect(parseConditionFacets('real').scene).toBe('real');
  });

  test('decodes a success-criterion token (gsr / dr) into success_criterion', () => {
    expect(parseConditionFacets('packed:gsr').scene).toBe('packed');
    expect(parseConditionFacets('packed:gsr').success_criterion).toBe('gsr');
    expect(parseConditionFacets('pile:dr').success_criterion).toBe('dr');
  });

  test('unknown tokens land in a raw list, not in a known facet', () => {
    const f = parseConditionFacets('packed:weirdtoken');
    expect(f.scene).toBe('packed');
    expect(f.raw).toContain('weirdtoken');
    // an unknown token must NOT be silently promoted into success_criterion
    expect(f.success_criterion).toBeFalsy();
  });

  test('is defensive on null / empty condition', () => {
    expect(() => parseConditionFacets(null)).not.toThrow();
    expect(() => parseConditionFacets('')).not.toThrow();
    expect(() => parseConditionFacets(undefined)).not.toThrow();
    const f = parseConditionFacets(null);
    expect(f.scene).toBeFalsy();
    expect(f.success_criterion).toBeFalsy();
  });
});

// ── 3) buildCells ─────────────────────────────────────────────────────────────
describe('buildCells', () => {
  test('emits one cell per (metric x condition) that has data', () => {
    const cells = buildCells(BENCH);
    const keys = cells.map((c) => c.key).sort();
    expect(keys).toEqual(
      ['declutter_rate||packed', 'declutter_rate||real', 'success_rate||packed', 'success_rate||pile'].sort()
    );
  });

  test('each cell carries key/metric/condition/facets/higher_is_better and the leaderboard entries', () => {
    const cells = buildCells(BENCH);
    const packed = cells.find((c) => c.key === 'success_rate||packed');
    expect(packed.metric_id).toBe('success_rate');
    expect(packed.metric_label).toBe('Success Rate (%)');
    expect(packed.condition).toBe('packed');
    expect(packed.higher_is_better).toBe(true);
    expect(packed.facets.scene).toBe('packed');
    expect(packed.entries).toHaveLength(3);
    expect(packed.entries.map((e) => e.method)).toContain('GIGA');
  });

  test('merges leaderboard + cross_validation + comparison into ONE cell keyed by CELL_KEY', () => {
    const cells = buildCells(BENCH);
    const packed = cells.find((c) => c.key === CELL_KEY('success_rate', 'packed'));
    // reproducibility = the cross_validations rows whose metric_id+condition match
    expect(packed.reproducibility).toHaveLength(2);
    expect(packed.reproducibility.map((r) => r.method).sort()).toEqual(
      ['Edge Grasp Network', 'Volumetric Grasping Network (VGN)'].sort()
    );
    // headToHead = the comparisons inside this cell
    expect(packed.headToHead).toHaveLength(1);
    expect(packed.headToHead[0].winner).toBe('Edge Grasp Network');
    expect(packed.headToHead[0].loser).toBe('GIGA');
  });

  test('n_methods counts distinct methods and n_papers counts distinct source papers', () => {
    const cells = buildCells(BENCH);
    const packed = cells.find((c) => c.key === 'success_rate||packed');
    // 3 entries → 3 distinct methods
    expect(packed.n_methods).toBe(3);
    // source_papers union: edge-grasp-network, neugraspnet, giga, vgn = 4 distinct
    expect(packed.n_papers).toBe(4);
  });

  test('a cell without cross-validation or comparison rows gets empty arrays, not undefined', () => {
    const cells = buildCells(BENCH);
    const pile = cells.find((c) => c.key === 'success_rate||pile');
    expect(Array.isArray(pile.reproducibility)).toBe(true);
    expect(pile.reproducibility).toHaveLength(0);
    expect(Array.isArray(pile.headToHead)).toBe(true);
    expect(pile.headToHead).toHaveLength(0);
  });
});

// ── 4) reproducibilityFor ─────────────────────────────────────────────────────
describe('reproducibilityFor', () => {
  test('returns the consistent cross-validation for a known (method, metric, condition)', () => {
    const r = reproducibilityFor(BENCH, 'Volumetric Grasping Network (VGN)', 'success_rate', 'packed');
    expect(r).not.toBeNull();
    expect(r.status).toBe('consistent');
    expect(r.mean).toBeCloseTo(76.92);
    expect(r.cv).toBeCloseTo(0.04);
    expect(r.n_papers).toBe(3);
    expect(r.grade).toBe('A');
  });

  test('returns the high_variance status for the noisy method', () => {
    const r = reproducibilityFor(BENCH, 'Edge Grasp Network', 'success_rate', 'packed');
    expect(r).not.toBeNull();
    expect(r.status).toBe('high_variance');
  });

  test('returns null when no cross-validation matches', () => {
    expect(reproducibilityFor(BENCH, 'GIGA', 'success_rate', 'packed')).toBeNull(); // no CV row for GIGA
    expect(reproducibilityFor(BENCH, 'Volumetric Grasping Network (VGN)', 'success_rate', 'pile')).toBeNull(); // wrong condition
    expect(reproducibilityFor(BENCH, 'No Such Method', 'success_rate', 'packed')).toBeNull();
  });
});

// ── 5) findCells ──────────────────────────────────────────────────────────────
describe('findCells', () => {
  test('matched: returns cells satisfying ALL provided constraints (metric + scene facet)', () => {
    const out = findCells(BENCH, { metricId: 'success_rate', facets: { scene: 'packed' } });
    expect(out.matched.map((c) => c.key)).toEqual(['success_rate||packed']);
  });

  test('matched on metric alone returns every cell for that metric', () => {
    const out = findCells(BENCH, { metricId: 'success_rate' });
    expect(out.matched.map((c) => c.key).sort()).toEqual(
      ['success_rate||packed', 'success_rate||pile'].sort()
    );
  });

  test('matched on methods restricts to cells containing all named methods', () => {
    const out = findCells(BENCH, { methods: ['Edge Grasp Network', 'GIGA'] });
    // both methods co-occur in success_rate||packed and declutter_rate||packed
    expect(out.matched.map((c) => c.key).sort()).toEqual(
      ['declutter_rate||packed', 'success_rate||packed'].sort()
    );
  });

  test('no exact match → nearest carries the closest cells with the differsBy facet names', () => {
    // success_rate exists, but only for scenes packed/pile — not "real".
    const out = findCells(BENCH, { metricId: 'success_rate', facets: { scene: 'real' } });
    expect(out.matched).toHaveLength(0);
    expect(out.nearest.length).toBeGreaterThan(0);
    // the nearest cells are the other success_rate cells, differing only by scene
    const near = out.nearest[0];
    expect(near.cell.metric_id).toBe('success_rate');
    expect(near.differsBy).toContain('scene');
  });

  test('NEVER returns a looser invalid match as if it matched', () => {
    // asking for a scene that no success_rate cell has must not leak into matched
    const out = findCells(BENCH, { metricId: 'success_rate', facets: { scene: 'real' } });
    expect(out.matched).toHaveLength(0);
    // and the nearest entries are reported as differing, not as matches
    out.nearest.forEach((n) => expect(n.differsBy.length).toBeGreaterThan(0));
  });
});

// ── 6) coverageGaps ───────────────────────────────────────────────────────────
describe('coverageGaps', () => {
  test('flags the cells with fewer than 2 methods (under-studied whitespace)', () => {
    const gaps = coverageGaps(BENCH);
    const keys = gaps.map((c) => c.key);
    // declutter_rate||real has a single method → must be flagged
    expect(keys).toContain('declutter_rate||real');
    // multi-method cells must NOT be flagged
    expect(keys).not.toContain('success_rate||packed');
    expect(keys).not.toContain('declutter_rate||packed');
    // every flagged cell genuinely has < 2 methods
    gaps.forEach((c) => expect(c.n_methods).toBeLessThan(2));
  });
});

// ── 7) pageRef ────────────────────────────────────────────────────────────────
describe('pageRef', () => {
  test('returns a serializable {view, cellKey, conditionFilter} for the reproducibility view', () => {
    const ref = pageRef('reproducibility', { cellKey: 'success_rate||packed', facets: { scene: 'packed' } });
    expect(ref.view).toBe('reproducibility');
    expect(ref.cellKey).toBe('success_rate||packed');
    expect('conditionFilter' in ref).toBe(true);
    // plain JSON-serializable — no functions, no class instances
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });

  test('returns a comparisons-view ref the page can consume to pre-filter', () => {
    const ref = pageRef('comparisons', { cellKey: 'success_rate||pile', facets: { scene: 'pile' } });
    expect(ref.view).toBe('comparisons');
    expect(ref.cellKey).toBe('success_rate||pile');
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });
});
