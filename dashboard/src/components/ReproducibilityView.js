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

// Render the reported per-paper spread as a tiny min..mean..max strip so the
// reproducibility card shows the agreement (or disagreement) at a glance.
function SpreadStrip({ reports, mean }) {
  const vals = (reports || [])
    .map(r => (typeof r.value === 'number' ? r.value : parseFloat(r.value)))
    .filter(v => !Number.isNaN(v));
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const meanPct = mean != null ? ((mean - min) / span) * 100 : 50;
  return (
    <div className="benchmarks-cv-spread" title={`Reported range ${min}–${max} across ${vals.length} papers`}>
      <span className="benchmarks-cv-spread-min">{min}</span>
      <span className="benchmarks-cv-spread-track">
        <span className="benchmarks-cv-spread-mean" style={{ left: `${Math.max(0, Math.min(100, meanPct))}%` }} />
      </span>
      <span className="benchmarks-cv-spread-max">{max}</span>
    </div>
  );
}

// One reproducibility card: the per-paper spread for a (method × metric × condition).
// Clicking opens the cell-scoped comparison for its (metric × condition) cell.
function ReproCard({ v, onOpenCell, showMetric }) {
  const sm = STATUS_META[v.status] || { label: v.status, cls: 'different-setup' };
  const cellKey = CELL_KEY(v.metric_id, v.condition);
  return (
    <div
      className={`benchmarks-cv-card benchmarks-cv-card-clickable ${sm.cls}`}
      onClick={() => onOpenCell && onOpenCell(cellKey)}
    >
      <div className="benchmarks-cv-header">
        <span className="benchmarks-cv-method">{v.method}</span>
        <div className="benchmarks-cv-badges">
          <span className={`benchmarks-cv-badge ${sm.cls}`}>{sm.label}</span>
          {v.grade && (
            <span className={`benchmarks-grade-badge ${gradeClass(v.grade)}`}>{v.grade}</span>
          )}
        </div>
      </div>
      <div className="benchmarks-cv-metric">
        {showMetric && (v.metric_label || v.metric_id)}
        {v.condition ? <span className="benchmarks-cv-cond-tag">{showMetric ? ' · ' : ''}{v.condition}</span> : null}
      </div>
      <div className="benchmarks-cv-stats">
        <span>Mean: <strong>{v.mean}</strong></span>
        {v.cv !== undefined && (
          <span>CV: <strong>{Math.round(v.cv * 100)}%</strong></span>
        )}
        <span>{v.n_papers} paper{v.n_papers !== 1 ? 's' : ''}</span>
      </div>
      <SpreadStrip reports={v.reports} mean={v.mean} />
      {v.reports && v.reports.length > 0 && (
        <div className="benchmarks-cv-reports">
          {v.reports.map((r, j) => (
            <ReportRow key={j} r={r} />
          ))}
        </div>
      )}
      <div className="benchmarks-cv-drill">Compare within this cell →</div>
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
          <div className="benchmarks-cv-grid">
            {consistent.map((v, i) => <ReproCard key={`c-${i}`} v={v} onOpenCell={onOpenCell} showMetric={showMetric} />)}
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
          <div className="benchmarks-cv-grid">
            {contested.map((v, i) => <ReproCard key={`x-${i}`} v={v} onOpenCell={onOpenCell} showMetric={showMetric} />)}
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
