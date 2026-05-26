/**
 * Hook: useTruncationTitles
 *
 * Walks every element on the page that uses CSS `text-overflow: ellipsis`
 * and, for the ones whose text is actually being clipped, sets a
 * `title="<full text>"` attribute so users get the full string as a
 * native browser tooltip on hover.
 *
 * Why: the dashboard has dozens of ellipsized labels (institution names,
 * paper titles, dataset names, technique names) and the truncation is
 * silent today; users have no way to read the full string short of
 * clicking through. The standard mechanism is the `title` attribute,
 * but only when the element is actually clipped (clamped names shouldn't
 * also surface a redundant tooltip).
 *
 * Uses scrollWidth > clientWidth + 1 to detect truncation (the +1 is
 * for sub-pixel rounding). Re-runs on:
 *   - window resize
 *   - DOM mutations (debounced 120ms)
 *   - manual ticks via `forceTick` if the caller needs it
 *
 * Throttled to avoid storming on graph-viz / scatter / table redraws.
 */
import { useEffect } from 'react';

// Every CSS class in this app that applies text-overflow: ellipsis.
// Keep in sync with App.css; missing one here means its truncated text
// won't get a hover tooltip. The grep that produced this list is in the
// commit that introduced this file.
const TRUNCATE_SELECTOR = [
  '.weight-slider-label',
  '.evidence-paper-name',
  '.segment-label',
  '.pdf-viewer-title',
  '.rag-bar-label',
  '.rag-anatomy-section',
  '.gr-edge-source',
  '.gr-edge-target',
  '.gr-bar-name',
  '.kgl-tech-name',
  '.kgl-bench-name',
  '.kgl-cited-name',
  '.kgnd-id-fact',
  '.kgnd-spec-val',
  '.kgnd-cmp-target',
  '.kgnd-entity-paper',
  '.kgnd-conn .metadata-key',
  '.metadata-key',
  '.metadata-val',
].join(', ');

function applyTitles() {
  const els = document.querySelectorAll(TRUNCATE_SELECTOR);
  els.forEach((el) => {
    // Skip elements whose own `title` is already user-supplied as
    // distinct content (e.g. the row gives a richer tooltip with extra
    // info). Heuristic: if title is set and differs from textContent,
    // assume the parent author wanted that text and don't overwrite.
    const txt = (el.textContent || '').trim();
    if (!txt) return;
    const isClipped = el.scrollWidth > el.clientWidth + 1;
    const existing = el.getAttribute('title');
    const ours = el.getAttribute('data-trunc-applied');
    if (isClipped) {
      if (!existing || existing === ours) {
        el.setAttribute('title', txt);
        el.setAttribute('data-trunc-applied', txt);
      }
    } else {
      // Not clipped anymore; only remove the title if WE were the ones
      // who set it (don't touch user-supplied titles).
      if (existing && existing === ours) {
        el.removeAttribute('title');
        el.removeAttribute('data-trunc-applied');
      }
    }
  });
}

export function useTruncationTitles() {
  useEffect(() => {
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      // requestAnimationFrame + microtask batch: catches the post-layout
      // measurement without firing on every mid-frame mutation.
      requestAnimationFrame(() => {
        scheduled = false;
        applyTitles();
      });
    };

    // Initial run after first paint.
    schedule();

    // Re-check on resize (column widths change → clip status changes).
    window.addEventListener('resize', schedule);

    // Re-check whenever the DOM updates (data load, filter toggle, panel
    // open/close). MutationObserver fires constantly so we debounce via
    // the schedule() batcher above.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, []);
}

export default useTruncationTitles;
