/**
 * KGLanding — Knowledge Graph exploration dashboard.
 *
 * Layout matches Explorer's density:
 * - Top: compact query pills + inline stats
 * - Main: graph (left 60%) + panels (right 40%)
 * - Bottom: gap matrix + benchmarks (two-col)
 *
 * The graph is the interactive center. Filters change what's visible in the graph.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Tooltip from './Tooltip';
import KGGraphViz from './KGGraphViz';
import KGNodeDetail from './KGNodeDetail';
import KGEdgeDetail from './KGEdgeDetail';

// Grouped by the *kind of signal* each edge carries (not the technical name).
// Covers every edge type emitted by the current pipeline (TEI + Groq + CSV + similarity).
const EDGE_GROUPS = [
  { label: 'Citations',   keys: ['cites', 'cites_external'] },
  { label: 'Claims',      keys: ['contributes', 'has_limitation', 'addresses_problem'] },
  { label: 'Evidence',    keys: ['compares', 'outperforms'] },
  { label: 'Methodology', keys: ['uses_technique', 'uses_backbone', 'uses_loss',
                                 'uses_architecture', 'trained_on', 'trained_with',
                                 'uses_dataset'] },
  { label: 'Hardware',    keys: ['uses_hardware', 'uses_effector', 'uses_camera',
                                 'requires_input', 'outputs', 'handles_scene'] },
  { label: 'Planning',    keys: ['uses_planning_method', 'described_in'] },
  { label: 'Content',     keys: ['has_figure', 'has_table', 'has_equation'] },
  { label: 'People',      keys: ['authored_by', 'affiliated_with', 'published_from'] },
  { label: 'Community',   keys: ['co_authored_with', 'colleagues_with', 'author_works_on'] },
  { label: 'Intellectual siblings', keys: ['co_cited_with', 'shares_bibliography'] },
  { label: 'Meta',        keys: ['implemented_in', 'maintained_by', 'published_in_year'] },
];

/**
 * KG-specific filters — horizontal panel matching Explorer's ATTRIBUTE WEIGHTS style.
 */
function KGFilterPanel({
  searchTerm, onSearchChange,
  hiddenEdgeTypes, onToggleEdgeGroup, isEdgeGroupHidden,
  minDegree, onMinDegreeChange,
  yearRange, yearBounds, onYearChange,
  onClear,
}) {
  const hasYear = yearBounds && yearBounds[0] != null;
  return (
    <div className="kg-filter-panel">
      <div className="kg-filter-panel-body">
        <div className="kg-filter-group">
          <label className="kg-filter-label">Find</label>
          <input
            className="kg-filter-input"
            type="search"
            placeholder="Search by name…"
            value={searchTerm}
            onChange={e => onSearchChange(e.target.value)}
          />
        </div>

        <div className="kg-filter-group">
          <label className="kg-filter-label">Relationships</label>
          <div className="kg-filter-chips">
            {EDGE_GROUPS.map(g => {
              const active = !isEdgeGroupHidden(g.keys);
              return (
                <button key={g.label}
                  className={`kg-filter-chip ${active ? 'active' : ''}`}
                  onClick={() => onToggleEdgeGroup(g.keys)}>
                  {g.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="kg-filter-group">
          <label className="kg-filter-label">Min connections <span className="kg-filter-val">≥ {minDegree}</span></label>
          <input type="range" min="0" max="20" value={minDegree}
            className="kg-filter-range"
            onChange={e => onMinDegreeChange(Number(e.target.value))} />
        </div>

        {hasYear && (
          <div className="kg-filter-group">
            <label className="kg-filter-label">Years</label>
            <div className="kg-filter-year">
              <input type="number" min={yearBounds[0]} max={yearBounds[1]} value={yearRange[0]}
                onChange={e => onYearChange([Number(e.target.value), yearRange[1]])} />
              <span>–</span>
              <input type="number" min={yearBounds[0]} max={yearBounds[1]} value={yearRange[1]}
                onChange={e => onYearChange([yearRange[0], Number(e.target.value)])} />
            </div>
          </div>
        )}

        <button className="kg-filter-reset" onClick={onClear}>Reset All</button>
      </div>
    </div>
  );
}

/* ─── Gap Matrix ─── */
function GapMatrix({ highlightedMethods }) {
  const [hover, setHover] = useState(null);
  const [m, setM] = useState(null);                // current matrix {row_label, col_label, columns, rows}
  const [availableCols, setAvailableCols] = useState([]);
  const [rowCol, setRowCol] = useState('');
  const [colCol, setColCol] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Single effect that loads methods, picks default axes, and computes the
  // matrix. Earlier this was split across two effects with separate loading
  // toggles which created a race where the matrix could end up with
  // loading=true and m=null indefinitely if either branch threw silently.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { loadMethods } = await import('../lib/data-loader');
        const methods = await loadMethods();
        if (cancelled) return;

        // Pick default axes the first time we run.
        let chosenRow = rowCol;
        let chosenCol = colCol;
        if (!chosenRow || !chosenCol) {
          const exclude = new Set([
            'Name', 'Title', 'Authors', 'Year (Initial Release)', 'Venue',
            'Link(s)', 'URL', 'Notes', 'Description', 'Combined_Description',
            'Citation', 'License', 'Maintainer(s)',
          ]);
          const cols = Object.keys(methods[0] || {}).filter(c => !exclude.has(c));
          setAvailableCols(cols);
          if (cols.length < 2) {
            setLoading(false);
            return;
          }
          chosenRow = chosenRow || cols[0];
          chosenCol = chosenCol || cols[1];
          if (chosenRow !== rowCol) setRowCol(chosenRow);
          if (chosenCol !== colCol) setColCol(chosenCol);
        }
        if (chosenRow === chosenCol) {
          setLoading(false);
          return;
        }

        const rows = {};
        methods.forEach(meth => {
          const name = (meth['Name'] || '').replace('🤖 ', '').trim();
          const rv = (meth[chosenRow] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
          const cv = (meth[chosenCol] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
          rv.forEach(r => {
            cv.forEach(c => {
              if (!rows[r]) rows[r] = {};
              if (!rows[r][c]) rows[r][c] = { count: 0, methods: [] };
              rows[r][c].count += 1;
              if (name) rows[r][c].methods.push(name);
            });
          });
        });
        const allCols = [...new Set(Object.values(rows).flatMap(r => Object.keys(r)))].sort();
        const matrix = Object.entries(rows)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, byCol]) => ({
            label,
            cells: allCols.map(c => ({
              value: byCol[c]?.count || 0,
              methods: byCol[c]?.methods || [],
            })),
          }));
        if (cancelled) return;
        setM({ success: true, row_label: chosenRow, col_label: chosenCol, columns: allCols, rows: matrix });
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowCol, colCol]);

  if (error) {
    return (
      <div className="kgl-card">
        <div className="kgl-card-header"><h3>Research Gaps</h3></div>
        <div className="kgl-card-body" style={{ color: '#b03029' }}>Error: {error}</div>
      </div>
    );
  }
  if (loading && !m) return <div className="kgl-card"><div className="kgl-card-header"><h3>Research Gaps</h3></div><div className="kgl-card-body">Loading…</div></div>;
  if (!m) return null;
  return (
    <div className="kgl-card">
      <div className="kgl-card-header">
        <h3>Research Gaps <Tooltip text="Cross-tabulation of any two CSV attributes. Empty cells are coverage gaps where no method exists. Pick any pair to spot opportunities." wide><span className="chart-help">?</span></Tooltip></h3>
        {loading && <span className="kgl-graph-hint">Updating…</span>}
      </div>
      <div className="kgl-gap-picker">
        <div className="kgl-gap-field">
          <span className="kgl-gap-axis">ROWS</span>
          <select value={rowCol} onChange={e => setRowCol(e.target.value)} className="kgl-gap-select">
            {availableCols.map(c => <option key={c} value={c} disabled={c === colCol}>{c}</option>)}
          </select>
        </div>
        <button
          className="kgl-gap-swap"
          title="Swap rows and columns"
          onClick={() => { setRowCol(colCol); setColCol(rowCol); }}
          disabled={!rowCol || !colCol}
        >⇄</button>
        <div className="kgl-gap-field">
          <span className="kgl-gap-axis">COLS</span>
          <select value={colCol} onChange={e => setColCol(e.target.value)} className="kgl-gap-select">
            {availableCols.map(c => <option key={c} value={c} disabled={c === rowCol}>{c}</option>)}
          </select>
        </div>
        <div className="kgl-gap-status">
          {loading ? <span className="kgl-gap-dot loading" /> : <span className="kgl-gap-dot ready" />}
          <span className="kgl-gap-meta">{m.rows.length}×{m.columns.length}</span>
        </div>
      </div>
      <div className="kgl-card-body kgl-matrix-scroll">
        <table className="kgl-matrix">
          <thead><tr><th className="kgl-matrix-corner"></th>{m.columns.map((c, i) => <th key={i} className="kgl-matrix-colhead">{c}</th>)}</tr></thead>
          <tbody>{m.rows.map((row, ri) => (
            <tr key={ri}><td className="kgl-matrix-rowhead">{row.label}</td>
              {row.cells.map((cell, ci) => {
                const gap = cell.value === 0;
                const hl = highlightedMethods.size > 0 && cell.methods.some(m => highlightedMethods.has(m));
                const dim = highlightedMethods.size > 0 && !hl && cell.value > 0;
                return <td key={ci} className={`kgl-matrix-cell ${gap ? 'gap' : ''} ${cell.value >= 5 ? 'dense' : cell.value >= 2 ? 'moderate' : ''} ${dim ? 'dimmed' : ''} ${hl ? 'highlighted' : ''}`}
                  onMouseEnter={() => setHover({r:ri,c:ci})} onMouseLeave={() => setHover(null)}>
                  {gap ? '' : cell.value}
                  {hover && hover.r === ri && hover.c === ci && cell.value > 0 && (
                    <div className="kgl-cell-tooltip"><div className="kgl-cell-tooltip-header">{row.label} + {m.columns[ci]}</div>{cell.methods.map((m,i) => <div key={i}>{m}</div>)}</div>
                  )}
                </td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Benchmarks (compact) ─── */
function Benchmarks({ data, highlightedMethods, highlightedBenchmarks }) {
  const [exp, setExp] = useState(null);
  const filtered = (data || []).filter(d => d.dataset !== 'Custom').slice(0, 8);
  if (!filtered.length) return null;
  const max = Math.max(...filtered.map(d => d.count), 1);
  const hasAnyHL =
    (highlightedMethods && highlightedMethods.size > 0) ||
    (highlightedBenchmarks && highlightedBenchmarks.size > 0);
  return (
    <div className="kgl-card">
      <div className="kgl-card-header">
        <h3>Benchmarks <Tooltip text="Evaluation datasets used across the corpus. Click to see which methods test on each." wide><span className="chart-help">?</span></Tooltip></h3>
      </div>
      <div className="kgl-card-body">
        {filtered.map((item, i) => {
          const byMethod = highlightedMethods && highlightedMethods.size > 0 && item.methods.some(m => highlightedMethods.has(m));
          const byBench = highlightedBenchmarks && highlightedBenchmarks.has(item.dataset);
          const hl = byMethod || byBench;
          const dim = hasAnyHL && !hl;
          return <div key={i}>
            <div className={`kgl-bench-row ${dim ? 'dimmed' : ''} ${hl ? 'hl' : ''}`} onClick={() => setExp(exp === i ? null : i)}>
              <span className="kgl-bench-name">{item.dataset}</span>
              <div className="kgl-bench-track"><div className="kgl-bench-fill" style={{width:`${(item.count/max)*100}%`}} /></div>
              <span className="kgl-bench-n">{item.count}</span>
            </div>
            {exp === i && <div className="kgl-bench-expand">{item.methods.map((m,j) => <span key={j} className="kgl-bench-method">{m}</span>)}</div>}
          </div>;
        })}
      </div>
    </div>
  );
}

/* ─── Most Referenced (compact) ─── */
function TopCited({ topCited, selectedTopCited, onTopCitedSelect, highlightedMethods, highlightedPapers }) {
  if (!topCited || !topCited.length) return null;
  const max = Math.max(...topCited.map(t => t.citations), 1);
  const hasAnyHL =
    (highlightedMethods && highlightedMethods.size > 0) ||
    (highlightedPapers && highlightedPapers.size > 0);
  return (
    <div className="kgl-card">
      <div className="kgl-card-header">
        <h3>Most Referenced <Tooltip text="Papers most cited by other papers in this corpus. Click a row to highlight it across the graph and every chart." wide><span className="chart-help">?</span></Tooltip></h3>
        {selectedTopCited && <button className="kgl-side-clear" onClick={() => onTopCitedSelect && onTopCitedSelect(null)}>Clear</button>}
      </div>
      <div className="kgl-card-body">
        {topCited.slice(0, 6).map((item, i) => {
          const isActive = selectedTopCited === item.paper;
          const isHL =
            hasAnyHL &&
            (
              (highlightedPapers && highlightedPapers.has(item.paper)) ||
              (highlightedMethods && highlightedMethods.has(item.paper))
            );
          return (
            <div
              key={i}
              className={`kgl-cited-row ${isActive ? 'active' : ''} ${isHL ? 'graph-highlighted' : ''}`}
              onClick={() => onTopCitedSelect && onTopCitedSelect(isActive ? null : item.paper)}
              title={item.paper}
            >
              <span className="kgl-cited-rank">{i + 1}</span>
              <span className="kgl-cited-name">{item.paper}</span>
              <div className="kgl-cited-track"><div className="kgl-cited-fill" style={{width:`${(item.citations/max)*100}%`}} /></div>
              <span className="kgl-cited-n">{item.citations}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Right side panel: Techniques + Timeline + Filters ─── */
function SidePanel({ data, selectedTechnique, onTechSelect, selectedYear, onYearClick, highlightedMethods, highlightedTechniques, highlightedYears }) {
  if (!data) return null;
  const techNodes = data.techniqueCooccurrence?.nodes || [];
  const temporal = data.temporal || [];
  const maxTech = Math.max(...techNodes.map(n => n.count), 1);
  const maxYear = Math.max(...temporal.map(t => t.count), 1);
  const selectedMethods = selectedYear ? (temporal.find(t => t.year === selectedYear)?.methods || []) : [];

  // Render as a fragment so Techniques and Timeline land as siblings of
  // the other infographics in `.kgl-bottom-grid` (each card gets its own
  // grid cell, no nested column wrapping).
  return (
    <>
      {/* Techniques as clickable filter bars */}
      <div className="kgl-card">
        <div className="kgl-card-header">
          <h3>Techniques <Tooltip text="Click a technique to filter the graph and highlight methods using it across all panels." wide><span className="chart-help">?</span></Tooltip></h3>
          {selectedTechnique && <button className="kgl-side-clear" onClick={() => onTechSelect(null)}>Clear</button>}
        </div>
        <div className="kgl-card-body">
          {techNodes.slice(0, 10).map((node, i) => {
            const pct = (node.count / maxTech) * 100;
            const isActive = selectedTechnique === node.name;
            const hasHL = highlightedTechniques && highlightedTechniques.size > 0;
            const isHL = hasHL && highlightedTechniques.has(node.name);
            const isDim = hasHL && !isHL;
            return (
              <div key={i} className={`kgl-tech-row ${isActive ? 'active' : ''} ${isHL ? 'graph-highlighted' : ''} ${isDim ? 'dimmed' : ''}`} onClick={() => onTechSelect(isActive ? null : node.name)}>
                <span className="kgl-tech-name">{node.name}</span>
                <div className="kgl-tech-track"><div className="kgl-tech-fill" style={{width:`${pct}%`}} /></div>
                <span className="kgl-tech-n">{node.count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline as compact bars */}
      <div className="kgl-card">
        <div className="kgl-card-header">
          <h3>Timeline <Tooltip text="Click a year to highlight methods published that year across all panels." wide><span className="chart-help">?</span></Tooltip></h3>
          {selectedYear && <button className="kgl-side-clear" onClick={() => onYearClick(null)}>Clear {selectedYear}</button>}
        </div>
        <div className="kgl-card-body">
          <div className="kgl-tl-bars">
            {temporal.map((item, i) => {
              const isActive = selectedYear === item.year;
              const isYearHL = highlightedYears && highlightedYears.has(item.year);
              return (
                <div key={i} className={`kgl-tl-col ${isActive ? 'active' : ''} ${isYearHL ? 'graph-highlighted' : ''}`} onClick={() => onYearClick(isActive ? null : item.year)}>
                  <div className="kgl-tl-bar-wrap"><div className="kgl-tl-bar" style={{height:`${(item.count/maxYear)*100}%`}} /></div>
                  <span className="kgl-tl-year">{item.year}</span>
                  <span className="kgl-tl-count">{item.count}</span>
                </div>
              );
            })}
          </div>
          {selectedMethods.length > 0 && (
            <div className="kgl-tl-methods">{selectedMethods.map((m, i) => <span key={i} className="kgl-tl-method">{m}</span>)}</div>
          )}
        </div>
      </div>
    </>
  );
}

/* ─── Citation Stance (TEI-derived, divergent spectrum bar) ─── */
function CitationStance({ data }) {
  if (!data) return null;
  const flow = data.citeFlow || { builds_on: 0, differs_from: 0, neutral: 0 };
  const total = (flow.builds_on || 0) + (flow.differs_from || 0) + (flow.neutral || 0);
  if (total === 0) return null;

  const segments = [
    { key: 'builds_on',    label: 'Builds on',    value: flow.builds_on    || 0, desc: 'extends or adopts prior work',     cls: 'builds'   },
    { key: 'neutral',      label: 'Neutral',      value: flow.neutral      || 0, desc: 'descriptive reference, no stance', cls: 'neutral'  },
    { key: 'differs_from', label: 'Differs from', value: flow.differs_from || 0, desc: 'outperforms or contrasts',         cls: 'differs'  },
  ];
  const dominant = segments.slice().sort((a, b) => b.value - a.value)[0];
  const dominantPct = Math.round((dominant.value / total) * 100);

  return (
    <div className="kgl-card kgl-stance-v2">
      <div className="kgl-card-header">
        <h3>Citation Stance <Tooltip text="How papers cite each other in the corpus: building on prior work, differentiating from it, or neutral. Derived from in-text context around each TEI citation." wide><span className="chart-help">?</span></Tooltip></h3>
        <span className="kgl-stance-v2-total">{total.toLocaleString()} citations</span>
      </div>
      <div className="kgl-card-body kgl-stance-v2-body">
        <div className="kgl-stance-v2-headline">
          The corpus leans <strong className={`kgl-stance-v2-lean ${dominant.cls}`}>{dominant.label.toLowerCase()}</strong>
          {' '}—{' '}<strong>{dominantPct}%</strong> of in-text citations {dominant.desc}.
        </div>
        <div className="kgl-stance-v2-bar" role="img" aria-label={`Citation stance: ${segments.map(s => `${s.label} ${Math.round((s.value/total)*100)}%`).join(', ')}`}>
          {segments.map(s => {
            const pct = (s.value / total) * 100;
            return (
              <div key={s.key} className={`kgl-stance-v2-seg ${s.cls}`} style={{ flexGrow: pct }} title={`${s.label}: ${s.value} (${pct.toFixed(1)}%)`}>
                {pct >= 9 && <span className="kgl-stance-v2-seg-num">{Math.round(pct)}%</span>}
              </div>
            );
          })}
        </div>
        <div className="kgl-stance-v2-legend">
          {segments.map(s => {
            const pct = (s.value / total) * 100;
            return (
              <div key={s.key} className="kgl-stance-v2-item">
                <div className="kgl-stance-v2-item-head">
                  <span className={`kgl-stance-v2-dot ${s.cls}`} />
                  <span className="kgl-stance-v2-item-label">{s.label}</span>
                </div>
                <div className="kgl-stance-v2-item-num">{s.value.toLocaleString()}<span className="kgl-stance-v2-item-pct">{pct.toFixed(1)}%</span></div>
                <div className="kgl-stance-v2-item-desc">{s.desc}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Institutions + Authors + Foundational External Works (TEI-derived) ─── */
function CommunityPanel({
  data, selectedInstitution, onInstitutionSelect,
  selectedAuthor, onAuthorSelect,
  selectedExternalRef, onExternalRefSelect,
  highlightedMethods, highlightedLabels,
  highlightedInstitutions, highlightedAuthors,
  highlightedExternalRefs, highlightedPapers,
}) {
  if (!data) return null;
  const institutions = data.topInstitutions || [];
  const authors = data.topAuthors || [];
  const topRefs = data.topExternalRefs || [];
  const maxInst = Math.max(...institutions.map(i => i.count), 1);
  const maxAuth = Math.max(...authors.map(a => a.count), 1);
  // A row is "highlighted" if EITHER its name is in the relevant dimension
  // set (cross-selection from another card) OR one of its papers intersects
  // the current paper/method highlight set.
  const hasAnyHL =
    (highlightedMethods && highlightedMethods.size > 0) ||
    (highlightedPapers && highlightedPapers.size > 0) ||
    (highlightedInstitutions && highlightedInstitutions.size > 0) ||
    (highlightedAuthors && highlightedAuthors.size > 0) ||
    (highlightedExternalRefs && highlightedExternalRefs.size > 0);
  const paperOverlap = (papers) => papers && papers.some(p => (
    (highlightedMethods && highlightedMethods.has(p)) ||
    (highlightedPapers && highlightedPapers.has(p))
  ));
  // Render as a fragment so the cards land as direct grid children of the
  // parent `.kgl-bottom-grid`. Wrapping them in `.kgl-community` (the old
  // multi-column masonry) made the right half of the page empty whenever
  // the cards didn't fill all available masonry columns.
  return (
    <>
      {institutions.length > 0 && (
        <div className="kgl-card">
          <div className="kgl-card-header">
            <h3>Top Institutions <Tooltip text="Click to highlight papers from this institution across the graph and every chart below." wide><span className="chart-help">?</span></Tooltip></h3>
            {selectedInstitution && <button className="kgl-side-clear" onClick={() => onInstitutionSelect(null)}>Clear</button>}
          </div>
          <div className="kgl-card-body">
            {institutions.slice(0, 8).map((inst, i) => {
              const isActive = selectedInstitution === inst.name;
              const byName = highlightedInstitutions && highlightedInstitutions.has(inst.name);
              const isHL = byName || paperOverlap(inst.papers);
              const isDim = hasAnyHL && !isHL && !isActive;
              return (
                <div
                  key={i}
                  className={`kgl-tech-row variant-inst ${isActive ? 'active' : ''} ${isHL ? 'graph-highlighted' : ''} ${isDim ? 'dimmed' : ''}`}
                  title={inst.papers ? inst.papers.join(', ') : ''}
                  onClick={() => onInstitutionSelect(isActive ? null : inst.name)}
                >
                  <span className="kgl-tech-name">{inst.name}</span>
                  <div className="kgl-tech-track"><div className="kgl-tech-fill" style={{width:`${(inst.count/maxInst)*100}%`}} /></div>
                  <span className="kgl-tech-n">{inst.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {authors.length > 0 && (
        <div className="kgl-card">
          <div className="kgl-card-header">
            <h3>Top Authors <Tooltip text="Click to highlight papers by this author across the graph and every chart below." wide><span className="chart-help">?</span></Tooltip></h3>
            {selectedAuthor && <button className="kgl-side-clear" onClick={() => onAuthorSelect(null)}>Clear</button>}
          </div>
          <div className="kgl-card-body">
            {authors.slice(0, 8).map((a, i) => {
              const isActive = selectedAuthor === a.name;
              const byName = highlightedAuthors && highlightedAuthors.has(a.name);
              const isHL = byName || paperOverlap(a.papers);
              const isDim = hasAnyHL && !isHL && !isActive;
              return (
                <div
                  key={i}
                  className={`kgl-tech-row variant-author ${isActive ? 'active' : ''} ${isHL ? 'graph-highlighted' : ''} ${isDim ? 'dimmed' : ''}`}
                  title={a.papers ? a.papers.join(', ') : ''}
                  onClick={() => onAuthorSelect(isActive ? null : a.name)}
                >
                  <span className="kgl-tech-name">{a.name}</span>
                  <div className="kgl-tech-track"><div className="kgl-tech-fill" style={{width:`${(a.count/maxAuth)*100}%`}} /></div>
                  <span className="kgl-tech-n">{a.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {topRefs.length > 0 && (
        <div className="kgl-card">
          <div className="kgl-card-header">
            <h3>Foundational External Works <Tooltip text="Click a work to highlight every corpus paper that cites it — the scholarly roots of a method family." wide><span className="chart-help">?</span></Tooltip></h3>
            {selectedExternalRef && <button className="kgl-side-clear" onClick={() => onExternalRefSelect(null)}>Clear</button>}
          </div>
          <div className="kgl-card-body">
            {topRefs.slice(0, 6).map((r, i) => {
              const isActive = selectedExternalRef === r.title;
              const isHL = highlightedExternalRefs && highlightedExternalRefs.has(r.title);
              const isDim = hasAnyHL && !isHL && !isActive;
              return (
                <div
                  key={i}
                  className={`kgl-ref-row ${isActive ? 'active' : ''} ${isHL ? 'graph-highlighted' : ''} ${isDim ? 'dimmed' : ''}`}
                  onClick={() => onExternalRefSelect(isActive ? null : r.title)}
                >
                  <div className="kgl-ref-title">{r.title}</div>
                  <div className="kgl-ref-meta">
                    {r.authors && r.authors.length > 0 && <span>{r.authors.join(', ')}</span>}
                    {r.year && <span>{r.year}</span>}
                    <span className="kgl-ref-cites">{r.citations} cites</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/* ─── MAIN ─── */
export default function KGLanding({
  scatterData, scatterHighlights, selectedPoint, hoveredIndex,
  onSelect, onHover, onUnhover, onFilter,
}) {
  const [data, setData] = useState(null);
  // Filters closed by default to match the rest of the dashboard. Opens via
  // the "Filters" button in the viz toolbar. Reason: the filter panel is
  // visually heavy (chip wall + sliders) and the first impression of the
  // landing should be the graph itself, not a wall of controls.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [minDegree, setMinDegree] = useState(0);
  const [yearRange, setYearRange] = useState([0, 9999]);

  const toggleEdgeGroup = useCallback(keys => setHiddenEdgeTypes(prev => {
    const next = new Set(prev);
    const allHidden = keys.every(k => next.has(k));
    if (allHidden) keys.forEach(k => next.delete(k));
    else keys.forEach(k => next.add(k));
    return next;
  }), []);
  const isEdgeGroupHidden = useCallback(keys => keys.every(k => hiddenEdgeTypes.has(k)), [hiddenEdgeTypes]);

  const clearFilters = useCallback(() => {
    setHiddenEdgeTypes(new Set());
    setSearchTerm('');
    setMinDegree(0);
  }, []);
  const [loading, setLoading] = useState(true);
  const [selectedTechnique, setSelectedTechnique] = useState(null);
  const [selectedYear, setSelectedYear] = useState(null);
  const [selectedGraphNode, setSelectedGraphNode] = useState(null);
  const [nodeSelection, setNodeSelection] = useState(null);
  // Edge selection — populated when the user clicks a predicted edge.
  // Mutually exclusive with nodeSelection: clicking either type clears
  // the other so the side-panel slot only ever holds one detail view.
  const [edgeSelection, setEdgeSelection] = useState(null);
  const [macroGraph, setMacroGraph] = useState(null);
  // Community-panel selections (institution / author / foundational-ref).
  // Any of these broadcasts a highlight across the graph + all sibling charts.
  const [selectedInstitution, setSelectedInstitution] = useState(null);
  const [selectedAuthor, setSelectedAuthor] = useState(null);
  const [selectedExternalRef, setSelectedExternalRef] = useState(null);
  // Most-Referenced (TopCited) selection — clicking a row highlights that
  // paper across the graph + every other chart. Same connect-everything
  // pattern as the other selection-state vars above.
  const [selectedTopCited, setSelectedTopCited] = useState(null);
  // Hover preview: lights up a node on the graph without committing a selection.
  // Fired from side-panel connection rows and lineage items.
  const [hoverEntity, setHoverEntity] = useState(null);
  // View tab: 'macro' = the full KG, 'predictions' = HGT latent edges only
  const [graphView, setGraphView] = useState('macro');
  const [predMinConf, setPredMinConf] = useState(0.55);
  // Overlay existing KG edges on top of predictions → visual diff of "known vs new"
  const [predShowExisting, setPredShowExisting] = useState(true);
  // Edge-type filter for the predictions view. null = show both,
  // 'outperforms' or 'uses_technique' = show only that type. Drives the
  // 2-entry legend's click behavior.
  const [predTypeFilter, setPredTypeFilter] = useState(null);
  // Full predicted edges + nodes so the cross-card highlight resolver can
  // fan out via predicted edges when the user is in the Predicted
  // Relationships view. Same shape as macroGraph: { nodes, links }. We
  // keep it separate (not merged into macroGraph) because the macro view
  // should not bleed predicted edges back into the KG view.
  const [predGraph, setPredGraph] = useState(null);
  // Side-panel expanded state — papers/methods open in a compact mode by
  // default showing just the first subheading (method spec + a hint of
  // the rest), and the user clicks Expand to see the full layout. Other
  // node types (technique/dataset/author/institution/reference/etc.)
  // have only one subheading of content so they always render in side
  // mode without an expand toggle.
  const [panelExpanded, setPanelExpanded] = useState(false);

  // Load full predictions data once when the user opens the predictions view.
  useEffect(() => {
    if (graphView !== 'predictions' || predGraph) return;
    let cancelled = false;
    import('../lib/data-loader').then(({ loadKgPredictions }) => {
      loadKgPredictions().then(d => {
        if (cancelled || !d || !d.links) return;
        setPredGraph({ nodes: d.nodes || [], links: d.links || [] });
      }).catch(() => {});
    });
    return () => { cancelled = true; };
  }, [graphView, predGraph]);

  // Recompute legend counts whenever the confidence slider changes.
  // Only counts predicted (inferred) edges, not observed overlays.
  const predCounts = useMemo(() => {
    if (!predGraph || !predGraph.links) return null;
    const counts = {};
    for (const e of predGraph.links) {
      if (e.source_type === 'observed') continue;
      if ((e.confidence || 0) < predMinConf) continue;
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    return counts;
  }, [predGraph, predMinConf]);

  useEffect(() => {
    import('../lib/data-loader').then(({ loadKgLanding, loadKgMacro }) => {
      Promise.all([loadKgLanding(), loadKgMacro()])
        .then(([landing, macro]) => {
          if (landing && landing.totalNodes) {
            setData({ success: true, ...landing });
            const td = landing.temporalDistribution;
            if (td) {
              const years = Object.keys(td).map(Number);
              if (years.length) setYearRange([Math.min(...years), Math.max(...years)]);
            }
          }
          if (macro && macro.nodes) setMacroGraph({ success: true, ...macro });
          setLoading(false);
        })
        .catch(() => setLoading(false));
    });
  }, []);

  // EVERYTHING CONNECTS TO EVERYTHING — central highlight resolver.
  //
  // Single-pass design: every selection (technique, institution, author,
  // year, top-cited row, external-ref, graph-node, table-row) is reduced
  // to a SEED set of paper IDs. From those paper IDs we fan out once,
  // walking every macroGraph edge incident to a seed paper, and assign
  // the touched node into its dimension-specific Set:
  //
  //   methods, papers, techniques, institutions, authors, externalRefs
  //
  // Years are derived by intersecting the seeded method labels against
  // `data.temporal`.
  //
  // Each card consumes the Set that matches its own dimension instead of
  // trying to guess membership by overloading `highlightedMethods`. That
  // was the original bug: clicking an institution populated method labels,
  // but the Techniques card keyed on `highlightedTechniques` (only ever
  // fed by graph-node neighbors) and the Timeline keyed on a single
  // `highlightedYear` value — so half the cards stayed dark.
  const _highlightResolution = useMemo(() => {
    const methods = new Set();
    const papers = new Set();          // paper labels
    const techniques = new Set();
    const institutions = new Set();
    const authors = new Set();
    const externalRefs = new Set();
    const benchmarks = new Set();
    const years = new Set();
    const labels = new Set();          // graph-viz labels to keep bright

    if (!data || !macroGraph) return {
      methods, papers, techniques, institutions, authors, externalRefs, benchmarks, years, labels,
    };

    // --- Build lookup maps once -------------------------------------------
    const nodeById = new Map();
    macroGraph.nodes.forEach(n => nodeById.set(n.id, n));

    // adj[id] → list of [otherId, edgeType]
    const adj = new Map();
    macroGraph.links.forEach(l => {
      const s = l.source?.id || l.source;
      const t = l.target?.id || l.target;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push([t, l.type]);
      adj.get(t).push([s, l.type]);
    });

    // paperId → method label (via described_in)
    const paperIdToMethod = new Map();
    macroGraph.links.forEach(l => {
      if (l.type !== 'described_in') return;
      const s = l.source?.id || l.source;
      const t = l.target?.id || l.target;
      const sNode = nodeById.get(s);
      const tNode = nodeById.get(t);
      if (sNode?.type === 'method' && tNode?.type === 'paper') {
        paperIdToMethod.set(tNode.id, sNode.label);
      }
    });

    // --- Step 1: collect SEED paper IDs from every active selection ------
    const seedPaperIds = new Set();
    const addSeedPaper = (id) => { if (id != null) seedPaperIds.add(id); };

    const papersConnectedTo = (entityNode, edgeFilter) => {
      // Walks one hop out of entityNode and returns paper IDs (optionally
      // restricting to a specific edge type).
      const out = [];
      (adj.get(entityNode.id) || []).forEach(([otherId, etype]) => {
        if (edgeFilter && etype !== edgeFilter) return;
        const o = nodeById.get(otherId);
        if (o?.type === 'paper') out.push(o.id);
      });
      return out;
    };

    // Year → papers (via methods published that year)
    if (selectedYear && data.temporal) {
      const yd = data.temporal.find(t => t.year === selectedYear);
      if (yd) {
        const wanted = new Set(yd.methods.map(m => m.toLowerCase()));
        macroGraph.nodes.forEach(n => {
          if (n.type !== 'method') return;
          if (!wanted.has((n.label || '').toLowerCase())) return;
          // method → described_in → paper
          (adj.get(n.id) || []).forEach(([otherId, etype]) => {
            if (etype !== 'described_in') return;
            const o = nodeById.get(otherId);
            if (o?.type === 'paper') addSeedPaper(o.id);
          });
        });
      }
    }

    // Technique → papers using it
    if (selectedTechnique) {
      const tNode = macroGraph.nodes.find(n => n.type === 'technique' && n.label === selectedTechnique);
      if (tNode) papersConnectedTo(tNode).forEach(addSeedPaper);
    }

    // Institution → papers published from it
    if (selectedInstitution) {
      const iNode = macroGraph.nodes.find(n => n.type === 'institution' && n.label === selectedInstitution);
      if (iNode) papersConnectedTo(iNode, 'published_from').forEach(addSeedPaper);
    }

    // Author → papers they wrote
    if (selectedAuthor) {
      const aNode = macroGraph.nodes.find(n => n.type === 'author' && n.label === selectedAuthor);
      if (aNode) papersConnectedTo(aNode, 'authored_by').forEach(addSeedPaper);
    }

    // External-ref → corpus papers that cite it
    if (selectedExternalRef) {
      const rNode = macroGraph.nodes.find(n => n.type === 'reference' && n.label === selectedExternalRef);
      if (rNode) papersConnectedTo(rNode, 'cites_external').forEach(addSeedPaper);
    }

    // Top-cited row → the paper itself
    if (selectedTopCited) {
      const pNode = macroGraph.nodes.find(n => n.type === 'paper' && n.label === selectedTopCited);
      if (pNode) addSeedPaper(pNode.id);
      // Fallback: a few pipelines store method labels in topCited
      const mNode = macroGraph.nodes.find(n => n.type === 'method' && n.label === selectedTopCited);
      if (mNode) {
        (adj.get(mNode.id) || []).forEach(([otherId, etype]) => {
          if (etype !== 'described_in') return;
          const o = nodeById.get(otherId);
          if (o?.type === 'paper') addSeedPaper(o.id);
        });
      }
    }

    // Graph node click — route through the same paper-seed pipeline
    if (selectedGraphNode) {
      labels.add(selectedGraphNode.label);
      const sel = nodeById.get(selectedGraphNode.id) || selectedGraphNode;
      if (sel.type === 'paper') {
        addSeedPaper(sel.id);
      } else if (sel.type === 'method') {
        // method → its paper
        methods.add(sel.label);
        (adj.get(sel.id) || []).forEach(([otherId, etype]) => {
          if (etype !== 'described_in') return;
          const o = nodeById.get(otherId);
          if (o?.type === 'paper') addSeedPaper(o.id);
        });
      } else {
        // technique / institution / author / reference / etc. → fan to papers
        papersConnectedTo(sel).forEach(addSeedPaper);
        // Also surface the entity itself in its dimension set so its card lights up
        if (sel.type === 'technique')   techniques.add(sel.label);
        if (sel.type === 'institution') institutions.add(sel.label);
        if (sel.type === 'author')      authors.add(sel.label);
        if (sel.type === 'reference')   externalRefs.add(sel.label);
      }
    }

    // Table hover/click on the Explorer scatter → seed via the matching method
    const tableMethodName =
      (scatterData && hoveredIndex != null ? scatterData[hoveredIndex]?.name : null)
      || selectedPoint?.name
      || null;
    if (tableMethodName) {
      const methodNode = macroGraph.nodes.find(
        n => n.type === 'method' && (n.label || '').toLowerCase() === tableMethodName.toLowerCase()
      );
      if (methodNode) {
        methods.add(methodNode.label);
        labels.add(methodNode.label);
        (adj.get(methodNode.id) || []).forEach(([otherId, etype]) => {
          if (etype !== 'described_in') return;
          const o = nodeById.get(otherId);
          if (o?.type === 'paper') addSeedPaper(o.id);
        });
      } else {
        // No node match — still surface the bare name
        methods.add(tableMethodName);
        labels.add(tableMethodName);
      }
    }

    // --- Step 2: fan out from every seed paper ----------------------------
    seedPaperIds.forEach(pid => {
      const paper = nodeById.get(pid);
      if (!paper) return;
      papers.add(paper.label);
      labels.add(paper.label);
      // Its method
      const mLabel = paperIdToMethod.get(pid);
      if (mLabel) { methods.add(mLabel); labels.add(mLabel); }
      // All one-hop neighbors → bin into dimension sets
      (adj.get(pid) || []).forEach(([otherId, etype]) => {
        const o = nodeById.get(otherId);
        if (!o) return;
        switch (o.type) {
          case 'method':
            if (etype === 'described_in') { methods.add(o.label); labels.add(o.label); }
            break;
          case 'technique':
            techniques.add(o.label); labels.add(o.label); break;
          case 'institution':
            institutions.add(o.label); labels.add(o.label); break;
          case 'author':
            authors.add(o.label); labels.add(o.label); break;
          case 'reference':
            externalRefs.add(o.label); labels.add(o.label); break;
          case 'dataset':
          case 'benchmark':
            benchmarks.add(o.label); labels.add(o.label); break;
          default:
            break;
        }
      });
    });

    // --- Step 2b: in Predicted Relationships view, also fan out via the
    // predicted-edges adjacency. Reason: when the user clicks a paper in
    // the predictions tab, the meaningful "related" set is whichever
    // papers the model thinks belong in a head-to-head with it, plus the
    // techniques it likely uses — NOT the macroGraph cites/uses edges
    // (which would just re-light the observed neighborhood the user is
    // explicitly trying to look past). We add these on top of the macro
    // fan-out so observed metadata (author/institution) still highlights
    // alongside the predicted papers. ---------------------------------
    if (graphView === 'predictions' && predGraph && seedPaperIds.size > 0) {
      const predNodeById = new Map();
      (predGraph.nodes || []).forEach(n => { if (n && n.id) predNodeById.set(n.id, n); });
      const predAdj = new Map();
      (predGraph.links || []).forEach(l => {
        const s = l.source?.id || l.source;
        const t = l.target?.id || l.target;
        if (!predAdj.has(s)) predAdj.set(s, []);
        if (!predAdj.has(t)) predAdj.set(t, []);
        predAdj.get(s).push([t, l.type]);
        predAdj.get(t).push([s, l.type]);
      });
      seedPaperIds.forEach(pid => {
        (predAdj.get(pid) || []).forEach(([otherId]) => {
          // Prefer the predGraph node (richer) but fall back to macro for label.
          const o = predNodeById.get(otherId) || nodeById.get(otherId);
          if (!o) return;
          labels.add(o.label);
          if (o.type === 'paper') {
            papers.add(o.label);
            const mLabel = paperIdToMethod.get(otherId);
            if (mLabel) { methods.add(mLabel); labels.add(mLabel); }
          } else if (o.type === 'method') {
            methods.add(o.label);
          } else if (o.type === 'technique') {
            techniques.add(o.label);
          }
        });
      });
    }

    // --- Step 3: derive year set from highlighted methods -----------------
    if (data.temporal && methods.size > 0) {
      const lower = new Set([...methods].map(m => m.toLowerCase()));
      data.temporal.forEach(t => {
        if (t.methods.some(m => lower.has(m.toLowerCase()))) years.add(t.year);
      });
    }

    // Benchmark fan-out from method list (data.benchmarkCoverage stores
    // benchmark → methods, the inverse of what we just built). Catches
    // benchmark dimension highlighting even when its node isn't in the
    // macroGraph (some benchmark entries come from CSV-only pipeline).
    if (data.benchmarkCoverage && methods.size > 0) {
      const lower = new Set([...methods].map(m => m.toLowerCase()));
      data.benchmarkCoverage.forEach(b => {
        if (b.methods && b.methods.some(m => lower.has((m || '').toLowerCase()))) {
          benchmarks.add(b.dataset);
        }
      });
    }

    // Hover preview — additive label only (doesn't shift selection state)
    if (hoverEntity && hoverEntity.label) labels.add(hoverEntity.label);

    return { methods, papers, techniques, institutions, authors, externalRefs, benchmarks, years, labels };
  }, [data, selectedYear, selectedGraphNode, selectedTechnique, selectedInstitution,
      selectedAuthor, selectedExternalRef, selectedTopCited, macroGraph, hoverEntity,
      scatterData, hoveredIndex, selectedPoint, graphView, predGraph]);

  const highlightedMethods       = _highlightResolution.methods;
  const highlightedPapers        = _highlightResolution.papers;
  const highlightedTechniques    = _highlightResolution.techniques;
  const highlightedInstitutions  = _highlightResolution.institutions;
  const highlightedAuthors       = _highlightResolution.authors;
  const highlightedExternalRefs  = _highlightResolution.externalRefs;
  const highlightedBenchmarks    = _highlightResolution.benchmarks;
  const highlightedYears         = _highlightResolution.years;
  const highlightedLabels        = _highlightResolution.labels;
  const hasAnyHighlight          = highlightedLabels.size > 0;

  // One-selection-at-a-time helpers. Clicking any filter chip clears the
  // others so highlights never union confusingly across dimensions.
  const pickTechnique = useCallback((name) => {
    setSelectedTechnique(name);
    if (name) {
      setSelectedYear(null); setSelectedInstitution(null);
      setSelectedAuthor(null); setSelectedExternalRef(null);
      setSelectedGraphNode(null); setNodeSelection(null);
    }
  }, []);
  const pickYear = useCallback((year) => {
    setSelectedYear(year);
    if (year) {
      setSelectedTechnique(null); setSelectedInstitution(null);
      setSelectedAuthor(null); setSelectedExternalRef(null);
      setSelectedGraphNode(null); setNodeSelection(null);
    }
  }, []);
  const pickInstitution = useCallback((name) => {
    setSelectedInstitution(name);
    if (name) {
      setSelectedTechnique(null); setSelectedYear(null);
      setSelectedAuthor(null); setSelectedExternalRef(null);
      setSelectedGraphNode(null); setNodeSelection(null);
    }
  }, []);
  const pickAuthor = useCallback((name) => {
    setSelectedAuthor(name);
    if (name) {
      setSelectedTechnique(null); setSelectedYear(null);
      setSelectedInstitution(null); setSelectedExternalRef(null);
      setSelectedGraphNode(null); setNodeSelection(null);
    }
  }, []);
  const pickTopCited = useCallback((paper) => {
    setSelectedTopCited(paper);
    if (paper) {
      setSelectedTechnique(null); setSelectedYear(null);
      setSelectedInstitution(null); setSelectedAuthor(null);
      setSelectedExternalRef(null); setSelectedGraphNode(null); setNodeSelection(null);
    }
  }, []);
  const pickExternalRef = useCallback((name) => {
    setSelectedExternalRef(name);
    if (name) {
      setSelectedTechnique(null); setSelectedYear(null);
      setSelectedInstitution(null); setSelectedAuthor(null);
      setSelectedTopCited(null);
      setSelectedGraphNode(null); setNodeSelection(null);
    }
  }, []);

  // Click in empty space → clear every highlight selection.
  // Triggered from the root .kgl-page div; we ignore clicks whose target
  // sits inside a card, the graph stage, the toolbar, or the filter panel.
  // Reason: highlights are sticky (intentional, so the user can scan
  // multiple cards) but there's no obvious way to undo them without
  // hunting for the right "Clear" button. Clicking the page background is
  // the standard escape hatch — also matches Explorer's scatter-deselect.
  const clearAllSelections = useCallback(() => {
    setSelectedTechnique(null);
    setSelectedYear(null);
    setSelectedInstitution(null);
    setSelectedAuthor(null);
    setSelectedExternalRef(null);
    setSelectedTopCited(null);
    setSelectedGraphNode(null);
    setNodeSelection(null);
    setEdgeSelection(null);
  }, []);
  const handleBackgroundClick = useCallback((e) => {
    // Anything that visually "is a thing" lives inside one of these. If
    // the click target is outside ALL of them, treat as background.
    const inThing = e.target.closest(
      '.kgl-card, .scatter-panel, .viz-toolbar, .kg-filter-panel, ' +
      '.kgl-graph-panel, .kgl-pred-slider, .kgl-pred-legend, ' +
      '.kgl-pred-toggle, .kgl-graph-stage'
    );
    if (!inThing) clearAllSelections();
  }, [clearAllSelections]);

  const bottomPanelRef = React.useRef(null);
  useEffect(() => { setPanelExpanded(false); }, [nodeSelection?.node?.id, edgeSelection?.edge?.id]);
  useEffect(() => {
    if (panelExpanded && bottomPanelRef.current) {
      setTimeout(() => bottomPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, [panelExpanded]);

  const handleGraphNodeClick = useCallback(node => {
    if (!node) return;
    setSelectedGraphNode(prev => prev?.id === node.id ? null : node);
    // Reset coarser sidebar selections when drilling into a specific graph node —
    // otherwise their highlights union and the "drill-in" experience gets lost.
    // Exception: technique click syncs to the Techniques-chart selection.
    if (node.type === 'technique') {
      setSelectedTechnique(prev => prev === node.label ? null : node.label);
    } else {
      setSelectedTechnique(null);
    }
    setSelectedYear(null);
    setSelectedInstitution(null);
    setSelectedAuthor(null);
    setSelectedExternalRef(null);
  }, []);

  if (loading) return <div className="kgl-loading"><div className="gr-loading-bar" />Loading knowledge graph...</div>;
  if (!data) return <div className="kgl-loading">Knowledge graph not available.</div>;

  const s = data.summary;

  return (
    <div className="kgl-page" onClick={handleBackgroundClick}>
      {/* ── Exact Explorer layout: scatter-section > viz-toolbar > content ── */}
      <div className="scatter-section">
        <div className="viz-toolbar">
          <button
            className={`viz-toggle-btn ${graphView === 'macro' ? 'active' : ''}`}
            onClick={() => setGraphView('macro')}
          >
            Knowledge Graph
          </button>
          <button
            className={`viz-toggle-btn ${graphView === 'predictions' ? 'active' : ''}`}
            onClick={() => setGraphView('predictions')}
            title="Suggested relationships based on shared techniques, benchmarks, and research patterns. Dashed edges = suggested, not yet documented."
          >
            Predicted Relationships
          </button>
          {graphView === 'predictions' && (
            <>
              <div className="kgl-pred-slider">
                <label>min confidence</label>
                <input type="range" min="0.5" max="0.9" step="0.01"
                       value={predMinConf}
                       onChange={e => setPredMinConf(parseFloat(e.target.value))} />
                <span>{predMinConf.toFixed(2)}</span>
              </div>
              <button
                className={`kgl-pred-toggle ${predShowExisting ? 'on' : 'off'}`}
                onClick={() => setPredShowExisting(v => !v)}
                title="Show documented relationships alongside suggested ones for comparison."
              >
                <span className="kgl-pred-swatch kgl-pred-swatch-obs" />
                <span className="kgl-pred-toggle-label">show existing</span>
              </button>
              {predCounts && (() => {
                const PRED_GROUPS = [
                  { key: 'comparisons', label: 'Comparisons', types: ['outperforms', 'compares', 'compared_against'],
                    color: '#b14b1f', title: 'Performance comparisons and benchmark pairings between methods.' },
                  { key: 'claims',      label: 'Claims',      types: ['contributes', 'has_limitation', 'addresses_problem'],
                    color: '#2b6cb0', title: 'Research claims: contributions, limitations, and problems addressed.' },
                  { key: 'methodology', label: 'Methodology', types: ['uses_technique'],
                    color: '#7c3aed', title: 'Techniques and methods these papers likely use.' },
                ];
                return (
                  <div className="kgl-pred-legend">
                    {PRED_GROUPS.map(g => {
                      const n = g.types.reduce((s, t) => s + (predCounts[t] || 0), 0);
                      if (!n) return null;
                      return (
                        <button key={g.key}
                          className={`kgl-pred-legend-btn ${predTypeFilter === g.key ? 'active' : ''} ${predTypeFilter && predTypeFilter !== g.key ? 'inactive' : ''}`}
                          onClick={() => setPredTypeFilter(predTypeFilter === g.key ? null : g.key)}
                          title={g.title}
                        >
                          <span className="kgl-pred-legend-swatch" style={{ background: g.color }} />
                          {g.label}
                          <span className="kgl-pred-legend-count">{n}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </>
          )}
          <button
            className={`viz-toggle-btn weights-toggle ${filtersOpen ? 'active' : ''}`}
            onClick={() => setFiltersOpen(v => !v)}
          >
            {filtersOpen ? 'Hide Filters' : 'Filters'}
          </button>
        </div>
        {filtersOpen && (
          <KGFilterPanel
            searchTerm={searchTerm} onSearchChange={setSearchTerm}
            hiddenEdgeTypes={hiddenEdgeTypes}
            onToggleEdgeGroup={toggleEdgeGroup}
            isEdgeGroupHidden={isEdgeGroupHidden}
            minDegree={minDegree} onMinDegreeChange={setMinDegree}
            yearRange={yearRange}
            yearBounds={data && data.temporal && data.temporal.length
              ? [Math.min(...data.temporal.map(t => t.year)), Math.max(...data.temporal.map(t => t.year))]
              : [null, null]}
            onYearChange={setYearRange}
            onClear={clearFilters}
          />
        )}
        {/* Two-mode detail layout:
            COMPACT (default): side panel to the right of the graph in
            a CSS grid. Paper nodes show identity + spec card + ribbons
            with an Expand CTA. Other node types show their full content.
            EXPANDED (click Expand): side panel closes, full-width
            bottom panel docks below the graph inside .kgl-graph-panel.
            This reuses the existing 2-column CSS-column layout the
            bottom panel already has (.kgl-graph-panel .kgnd-panel). */}
        <div className={`scatter-content kgl-graph-stage ${!panelExpanded && (nodeSelection || edgeSelection) ? 'has-side-panel' : ''}`}>
          <div className={`scatter-panel kgl-graph-panel ${panelExpanded && nodeSelection ? 'has-detail' : ''}`}>
            <KGGraphViz
              key={graphView + '-' + predMinConf + '-' + (predShowExisting ? 'ov' : 'only') + '-' + (predTypeFilter || 'all')}
              height={480}
              onNodeClick={handleGraphNodeClick}
              selectedNode={selectedGraphNode}
              onNodeSelect={(s) => { setEdgeSelection(null); setNodeSelection(s); }}
              onEdgeSelect={(e) => { setNodeSelection(null); setSelectedGraphNode(null); setEdgeSelection(e); }}
              refitTrigger={`${!!nodeSelection}-${!!edgeSelection}-${searchTerm}-${predTypeFilter}-${panelExpanded}`}
              hiddenEdgeTypes={(() => {
                if (graphView !== 'predictions' || !predTypeFilter) return hiddenEdgeTypes;
                const PRED_FILTER_MAP = {
                  comparisons: new Set(['outperforms', 'compares', 'compared_against']),
                  claims: new Set(['contributes', 'has_limitation', 'addresses_problem']),
                  methodology: new Set(['uses_technique']),
                };
                const keep = PRED_FILTER_MAP[predTypeFilter];
                if (!keep) return hiddenEdgeTypes;
                const ALL_PRED_TYPES = ['outperforms', 'compares', 'compared_against',
                  'contributes', 'has_limitation', 'addresses_problem', 'uses_technique'];
                const toHide = ALL_PRED_TYPES.filter(t => !keep.has(t));
                return new Set([...hiddenEdgeTypes, ...toHide]);
              })()}
              minDegree={minDegree}
              searchTerm={searchTerm}
              dataUrl={graphView === 'predictions'
                ? 'kg-predictions'
                : 'kg-macro'}
              viewName={graphView === 'predictions' ? 'predictions' : 'macro'}
              inferredEdgesDashed={graphView === 'predictions'}
              minConfidence={graphView === 'predictions' ? predMinConf : 0}
              highlightedLabels={highlightedLabels}
              dimUnhighlighted={hasAnyHighlight}
            />
            {panelExpanded && nodeSelection && (
              <div ref={bottomPanelRef}>
                <KGNodeDetail
                  selection={nodeSelection}
                  onClose={() => { setNodeSelection(null); setSelectedGraphNode(null); setPanelExpanded(false); }}
                  onNodeClick={handleGraphNodeClick}
                  onHoverEntity={setHoverEntity}
                  placement="bottom"
                  expanded={true}
                  onToggleExpanded={() => setPanelExpanded(false)}
                />
              </div>
            )}
          </div>
          {!panelExpanded && nodeSelection && (
            <div className="kgl-side-detail">
              <KGNodeDetail
                selection={nodeSelection}
                onClose={() => { setNodeSelection(null); setSelectedGraphNode(null); }}
                onNodeClick={handleGraphNodeClick}
                onHoverEntity={setHoverEntity}
                placement="side"
                expanded={false}
                onToggleExpanded={() => setPanelExpanded(true)}
              />
            </div>
          )}
          {!panelExpanded && edgeSelection && !nodeSelection && (
            <div className="kgl-side-detail">
              <KGEdgeDetail
                selection={edgeSelection}
                onClose={() => setEdgeSelection(null)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Three semantic bands:
          - Band 1 (connectors A): Techniques · Timeline · Benchmarks · Top Cited
          - Band 2 (connectors B): Institutions · Authors · Foundational Works
          - Band 3 (aggregates):  Citation Stance + Research Gaps (matrix wider)
          Splitting like this groups the cross-highlighting bar charts together
          on top and keeps the two summary visualizations on their own row so
          neither competes for matrix width and the stance card has the
          horizontal space it needs for its divergent bar. */}
      <div className="kgl-bottom">
        <div className="kgl-band kgl-band-connectors">
          <SidePanel
            data={data}
            selectedTechnique={selectedTechnique}
            onTechSelect={pickTechnique}
            selectedYear={selectedYear}
            onYearClick={pickYear}
            highlightedMethods={highlightedMethods}
            highlightedTechniques={highlightedTechniques}
            highlightedYears={highlightedYears}
          />
          <Benchmarks
            data={data.benchmarkCoverage}
            highlightedMethods={highlightedMethods}
            highlightedBenchmarks={highlightedBenchmarks}
          />
          <TopCited
            topCited={data.topCited}
            selectedTopCited={selectedTopCited}
            onTopCitedSelect={pickTopCited}
            highlightedMethods={highlightedMethods}
            highlightedPapers={highlightedPapers}
          />
        </div>
        <div className="kgl-band kgl-band-connectors">
          <CommunityPanel
            data={data}
            selectedInstitution={selectedInstitution}
            onInstitutionSelect={pickInstitution}
            selectedAuthor={selectedAuthor}
            onAuthorSelect={pickAuthor}
            selectedExternalRef={selectedExternalRef}
            onExternalRefSelect={pickExternalRef}
            highlightedMethods={highlightedMethods}
            highlightedLabels={highlightedLabels}
            highlightedInstitutions={highlightedInstitutions}
            highlightedAuthors={highlightedAuthors}
            highlightedExternalRefs={highlightedExternalRefs}
            highlightedPapers={highlightedPapers}
          />
        </div>
        <div className="kgl-band kgl-band-aggregates">
          <CitationStance data={data} />
          <GapMatrix highlightedMethods={highlightedMethods} />
        </div>
      </div>

    </div>
  );
}
