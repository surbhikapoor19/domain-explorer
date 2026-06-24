import React from 'react';
import { buildCells, CELL_KEY, trustScore, inkWeight, reproducibilityCard } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * CoverageMatrix (Task 5 — Coverage gap-finder).
 *
 * The SAME cells the Agreement view renders, re-laid as a condition × metric
 * matrix so the EMPTY intersections (untested) read as whitespace/opportunity.
 * You only ever read DOWN one matched column — cross-cell comparison is
 * structurally impossible here. Below the grid, a robvis-style traffic-light
 * surfaces *reporting* gaps: which confound axes a paper did/didn't disclose.
 *
 * Honesty: an empty intersection is a GAP, never a zero; the traffic-light
 * marks a confound axis "missing" when the source didn't report it (from
 * reproducibilityCard). Pure presentational — no data mutation, no I/O.
 * ────────────────────────────────────────────────────────────────────────── */

// The confound axes (robvis columns), in fixed order.
const AXES = ['object_set', 'gripper', 'arm', 'sensor', 'scene', 'success_criterion', 'trials', 'protocol'];

export default function CoverageMatrix({ benchmarkData, conditionFilter = {}, onOpenCell }) {
  const allCells = buildCells(benchmarkData);

  // Friendly empty state — never crash on null/empty data.
  if (!allCells || allCells.length === 0) {
    return <div className="benchmarks-empty">No coverage data.</div>;
  }

  // Optional filtering (no-op for {}): narrow by metric / scene / success_criterion.
  const cells = allCells.filter((c) => {
    if (conditionFilter.metricId && c.metric_id !== conditionFilter.metricId) return false;
    if (conditionFilter.scene && (c.facets && c.facets.scene) !== conditionFilter.scene) return false;
    if (
      conditionFilter.success_criterion &&
      (c.facets && c.facets.success_criterion) !== conditionFilter.success_criterion
    ) {
      return false;
    }
    return true;
  });

  if (cells.length === 0) {
    return <div className="benchmarks-empty">No coverage data.</div>;
  }

  // Distinct metrics (first-seen order).
  const metrics = [];
  const seenMetrics = new Set();
  for (const c of cells) {
    if (!seenMetrics.has(c.metric_id)) {
      seenMetrics.add(c.metric_id);
      metrics.push({ metric_id: c.metric_id, metric_label: c.metric_label });
    }
  }

  // Distinct conditions (first-seen order).
  const conditions = [];
  const seenConditions = new Set();
  for (const c of cells) {
    const cond = c.condition == null ? '' : c.condition;
    if (!seenConditions.has(cond)) {
      seenConditions.add(cond);
      conditions.push(cond);
    }
  }

  // robvis rows: one per (cell, method) entry across all cells.
  const robvisRows = [];
  for (const cell of cells) {
    for (const entry of cell.entries || []) {
      robvisRows.push({ cell, method: entry.method });
    }
  }

  return (
    <div className="benchmarks-coverage-section">
      {/* ── Coverage matrix: condition rows × metric columns ──────────────── */}
      <div className="benchmarks-coverage-grid">
        {/* header row: leading corner cell + one head per metric */}
        <div className="benchmarks-coverage-row benchmarks-coverage-header">
          <div className="benchmarks-coverage-corner" />
          {metrics.map((metric) => (
            <div key={metric.metric_id} className="benchmarks-coverage-col-head">
              {metric.metric_label}
            </div>
          ))}
        </div>

        {conditions.map((condition) => (
          <div key={condition || '__all__'} className="benchmarks-coverage-row">
            <div className="benchmarks-coverage-row-head">{condition || 'all conditions'}</div>
            {metrics.map((metric) => {
              const cell = cells.find((c) => c.key === CELL_KEY(metric.metric_id, condition));
              if (cell) {
                return (
                  <button
                    key={metric.metric_id}
                    type="button"
                    className="benchmarks-coverage-cell filled"
                    data-cell-key={cell.key}
                    onClick={() => onOpenCell && onOpenCell(cell.key)}
                    title={`${metric.metric_label} · ${condition}`}
                  >
                    {/* micro dot-strip: one dot per entry, opacity = trust */}
                    {cell.entries.map((e, i) => {
                      const ink = inkWeight(trustScore(e, cell).score);
                      return (
                        <span
                          key={i}
                          className="benchmarks-coverage-dot"
                          style={{ opacity: ink.opacity }}
                        />
                      );
                    })}
                  </button>
                );
              }
              return (
                <div
                  key={metric.metric_id}
                  className="benchmarks-coverage-gap"
                  title="untested — opportunity to publish"
                >
                  untested
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* ── robvis traffic-light companion (reporting gaps) ───────────────── */}
      <div className="benchmarks-robvis">
        <h4 className="benchmarks-robvis-title">Reporting gaps — which confound axes were disclosed</h4>
        {robvisRows.map((row, ri) => {
          const card = reproducibilityCard(row.cell, row.method);
          return (
            <div key={ri} className="benchmarks-robvis-row">
              <span className="benchmarks-robvis-rowlabel">
                {row.method} · {row.cell.condition}
              </span>
              {AXES.map((axis) => (
                <span
                  key={axis}
                  className={`benchmarks-robvis-tile ${
                    card.factors[axis] === 'not reported' ? 'missing' : 'reported'
                  }`}
                  title={`${axis}: ${card.factors[axis]}`}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
