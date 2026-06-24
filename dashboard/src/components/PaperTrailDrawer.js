import React, { useEffect } from 'react';
import ComparisonsView from './ComparisonsView';
import ReproducibilityCard from './ReproducibilityCard';
import CellDifferences from './CellDifferences';
import { cellAttributes } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * PaperTrailDrawer (presentational)
 *
 * A right-side drawer that opens when a cell is clicked. Three stacked parts:
 *   1) the cell comparison — REUSES ComparisonsView (head-to-head for 2 methods,
 *      within-cell rank for N). No `onBack` is passed (the drawer owns closing),
 *      and it NEVER renders a pooled mean across the cell's methods.
 *   2) one Reproducibility Card per method (record schema + replication tier +
 *      do-not-compare list).
 *   3) a provenance crop viewer — one figure per source that carries a crop
 *      image, with caption / paper / page deep-link.
 *
 * Closes on backdrop click, the × control, or the Escape key.
 * ────────────────────────────────────────────────────────────────────────── */

export default function PaperTrailDrawer({ cell, data, selectedPoint, onSelect, onClose, cellContext, methodsIndex }) {
  const attrs = (methodsIndex && cell) ? cellAttributes(cell, methodsIndex) : {};

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape' && onClose) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!cell) {
    return (
      <div className="benchmarks-drawer-root">
        <div className="benchmarks-drawer-backdrop" onClick={onClose} aria-hidden="true" />
        <aside className="benchmarks-papertrail-drawer" role="dialog" aria-modal="true">
          <button type="button" className="benchmarks-drawer-close" aria-label="Close" onClick={onClose}>×</button>
          <div className="benchmarks-empty">No cell selected.</div>
        </aside>
      </div>
    );
  }

  return (
    <div className="benchmarks-drawer-root">
      <div className="benchmarks-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="benchmarks-papertrail-drawer" role="dialog" aria-modal="true">
        <button type="button" className="benchmarks-drawer-close" aria-label="Close" onClick={onClose}>×</button>

        {/* 1) cell comparison — reused, NO pooled mean, no back button */}
        <ComparisonsView cell={cell} data={data} selectedPoint={selectedPoint} onSelect={onSelect} />

        {/* "Why they differ" — KG-enriched explanation (renders null without context) */}
        <CellDifferences cell={cell} cellContext={cellContext} />

        {/* 2) one Reproducibility Card per method */}
        <section className="benchmarks-papertrail-cards">
          {(cell?.entries || []).map((e) => (
            <ReproducibilityCard key={e.method} cell={cell} method={e.method} attributes={attrs[e.method]} />
          ))}
        </section>

        {/* 3) provenance crop viewer — one entry per source that has a crop */}
        <section className="benchmarks-papertrail-crops">
          {(cell?.entries || []).flatMap((e) =>
            (e.sources || []).map((src, si) => (
              src.crop_image ? (
                <figure className="benchmarks-papertrail-crop" key={`${e.method}-${si}`}>
                  <img src={src.crop_image} alt={`source table for ${e.method}`} />
                  <figcaption className="benchmarks-papertrail-crop-meta">
                    {src.table_caption ? <span className="benchmarks-papertrail-crop-caption">{src.table_caption}</span> : null}
                    <span className="benchmarks-papertrail-crop-paper">{(src.paper || '').replace(/-/g, ' ')}</span>
                    {src.page != null ? (
                      <a className="benchmarks-papertrail-pdflink" href={src.crop_image} target="_blank" rel="noreferrer">p.{src.page}</a>
                    ) : null}
                  </figcaption>
                </figure>
              ) : null
            ))
          )}
        </section>
      </aside>
    </div>
  );
}
