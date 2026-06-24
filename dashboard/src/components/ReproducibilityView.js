import React, { useState } from 'react';
import { CELL_KEY } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * ReproducibilityView (Phase 2a — UNIT B1) — "Agreement Row" dumbbell design.
 *
 * The default landing view of the Benchmarks page. It reframes the cross-paper
 * data to answer "what replicates vs what is contested" — ONE method across
 * papers — built on benchmarkData.cross_validations:
 *
 *   - CONSISTENT  = status === 'consistent'              (independently reproduced)
 *   - CONTESTED   = status === 'high_variance'           (papers disagree)
 *                 | status === 'different_setup'         (conditions not comparable)
 *
 * A (method × metric × condition) only appears in those two buckets when 2+
 * independent papers measured it. Single-paper leaderboard cells (not yet
 * reproduced) are FOLDED into the SAME row component with an ○ "single source"
 * verdict — so the whole landing speaks ONE visual language.
 *
 * THE MARK is a Cleveland DUMBBELL, not a forest plot: one dot per paper on a
 * per-metric shared x-axis, plus a connecting segment between the lowest and
 * highest dot whose LENGTH + COLOR encode disagreement (short+teal = agree,
 * long+amber = contested). No mean diamond — only a thin neutral mean tick.
 * Higher-grade / higher-confidence papers get bolder, more opaque dots.
 *
 * Each row is CLICKABLE: it opens the cell-scoped Comparisons drill-down for
 * that exact (metric × condition) cell.
 * ────────────────────────────────────────────────────────────────────────── */

function gradeClass(grade) {
  if (!grade) return '';
  const g = grade.toUpperCase();
  if (g === 'A') return 'benchmarks-grade-a';
  if (g === 'B') return 'benchmarks-grade-b';
  return 'benchmarks-grade-c';
}

// Per-verdict glyph + label + CSS modifier. Color is ALWAYS paired with a
// symbol so the verdict survives grayscale and colorblindness.
//   ✓  agree      (consistent)         — teal/green
//   ⚠  contested  (papers disagree)    — amber
//   ○  single source (not yet contested) — slate/gray
const VERDICT = {
  agree:    { glyph: '✓', cls: 'agree' },
  contested:{ glyph: '⚠', cls: 'contested' },
  single:   { glyph: '○', cls: 'single' },
};

// Map a v2 cross_validation status onto a verdict key.
function verdictForStatus(status) {
  return status === 'consistent' ? 'agree' : 'contested';
}

// Coerce a report's value to a finite number, or null.
function numVal(r) {
  const n = typeof r.value === 'number' ? r.value : parseFloat(r.value);
  return Number.isNaN(n) ? null : n;
}

// Plain-language spread label from the per-paper values. We deliberately speak
// in the metric's own points ("agree ±2 pts" / "differ 27 pts"), NOT "CV 4%" —
// cv is kept only as an internal sort key on the row data.
function spreadLabel(vals, verdict) {
  if (!vals || vals.length < 2) return 'single source — not yet contested';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const range = hi - lo;
  const half = range / 2;
  const fmt = (n) => {
    const r = Math.round(n * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  if (verdict === 'agree') return `agree ±${fmt(half)} pts`;
  return `differ ${fmt(range)} pts`;
}

// A single per-paper report value, with optional crop provenance.
function ReportRow({ r }) {
  const [showCrop, setShowCrop] = useState(false);
  const hasCrop = Boolean(r.crop_image);
  return (
    <div className="benchmarks-cv-report">
      <div className="benchmarks-cv-report-line">
        <span className="benchmarks-cv-paper">{(r.paper || '').replace(/-/g, ' ')}</span>
        <span className="benchmarks-cv-value">
          {r.value_str || r.value}
          {r.condition ? <em className="benchmarks-cv-condition"> ({r.condition})</em> : null}
        </span>
        {hasCrop && (
          <button
            type="button"
            className={`benchmarks-source-btn benchmarks-cv-source-btn${showCrop ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowCrop(s => !s); }}
            aria-expanded={showCrop}
          >
            ⊙ Source
          </button>
        )}
      </div>
      {showCrop && hasCrop && (
        <div className="benchmarks-cv-report-proof">
          {r.table_caption && (
            <div className="benchmarks-source-caption">{r.table_caption}</div>
          )}
          <img
            className="benchmarks-source-crop"
            src={r.crop_image}
            alt={`source table for ${(r.paper || '').replace(/-/g, ' ')}`}
          />
        </div>
      )}
    </div>
  );
}

// Per-entry source provenance (re-used from a leaderboard entry's `sources`),
// so a single-source number is still traceable to its exact table cell,
// caption, and crop on the landing view.
function EntrySource({ entry }) {
  const [show, setShow] = useState(false);
  if (!entry.sources || entry.sources.length === 0) return null;
  return (
    <span className="benchmarks-cv-entry-source" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`benchmarks-source-btn${show ? ' active' : ''}`}
        onClick={(e) => { e.stopPropagation(); setShow(s => !s); }}
        aria-expanded={show}
      >
        ⊙ Source
      </button>
      {show && (
        <div className="benchmarks-source-panel benchmarks-source-panel-inline">
          {entry.sources.map((src, si) => (
            <div key={si} className="benchmarks-source-item">
              <div className="benchmarks-source-meta">
                <span className="benchmarks-source-value-str">{src.value_str}</span>
                {src.extractor && (
                  <span className="benchmarks-source-extractor-badge">{src.extractor}</span>
                )}
                <span className="benchmarks-source-paper">{(src.paper || '').replace(/-/g, ' ')}</span>
                {src.page != null && <span className="benchmarks-source-page">p.{src.page}</span>}
              </div>
              {src.table_caption && (
                <div className="benchmarks-source-caption">{src.table_caption}</div>
              )}
              {src.crop_image ? (
                <img
                  className="benchmarks-source-crop"
                  src={src.crop_image}
                  alt={`source table for ${entry.method}`}
                />
              ) : (
                <div className="benchmarks-source-no-crop">table image not available yet</div>
              )}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// ── ONE uniform Agreement Row ─────────────────────────────────────────────────
// Renders consistent, contested, AND single-source results identically:
//   [verdict glyph] · method · condition · grade chip
//   · dumbbell mark · readable per-paper values (TEXT)
//   · headline value (mono, right-aligned) + plain-language spread label
//   · ⊙ source affordance (expands per-paper / per-source provenance)
// `row` is a normalized shape: { method, condition, grade, verdict, domain,
//   points:[{v,weight,label,grade,...}], headline, spread, reports?, entry? }.
function AgreementRow({ row, onOpenCell }) {
  const [showReports, setShowReports] = useState(false);
  const v = VERDICT[row.verdict] || VERDICT.single;
  const hasReports = row.reports && row.reports.length > 0;
  const hasEntrySource = row.entry && row.entry.sources && row.entry.sources.length > 0;
  const canExpand = hasReports;

  return (
    <div
      className={`benchmarks-agreement-row benchmarks-cv-card-clickable verdict-${v.cls}`}
      onClick={() => onOpenCell && row.cellKey && onOpenCell(row.cellKey)}
    >
      {/* leftmost scan column: the verdict glyph (redundant color + symbol) */}
      <span
        className={`benchmarks-agreement-verdict verdict-${v.cls}`}
        title={row.verdict === 'agree' ? 'papers agree' : row.verdict === 'contested' ? 'papers disagree' : 'single source — not yet contested'}
        aria-hidden="true"
      >
        {v.glyph}
      </span>

      {/* method · condition + grade chip (grade kept visually separate from verdict) */}
      <div className="benchmarks-agreement-label">
        <div className="benchmarks-agreement-method-line">
          <span className="benchmarks-cv-method">{row.method}</span>
          {row.condition && (
            <span className="benchmarks-agreement-cond">· {row.condition}</span>
          )}
          {row.grade && (
            <span className={`benchmarks-agreement-grade-chip ${gradeClass(row.grade)}`}>{row.grade}</span>
          )}
        </div>
      </div>

      {/* the readable per-paper value list (as TEXT) — numbers-forward, no chart */}
      <div className="benchmarks-agreement-mark">
        {row.points.length > 0 && (
          <div className="benchmarks-agreement-values" title="per-paper reported values">
            {row.points.map((p, j) => (
              <span key={j} className="benchmarks-agreement-value">
                {p.label}
                {j < row.points.length - 1 && <span className="benchmarks-agreement-value-sep"> · </span>}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* headline value + plain-language spread label (mono, right-aligned) */}
      <div className="benchmarks-agreement-stats">
        {row.headline != null && (
          <span className="benchmarks-agreement-headline">{row.headline}</span>
        )}
        <span className={`benchmarks-agreement-spread verdict-${v.cls}`}>{row.spread}</span>
        <span className="benchmarks-agreement-npapers">
          {row.nPapers} paper{row.nPapers !== 1 ? 's' : ''}
        </span>
      </div>

      {/* source affordance: expands per-paper provenance (reports) or, for a
          single-source row, the entry's own source panel inline */}
      <div className="benchmarks-agreement-source" onClick={(e) => e.stopPropagation()}>
        {canExpand && (
          <button
            type="button"
            className={`benchmarks-source-btn benchmarks-agreement-src-btn${showReports ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowReports(s => !s); }}
            aria-expanded={showReports}
          >
            ⊙ Source
          </button>
        )}
        {!canExpand && hasEntrySource && <EntrySource entry={row.entry} />}
      </div>

      {/* expandable per-paper provenance (paper · value_str · crop) */}
      {showReports && hasReports && (
        <div className="benchmarks-agreement-reports" onClick={(e) => e.stopPropagation()}>
          {row.reports.map((r, j) => (
            <ReportRow key={j} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

// Normalize a cross_validation into the uniform AgreementRow shape.
function rowFromCrossValidation(v) {
  const verdict = verdictForStatus(v.status);
  const reports = v.reports || [];
  const points = reports
    .map(r => {
      const n = numVal(r);
      if (n == null) return null;
      return { v: n, label: r.value_str || r.value };
    })
    .filter(Boolean);
  const vals = points.map(p => p.v);
  return {
    kind: 'cv',
    method: v.method,
    condition: v.condition,
    grade: v.grade,
    verdict,
    cellKey: CELL_KEY(v.metric_id, v.condition),
    metricLabel: v.metric_label || v.metric_id || 'metric',
    points,
    vals,
    mean: v.mean,
    headline: v.mean,
    spread: spreadLabel(vals, verdict),
    nPapers: v.n_papers != null ? v.n_papers : reports.length,
    reports,
    cv: typeof v.cv === 'number' ? v.cv : 0,
  };
}

// Normalize a single-method leaderboard cell into uniform AgreementRow shapes —
// one row per method entry, each an ○ "single source — not yet contested" row.
function rowsFromUnreproducedCell(cell, showMetric) {
  const condition = cell.condition || (showMetric ? '' : 'all conditions');
  return (cell.entries || []).map((e) => {
    const n = numVal(e);
    const points = n == null ? [] : [{ v: n, label: e.value_str || e.value }];
    return {
      kind: 'single',
      method: e.method,
      condition,
      grade: e.grade,
      verdict: 'single',
      cellKey: cell.key,
      metricLabel: cell.metric_label || cell.metric_id || 'metric',
      points,
      vals: n == null ? [] : [n],
      mean: n,
      headline: e.value,
      spread: 'single source — not yet contested',
      nPapers: 1,
      reports: null,
      entry: e,
      cv: -1, // sort single-source rows last within a metric group
    };
  });
}

// Group normalized rows by metric, compute a shared x-domain per group (padded
// ~5%), and sort by cv. Different metrics never share an axis.
function buildGroups(rows, sortDir) {
  const byMetric = new Map();
  for (const r of rows) {
    const key = r.metricLabel || 'metric';
    if (!byMetric.has(key)) byMetric.set(key, []);
    byMetric.get(key).push(r);
  }
  const groups = [];
  for (const [label, groupRows] of byMetric.entries()) {
    const allVals = groupRows.flatMap(r => r.vals);
    let lo = allVals.length ? Math.min(...allVals) : 0;
    let hi = allVals.length ? Math.max(...allVals) : 1;
    if (hi === lo) { hi = lo + 1; }
    const pad = (hi - lo) * 0.05;
    const domain = [lo - pad, hi + pad];
    const sorted = [...groupRows].sort((a, b) =>
      sortDir === 'asc' ? a.cv - b.cv : b.cv - a.cv
    );
    groups.push({ label, rows: sorted, domain });
  }
  return groups;
}

// One metric sub-group: a small metric sub-heading + its agreement rows, all
// sharing the group's x-domain. The sub-heading is suppressed when the whole
// domain has a single metric (stated once in the spine), to avoid duplication.
function MetricGroup({ group, onOpenCell, keyPrefix, showMetric }) {
  return (
    <div className="benchmarks-agreement-group">
      {showMetric && <div className="benchmarks-agreement-group-title">{group.label}</div>}
      <div className="benchmarks-agreement-rows">
        {group.rows.map((row, i) => (
          <AgreementRow
            key={`${keyPrefix}-${i}`}
            row={{ ...row, domain: group.domain }}
            onOpenCell={onOpenCell}
          />
        ))}
      </div>
    </div>
  );
}

export default function ReproducibilityView({
  crossValidations,
  totalCrossValidations,
  minConfidence,
  unreproducedCells = [],
  onOpenCell,
  showMetric = true,
}) {
  // Nothing extracted at all for this domain.
  if (totalCrossValidations === 0 && unreproducedCells.length === 0) {
    return (
      <div className="benchmarks-agreement-section benchmarks-reproducibility-section">
        <div className="benchmarks-empty">
          No cross-paper validations found in this domain.
        </div>
      </div>
    );
  }

  const consistent = crossValidations.filter(v => v.status === 'consistent');
  const contested  = crossValidations.filter(v => v.status !== 'consistent');

  // Normalize every bucket into the SAME uniform row shape.
  const consistentRows = consistent.map(rowFromCrossValidation);
  const contestedRows  = contested.map(rowFromCrossValidation);
  const singleRows     = unreproducedCells.flatMap(c => rowsFromUnreproducedCell(c, showMetric));

  // Group each bucket by metric (shared x-domain per metric group). Consistent
  // sorts tightest-first (cv asc); contested sorts most-disagreeing-first (cv desc).
  const consistentGroups = buildGroups(consistentRows, 'asc');
  const contestedGroups  = buildGroups(contestedRows, 'desc');
  const singleGroups     = buildGroups(singleRows, 'asc');

  // Everything filtered out by the confidence threshold (and no fallback cells).
  if (crossValidations.length === 0 && unreproducedCells.length === 0) {
    return (
      <div className="benchmarks-agreement-section benchmarks-reproducibility-section">
        <div className="benchmarks-empty">
          Nothing meets the {Math.round(minConfidence * 100)}% confidence threshold — pick a
          lower tier on the Evidence filter in the header (or &ldquo;All&rdquo;).
        </div>
      </div>
    );
  }

  return (
    <div className="benchmarks-agreement-section benchmarks-reproducibility-section">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="benchmarks-agreement-hero">
        <div className="benchmarks-agreement-hero-line">
          <strong className="benchmarks-agreement-hero-count">{consistent.length}</strong>
          {' '}results independently reproduced under matched conditions
          {contested.length > 0 && (
            <span className="benchmarks-agreement-hero-contested">
              {' '}· <strong>{contested.length}</strong> contested
            </span>
          )}
        </div>
        <p className="benchmarks-agreement-caption">
          One method across papers: consistent vs contested. Only a
          (method × metric × condition) measured by 2+ independent papers can be
          agreement-checked, because that is the one comparison the conditions sanction. Each row
          is a dumbbell — one dot per paper, a connector whose length and colour show how far the
          papers disagree. This is an agreement check, not a global rank. Click any row to compare
          within its cell.
        </p>
        {/* compact legend: verdict glyphs are redundant color + symbol */}
        <div className="benchmarks-agreement-legend" aria-hidden="true">
          <span className="benchmarks-agreement-legend-item verdict-agree">
            <span className="benchmarks-agreement-verdict verdict-agree">✓</span> papers agree
          </span>
          <span className="benchmarks-agreement-legend-item verdict-contested">
            <span className="benchmarks-agreement-verdict verdict-contested">⚠</span> papers disagree
          </span>
          <span className="benchmarks-agreement-legend-item verdict-single">
            <span className="benchmarks-agreement-verdict verdict-single">○</span> single source
          </span>
        </div>
      </div>

      {/* ── Consistent (reproduced) ──────────────────────────────────────── */}
      <section className="benchmarks-agreement-bucket benchmarks-agreement-consistent">
        <h3 className="benchmarks-agreement-bucket-title">Consistent</h3>
        <div className="benchmarks-agreement-bucket-sub">
          {consistent.length} replicated independently
        </div>
        {consistent.length === 0 ? (
          <div className="benchmarks-agreement-bucket-empty">
            No independently-reproduced results above the current confidence threshold.
          </div>
        ) : (
          <div className="benchmarks-agreement-table">
            {consistentGroups.map((group, gi) => (
              <MetricGroup
                key={`cg-${gi}`}
                group={group}
                onOpenCell={onOpenCell}
                keyPrefix={`c-${gi}`}
                showMetric={showMetric}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Contested (papers disagree / not comparable) ─────────────────── */}
      <section className="benchmarks-agreement-bucket benchmarks-agreement-contested">
        <h3 className="benchmarks-agreement-bucket-title">Contested</h3>
        <div className="benchmarks-agreement-bucket-sub">
          {contested.length} where papers disagree or conditions differ
        </div>
        {contested.length === 0 ? (
          <div className="benchmarks-agreement-bucket-empty">
            No contested results above the current confidence threshold.
          </div>
        ) : (
          <div className="benchmarks-agreement-table">
            {contestedGroups.map((group, gi) => (
              <MetricGroup
                key={`xg-${gi}`}
                group={group}
                onOpenCell={onOpenCell}
                keyPrefix={`x-${gi}`}
                showMetric={showMetric}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Single source (not yet contested) — SAME uniform row component ─── */}
      {singleRows.length > 0 && (
        <section className="benchmarks-agreement-bucket benchmarks-agreement-single">
          <h3 className="benchmarks-agreement-bucket-title">Single source</h3>
          <div className="benchmarks-agreement-bucket-sub">
            {singleRows.length} result{singleRows.length !== 1 ? 's' : ''} from a single paper — not yet contested; open one to compare within its conditions
          </div>
          <div className="benchmarks-agreement-table">
            {singleGroups.map((group, gi) => (
              <MetricGroup
                key={`sg-${gi}`}
                group={group}
                onOpenCell={onOpenCell}
                keyPrefix={`s-${gi}`}
                showMetric={showMetric}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
