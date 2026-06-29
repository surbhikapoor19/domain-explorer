import React, { useState, useEffect, useMemo, useRef } from 'react';
import Tooltip from './Tooltip';
import { loadBenchmarkComparisons } from '../lib/data-loader';
import { buildResultRecords, tagFacets, filterByTags, tagKey } from '../lib/benchmark-records';

// Results are paginated so the landing view isn't a 200+ card scroll.
const PAGE_SIZE = 30;

// Benchmarks = a flat, tag-filterable view of the EXTRACTED result data. No
// ranking, no charts — every number is shown with its full protocol (the tags we
// parsed) and its source. Pick tags to narrow: tags in different categories are
// AND-ed (e.g. Packed + Random camera + GSR = all three), tags in the same
// category are OR-ed.

const GRADE_TIP = {
  A: 'Grade A — corroborated by multiple independent papers',
  B: 'Grade B — a single solid source',
  C: 'Grade C — low-confidence / disputed extraction',
};

// The "?" explainer: HOW each number is graded, and WHY grade A is rare in this
// corpus (so a reader understands the B-dominance is honest, not a data defect).
const GRADE_EXPLAIN =
  'The grade measures how well-CORROBORATED a number is — NOT how good the method is.\n\n' +
  'A — the same method, on the same metric, under the same protocol, reported with consistent ' +
  'values by 2+ INDEPENDENT papers.\n' +
  'B — a single solid source. One paper reporting a number can only be a B (one paper is not corroboration).\n' +
  'C — low-confidence extraction, OR papers that report the same cell but DISAGREE (high variance).\n\n' +
  'Why A is rare here: grasp-planning benchmarks are not standardized. Most (method × metric × protocol) ' +
  'combinations are reported by only one paper (so they are B); papers frequently re-quote each other\'s ' +
  'baseline numbers rather than independently re-running them (re-quoting is not corroboration, so it cannot ' +
  'earn an A); and when two papers do re-run the same setup, their numbers often disagree (→ C). A mostly-B ' +
  'board is the honest picture of this literature — we do not fabricate agreement.';

function prettyPaper(p) {
  return String(p || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// A collapsible, optionally-searchable filter facet. Categories with many options
// (e.g. Method, with one entry per method/paper) get a search box + scrollable
// list so you can find one alphabetically or by typing; small categories render
// as a short open list. Selecting options is OR within a facet, AND across facets.
function FacetDropdown({ facet, selected, onToggle }) {
  const searchable = facet.tags.length > 8;
  const selCount = useMemo(
    () => facet.tags.reduce((n, t) => n + (selected.has(tagKey(facet.category, t.value)) ? 1 : 0), 0),
    [facet, selected]
  );
  // Open small facets (and any with an active selection) by default; collapse big
  // ones so the rail stays compact.
  const [open, setOpen] = useState(() => facet.tags.length <= 6 || selCount > 0);
  const [q, setQ] = useState('');

  const tags = useMemo(() => {
    let ts = facet.tags;
    if (searchable) ts = [...ts].sort((a, b) => a.label.localeCompare(b.label));
    const needle = q.trim().toLowerCase();
    if (needle) ts = ts.filter(t => t.label.toLowerCase().includes(needle));
    return ts;
  }, [facet.tags, searchable, q]);

  return (
    <div className="bmr-facet">
      <button type="button" className="bmr-facet-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="bmr-facet-chev" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="bmr-facet-name">{facet.category}</span>
        {selCount > 0 && <span className="bmr-facet-selcount">{selCount}</span>}
      </button>
      {open && (
        <div className="bmr-facet-body">
          {searchable && (
            <input
              type="text"
              className="bmr-facet-search"
              placeholder={`Search ${facet.category.toLowerCase()}…`}
              value={q}
              onChange={e => setQ(e.target.value)}
              aria-label={`Search ${facet.category}`}
            />
          )}
          <div className="bmr-facet-list">
            {tags.map(t => {
              const k = tagKey(facet.category, t.value);
              const on = selected.has(k);
              return (
                <button key={k} type="button" className={`bmr-opt ${on ? 'on' : ''}`} onClick={() => onToggle(k)} aria-pressed={on}>
                  <span className="bmr-opt-check" aria-hidden>{on ? '✓' : ''}</span>
                  <span className="bmr-opt-label" title={t.label}>{t.label}</span>
                  <span className="bmr-opt-count">{t.count}</span>
                </button>
              );
            })}
            {tags.length === 0 && <div className="bmr-facet-none">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Full-screen viewer for a source-table crop so the numbers are actually readable
// (the inline thumbnail on the card is too small). Fit-to-screen by default with a
// toggle to actual size; Esc or backdrop click closes.
function BenchmarkLightbox({ data, onClose }) {
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { setZoom(false); }, [data]);
  if (!data) return null;
  return (
    <div className="bmr-lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Source table for ${data.method}`}>
      <div className="bmr-lightbox-inner" onClick={e => e.stopPropagation()}>
        <div className="bmr-lightbox-bar">
          <span className="bmr-lightbox-title">{data.method}{data.caption ? ` — ${data.caption}` : ''}</span>
          <div className="bmr-lightbox-actions">
            <button type="button" onClick={() => setZoom(z => !z)}>{zoom ? 'Fit to screen' : 'Actual size'}</button>
            <button type="button" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <div className={`bmr-lightbox-scroll ${zoom ? 'zoom' : ''}`}>
          <img src={data.src} alt={`Source table for ${data.method}`} className={zoom ? 'actual' : 'fit'} />
        </div>
      </div>
    </div>
  );
}

// Windowed page controls: ‹ Prev · 1 … (p-1) p (p+1) … last · Next ›
function Pagination({ page, pageCount, onPage }) {
  if (pageCount <= 1) return null;
  const nums = [];
  const add = n => { if (n >= 1 && n <= pageCount && !nums.includes(n)) nums.push(n); };
  add(1); add(2);
  for (let d = -1; d <= 1; d++) add(page + d);
  add(pageCount - 1); add(pageCount);
  nums.sort((a, b) => a - b);
  const items = [];
  let prev = 0;
  for (const n of nums) { if (n - prev > 1) items.push(`gap${n}`); items.push(n); prev = n; }
  return (
    <nav className="bmr-pager" aria-label="Results pages">
      <button type="button" className="bmr-pager-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
      {items.map(it => (typeof it === 'string'
        ? <span key={it} className="bmr-pager-ellipsis" aria-hidden>…</span>
        : <button key={it} type="button" className={`bmr-pager-num ${it === page ? 'on' : ''}`} aria-current={it === page ? 'page' : undefined} onClick={() => onPage(it)}>{it}</button>
      ))}
      <button type="button" className="bmr-pager-btn" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next ›</button>
    </nav>
  );
}

function ResultCard({ rec, onZoom }) {
  const [showSrc, setShowSrc] = useState(false);
  const src = (rec.sources || [])[0] || null;
  const hasSrc = src && (src.crop_image || src.table_caption);
  // Card chips show the PROTOCOL only — not Method/Metric/grade, which already
  // have dedicated slots (method name in the head, metric+value below, grade badge).
  const protocolTags = rec.tags.filter(t => t.cat !== 'Metric' && t.cat !== 'Evidence grade' && t.cat !== 'Method');
  return (
    <div className="bmr-card">
      <div className="bmr-card-head">
        <span className="bmr-method" title={rec.method}>{rec.method}</span>
        {rec.grade && (
          <span className={`bmr-grade bmr-grade-${rec.grade}`} title={GRADE_TIP[rec.grade] || ''}>
            {rec.grade}
          </span>
        )}
      </div>
      <div className="bmr-metric">
        <span className="bmr-metric-name">{rec.metric}</span>
        <span className="bmr-value">{rec.value != null ? rec.value : '—'}</span>
        {rec.nReports > 1 && <span className="bmr-nreports">median · {rec.nReports} papers</span>}
      </div>
      {protocolTags.length > 0 && (
        <div className="bmr-tags">
          {protocolTags.map((t, i) => (
            <span key={i} className="bmr-tag">{t.label}</span>
          ))}
        </div>
      )}
      <div className="bmr-src">
        <span className="bmr-papers">{(rec.papers || []).map(prettyPaper).join(', ') || 'source not recorded'}</span>
        {hasSrc && (
          <button type="button" className="bmr-src-toggle" onClick={() => setShowSrc(s => !s)} aria-expanded={showSrc}>
            {showSrc ? 'Hide source' : 'Source'}
          </button>
        )}
      </div>
      {showSrc && hasSrc && (
        <div className="bmr-src-body">
          {src.table_caption && <div className="bmr-src-caption">{src.table_caption}</div>}
          {src.crop_image && (
            <button
              type="button"
              className="bmr-src-cropbtn"
              onClick={() => onZoom && onZoom({ src: src.crop_image, caption: src.table_caption, method: rec.method })}
              title="Click to enlarge"
            >
              <img className="bmr-src-crop" src={src.crop_image} alt={`source table for ${rec.method}`} loading="lazy" />
              <span className="bmr-src-zoomhint">⤢ Click to enlarge</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line no-unused-vars
export default function BenchmarksPage({ data, selectedPoint, onSelect, minConfidence, incomingPageRef }) {
  const [benchmarkData, setBenchmarkData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [lightbox, setLightbox] = useState(null);
  const [page, setPage] = useState(1);
  const resultsRef = useRef(null);

  useEffect(() => {
    let alive = true;
    loadBenchmarkComparisons()
      .then(d => { if (alive) { setBenchmarkData(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const records = useMemo(() => buildResultRecords(benchmarkData), [benchmarkData]);
  const facets = useMemo(() => tagFacets(records), [records]);
  const filtered = useMemo(() => filterByTags(records, selected), [records, selected]);

  // Reset to page 1 whenever the filter changes (the result set is different).
  useEffect(() => { setPage(1); }, [selected]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageClamped = Math.min(page, pageCount);
  const start = (pageClamped - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  const goPage = (p) => {
    setPage(p);
    if (resultsRef.current && resultsRef.current.scrollIntoView) {
      resultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const toggle = (k) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const clear = () => setSelected(new Set());

  if (loading) return <div className="bmr-page"><div className="bmr-loading">Loading benchmark data…</div></div>;
  if (!records.length) return <div className="bmr-page"><div className="bmr-empty">No benchmark data available.</div></div>;

  return (
    <div className="bmr-page">
      <div className="bmr-header">
        <div className="bmr-header-text">
          <h2>Benchmark Results</h2>
          <p>
            Every result extracted from the corpus' result tables, shown with its full protocol.
            These are <strong>not ranked</strong> — pick tags to find results that match. Tags in
            different categories must all hold; tags within one category match either.
          </p>
        </div>
        <div className="bmr-gradekey">
          <span className="bmr-gradekey-label">
            Evidence grade
            <Tooltip text={GRADE_EXPLAIN} wide><span className="chart-help">?</span></Tooltip>
          </span>
          <span className="bmr-gradekey-item"><span className="bmr-grade bmr-grade-A">A</span> 2+ independent papers agree</span>
          <span className="bmr-gradekey-item"><span className="bmr-grade bmr-grade-B">B</span> single solid source</span>
          <span className="bmr-gradekey-item"><span className="bmr-grade bmr-grade-C">C</span> low-confidence / disputed</span>
          <span className="bmr-gradekey-note">Most results are B — see the “?” for why A is rare here.</span>
        </div>
      </div>

      <div className="bmr-layout">
        <aside className="bmr-rail">
          <div className="bmr-rail-head">
            <span>Filters</span>
            {selected.size > 0 && (
              <button type="button" className="bmr-clear" onClick={clear}>Clear ({selected.size})</button>
            )}
          </div>
          {facets.map(f => (
            <FacetDropdown key={f.category} facet={f} selected={selected} onToggle={toggle} />
          ))}
        </aside>

        <main className="bmr-results" data-testid="bmr-results" ref={resultsRef}>
          <div className="bmr-results-count">
            {pageCount <= 1
              ? `${filtered.length} of ${records.length} results`
              : `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} results`}
            {selected.size > 0 ? ` · ${selected.size} tag${selected.size > 1 ? 's' : ''} selected` : ''}
          </div>
          {filtered.length === 0 ? (
            <div className="bmr-empty">No result has all the selected tags. Remove a tag to broaden the search.</div>
          ) : (
            <>
              <div className="bmr-grid">
                {pageItems.map(r => <ResultCard key={r.id} rec={r} onZoom={setLightbox} />)}
              </div>
              <Pagination page={pageClamped} pageCount={pageCount} onPage={goPage} />
            </>
          )}
        </main>
      </div>

      <BenchmarkLightbox data={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
