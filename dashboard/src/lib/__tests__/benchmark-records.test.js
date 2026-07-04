/* benchmark-records — AUTHORED BY ORCHESTRATOR. The redesigned Benchmarks page is
 * a flat, tag-filtered view of the EXTRACTED data (no ranking, no charts). This
 * pins the flatten + tag-facet + AND/OR filter contract. */
import { buildResultRecords, tagFacets, filterByTags, tagKey, tagKeysFromCellKey, TAG_CATEGORY_ORDER } from '../benchmark-records';

const BENCH = {
  leaderboards: {
    'success_rate||packed:randomview:gsr': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)',
      condition: 'packed:randomview:gsr', higher_is_better: true,
      entries: [
        { method: 'VGN', value: 80, grade: 'B', n_reports: 1, source_papers: ['vgn'], sources: [{ paper: 'vgn', value_str: '80' }] },
        { method: 'GIGA', value: 85, grade: 'A', n_reports: 2, source_papers: ['giga', 'x'] },
      ],
    },
    'success_rate||pile': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'pile', higher_is_better: true,
      entries: [{ method: 'AnyGrasp', value: 70, grade: 'B', n_reports: 1, source_papers: ['any'] }],
    },
    'latency||inference-time': {
      metric_id: 'latency', metric_label: 'Latency (ms)', condition: 'inference-time', higher_is_better: false,
      entries: [{ method: 'VGN', value: 10, grade: 'B', n_reports: 1, source_papers: ['vgn'] }],
    },
  },
};

describe('buildResultRecords', () => {
  const recs = buildResultRecords(BENCH);
  test('one record per (method × metric × protocol) cell, alphabetical by method', () => {
    expect(recs).toHaveLength(4);
    expect(recs.map(r => r.method)).toEqual(['AnyGrasp', 'GIGA', 'VGN', 'VGN']);
  });
  test('tags the protocol correctly', () => {
    const vgnPacked = recs.find(r => r.method === 'VGN' && r.metricId === 'success_rate');
    expect(vgnPacked.tagKeys.has('Method:VGN')).toBe(true);
    expect(vgnPacked.tagKeys.has('Metric:success_rate')).toBe(true);
    expect(vgnPacked.tagKeys.has('Scene:packed')).toBe(true);
    expect(vgnPacked.tagKeys.has('Camera view:randomview')).toBe(true);
    expect(vgnPacked.tagKeys.has('Success criterion:gsr')).toBe(true);
    expect(vgnPacked.tagKeys.has('Evidence grade:B')).toBe(true);
    expect(vgnPacked.value).toBe(80);
  });
  test('measurement-scope tokens (inference-time) are categorized + humanized', () => {
    const lat = recs.find(r => r.metricId === 'latency');
    expect(lat.tags.find(t => t.value === 'inference-time')).toMatchObject({ cat: 'Measurement scope', label: 'Inference Time' });
  });
  test('defensive on empty input', () => {
    expect(buildResultRecords(null)).toEqual([]);
    expect(buildResultRecords({})).toEqual([]);
  });
});

describe('buildResultRecords — full `results` set (comparable AND uncomparable)', () => {
  const BENCH_RESULTS = {
    leaderboards: {},           // present but empty; `results` must take precedence
    results: [
      { method: 'AnyGrasp', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
        value: 85, condition: 'packed', comparable: true, grade: 'B', paper_id: 'any',
        value_str: '85', table_caption: 'Table 1' },
      { method: 'GraspQP', metric_id: null, metric_label: 'Entropy (H)', metric_raw: 'entropy (H)',
        value: 2.3, unit: 'bits', condition: null, comparable: false, grade: 'C', paper_id: 'graspqp',
        value_str: '2.3', table_caption: 'Table 4: grasp diversity', page: 7 },
    ],
  };
  const recs = buildResultRecords(BENCH_RESULTS);
  test('keeps every extracted result, comparable or not', () => {
    expect(recs).toHaveLength(2);
    expect(recs.map(r => r.method).sort()).toEqual(['AnyGrasp', 'GraspQP']);
  });
  test('an uncomparable metric is a first-class, filterable row labeled by its raw header', () => {
    const ent = recs.find(r => r.method === 'GraspQP');
    expect(ent.metric).toBe('Entropy (H)');
    expect(ent.comparable).toBe(false);
    expect(ent.value).toBe(2.3);
    // it becomes its own Metric facet option (value falls back to the label when metric_id is null)
    expect(ent.tagKeys.has('Metric:Entropy (H)')).toBe(true);
    expect(ent.tagKeys.has('Evidence grade:C')).toBe(true);
    // provenance carried for the source drawer
    expect(ent.sources[0]).toMatchObject({ paper: 'graspqp', table_caption: 'Table 4: grasp diversity', page: 7 });
  });
  test('recognized metrics still group under their metric_id facet', () => {
    const sr = recs.find(r => r.method === 'AnyGrasp');
    expect(sr.tagKeys.has('Metric:success_rate')).toBe(true);
    expect(sr.comparable).toBe(true);
  });
});

describe('results path carries the protocol axes a researcher needs', () => {
  const BENCH2 = {
    results: [
      { method: 'AnyGrasp', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
        value: 85, value_str: '85%', unit: '%', condition: 'packed', comparable: true,
        grade: 'A', n_reports: 2, paper_id: 'any', dataset_id: 'ycb', is_own_method: true,
        method_resolved: true },
      { method: 'SomeRawName', metric_id: null, metric_label: 'Torque (Nm)', value: 1.2,
        condition: null, comparable: false, grade: 'C', paper_id: 'p2',
        is_own_method: false, method_resolved: false },
    ],
  };
  const recs = buildResultRecords(BENCH2);
  test('dataset + reported-by become filter facets; value_str/unit/nReports carried', () => {
    const a = recs.find(r => r.method === 'AnyGrasp');
    expect(a.tagKeys.has('Dataset:ycb')).toBe(true);
    expect(a.tagKeys.has('Reported by:self')).toBe(true);
    expect(a.valueStr).toBe('85%');
    expect(a.unit).toBe('%');
    expect(a.nReports).toBe(2);          // corroborated grade joined from cross-validation
    expect(a.grade).toBe('A');
  });
  test('unresolved raw method names are flagged, third-party reporting tagged', () => {
    const b = recs.find(r => r.method === 'SomeRawName');
    expect(b.methodResolved).toBe(false);
    expect(b.tagKeys.has('Reported by:third-party')).toBe(true);
  });
});

describe('tagKeysFromCellKey — copilot deep-link -> filter selection', () => {
  test('splits a leaderboard cell key into Metric + protocol tag keys', () => {
    expect(tagKeysFromCellKey('success_rate||packed:randomview:gsr')).toEqual([
      'Metric:success_rate', 'Scene:packed', 'Camera view:randomview', 'Success criterion:gsr',
    ]);
    expect(tagKeysFromCellKey('latency')).toEqual(['Metric:latency']);
    expect(tagKeysFromCellKey('')).toEqual([]);
  });
});

describe('tagFacets with a selection — counts conditioned on OTHER categories', () => {
  const recs = buildResultRecords(BENCH);
  test("selecting a Scene narrows other categories' counts but not Scene's own", () => {
    const sel = new Set([tagKey('Scene', 'pile')]);          // only AnyGrasp is pile
    const facets = tagFacets(recs, sel);
    const method = facets.find(f => f.category === 'Method');
    // Method counts are conditioned on Scene:pile -> only AnyGrasp has results
    expect(method.tags.find(t => t.value === 'AnyGrasp').count).toBe(1);
    expect(method.tags.find(t => t.value === 'VGN').count).toBe(0);
    // Scene's own counts are NOT self-constrained (its siblings stay pickable)
    const scene = facets.find(f => f.category === 'Scene');
    expect(scene.tags.find(t => t.value === 'packed').count).toBeGreaterThan(0);
  });
});

describe('tagFacets', () => {
  const facets = tagFacets(buildResultRecords(BENCH));
  test('categories appear in TAG_CATEGORY_ORDER, Method first', () => {
    expect(facets[0].category).toBe('Method');
    const cats = facets.map(f => f.category);
    const order = cats.map(c => TAG_CATEGORY_ORDER.indexOf(c));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  test('counts reflect the full record set', () => {
    const metric = facets.find(f => f.category === 'Metric');
    expect(metric.tags.find(t => t.value === 'success_rate').count).toBe(3);
    expect(metric.tags.find(t => t.value === 'latency').count).toBe(1);
    const scene = facets.find(f => f.category === 'Scene');
    expect(scene.tags.find(t => t.value === 'packed').count).toBe(2);
  });
  test('Method facet lists every distinct method with its result count', () => {
    const method = facets.find(f => f.category === 'Method');
    expect(method.tags.map(t => t.value).sort()).toEqual(['AnyGrasp', 'GIGA', 'VGN']);
    expect(method.tags.find(t => t.value === 'VGN').count).toBe(2); // packed + latency
    expect(method.tags.find(t => t.value === 'GIGA').count).toBe(1);
  });
});

describe('filterByTags — AND across categories, OR within', () => {
  const recs = buildResultRecords(BENCH);
  test('empty selection returns everything', () => {
    expect(filterByTags(recs, new Set())).toHaveLength(4);
  });
  test('a single tag returns every record with it', () => {
    expect(filterByTags(recs, new Set([tagKey('Scene', 'packed')])).map(r => r.method).sort())
      .toEqual(['GIGA', 'VGN']);
  });
  test('two tags in DIFFERENT categories require BOTH (AND)', () => {
    const out = filterByTags(recs, new Set([tagKey('Scene', 'packed'), tagKey('Camera view', 'randomview')]));
    expect(out.map(r => r.method).sort()).toEqual(['GIGA', 'VGN']);
    // a metric+scene combo that no record satisfies -> empty
    expect(filterByTags(recs, new Set([tagKey('Metric', 'latency'), tagKey('Scene', 'packed')]))).toHaveLength(0);
  });
  test('two tags in the SAME category are OR', () => {
    const out = filterByTags(recs, new Set([tagKey('Scene', 'packed'), tagKey('Scene', 'pile')]));
    expect(out.map(r => r.method).sort()).toEqual(['AnyGrasp', 'GIGA', 'VGN']);
  });
  test('filtering by Method returns only that method\'s records', () => {
    const out = filterByTags(recs, new Set([tagKey('Method', 'VGN')]));
    expect(out).toHaveLength(2);
    expect(out.every(r => r.method === 'VGN')).toBe(true);
  });
});
