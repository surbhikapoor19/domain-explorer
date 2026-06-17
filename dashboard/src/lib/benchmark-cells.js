/* ALIGNMENT CORE — the ONE shared, PURE module the Benchmarks page and the
 * copilot both consume. No React, no I/O. Every function takes benchmarkData
 * (the loaded benchmark-comparisons.json object) as an argument.
 *
 * The whole point: a copilot answer about a cell (e.g. "success on packed
 * clutter") references the EXACT SAME cell the page renders, and can hand the
 * UI a serializable deep-link via pageRef().
 *
 * Real data shape (confirmed against public/data-grasp-planning/
 * benchmark-comparisons.json):
 *   leaderboards: map "metric_id||condition" -> { metric_id, metric_label,
 *     condition, higher_is_better, entries:[{method,value,grade,n_reports,cv,
 *     source_papers,sources}] }   (separator is a literal double-pipe; an empty
 *     condition yields keys like "success_rate||")
 *   cross_validations: [{ method, metric_id, metric_label, condition, mean, cv,
 *     status:"consistent"|"high_variance"|"different_setup", grade, n_papers,
 *     reports:[{paper,value,value_str,condition}] }]
 *   comparisons: [{ winner, loser, metric_id, condition, winner_value,
 *     loser_value, margin, grade, confidence, paper, ... }]
 */

// The literal separator the leaderboards map uses between metric_id and condition.
const SEP = '||';

// ── Known token maps for condition-facet decode ──────────────────────────────
// Condition strings are colon-delimited token lists, e.g. "packed:gsr",
// "pile:dr", "real", "success-rate". We decode known tokens into structured
// facets; everything else falls into `raw`.
const SCENE_TOKENS = {
  pile: 'pile',
  packed: 'packed',
  real: 'real',
  isolated: 'isolated',
  cluttered: 'cluttered',
  sim: 'sim',
  simulation: 'sim',
};

const SUCCESS_CRITERION_TOKENS = {
  gsr: 'gsr', // grasp success rate
  dr: 'dr', // declutter rate
  sr: 'sr', // success rate
};

/**
 * CELL_KEY(metricId, condition) -> canonical cell id string in the SAME format
 * as the leaderboard map keys: `${metric_id}${SEP}${condition}`. A null/empty/
 * undefined condition still produces a stable key ending in the separator.
 */
export function CELL_KEY(metricId, condition) {
  const m = metricId == null ? '' : String(metricId);
  const c = condition == null ? '' : String(condition);
  return `${m}${SEP}${c}`;
}

/**
 * parseConditionFacets(condition) -> structured facets decoded from the
 * condition string tokens. Decodes a `scene` facet (pile/packed/real/...) and a
 * `success_criterion` facet (gsr/dr/...), driven by the known token maps above.
 * Unknown tokens go into `raw`. Defensive on null/empty/undefined.
 *
 * @returns {{ scene: ?string, success_criterion: ?string, raw: string[],
 *             tokens: string[] }}
 */
export function parseConditionFacets(condition) {
  const facets = {
    scene: null,
    success_criterion: null,
    raw: [],
    tokens: [],
  };
  if (condition == null) return facets;
  const str = String(condition).trim();
  if (str === '') return facets;

  // Tokens are separated by ':' (e.g. "packed:gsr"); be tolerant of stray
  // whitespace / empty segments.
  const tokens = str
    .split(':')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  facets.tokens = tokens;

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (facets.scene == null && SCENE_TOKENS[lower] !== undefined) {
      facets.scene = SCENE_TOKENS[lower];
    } else if (
      facets.success_criterion == null &&
      SUCCESS_CRITERION_TOKENS[lower] !== undefined
    ) {
      facets.success_criterion = SUCCESS_CRITERION_TOKENS[lower];
    } else {
      // Unknown token (or a duplicate of an already-filled facet): keep raw.
      facets.raw.push(tok);
    }
  }

  return facets;
}

// Count distinct values, ignoring null/undefined.
function distinctCount(values) {
  const s = new Set();
  for (const v of values) {
    if (v != null) s.add(v);
  }
  return s.size;
}

/**
 * buildCells(benchmarkData) -> array of merged Cell objects, one per
 * (metric x condition) that has any leaderboard data. Each cell merges the
 * leaderboard entries, matching cross_validations rows, and matching
 * comparisons rows into ONE object keyed by CELL_KEY.
 *
 * Cell = { key, metric_id, metric_label, condition, facets, higher_is_better,
 *          entries, reproducibility, headToHead, n_methods, n_papers }
 */
export function buildCells(benchmarkData) {
  if (!benchmarkData || typeof benchmarkData !== 'object') return [];

  const leaderboards = benchmarkData.leaderboards || {};
  const crossValidations = Array.isArray(benchmarkData.cross_validations)
    ? benchmarkData.cross_validations
    : [];
  const comparisons = Array.isArray(benchmarkData.comparisons)
    ? benchmarkData.comparisons
    : [];

  const cells = [];

  for (const lbKey of Object.keys(leaderboards)) {
    const lb = leaderboards[lbKey] || {};
    const metric_id = lb.metric_id;
    const condition = lb.condition == null ? '' : lb.condition;
    const entries = Array.isArray(lb.entries) ? lb.entries : [];

    // Canonical key — recomputed from the leaderboard's own metric_id/condition
    // so the cell key is always in the shared CELL_KEY format. (For real data
    // this equals lbKey; recomputing keeps a single source of truth.)
    const key = CELL_KEY(metric_id, condition);

    // reproducibility = cross_validations whose metric_id + condition match.
    const reproducibility = crossValidations.filter(
      (cv) => cv.metric_id === metric_id && (cv.condition == null ? '' : cv.condition) === condition
    );

    // headToHead = comparisons whose metric_id + condition match.
    const headToHead = comparisons.filter(
      (cmp) => cmp.metric_id === metric_id && (cmp.condition == null ? '' : cmp.condition) === condition
    );

    // n_methods = distinct methods across the leaderboard entries.
    const n_methods = distinctCount(entries.map((e) => e.method));

    // n_papers = distinct union of source_papers across entries.
    const paperSet = new Set();
    for (const e of entries) {
      const sp = Array.isArray(e.source_papers) ? e.source_papers : [];
      for (const p of sp) {
        if (p != null) paperSet.add(p);
      }
    }
    const n_papers = paperSet.size;

    cells.push({
      key,
      metric_id,
      metric_label: lb.metric_label,
      condition,
      facets: parseConditionFacets(condition),
      higher_is_better: lb.higher_is_better,
      entries,
      reproducibility,
      headToHead,
      n_methods,
      n_papers,
    });
  }

  return cells;
}

/**
 * reproducibilityFor(benchmarkData, method, metricId, condition) ->
 * { status, mean, cv, n_papers, grade } for the matching cross_validation row,
 * or null. The page Reproducibility view and the copilot MUST agree on this.
 */
export function reproducibilityFor(benchmarkData, method, metricId, condition) {
  if (!benchmarkData || !Array.isArray(benchmarkData.cross_validations)) return null;
  const cond = condition == null ? '' : String(condition);

  const row = benchmarkData.cross_validations.find(
    (cv) =>
      cv.method === method &&
      cv.metric_id === metricId &&
      (cv.condition == null ? '' : String(cv.condition)) === cond
  );

  if (!row) return null;

  return {
    status: row.status,
    mean: row.mean,
    cv: row.cv,
    n_papers: row.n_papers,
    grade: row.grade,
  };
}

// Which facet names we compare on (drives both `matched` filtering and the
// `differsBy` report). Kept in sync with parseConditionFacets' known facets.
const FACET_NAMES = ['scene', 'success_criterion'];

/**
 * findCells(benchmarkData, query) where
 *   query = { metricId?, facets?: { scene?, success_criterion?, ... }, methods?: [] }
 *
 * -> { matched: Cell[], nearest: [{ cell, differsBy: string[] }] }
 *
 *   matched  = cells satisfying ALL provided constraints.
 *   nearest  = if nothing matched, the closest cells with the list of facet
 *              names that differ. NEVER returns a looser invalid match as if it
 *              matched.
 */
export function findCells(benchmarkData, query) {
  const cells = buildCells(benchmarkData);
  const q = query || {};
  const wantMetric = q.metricId;
  const wantFacets = q.facets || {};
  const wantMethods = Array.isArray(q.methods) ? q.methods : [];

  // Only the facet keys the caller actually constrained on (and that are known).
  const constrainedFacets = FACET_NAMES.filter(
    (name) => wantFacets[name] != null && wantFacets[name] !== ''
  );

  const cellHasAllMethods = (cell) => {
    if (wantMethods.length === 0) return true;
    const present = new Set((cell.entries || []).map((e) => e.method));
    return wantMethods.every((m) => present.has(m));
  };

  const metricMatches = (cell) => wantMetric == null || cell.metric_id === wantMetric;

  const matched = cells.filter((cell) => {
    if (!metricMatches(cell)) return false;
    if (!cellHasAllMethods(cell)) return false;
    for (const name of constrainedFacets) {
      if (cell.facets[name] !== wantFacets[name]) return false;
    }
    return true;
  });

  let nearest = [];
  if (matched.length === 0) {
    // Candidate pool: cells that still satisfy the NON-facet constraints
    // (metric + methods) but differ on one or more facets. We never include a
    // cell as "nearest" unless it genuinely differs by at least one facet.
    const candidates = cells.filter(
      (cell) => metricMatches(cell) && cellHasAllMethods(cell)
    );

    nearest = candidates
      .map((cell) => {
        const differsBy = constrainedFacets.filter(
          (name) => cell.facets[name] !== wantFacets[name]
        );
        return { cell, differsBy };
      })
      .filter((n) => n.differsBy.length > 0)
      .sort((a, b) => a.differsBy.length - b.differsBy.length);
  }

  return { matched, nearest };
}

/**
 * coverageGaps(benchmarkData) -> cells with n_methods < 2 (whitespace /
 * under-studied conditions).
 */
export function coverageGaps(benchmarkData) {
  return buildCells(benchmarkData).filter((cell) => cell.n_methods < 2);
}

/**
 * pageRef(view, opts) where view = "reproducibility" | "comparisons" and
 * opts = { cellKey, facets } -> a plain JSON-serializable object
 * { view, cellKey, conditionFilter } that the copilot emits and the page
 * consumes to deep-link / pre-filter. The literal alignment handshake — keep it
 * serializable (no functions, no class instances).
 */
export function pageRef(view, opts) {
  const o = opts || {};
  const cellKey = o.cellKey == null ? null : String(o.cellKey);

  // conditionFilter is a plain object the page can use to pre-filter its
  // condition spine. Derive it from explicit facets when given, else decode
  // from the cellKey's condition portion.
  let conditionFilter = null;
  if (o.facets && typeof o.facets === 'object') {
    conditionFilter = {};
    for (const name of FACET_NAMES) {
      if (o.facets[name] != null && o.facets[name] !== '') {
        conditionFilter[name] = o.facets[name];
      }
    }
  } else if (cellKey != null && cellKey.indexOf(SEP) !== -1) {
    const condition = cellKey.slice(cellKey.indexOf(SEP) + SEP.length);
    const f = parseConditionFacets(condition);
    conditionFilter = {};
    for (const name of FACET_NAMES) {
      if (f[name] != null) conditionFilter[name] = f[name];
    }
  }

  return {
    view,
    cellKey,
    conditionFilter,
  };
}
