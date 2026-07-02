// Benchmarks = a flat, tag-filterable view of the EXTRACTED data. No ranking, no
// charts — one record per (method × metric × protocol) extracted cell, carrying
// the tags we parsed (metric, scene, success-criterion, camera view, depth noise,
// object set, training regime, evidence grade). The filter rail is built from
// these tags; selecting tags narrows the set.
//
// Pure + unit-testable. Reuses humanizeFacet so tag labels match the rest of the app.
import { humanizeFacet } from './benchmark-cells';

const SCENE = new Set(['packed', 'pile', 'real', 'sim', 'isolated', 'cluttered']);
const CRIT = new Set(['gsr', 'dr', 'sr']);
const VIEW = new Set(['fixedview', 'randomview']);
const NOISE = new Set(['gammanoise', 'gaussnoise']);
const OBJSET = new Set(['egad', 'ycb', 'partnet']);
const RETRAIN = new Set(['noretrain']);

// Display order of the filter-rail categories. 'Method' is first: filtering by a
// specific method/paper is a primary entry point (the rail renders it as a
// searchable dropdown because there are many distinct methods).
export const TAG_CATEGORY_ORDER = [
  'Method', 'Metric', 'Scene', 'Success criterion', 'Camera view', 'Depth noise',
  'Object set', 'Training', 'Measurement scope', 'Evidence grade',
];

function tokenCategory(t) {
  if (SCENE.has(t)) return 'Scene';
  if (CRIT.has(t)) return 'Success criterion';
  if (VIEW.has(t)) return 'Camera view';
  if (NOISE.has(t)) return 'Depth noise';
  if (OBJSET.has(t)) return 'Object set';
  if (RETRAIN.has(t)) return 'Training';
  return 'Measurement scope'; // latency / inference-time / success-rate-k / …
}

// "inference-time" -> "Inference time"; "success-rate-k" -> "Success rate @ K".
function scopeLabel(t) {
  if (t === 'success-rate-k') return 'Success rate @ K';
  return t.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Shared: turn a (method, metricId, metricLabel, condition, grade) into the tag list
// + tagKeys that drive the filter rail. Metric tag VALUE = metricId when the metric
// is recognized (so all success-rate results group under one facet), else the raw
// label (so an uncomparable metric like "Entropy (H)" is still its own filter option).
function buildTags({ method, metricId, metricLabel, condition, grade }) {
  const tags = [
    { cat: 'Method', value: method, label: method },
    { cat: 'Metric', value: metricId || metricLabel, label: metricLabel },
  ];
  for (const t of (condition || '').split(':').filter(Boolean)) {
    const cat = tokenCategory(t);
    tags.push({ cat, value: t, label: cat === 'Measurement scope' ? scopeLabel(t) : humanizeFacet(t) });
  }
  if (grade) tags.push({ cat: 'Evidence grade', value: grade, label: `Grade ${grade}` });
  return tags;
}

/**
 * buildResultRecords(benchmarkData) -> one record per extracted result. Prefers the
 * full `results` array (EVERY extracted number, comparable or not — the Benchmarks
 * page is a filterable table, not a leaderboard). Falls back to flattening
 * `leaderboards` for older data that predates the `results` field.
 */
export function buildResultRecords(benchmarkData) {
  const results = benchmarkData && Array.isArray(benchmarkData.results) ? benchmarkData.results : null;
  const out = [];

  if (results && results.length) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const metricLabel = r.metric_label || r.metric_id || 'metric';
      const cond = r.condition || '';
      const grade = r.grade || null;
      const tags = buildTags({ method: r.method, metricId: r.metric_id, metricLabel, condition: cond, grade });
      out.push({
        id: `${r.paper_id}::${r.method}::${metricLabel}::${cond}::${i}`,
        method: r.method,
        metric: metricLabel,
        metricId: r.metric_id,
        value: r.value,
        unit: r.unit || null,
        grade,
        nReports: 1,
        comparable: r.comparable !== false,
        papers: r.paper_id ? [r.paper_id] : [],
        higherIsBetter: r.higher_is_better,
        condition: cond,
        sources: [{
          paper: r.paper_id, value_str: r.value_str, metric_raw: r.metric_raw,
          condition: r.condition, table_caption: r.table_caption, page: r.page,
          extractor: r.extractor, crop_image: r.crop_image,
        }],
        tags,
        tagKeys: new Set(tags.map(t => `${t.cat}:${t.value}`)),
      });
    }
    out.sort((a, b) => a.method.localeCompare(b.method) || a.metric.localeCompare(b.metric));
    return out;
  }

  // Fallback: flatten leaderboard entries (legacy data with no `results` field).
  const lbs = (benchmarkData && benchmarkData.leaderboards) || {};
  for (const key of Object.keys(lbs)) {
    const lb = lbs[key] || {};
    const metricLabel = lb.metric_label || lb.metric_id || 'metric';
    const cond = lb.condition || '';
    for (const e of (lb.entries || [])) {
      const tags = buildTags({ method: e.method, metricId: lb.metric_id, metricLabel, condition: cond, grade: e.grade });
      out.push({
        id: `${key}::${e.method}`,
        method: e.method,
        metric: metricLabel,
        metricId: lb.metric_id,
        value: e.value,
        best: e.best,
        grade: e.grade,
        nReports: e.n_reports,
        corroboration: e.corroboration,
        papers: e.source_papers || [],
        higherIsBetter: lb.higher_is_better,
        condition: cond,
        sources: e.sources || [],
        tags,
        tagKeys: new Set(tags.map(t => `${t.cat}:${t.value}`)),
      });
    }
  }
  out.sort((a, b) => a.method.localeCompare(b.method) || a.metric.localeCompare(b.metric));
  return out;
}

/**
 * tagFacets(records) -> [{category, tags:[{value,label,count}]}] in display order,
 * for the filter rail. Counts reflect the FULL record set (not the current filter),
 * so the rail is stable.
 */
export function tagFacets(records) {
  const cats = new Map(); // cat -> Map(value -> {value,label,count})
  for (const r of (records || [])) {
    for (const t of r.tags) {
      if (!cats.has(t.cat)) cats.set(t.cat, new Map());
      const m = cats.get(t.cat);
      if (!m.has(t.value)) m.set(t.value, { value: t.value, label: t.label, count: 0 });
      m.get(t.value).count += 1;
    }
  }
  const idx = (c) => { const i = TAG_CATEGORY_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  return [...cats.keys()].sort((a, b) => idx(a) - idx(b)).map(cat => ({
    category: cat,
    tags: [...cats.get(cat).values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  }));
}

export function tagKey(category, value) { return `${category}:${value}`; }

/**
 * filterByTags(records, selectedKeys) -> records matching the selection.
 * AND across categories, OR within a category (the standard faceted pattern):
 * selecting "Scene:packed" + "Camera view:randomview" + "Success criterion:gsr"
 * requires all three; selecting two scenes shows either scene. Empty selection
 * returns everything.
 */
export function filterByTags(records, selectedKeys) {
  const sel = [...(selectedKeys || [])];
  if (!sel.length) return records || [];
  const byCat = new Map();
  for (const k of sel) {
    const cat = k.slice(0, k.indexOf(':'));
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(k);
  }
  const groups = [...byCat.values()];
  return (records || []).filter(r => groups.every(keys => keys.some(k => r.tagKeys.has(k))));
}
