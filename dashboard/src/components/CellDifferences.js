import React from 'react';
import { cellDifferences } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * CellDifferences (presentational) — the drawer's "Why they differ" section.
 *
 * Reads the precomputed cell_context to explain a disagreement:
 *   • source-tagged attribute differences (one row per differing axis),
 *   • technique-lineage (shared backbones + builds-on pairs),
 *   • citation stance between the methods' papers,
 *   • STATED outperforms claims, with the paper's own evidence text.
 *
 * HONESTY GUARD (pinned): HGT *predicted* outperforms are gated OFF. This
 * component NEVER renders a `kind === 'predicted'` entry, never emits a
 * `benchmarks-celldiff-predicted` class, and never leaks a predicted
 * confidence number or the word "predicted" into the DOM.
 * ────────────────────────────────────────────────────────────────────────── */

export default function CellDifferences({ cell, cellContext }) {
  const ctx = cellContext && cellContext[cell.key];
  if (!ctx) return null;

  const diffs = cellDifferences(cellContext, cell);

  const lineage = ctx.relations && ctx.relations.technique_lineage;
  const sharedBackbones = (lineage && lineage.shared_backbones) || [];
  const buildsOnPairs = (lineage && lineage.builds_on_pairs) || [];
  const hasLineage = sharedBackbones.length > 0 || buildsOnPairs.length > 0;

  const citations = (ctx.relations && ctx.relations.citations) || [];
  const statedOutperforms = ((ctx.relations && ctx.relations.outperforms) || [])
    .filter((o) => o.kind === 'stated');

  return (
    <div className="benchmarks-celldiff">
      <h4 className="benchmarks-celldiff-heading">Why they differ</h4>

      {/* attribute differences — one row per differing axis, chips source-tagged */}
      {(diffs || []).map((d, di) => (
        <div className="benchmarks-celldiff-axis" key={di}>
          <span className="benchmarks-celldiff-axis-label">{d.axis}</span>
          {Object.entries(d.values).map(([method, value]) => (
            <span className="benchmarks-celldiff-chip" data-source={d.source} key={method}>
              {method}: {value}
            </span>
          ))}
        </div>
      ))}

      {/* technique-lineage */}
      {hasLineage && (
        <div className="benchmarks-celldiff-lineage">
          {sharedBackbones.length > 0 && (
            <div className="benchmarks-celldiff-shared">Shared backbone: {sharedBackbones.join(', ')}</div>
          )}
          {buildsOnPairs.map(([a, b], pi) => (
            <div className="benchmarks-celldiff-buildson" key={pi}>{a} builds-on {b}</div>
          ))}
        </div>
      )}

      {/* citation stance */}
      {citations.map((c, ci) => (
        <div className="benchmarks-celldiff-stance" key={ci}>
          {c.from_paper} {String(c.stance).replace(/_/g, '-')} {c.to_paper}
        </div>
      ))}

      {/* STATED outperforms only — predicted entries are gated off */}
      {statedOutperforms.map((o, oi) => (
        <div className="benchmarks-celldiff-outperforms" key={oi}>
          {o.winner_paper} outperforms {o.loser_paper} — stated in paper: {o.evidence}
        </div>
      ))}
    </div>
  );
}
