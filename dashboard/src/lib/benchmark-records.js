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
  'Method', 'Metric', 'Dataset', 'Scene', 'Success criterion', 'Camera view', 'Depth noise',
  'Object set', 'Training', 'Measurement scope', 'Reported by', 'Corroboration', 'Evidence grade',
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

// A Measurement-scope condition token is redundant when it's just re-stating the
// metric itself (e.g. condition "latency" on a metric already labeled "Latency
// (ms)") — that's a duplicate chip, not new information. Normalize away
// non-alphanumerics so "success-rate" matches "success_rate"/"Success Rate (%)".
// "success-rate-k" is kept even on a success_rate metric — it's additive (states
// K), not a restatement.
function normScope(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function isRedundantScope(token, metricId, metricLabel) {
  if (token === 'success-rate-k') return false;
  const nt = normScope(token);
  if (!nt) return false;
  const nid = normScope(metricId);
  const nlabel = normScope(metricLabel);
  return (!!nid && nid.includes(nt)) || (!!nlabel && nlabel.includes(nt));
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
    if (cat === 'Measurement scope' && isRedundantScope(t, metricId, metricLabel)) continue;
    tags.push({ cat, value: t, label: cat === 'Measurement scope' ? scopeLabel(t) : humanizeFacet(t) });
  }
  if (grade) tags.push({ cat: 'Evidence grade', value: grade, label: `Grade ${grade}` });
  return tags;
}

// A re-quoted/copied baseline is a distinct provenance concern from evidence grade
// (it's about WHERE the number came from, not how confident the extraction is) —
// surface it as its own filterable facet rather than only a card-level chip.
function isRequoted(corroboration) {
  return corroboration === 'caption_copied_baseline' || corroboration === 'identical_values_suspected_copy';
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
      // Protocol axes a robotics researcher needs that the condition tokens don't
      // carry: WHICH benchmark suite (dataset), and WHO reported the number (the
      // paper's own method vs. a baseline re-run/re-quote by another paper — the
      // single biggest bias axis in this literature).
      const dataset = r.dataset_id || r.dataset_raw || null;
      if (dataset) tags.push({ cat: 'Dataset', value: dataset, label: humanizeFacet(dataset) });
      if (typeof r.is_own_method === 'boolean') {
        tags.push(r.is_own_method
          ? { cat: 'Reported by', value: 'self', label: 'Self-reported' }
          : { cat: 'Reported by', value: 'third-party', label: 'Reported by another paper' });
      }
      if (isRequoted(r.corroboration)) {
        tags.push({ cat: 'Corroboration', value: 'requoted', label: 'Re-quoted baseline' });
      }
      out.push({
        id: `${r.paper_id}::${r.method}::${metricLabel}::${cond}::${i}`,
        method: r.method,
        methodResolved: r.method_resolved !== false,
        metric: metricLabel,
        metricId: r.metric_id,
        value: r.value,
        valueStr: r.value_str || '',
        unit: r.unit || null,
        grade,
        nReports: r.n_reports || 1,
        corroboration: r.corroboration || null,
        comparable: r.comparable !== false,
        papers: r.paper_id ? [r.paper_id] : [],
        higherIsBetter: r.higher_is_better,
        condition: cond,
        page: r.page != null ? r.page : null,
        sources: [{
          paper: r.paper_id, value_str: r.value_str, metric_raw: r.metric_raw,
          condition: r.condition, table_caption: r.table_caption, page: r.page,
          extractor: r.extractor, crop_image: r.crop_image,
        }],
        tags,
        tagKeys: new Set(tags.map(t => `${t.cat}:${t.value}`)),
      });
    }
    // Default order is evidence STRENGTH, not performance ranking — see
    // compareEvidenceStrength above.
    out.sort(compareEvidenceStrength);
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
      if (isRequoted(e.corroboration)) {
        tags.push({ cat: 'Corroboration', value: 'requoted', label: 'Re-quoted baseline' });
      }
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
  // Default order is evidence STRENGTH, not performance ranking — see
  // compareEvidenceStrength above.
  out.sort(compareEvidenceStrength);
  return out;
}

/**
 * tagFacets(records, selectedKeys?) -> [{category, tags:[{value,label,count}]}]
 * in display order, for the filter rail. Without a selection, counts are over the
 * full record set. With one, each category's counts are CONDITIONED on the
 * selections in the OTHER categories (standard faceted search): they answer
 * "if I also picked this, how many results would I get?" — so the rail never
 * offers a dead-end zero. Options of the whole corpus stay listed either way.
 */
export function tagFacets(records, selectedKeys) {
  const sel = [...(selectedKeys || [])];
  const byCat = new Map();
  for (const k of sel) {
    const cat = k.slice(0, k.indexOf(':'));
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(k);
  }
  // records matching every selected category EXCEPT `skipCat` (whose own selection
  // must not constrain its counts — else picking one option zeroes its siblings).
  const matchesOthers = (r, skipCat) => {
    for (const [cat, keys] of byCat) {
      if (cat === skipCat) continue;
      if (!keys.some(k => r.tagKeys.has(k))) return false;
    }
    return true;
  };

  const cats = new Map(); // cat -> Map(value -> {value,label,count})
  for (const r of (records || [])) {
    for (const t of r.tags) {
      if (!cats.has(t.cat)) cats.set(t.cat, new Map());
      const m = cats.get(t.cat);
      if (!m.has(t.value)) m.set(t.value, { value: t.value, label: t.label, count: 0 });
      if (!sel.length || matchesOthers(r, t.cat)) m.get(t.value).count += 1;
    }
  }
  const idx = (c) => { const i = TAG_CATEGORY_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  return [...cats.keys()].sort((a, b) => idx(a) - idx(b)).map(cat => ({
    category: cat,
    tags: [...cats.get(cat).values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  }));
}

// Default list order is EVIDENCE STRENGTH, NOT a performance ranking. A row whose
// method name resolves to a real corpus method sorts before one that doesn't
// (an unresolved name is usually a mis-parsed/non-corpus baseline, not a
// first-class result); within that, higher evidence grade (A > B > C, ungraded
// last) sorts first; ties break alphabetically by method, then by metric. This
// never reorders by VALUE — it says nothing about which method performs better.
const GRADE_RANK = { A: 0, B: 1, C: 2 };
function compareEvidenceStrength(a, b) {
  const aResolved = a.methodResolved !== false;
  const bResolved = b.methodResolved !== false;
  if (aResolved !== bResolved) return aResolved ? -1 : 1;
  const aGrade = a.grade in GRADE_RANK ? GRADE_RANK[a.grade] : 3;
  const bGrade = b.grade in GRADE_RANK ? GRADE_RANK[b.grade] : 3;
  if (aGrade !== bGrade) return aGrade - bGrade;
  return a.method.localeCompare(b.method) || a.metric.localeCompare(b.metric);
}

export function tagKey(category, value) { return `${category}:${value}`; }

/**
 * tagKeysFromCellKey(cellKey) -> tag keys for a copilot deep-link ref whose
 * cellKey is a leaderboard key ("metric_id||cond:tokens"). Lets the page apply a
 * pageRef as a real filter selection (Metric + each protocol token's category).
 */
export function tagKeysFromCellKey(cellKey) {
  const s = String(cellKey || '');
  if (!s) return [];
  const sep = s.indexOf('||');
  const metric = sep >= 0 ? s.slice(0, sep) : s;
  const cond = sep >= 0 ? s.slice(sep + 2) : '';
  const keys = [];
  if (metric) keys.push(tagKey('Metric', metric));
  for (const t of cond.split(':').filter(Boolean)) keys.push(tagKey(tokenCategory(t), t));
  return keys;
}

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
