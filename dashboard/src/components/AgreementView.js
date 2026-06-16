import React, { useState } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
 * AgreementView (UNIT B1)
 *
 * The default landing view of the Benchmarks page. It reframes the cross-paper
 * data to answer "what replicates vs what is contested", built ENTIRELY on
 * benchmarkData.cross_validations.
 *
 *   - CONSISTENT  = status === 'consistent'              (independently reproduced)
 *   - CONTESTED   = status === 'high_variance'           (papers disagree)
 *                 | status === 'different_setup'         (conditions not comparable)
 *
 * A (method × metric × condition) only appears here when 2+ independent papers
 * measured it — that is the one comparison the conditions sanction. The framing
 * is agreement / reproducibility, never a global rank.
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
            onClick={() => setShowCrop(s => !s)}
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

// One agreement card: the per-paper spread for a (method × metric × condition).
function AgreementCard({ v }) {
  const sm = STATUS_META[v.status] || { label: v.status, cls: 'different-setup' };
  return (
    <div className={`benchmarks-cv-card ${sm.cls}`}>
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
        {v.metric_label || v.metric_id}
        {v.condition ? <span className="benchmarks-cv-cond-tag"> · {v.condition}</span> : null}
      </div>
      <div className="benchmarks-cv-stats">
        <span>Mean: <strong>{v.mean}</strong></span>
        {v.cv !== undefined && (
          <span>CV: <strong>{Math.round(v.cv * 100)}%</strong></span>
        )}
        <span>{v.n_papers} paper{v.n_papers !== 1 ? 's' : ''}</span>
      </div>
      {v.reports && v.reports.length > 0 && (
        <div className="benchmarks-cv-reports">
          {v.reports.map((r, j) => (
            <ReportRow key={j} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgreementView({ crossValidations, totalCrossValidations, minConfidence }) {
  // Nothing extracted at all for this domain.
  if (totalCrossValidations === 0) {
    return (
      <div className="benchmarks-agreement-section">
        <div className="benchmarks-empty">
          No cross-paper validations found in this domain.
        </div>
      </div>
    );
  }

  // Everything filtered out by the confidence threshold.
  if (crossValidations.length === 0) {
    return (
      <div className="benchmarks-agreement-section">
        <div className="benchmarks-empty">
          Nothing meets the {Math.round(minConfidence * 100)}% confidence threshold — pick a
          lower tier on the Evidence filter in the header (or &ldquo;All&rdquo;).
        </div>
      </div>
    );
  }

  const consistent = crossValidations.filter(v => v.status === 'consistent');
  const contested  = crossValidations.filter(v => v.status !== 'consistent');

  return (
    <div className="benchmarks-agreement-section">

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
          Only a (method × metric × condition) measured by 2+ independent papers appears
          here, because that is the one comparison the conditions sanction. This is an
          agreement check, not a global rank.
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
            {consistent.map((v, i) => <AgreementCard key={`c-${i}`} v={v} />)}
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
            {contested.map((v, i) => <AgreementCard key={`x-${i}`} v={v} />)}
          </div>
        )}
      </section>
    </div>
  );
}
