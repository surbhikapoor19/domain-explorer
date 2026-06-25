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

// Clamp a value into [lo, hi]. Used by the trust/ink rendering core.
function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

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

// Human-readable labels for condition facet tokens, so the UI NEVER shows raw
// extraction shorthand (e.g. "gsr"/"dr") to a researcher. The paper-native
// abbreviation is kept in parens for those who recognise it.
const FACET_LABELS = {
  gsr: 'Grasp success rate (GSR)',
  dr: 'Declutter rate (DR)',
  sr: 'Success rate (SR)',
  packed: 'Packed',
  pile: 'Pile',
  real: 'Real-world',
  isolated: 'Isolated',
  cluttered: 'Cluttered',
  sim: 'Simulation',
};

/**
 * humanizeFacet(token) -> a readable label for a condition facet token (scene or
 * success_criterion). Unknown tokens are title-cased; raw lowercase shorthand is
 * never shown to the user.
 */
export function humanizeFacet(token) {
  if (token == null) return '';
  const key = String(token).trim().toLowerCase();
  if (FACET_LABELS[key]) return FACET_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * humanizeCondition(condition) -> a readable label for a full (possibly compound)
 * condition string. Splits the colon-delimited tokens (e.g. "pile:gsr") and
 * humanizes each, so a Coverage row reads "Pile · Grasp success rate (GSR)"
 * instead of a raw "pile:gsr", and a measurement-scope like "inference-time"
 * renders as a proper Title — never masquerading as a scene token. Empty/null
 * conditions read as "All conditions".
 */
export function humanizeCondition(condition) {
  if (condition == null || String(condition).trim() === '') return 'All conditions';
  return String(condition)
    .split(':')
    .map((t) => humanizeFacet(t.trim()))
    .filter(Boolean)
    .join(' · ');
}

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

// ════════════════════════════════════════════════════════════════════════════
// REDESIGN ADDITIONS — trust-as-ink rendering core + reproducibility card.
// The honesty invariants: NO fake CI when trials are unknown; tier is a
// replication SIGNAL not a quality rank; unreported fields are never invented.
// ════════════════════════════════════════════════════════════════════════════

/**
 * wilsonInterval(successes, trials, z = 1.96) -> Wilson score interval for a
 * binomial proportion, as PROPORTIONS in [0,1]:
 *   { lower, center, upper, halfWidth }
 * or `null` when the inputs are invalid (trials unknown/non-positive,
 * successes missing/NaN, or successes > trials). NEVER fabricates a CI.
 */
export function wilsonInterval(successes, trials, z = 1.96) {
  if (trials == null || Number.isNaN(trials) || trials <= 0) return null;
  if (successes == null || Number.isNaN(successes)) return null;
  if (successes > trials) return null;

  const n = trials;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    lower: center - halfWidth,
    center,
    upper: center + halfWidth,
    halfWidth,
  };
}

/**
 * trustScore(entry, cell) -> composite trust in [0,1] for one leaderboard
 * entry, given its cell (which carries cell.facets.scene and
 * cell.facets.success_criterion). Returns
 *   { score, factors: { tightness, confound, corroboration }, hasInterval }
 *
 * - corroboration: how many distinct papers report it (capped at 3).
 * - confound: fraction of the two key facets (scene, success_criterion) that
 *   are actually pinned on the cell.
 * - tightness: 1 minus the (normalized) Wilson half-width when trials are
 *   known; a neutral 0.5 when trials are absent (no fake CI).
 * Each factor is floored before multiplying so any weak factor suppresses the
 * product; `factors` returns the RAW (un-floored) values.
 */
export function trustScore(entry, cell) {
  const e = entry || {};

  const nPapers =
    (Array.isArray(e.source_papers) && e.source_papers.length) ||
    e.n_reports ||
    1;
  const corroboration = Math.min(nPapers, 3) / 3;

  const facets = cell && cell.facets ? cell.facets : null;
  const KEY_FACETS = ['scene', 'success_criterion'];
  let confoundPresent = 0;
  if (facets) {
    for (const name of KEY_FACETS) {
      const v = facets[name];
      if (v != null && v !== '') confoundPresent += 1;
    }
  }
  const confound = confoundPresent / 2;

  let hasInterval = false;
  let tightness = 0.5; // neutral when no interval can be drawn
  if (typeof e.trials === 'number' && Number.isFinite(e.trials) && e.trials > 0) {
    const successes = Math.round((e.value / 100) * e.trials);
    const w = wilsonInterval(successes, e.trials);
    if (w) {
      hasInterval = true;
      tightness = 1 - clamp(w.halfWidth / 0.5, 0, 1);
    }
  }

  const tPrime = 0.3 + 0.7 * tightness;
  const cPrime = 0.4 + 0.6 * confound;
  const rPrime = 0.4 + 0.6 * corroboration;
  const score = clamp(tPrime * cPrime * rPrime, 0, 1);

  return {
    score,
    factors: { tightness, confound, corroboration },
    hasInterval,
  };
}

/**
 * inkWeight(trust) -> { opacity, desaturate } render weights mapped from a
 * trust score in [0,1]. More trust = more opaque ink and less grey.
 *   opacity    in [0.25, 1]   (0.25 + 0.75 * trust, clamped)
 *   desaturate in [0, 1]      (1 - trust, clamped) — fraction to mix the
 *                              verdict hue toward grey.
 */
export function inkWeight(trust) {
  return {
    opacity: clamp(0.25 + 0.75 * trust, 0.25, 1),
    desaturate: clamp(1 - trust, 0, 1),
  };
}

/**
 * reproducibilityCard(cell, method) -> the record-schema card for one
 * (cell, method) pair:
 *   { method, condition, metricLabel,
 *     factors: { object_set, gripper, arm, sensor, scene, success_criterion,
 *                trials, protocol },
 *     doNotCompare: string[], tier, tierLabel, nPapers, reports }
 *
 * Facets start from the cell and merge per-source condition tokens (so a packed
 * cell whose sources carry 'packed:gsr' yields success_criterion 'gsr'). Fields
 * we do not extract say 'not reported' and are never invented. `tier` is a
 * REPLICATION signal (reproduced / single-full / single-partial), not a quality
 * rank. `doNotCompare` lists every unreported key the reader must not compare on.
 */
export function reproducibilityCard(cell, method) {
  const c = cell || {};
  const entry = (c.entries || []).find((e) => e.method === method);
  const sources = (entry && entry.sources) || [];

  const cv = (c.reproducibility || []).find((r) => r.method === method) || null;
  const cvReports = (cv && cv.reports) || [];

  const reports = sources.length ? sources : cvReports;

  // Facets: start from the cell, then merge any per-source condition tokens.
  let scene = (c.facets && c.facets.scene) || null;
  let success_criterion = (c.facets && c.facets.success_criterion) || null;

  const mergeFromReports = (list) => {
    for (const r of list) {
      if (!r) continue;
      const decoded = parseConditionFacets(r.condition);
      if (scene == null && decoded.scene != null) scene = decoded.scene;
      if (success_criterion == null && decoded.success_criterion != null) {
        success_criterion = decoded.success_criterion;
      }
    }
  };
  mergeFromReports(reports);
  mergeFromReports(cvReports);

  // trials: a positive numeric trial count if any source carries one.
  let trials = 'not reported';
  for (const r of reports) {
    if (r && typeof r.trials === 'number' && Number.isFinite(r.trials) && r.trials > 0) {
      trials = r.trials;
      break;
    }
  }

  const factors = {
    object_set: 'not reported',
    gripper: 'not reported',
    arm: 'not reported',
    sensor: 'not reported',
    scene: scene || 'not reported',
    success_criterion: success_criterion || 'not reported',
    trials,
    protocol: 'not reported',
  };

  const nPapers =
    (cv && cv.n_papers) ||
    (entry && Array.isArray(entry.source_papers) && entry.source_papers.length) ||
    1;

  let tier;
  let tierLabel;
  if (cv && cv.status === 'consistent' && nPapers >= 2) {
    tier = 'reproduced';
    tierLabel = 'Reproduced (≥2 papers agree)';
  } else if (scene && success_criterion) {
    tier = 'single-full';
    tierLabel = 'Single paper, full protocol';
  } else {
    tier = 'single-partial';
    tierLabel = 'Single paper, partial protocol';
  }

  const DNC_KEYS = [
    'object_set',
    'gripper',
    'arm',
    'sensor',
    'scene',
    'success_criterion',
    'trials',
    'protocol',
  ];
  const doNotCompare = [];
  for (const key of DNC_KEYS) {
    if (factors[key] === 'not reported') {
      doNotCompare.push(`${key} not reported — do not compare across it`);
    }
  }

  return {
    method,
    condition: c.condition,
    metricLabel: c.metric_label,
    factors,
    doNotCompare,
    tier,
    tierLabel,
    nPapers,
    reports,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// KG-POWERED BENCHMARKS (P1) — the runtime method-attribute join. The Benchmarks
// page joins each leaderboard method to its methods.json record (KG/CSV) so the
// reader sees the typical gripper/sensor/backbone behind a benchmark cell. The
// honesty invariants: a name-join MISS yields "not reported" (never guessed),
// and facet lists exclude "not reported" values entirely.
// ════════════════════════════════════════════════════════════════════════════

/**
 * normalizeMethodName(name) -> a casefolded join key. Strips a leading run of
 * non-letter/non-digit characters (e.g. the "🤖 " emoji prefix carried by ~16%
 * of methods.json Names), then trims and lowercases. A leading letter is left
 * untouched; internal punctuation like "(VGN)" is preserved. Defensive on null.
 */
export function normalizeMethodName(name) {
  if (name == null) return '';
  return String(name)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
    .toLowerCase();
}

/**
 * buildMethodsIndex(methods) -> a Map keyed by normalizeMethodName(record.Name)
 * -> the record. Iterates `methods || []`; records without a Name are skipped
 * (they cannot be joined to a leaderboard method).
 */
export function buildMethodsIndex(methods) {
  const index = new Map();
  for (const record of methods || []) {
    if (!record || record.Name == null || record.Name === '') continue;
    index.set(normalizeMethodName(record.Name), record);
  }
  return index;
}

/**
 * cellAttributes(cell, methodsIndex) -> per-method attribute join, keyed by the
 * ORIGINAL method name in cell.entries. Each method maps to
 *   { gripper, end_effector, sensor, backbone, learning_paradigm }
 * where each field is { value, source }. A join miss (or an empty mapped field)
 * yields { value:'not reported', source:'not reported' } — NEVER guessed.
 * A present field is sourced as 'method-typical (KG/CSV)'.
 */
export function cellAttributes(cell, methodsIndex) {
  const NOT_REPORTED = { value: 'not reported', source: 'not reported' };
  const out = {};
  const methods = ((cell && cell.entries) || []).map((e) => e.method);

  for (const method of methods) {
    const rec = methodsIndex ? methodsIndex.get(normalizeMethodName(method)) : null;

    const field = (raw) => {
      if (rec == null || raw == null || raw === '') {
        return { value: 'not reported', source: 'not reported' };
      }
      return { value: raw, source: 'method-typical (KG/CSV)' };
    };

    if (rec == null) {
      out[method] = {
        gripper: { ...NOT_REPORTED },
        end_effector: { ...NOT_REPORTED },
        sensor: { ...NOT_REPORTED },
        backbone: { ...NOT_REPORTED },
        learning_paradigm: { ...NOT_REPORTED },
      };
      continue;
    }

    out[method] = {
      gripper: field(rec['Gripper Type'] || rec['End-effector Hardware']),
      end_effector: field(rec['End-effector Hardware']),
      sensor: field(rec['Input Data'] || rec['Sensor Complexity']),
      backbone: field(rec['Backbone']),
      learning_paradigm: field(rec['Learning Paradigm']),
    };
  }

  return out;
}

/**
 * cellDifferences(cellContext, cell, methodsIndex) -> the list of differing
 * attribute axes for a cell. Precomputed differences (cellContext[cell.key].
 * differences) win verbatim. Otherwise, with a methodsIndex and ≥2 methods, we
 * derive them from cellAttributes across the axes [gripper, sensor, backbone]:
 * an axis is included only when at least one method reports a real (non-"not
 * reported") value; `differ` is true when ≥2 distinct real values appear.
 */
export function cellDifferences(cellContext, cell, methodsIndex = null) {
  const ctx = cellContext && cellContext[cell.key];
  if (ctx && Array.isArray(ctx.differences)) return ctx.differences;

  if (!methodsIndex) return [];

  const methods = ((cell && cell.entries) || []).map((e) => e.method);
  if (methods.length < 2) return [];

  const attrs = cellAttributes(cell, methodsIndex);
  const diffs = [];

  for (const axis of ['gripper', 'sensor', 'backbone']) {
    const values = {};
    for (const method of methods) {
      values[method] = attrs[method][axis].value;
    }
    const real = Array.from(
      new Set(Object.values(values).filter((v) => v !== 'not reported'))
    );
    if (real.length >= 1) {
      diffs.push({
        axis,
        values,
        differ: real.length >= 2,
        source: 'method-typical (KG/CSV)',
      });
    }
  }

  return diffs;
}

/**
 * facetCounts(cells, methodsIndex) -> facet -> [{value, count}] for the
 * Benchmarks page filter rail. Condition facets (scene / success_criterion) and
 * the metric label are counted once per cell; method-attribute facets (gripper /
 * sensor / learning_paradigm) count each DISTINCT value once per cell. Null,
 * empty, and "not reported" values never appear in any facet list.
 */
export function facetCounts(cells, methodsIndex) {
  const maps = {
    scene: new Map(),
    success_criterion: new Map(),
    metric: new Map(),
    gripper: new Map(),
    sensor: new Map(),
    learning_paradigm: new Map(),
  };

  const bump = (map, value) => {
    if (value == null || value === '' || value === 'not reported') return;
    map.set(value, (map.get(value) || 0) + 1);
  };

  for (const cell of cells || []) {
    bump(maps.scene, cell.facets && cell.facets.scene);
    bump(maps.success_criterion, cell.facets && cell.facets.success_criterion);
    bump(maps.metric, cell.metric_label);

    const attrs = cellAttributes(cell, methodsIndex);
    const methods = ((cell && cell.entries) || []).map((e) => e.method);

    for (const axis of ['gripper', 'sensor', 'learning_paradigm']) {
      const distinct = new Set();
      for (const method of methods) {
        const v = attrs[method][axis].value;
        if (v != null && v !== '' && v !== 'not reported') distinct.add(v);
      }
      for (const v of distinct) bump(maps[axis], v);
    }
  }

  const toList = (map) =>
    Array.from(map.entries()).map(([value, count]) => ({ value, count }));

  return {
    scene: toList(maps.scene),
    success_criterion: toList(maps.success_criterion),
    metric: toList(maps.metric),
    gripper: toList(maps.gripper),
    sensor: toList(maps.sensor),
    learning_paradigm: toList(maps.learning_paradigm),
  };
}

/**
 * filterCells(cells, selection, methodsIndex) -> the subset of `cells` matching
 * the selection. THE single source of truth for both the QueryComposer's live
 * counts and the page's visible results, so a bracket count can never disagree
 * with what actually shows. selection = { metricId?, scene?, success_criterion?,
 * gripper?, sensor?, learning_paradigm? }. A facet that isn't set doesn't narrow.
 */
export function filterCells(cells, selection, methodsIndex) {
  const sel = selection || {};
  let out = Array.isArray(cells) ? cells : [];
  if (sel.metricId) out = out.filter((c) => c.metric_id === sel.metricId);
  if (sel.scene) out = out.filter((c) => c.facets && c.facets.scene === sel.scene);
  if (sel.success_criterion) out = out.filter((c) => c.facets && c.facets.success_criterion === sel.success_criterion);
  const attrKeys = ['gripper', 'sensor', 'learning_paradigm'].filter((k) => sel[k]);
  if (attrKeys.length) {
    const idx = methodsIndex || new Map();
    out = out.filter((cell) => {
      const attrs = cellAttributes(cell, idx);
      return Object.values(attrs).some((m) => attrKeys.every((k) => m[k] && m[k].value === sel[k]));
    });
  }
  return out;
}

/** matchCells(benchmarkData, selection, methodsIndex) — filterCells over freshly built cells. */
export function matchCells(benchmarkData, selection, methodsIndex) {
  return filterCells(buildCells(benchmarkData), selection, methodsIndex);
}
