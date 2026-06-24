import React, { useState } from 'react';
import { humanizeFacet } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * ComparisonsView (Phase 2a)
 *
 * A CELL-SCOPED drill-down for ONE (metric × condition) cell. This is the
 * surface that MERGES the old Leaderboards + Head-to-Head tabs: every result
 * shown here lives inside the same cell, so the same metric AND the same
 * conditions hold for every row. It can therefore never read as a global rank.
 *
 *   - exactly 2 methods  -> a head-to-head with a delta/margin column, using
 *                           the cell.headToHead comparison row(s) when present
 *                           (winner / loser / winner_value / loser_value /
 *                           margin + crop_image provenance).
 *   - N methods          -> a within-cell ranking (the leaderboard, scoped),
 *                           each row badged with the cell facets.
 *
 * Every row is badged with the cell's scene + success_criterion facets, and a
 * one-line caption states the ranking is valid ONLY within this cell.
 * ────────────────────────────────────────────────────────────────────────── */

function gradeClass(grade) {
  if (!grade) return '';
  const g = grade.toUpperCase();
  if (g === 'A') return 'benchmarks-grade-a';
  if (g === 'B') return 'benchmarks-grade-b';
  return 'benchmarks-grade-c';
}

function cvLabel(cv, n_reports) {
  if (cv == null || (n_reports != null && n_reports < 2)) return '';
  return `${Math.round(cv * 100)}%`;
}

// The cell-facet badges (scene + criterion) — the canonical, human-readable
// statement of this cell's conditions. Rendered ONCE in the cell header so the
// scene/criterion tokens have a single, unambiguous home on the page.
function CellFacetBadges({ facets }) {
  if (!facets) return null;
  const hasAny = facets.scene || facets.success_criterion || (facets.raw || []).length > 0;
  if (!hasAny) return null;
  return (
    <span className="benchmarks-cell-facets">
      {facets.scene && (
        <span className="benchmarks-cell-facet benchmarks-cell-facet-scene">{humanizeFacet(facets.scene)}</span>
      )}
      {facets.success_criterion && (
        <span className="benchmarks-cell-facet benchmarks-cell-facet-criterion">{humanizeFacet(facets.success_criterion)}</span>
      )}
      {(facets.raw || []).map((r, i) => (
        <span key={i} className="benchmarks-cell-facet benchmarks-cell-facet-raw">{r}</span>
      ))}
    </span>
  );
}

// Per-row scoping marker: every comparison row is badged as belonging to the
// SAME cell (so it can never read as a global rank), but it points back to the
// header's facet badges rather than re-printing the tokens — keeping the page's
// scene/criterion wording in exactly one canonical place.
function RowScopeBadge({ facets }) {
  const parts = [];
  if (facets?.scene) parts.push(facets.scene);
  if (facets?.success_criterion) parts.push(facets.success_criterion);
  const title = parts.length
    ? `Scoped to this cell — ${parts.join(' / ')}`
    : 'Scoped to this cell';
  return (
    <span className="benchmarks-cell-facet benchmarks-row-scope" title={title}>
      same cell
    </span>
  );
}

// Provenance crop for a head-to-head comparison row.
function ComparisonProof({ cmp }) {
  const [show, setShow] = useState(false);
  const hasCrop = Boolean(cmp.crop_image);
  if (!hasCrop && !cmp.table_caption) return null;
  return (
    <div className="benchmarks-h2h-proof-wrap">
      <button
        type="button"
        className={`benchmarks-source-btn${show ? ' active' : ''}`}
        onClick={() => setShow(s => !s)}
        aria-expanded={show}
      >
        Source
      </button>
      {show && (
        <div className="benchmarks-cv-report-proof">
          {cmp.table_caption && (
            <div className="benchmarks-source-caption">{cmp.table_caption}</div>
          )}
          {hasCrop ? (
            <img
              className="benchmarks-source-crop"
              src={cmp.crop_image}
              alt={`source table for ${cmp.winner} vs ${cmp.loser}`}
            />
          ) : (
            <div className="benchmarks-source-no-crop">table image not available yet</div>
          )}
        </div>
      )}
    </div>
  );
}

// One per-entry source provenance panel (re-used from the leaderboard's `sources`).
function EntrySource({ entry }) {
  const [show, setShow] = useState(false);
  if (!entry.sources || entry.sources.length === 0) return null;
  return (
    <>
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
    </>
  );
}

export default function ComparisonsView({ cell, data, selectedPoint, onSelect, onBack }) {
  if (!cell) {
    return (
      <div className="benchmarks-comparisons-section">
        <div className="benchmarks-empty">Pick a cell from the spine or a result above to compare.</div>
      </div>
    );
  }

  const facets = cell.facets || {};
  const entries = cell.entries || [];
  const higherIsBetter = cell.higher_is_better !== false;

  // Rank the scoped entries (best first). The leaderboard entries are already
  // ordered best-first, but we sort defensively by value with direction.
  const ranked = [...entries].sort((a, b) =>
    higherIsBetter ? (b.value - a.value) : (a.value - b.value)
  );

  const selectMethod = (name) => {
    const match = (data || []).find(d => d.name === name);
    if (match && onSelect) onSelect(match);
  };

  // Whether the parsed facets fully account for the condition string. If there
  // is an unparsed remainder, we keep a small raw-condition tag so nothing is
  // hidden — but for cleanly-parsed cells the facet badges are the only home
  // for the scene/criterion tokens (one canonical place on the page).
  const facetsCoverCondition =
    !cell.condition ||
    Boolean(facets.scene) ||
    Boolean(facets.success_criterion) ||
    (facets.raw || []).length > 0;

  // Header shared by both layouts.
  const header = (
    <div className="benchmarks-cell-header">
      {onBack && (
        <button type="button" className="benchmarks-cell-back" onClick={onBack}>
          ← Back to all cells
        </button>
      )}
      <div className="benchmarks-cell-title-row">
        <h3 className="benchmarks-cell-title">
          {cell.metric_label || cell.metric_id}
          {!facetsCoverCondition && (
            <span className="benchmarks-cell-cond"> · {cell.condition}</span>
          )}
        </h3>
        <CellFacetBadges facets={facets} />
      </div>
      <p className="benchmarks-cell-caption">
        Ranking valid ONLY within this cell (same metric + conditions); do not generalize.
      </p>
    </div>
  );

  // ── Layout A: exactly 2 methods → head-to-head with a delta column. ─────────
  if (ranked.length === 2) {
    const [top, bottom] = ranked;
    // Prefer the explicit comparison row (carries the paper-stated margin + crop).
    const cmp = (cell.headToHead || []).find(
      c =>
        (c.winner === top.method && c.loser === bottom.method) ||
        (c.winner === bottom.method && c.loser === top.method)
    );

    const winnerName = cmp ? cmp.winner : top.method;
    const loserName = cmp ? cmp.loser : bottom.method;
    const winnerVal = cmp && cmp.winner_value != null ? cmp.winner_value : top.value;
    const loserVal = cmp && cmp.loser_value != null ? cmp.loser_value : bottom.value;
    const margin = cmp && cmp.margin != null
      ? cmp.margin
      : Math.abs((top.value || 0) - (bottom.value || 0));

    const winnerEntry = entries.find(e => e.method === winnerName) || top;
    const loserEntry = entries.find(e => e.method === loserName) || bottom;

    return (
      <div className="benchmarks-comparisons-section">
        {header}
        <div className="benchmarks-h2h-cell">
          <table className="benchmarks-table benchmarks-h2h-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Conditions</th>
                <th>Score</th>
                <th>Δ vs other <span className="chart-help" title="Margin between the two methods, as reported in the same paper / cell.">?</span></th>
                <th>Grade</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                className={`benchmarks-h2h-winner${selectedPoint?.name === winnerName ? ' benchmarks-selected' : ''}`}
                onClick={() => selectMethod(winnerName)}
              >
                <td className="benchmarks-method"><span className="benchmarks-h2h-name">{winnerName}</span> <span className="benchmarks-h2h-tag-win">winner</span></td>
                <td><RowScopeBadge facets={facets} /></td>
                <td className="benchmarks-score">{winnerVal}</td>
                <td className="benchmarks-net positive">+{Number(margin).toFixed(2).replace(/\.00$/, '')}</td>
                <td className="benchmarks-grade-cell">
                  {winnerEntry.grade && (
                    <span className={`benchmarks-grade-badge ${gradeClass(winnerEntry.grade)}`}>{winnerEntry.grade}</span>
                  )}
                </td>
                <td className="benchmarks-source-col" onClick={e => e.stopPropagation()}>
                  <EntrySource entry={winnerEntry} />
                </td>
              </tr>
              <tr
                className={`benchmarks-h2h-loser${selectedPoint?.name === loserName ? ' benchmarks-selected' : ''}`}
                onClick={() => selectMethod(loserName)}
              >
                <td className="benchmarks-method">{loserName}</td>
                <td><RowScopeBadge facets={facets} /></td>
                <td className="benchmarks-score">{loserVal}</td>
                <td className="benchmarks-net negative">—</td>
                <td className="benchmarks-grade-cell">
                  {loserEntry.grade && (
                    <span className={`benchmarks-grade-badge ${gradeClass(loserEntry.grade)}`}>{loserEntry.grade}</span>
                  )}
                </td>
                <td className="benchmarks-source-col" onClick={e => e.stopPropagation()}>
                  <EntrySource entry={loserEntry} />
                </td>
              </tr>
            </tbody>
          </table>
          {cmp && (
            <div className="benchmarks-h2h-provenance">
              <span className="benchmarks-h2h-provenance-line">
                Reported in the same table by {(cmp.paper || '').replace(/-/g, ' ')}:{' '}
                <strong>{cmp.winner_value_str || winnerVal}</strong>
                {' vs '}
                <strong>{cmp.loser_value_str || loserVal}</strong>
              </span>
              <ComparisonProof cmp={cmp} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Layout B: N methods (or 1) → within-cell ranking, facet-badged rows. ────
  return (
    <div className="benchmarks-comparisons-section">
      {header}
      {ranked.length <= 1 ? (
        <div className="benchmarks-empty benchmarks-cell-gap-note">
          Only one method has a reported number in this cell — there is nothing to compare it
          against yet. This is a coverage gap, not a ranking.
        </div>
      ) : null}
      <div className="benchmarks-table-container">
        <table className="benchmarks-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Method</th>
              <th>Conditions</th>
              <th>Score</th>
              <th>Grade</th>
              <th>CV%</th>
              <th>Reports</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((entry, i) => (
              <tr
                key={entry.method}
                className={[
                  i === 0 && ranked.length > 1 ? 'benchmarks-rank-1' : '',
                  selectedPoint?.name === entry.method ? 'benchmarks-selected' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => selectMethod(entry.method)}
              >
                <td className="benchmarks-rank">{i + 1}</td>
                <td className="benchmarks-method">{entry.method}</td>
                <td><RowScopeBadge facets={facets} /></td>
                <td className="benchmarks-score">{entry.value}</td>
                <td className="benchmarks-grade-cell">
                  {entry.grade && (
                    <span className={`benchmarks-grade-badge ${gradeClass(entry.grade)}`}>{entry.grade}</span>
                  )}
                </td>
                <td className="benchmarks-cv-cell">{cvLabel(entry.cv, entry.n_reports)}</td>
                <td className="benchmarks-reports">{entry.n_reports}</td>
                <td className="benchmarks-source-col" onClick={e => e.stopPropagation()}>
                  <EntrySource entry={entry} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
