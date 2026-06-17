import React, { useState } from 'react';
import { CELL_KEY } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * ReproducibilityView (Phase 2a — renamed/evolved from AgreementView, UNIT B1)
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
 * independent papers measured it — that is the one comparison the conditions
 * sanction. The framing is reproducibility, never a global rank.
 *
 * Each reproducibility card is CLICKABLE: clicking it (or its method) opens the
 * cell-scoped Comparisons drill-down for that exact (metric × condition) cell.
 *
 * Cells that have leaderboard entries but no cross-validation yet (single-paper
 * / not-yet-reproduced numbers) are surfaced in a "Not yet reproduced" section
 * so they remain reachable from the landing view and can be drilled into.
 * ────────────────────────────────────────────────────────────────────────── */

function gradeClass(grade) {
  if (!grade) return '';
  const g = grade.toUpperCase();
  if (g === 'A') return 'benchmarks-grade-a';
  if (g === 'B') return 'benchmarks-grade-b';
  return 'benchmarks-grade-c';
}

// Display labels + CSS modifier for each v2 status. The consistent badge says
// "Replicated" (not "Consistent") so the single "Consistent" section heading
// stays unambiguous for assistive tech and queries.
const STATUS_META = {
  consistent:      { label: 'Replicated',                      cls: 'consistent' },
  high_variance:   { label: 'High variance',                   cls: 'high-variance' },
  different_setup: { label: 'Different setup (not comparable)', cls: 'different-setup' },
};

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
            Source
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
// so a not-yet-reproduced number is still traceable to its exact table cell,
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
        Source
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

// Coerce a report's value to a finite number, or null.
function numVal(r) {
  const n = typeof r.value === 'number' ? r.value : parseFloat(r.value);
  return Number.isNaN(n) ? null : n;
}

// Inline SVG forest strip for ONE entry, mapped onto a domain SHARED by its
// metric group so spread width reads as true agreement/disagreement: a faint
// axis line, a light min→max spread segment, a small dot per paper report, and
// a distinct diamond MEAN marker. Color (teal vs amber) is driven by status.
// Per-paper values are rendered as TEXT elsewhere in the row, not here — this
// strip is the at-a-glance visual only.
const FOREST_W = 180;
const FOREST_H = 22;
const FOREST_PAD = 6; // left/right inset so edge dots aren't clipped

function ForestStrip({ reports, mean, domain, tone }) {
  const [lo, hi] = domain;
  const span = hi - lo || 1;
  const x = (v) => FOREST_PAD + ((v - lo) / span) * (FOREST_W - 2 * FOREST_PAD);
  const cy = FOREST_H / 2;

  const vals = (reports || []).map(numVal).filter(v => v != null);
  const segMin = vals.length ? Math.min(...vals) : null;
  const segMax = vals.length ? Math.max(...vals) : null;
  const meanN = typeof mean === 'number' ? mean : parseFloat(mean);
  const hasMean = !Number.isNaN(meanN);

  return (
    <svg
      className={`benchmarks-forest-svg tone-${tone}`}
      width={FOREST_W}
      height={FOREST_H}
      viewBox={`0 0 ${FOREST_W} ${FOREST_H}`}
      role="presentation"
      aria-hidden="true"
    >
      {/* faint axis line */}
      <line
        className="benchmarks-forest-axis"
        x1={FOREST_PAD} y1={cy} x2={FOREST_W - FOREST_PAD} y2={cy}
      />
      {/* light min→max spread segment */}
      {segMin != null && segMax != null && segMax > segMin && (
        <line
          className="benchmarks-forest-segment"
          x1={x(segMin)} y1={cy} x2={x(segMax)} y2={cy}
        />
      )}
      {/* one dot per paper report */}
      {vals.map((v, i) => (
        <circle key={i} className="benchmarks-forest-dot" cx={x(v)} cy={cy} r={3} />
      ))}
      {/* mean marker — a filled diamond */}
      {hasMean && (
        <rect
          className="benchmarks-forest-mean"
          x={x(meanN) - 4} y={cy - 4}
          width={8} height={8}
          transform={`rotate(45 ${x(meanN)} ${cy})`}
        />
      )}
    </svg>
  );
}

// One reproducibility forest ROW: the per-paper spread for a (method × metric ×
// condition), mapped onto its metric group's shared x-domain. Clicking opens the
// cell-scoped comparison for its (metric × condition) cell.
//   left   = method · condition + status + grade badges
//   center = the forest strip + a compact per-paper value list (as TEXT)
//   right  = mean, CV%, N papers (as TEXT)
function ForestRow({ v, onOpenCell, domain, tone }) {
  const [showReports, setShowReports] = useState(false);
  const sm = STATUS_META[v.status] || { label: v.status, cls: 'different-setup' };
  const cellKey = CELL_KEY(v.metric_id, v.condition);
  const hasReports = v.reports && v.reports.length > 0;

  return (
    <div
      className={`benchmarks-forest-row benchmarks-cv-card-clickable ${sm.cls} tone-${tone}`}
      onClick={() => onOpenCell && onOpenCell(cellKey)}
    >
      {/* left: method · condition + badges */}
      <div className="benchmarks-forest-label">
        <div className="benchmarks-forest-method-line">
          <span className="benchmarks-cv-method">{v.method}</span>
          {v.condition && (
            <span className="benchmarks-forest-cond">· {v.condition}</span>
          )}
        </div>
        <div className="benchmarks-cv-badges">
          <span className={`benchmarks-cv-badge ${sm.cls}`}>{sm.label}</span>
          {v.grade && (
            <span className={`benchmarks-grade-badge ${gradeClass(v.grade)}`}>{v.grade}</span>
          )}
        </div>
      </div>

      {/* center: the forest strip + readable per-paper value list */}
      <div className="benchmarks-forest-plot">
        <ForestStrip reports={v.reports} mean={v.mean} domain={domain} tone={tone} />
        {hasReports && (
          <div className="benchmarks-forest-values" title="per-paper reported values">
            {v.reports.map((r, j) => (
              <span key={j} className="benchmarks-forest-value">
                {r.value_str || r.value}
                {j < v.reports.length - 1 && <span className="benchmarks-forest-value-sep"> · </span>}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* right: mean / CV% / N papers */}
      <div className="benchmarks-forest-stats">
        <span className="benchmarks-forest-mean-val">{v.mean}</span>
        <span className="benchmarks-forest-stat-sub">
          {v.cv !== undefined && <>CV {Math.round(v.cv * 100)}% · </>}
          {v.n_papers} paper{v.n_papers !== 1 ? 's' : ''}
        </span>
        {hasReports && (
          <button
            type="button"
            className={`benchmarks-source-btn benchmarks-forest-src-btn${showReports ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowReports(s => !s); }}
            aria-expanded={showReports}
          >
            Source
          </button>
        )}
      </div>

      {/* expandable per-paper provenance (paper · value_str · crop) */}
      {showReports && hasReports && (
        <div className="benchmarks-forest-reports" onClick={(e) => e.stopPropagation()}>
          {v.reports.map((r, j) => (
            <ReportRow key={j} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

// Group a section's entries by metric_label, compute a shared x-domain per group
// (padded ~5%), and sort rows by cv (ascending = tightest first, or descending =
// most-disagreeing first). Different metrics have different scales, so they never
// share an axis.
function buildMetricGroups(entries, sortDir) {
  const byMetric = new Map();
  for (const v of entries) {
    const key = v.metric_label || v.metric_id || 'metric';
    if (!byMetric.has(key)) byMetric.set(key, []);
    byMetric.get(key).push(v);
  }
  const groups = [];
  for (const [label, rows] of byMetric.entries()) {
    // Shared domain = [min, max] of every report value across the group.
    const allVals = rows.flatMap(v => (v.reports || []).map(numVal)).filter(x => x != null);
    let lo = allVals.length ? Math.min(...allVals) : 0;
    let hi = allVals.length ? Math.max(...allVals) : 1;
    if (hi === lo) { hi = lo + 1; }
    const pad = (hi - lo) * 0.05;
    const domain = [lo - pad, hi + pad];
    const cvOf = (v) => (typeof v.cv === 'number' ? v.cv : 0);
    const sorted = [...rows].sort((a, b) =>
      sortDir === 'asc' ? cvOf(a) - cvOf(b) : cvOf(b) - cvOf(a)
    );
    groups.push({ label, rows: sorted, domain });
  }
  return groups;
}

// One metric sub-group: a small metric sub-heading + its forest rows, all sharing
// the group's x-domain. The sub-heading is suppressed when the whole domain has a
// single metric (stated once in the spine), so the label isn't duplicated.
function ForestMetricGroup({ group, onOpenCell, tone, keyPrefix, showMetric }) {
  return (
    <div className="benchmarks-forest-group">
      {showMetric && <div className="benchmarks-forest-group-title">{group.label}</div>}
      <div className="benchmarks-forest-rows">
        {group.rows.map((v, i) => (
          <ForestRow
            key={`${keyPrefix}-${i}`}
            v={v}
            onOpenCell={onOpenCell}
            domain={group.domain}
            tone={tone}
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

  // Group each bucket by metric (shared x-domain per metric group). Consistent
  // sorts tightest-first (cv asc); contested sorts most-disagreeing-first (cv desc).
  const consistentGroups = buildMetricGroups(consistent, 'asc');
  const contestedGroups  = buildMetricGroups(contested, 'desc');

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
          (method × metric × condition) measured by 2+ independent papers appears in these
          buckets, because that is the one comparison the conditions sanction. This is an
          agreement check, not a global rank. Click any card to compare within its cell.
        </p>
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
          <div className="benchmarks-forest">
            {consistentGroups.map((group, gi) => (
              <ForestMetricGroup
                key={`cg-${gi}`}
                group={group}
                onOpenCell={onOpenCell}
                tone="consistent"
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
          <div className="benchmarks-forest">
            {contestedGroups.map((group, gi) => (
              <ForestMetricGroup
                key={`xg-${gi}`}
                group={group}
                onOpenCell={onOpenCell}
                tone="contested"
                keyPrefix={`x-${gi}`}
                showMetric={showMetric}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Not yet reproduced (single-paper leaderboard cells) ──────────── */}
      {unreproducedCells.length > 0 && (
        <section className="benchmarks-agreement-bucket benchmarks-agreement-unreproduced">
          <h3 className="benchmarks-agreement-bucket-title">Not yet reproduced</h3>
          <div className="benchmarks-agreement-bucket-sub">
            {unreproducedCells.length} cell{unreproducedCells.length !== 1 ? 's' : ''} with results from a single paper — open one to compare within its conditions
          </div>
          <div className="benchmarks-cv-grid">
            {unreproducedCells.map((cell) => (
              <div
                key={cell.key}
                className="benchmarks-cv-card benchmarks-cv-card-clickable benchmarks-cv-card-single"
                onClick={() => onOpenCell && onOpenCell(cell.key)}
              >
                <div className="benchmarks-cv-header">
                  <span className="benchmarks-cv-metric">
                    {showMetric && (cell.metric_label || cell.metric_id)}
                    {cell.condition
                      ? <span className="benchmarks-cv-cond-tag">{showMetric ? ' · ' : ''}{cell.condition}</span>
                      : (!showMetric ? <span className="benchmarks-cv-cond-tag">all conditions</span> : null)}
                  </span>
                  <span className="benchmarks-cv-badge different-setup">
                    {cell.n_methods} method{cell.n_methods !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="benchmarks-cv-single-methods">
                  {(cell.entries || []).map((e) => (
                    <span key={e.method} className="benchmarks-cv-single-method">
                      <span className="benchmarks-method">{e.method}</span>
                      <span className="benchmarks-score"> {e.value}</span>
                      {e.grade && (
                        <span className={`benchmarks-grade-badge ${gradeClass(e.grade)}`}>{e.grade}</span>
                      )}
                      <EntrySource entry={e} />
                    </span>
                  ))}
                </div>
                <div className="benchmarks-cv-drill">Compare within this cell →</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
