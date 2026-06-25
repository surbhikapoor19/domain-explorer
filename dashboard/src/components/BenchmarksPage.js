import React, { useState, useEffect, useMemo } from 'react';
import Tooltip from './Tooltip';
import ReproducibilityView from './ReproducibilityView';
import CoverageMatrix from './CoverageMatrix';
import PaperTrailDrawer from './PaperTrailDrawer';
import ConditionSpine from './ConditionSpine';
import { loadBenchmarkComparisons, loadMethods } from '../lib/data-loader';
import { buildCells, filterCells, buildMethodsIndex } from '../lib/benchmark-cells';

// Reusable help affordance, matching the rest of the app's "?" tooltips.
const Help = ({ text }) => (
  <Tooltip text={text} wide><span className="chart-help">?</span></Tooltip>
);

// -----------------------------------------------------------------------------

export default function BenchmarksPage({
  data,
  selectedPoint,
  onSelect,
  minConfidence = 0.70,
  incomingPageRef,
}) {
  const [benchmarkData, setBenchmarkData] = useState(null);
  const [loading, setLoading]             = useState(true);
  const [showLowConf, setShowLowConf]     = useState(false);  // "Show all" confidence escape hatch
  // The page has two top-level modes: the default "agreement" landing and the
  // "coverage" gap-finder matrix. The cell drill-down is a DRAWER, not a tab.
  const [viewMode, setViewMode]           = useState('agreement'); // 'agreement' | 'coverage'
  const [drawerOpen, setDrawerOpen]       = useState(false);
  const [pendingRef, setPendingRef]       = useState(null); // copilot draft, applied on confirm
  // The cell-scoped drill-down targets ONE (metric × condition) cell by key.
  const [activeCellKey, setActiveCellKey] = useState(null);
  // The condition spine's facet filter: { metricId?, scene?, success_criterion? }.
  const [conditionFilter, setConditionFilter] = useState({});
  // Method-attribute filter ({ gripper?, sensor?, learning_paradigm? }).
  const [attrFilter, setAttrFilter]           = useState({});
  // The methods.json index (KG/CSV join) for method-attribute facets.
  const [methodsIndex, setMethodsIndex]       = useState(null);
  // The in-app walkthrough help modal.
  const [helpOpen, setHelpOpen]               = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadBenchmarkComparisons()
      .then(d => {
        if (!cancelled) {
          setBenchmarkData(d);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Load the methods index for the KG/CSV method-attribute join.
  useEffect(() => {
    loadMethods()
      .then((m) => setMethodsIndex(buildMethodsIndex(m)))
      .catch(() => setMethodsIndex(new Map()));
  }, []);

  // ── Deep-link handshake: incomingPageRef stages a DRAFT (no immediate apply). ──
  // The copilot's pageRef stages an editable "Copilot applied: …" banner; the
  // view only moves once the user clicks Apply.
  useEffect(() => {
    setPendingRef(incomingPageRef || null);
  }, [incomingPageRef]);

  const crossValidations = benchmarkData?.cross_validations || [];
  const stats            = benchmarkData?.stats || {};
  const quarantine       = benchmarkData?.quarantine || {};
  const cellContext      = benchmarkData?.cell_context || {};

  // All merged cells (metric × condition) from the shared alignment module.
  const allCells = useMemo(() => buildCells(benchmarkData), [benchmarkData]);

  // The condition spine is now persistent across BOTH the Agreement and Coverage
  // modes, so the metric label is always stated canonically in the spine. We
  // therefore never repeat it on the agreement cards — keeping each metric label
  // in exactly one canonical place on the page (the spine) and avoiding a
  // duplicated metric token between the spine chip and the card group title.
  const showMetricOnCards = useMemo(() => {
    // Multiple metrics in scope → label each agreement group by its metric (a
    // useful inline section divider when scrolling). A single-metric domain
    // states the metric once in the spine and keeps the rows metric-free.
    const ids = new Set(allCells.map(c => c.metric_id));
    return ids.size > 1;
  }, [allCells]);

  // THE single filter — identical to the composer's live counts (both call
  // filterCells), so a bracket count can never disagree with what the page shows.
  // Combines the condition facets (metric/scene/criterion) with the method-attribute
  // facets (gripper/sensor/learning_paradigm). No facets selected => every cell.
  const visibleCells = useMemo(() => {
    if (!benchmarkData) return [];
    const selection = {
      metricId: conditionFilter.metricId,
      scene: conditionFilter.scene,
      success_criterion: conditionFilter.success_criterion,
      gripper: attrFilter.gripper,
      sensor: attrFilter.sensor,
      learning_paradigm: attrFilter.learning_paradigm,
    };
    return filterCells(allCells, selection, methodsIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchmarkData, allCells, conditionFilter, attrFilter, methodsIndex]);

  // Set of cell keys currently in scope (for filtering cross-validations).
  const visibleCellKeys = useMemo(
    () => new Set(visibleCells.map(c => c.key)),
    [visibleCells]
  );

  // Confidence gate — below the threshold the extracted numbers are unreliable
  // (grade C / weak / disputed) and are hidden. "Show all" ignores the gate.
  const passesConf = (x) =>
    showLowConf || (typeof x?.confidence === 'number' ? x.confidence : 1) >= minConfidence;

  // Cross-validations shown in the reproducibility buckets: pass the confidence
  // gate AND fall inside a spine-visible (metric × condition) cell.
  const visibleCrossValidations = useMemo(() => {
    return crossValidations
      .filter(passesConf)
      .filter(cv => {
        // Map each CV to its cell via the merged cells (metric_id + condition).
        const cond = cv.condition == null ? '' : String(cv.condition);
        const cell = allCells.find(
          c => c.metric_id === cv.metric_id && c.condition === cond
        );
        // If the CV has a backing cell, require it to be in scope; if it has no
        // backing leaderboard cell, keep it only when no facet filter is set.
        if (cell) return visibleCellKeys.has(cell.key);
        return visibleCellKeys.size === allCells.length; // no facet narrowing
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossValidations, allCells, visibleCellKeys, showLowConf, minConfidence]);

  // Cell keys that already appear as a cross-validation in the buckets — so we
  // don't double-list them under "Not yet reproduced".
  const reproducedCellKeys = useMemo(() => {
    const s = new Set();
    for (const cv of visibleCrossValidations) {
      const cond = cv.condition == null ? '' : String(cv.condition);
      const cell = allCells.find(c => c.metric_id === cv.metric_id && c.condition === cond);
      if (cell) s.add(cell.key);
    }
    return s;
  }, [visibleCrossValidations, allCells]);

  // Cells with leaderboard entries but no cross-validation in scope: surface
  // them as "Not yet reproduced", confidence-filtering their entries so they
  // honour the same threshold as everything else.
  const unreproducedCells = useMemo(() => {
    return visibleCells
      .filter(cell => !reproducedCellKeys.has(cell.key))
      .map(cell => ({
        ...cell,
        entries: (cell.entries || []).filter(passesConf),
      }))
      .filter(cell => cell.entries.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCells, reproducedCellKeys, showLowConf, minConfidence]);

  // The cell currently open in the Comparisons drill-down, with its entries
  // confidence-filtered to match the rest of the page.
  const activeCell = useMemo(() => {
    if (!activeCellKey) return null;
    const cell = allCells.find(c => c.key === activeCellKey);
    if (!cell) return null;
    return { ...cell, entries: (cell.entries || []).filter(passesConf) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCellKey, allCells, showLowConf, minConfidence]);

  // Open the cell-scoped PaperTrail drawer for a given cell key.
  const openCell = (cellKey) => { setActiveCellKey(cellKey); setDrawerOpen(true); };
  const closeDrawer = () => setDrawerOpen(false);

  // -------------------------------------------------------------------------
  // Loading / empty states
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="benchmarks-page">
        <div className="benchmarks-loading">Loading benchmark data...</div>
      </div>
    );
  }

  if (!benchmarkData || allCells.length === 0) {
    return (
      <div className="benchmarks-page">
        <div className="benchmarks-empty">
          No benchmark comparison data available for this domain yet.
        </div>
      </div>
    );
  }

  // ── Copilot draft (pendingRef) — staged but not applied until "Apply". ──────
  // Map a pageRef.conditionFilter into the spine's filter shape.
  const pendingFilter = (() => {
    const cf = pendingRef && pendingRef.conditionFilter;
    if (!cf || typeof cf !== 'object') return {};
    const next = {};
    for (const k of ['metricId', 'scene', 'success_criterion', 'gripper', 'sensor', 'learning_paradigm']) {
      if (cf[k] != null) next[k] = cf[k];
    }
    return next;
  })();
  // Does the draft's cell actually exist? (null cellKey = filter-only draft = resolves.)
  const pendingCellResolves = pendingRef && pendingRef.cellKey
    ? allCells.some(c => c.key === pendingRef.cellKey)
    : Boolean(pendingRef);
  // Human summary of the draft (metric label + scene + criterion).
  const pendingSummary = (() => {
    if (!pendingRef) return '';
    const parts = [];
    if (pendingFilter.metricId) {
      const m = allCells.find(c => c.metric_id === pendingFilter.metricId);
      parts.push(m ? (m.metric_label || pendingFilter.metricId) : pendingFilter.metricId);
    }
    if (pendingFilter.scene) parts.push(pendingFilter.scene);
    if (pendingFilter.success_criterion) parts.push(pendingFilter.success_criterion);
    return parts.join(' · ');
  })();
  const applyPendingRef = () => {
    if (!pendingRef) return;
    // Apply the copilot's facets to the (optional) filters, then open the cell.
    setConditionFilter({ metricId: pendingFilter.metricId, scene: pendingFilter.scene, success_criterion: pendingFilter.success_criterion });
    setAttrFilter({ gripper: pendingFilter.gripper, sensor: pendingFilter.sensor, learning_paradigm: pendingFilter.learning_paradigm });
    if (pendingRef.cellKey && pendingCellResolves) openCell(pendingRef.cellKey);
    setPendingRef(null);
  };
  const dismissPendingRef = () => setPendingRef(null);

  return (
    <div className="benchmarks-page">

      {/* ── Page toolbar — always present (the "?" help affordance lives here). */}
      <div className="benchmarks-page-toolbar">
        <button type="button" className="benchmarks-help-btn" aria-label="How to use this page" title="How to use this page" onClick={() => setHelpOpen(true)}>?</button>
      </div>

      {/* ── Copilot draft banner — staged pageRef, applied on confirm. ─────
       * Always rendered so a copilot deep-link can be surfaced; Apply commits
       * the facets to the (optional) filters via applyPendingRef. */}
      {pendingRef && (
        <div className="benchmarks-copilot-banner">
          <span className="benchmarks-copilot-banner-label">
            Copilot applied: <strong>{pendingSummary || 'this view'}</strong>
          </span>
          {!pendingCellResolves && (
            <span className="benchmarks-copilot-nomatch">no matched comparison available</span>
          )}
          <span className="benchmarks-copilot-banner-actions">
            <button type="button" className="benchmarks-tab" onClick={applyPendingRef}>Apply</button>
            <button type="button" className="benchmarks-tab" onClick={dismissPendingRef}>Dismiss</button>
          </span>
        </div>
      )}

      {/* ── Show-all-by-default: every extracted comparison is visible; the
           condition spine below is OPTIONAL refinement, never a gate. ───────── */}
      <>
          <p className="benchmarks-orientation">
            Every head-to-head result we could extract from the papers, grouped by metric.
            Browse them all below — or use the filters to narrow to a specific metric or condition.
          </p>

          {/* ── Stats bar ──────────────────────────────────────────────── */}
          <div className="benchmarks-stats-bar">
            <div className="benchmarks-stat">
              <span className="benchmarks-stat-value">{stats.n_comparisons ?? '—'}</span>
              <span className="benchmarks-stat-label">comparisons <Help text="Head-to-head results extracted from papers where one method directly outperformed another on the same metric and condition." /></span>
            </div>
            <div className="benchmarks-stat">
              <span className="benchmarks-stat-value">{stats.n_leaderboards ?? '—'}</span>
              <span className="benchmarks-stat-label">benchmarks <Help text="Distinct metric + condition cells (e.g. success rate on pile scenes). Drill into one to compare the methods measured under those exact conditions." /></span>
            </div>
            <div className="benchmarks-stat">
              <span className="benchmarks-stat-value">{stats.n_methods_indexed ?? '—'}</span>
              <span className="benchmarks-stat-label">methods</span>
            </div>
            <div className="benchmarks-stat">
              <span className="benchmarks-stat-value">{stats.n_cross_validations ?? '—'}</span>
              <span className="benchmarks-stat-label">cross-paper <Help text="Numbers reported for the same method + metric by 2+ independent papers — the basis for the reproducibility consistency check." /></span>
            </div>
          </div>

          {/* ── View toggle: Agreement ⇄ Coverage ──────────────────────── */}
          <div className="benchmarks-tabs benchmarks-viewtoggle">
            <button className={`benchmarks-tab ${viewMode === 'agreement' ? 'active' : ''}`} onClick={() => setViewMode('agreement')}>Agreement</button>
            <button className={`benchmarks-tab ${viewMode === 'coverage' ? 'active' : ''}`} onClick={() => setViewMode('coverage')}>Coverage</button>
          </div>

          {/* ── Condition spine (persistent facet filter bar) ────────────── */}
          <ConditionSpine benchmarkData={benchmarkData} value={conditionFilter} onChange={setConditionFilter} />

          {/* ── Confidence filter (driven by the global Min-confidence control). */}
          <div className="benchmarks-confidence-toggle">
            <label>
              <input
                type="checkbox"
                checked={showLowConf}
                onChange={e => setShowLowConf(e.target.checked)}
              />
              Show all (including below {Math.round(minConfidence * 100)}% confidence)
            </label>
          </div>

          {/* AGREEMENT VIEW — default landing */}
          {viewMode === 'agreement' && (
            <ReproducibilityView
              crossValidations={visibleCrossValidations}
              totalCrossValidations={crossValidations.length}
              minConfidence={minConfidence}
              unreproducedCells={unreproducedCells}
              onOpenCell={openCell}
              showMetric={showMetricOnCards}
            />
          )}

          {/* COVERAGE VIEW — condition × metric gap-finder matrix */}
          {viewMode === 'coverage' && (
            <CoverageMatrix
              benchmarkData={benchmarkData}
              conditionFilter={conditionFilter}
              onOpenCell={openCell}
            />
          )}

          {/* ── Quarantine footnote ──────────────────────────────────── */}
          {(stats.n_quarantined > 0 || quarantine.n_records > 0) && (
            <div className="benchmarks-quarantine-note">
              <strong>{stats.n_quarantined ?? quarantine.n_records}</strong> record{(stats.n_quarantined ?? quarantine.n_records) !== 1 ? 's' : ''} withheld (low quality)
              {quarantine.reasons && Object.keys(quarantine.reasons).length > 0 && (
                <span className="benchmarks-quarantine-reasons">
                  {' — '}
                  {Object.entries(quarantine.reasons)
                    .map(([reason, count]) => `${count} ${reason.replace(/_/g, ' ')}`)
                    .join(', ')}
                </span>
              )}
              . These rows had unresolvable headers or unmatched method names and were excluded from all analysis.
            </div>
          )}
      </>

      {/* ── Cell drill-down drawer (overlay) ────────────────────────────── */}
      {drawerOpen && activeCell && (
        <PaperTrailDrawer
          cell={activeCell}
          cellContext={cellContext}
          methodsIndex={methodsIndex}
          data={data}
          selectedPoint={selectedPoint}
          onSelect={onSelect}
          onClose={closeDrawer}
        />
      )}

      {/* ── In-app walkthrough help modal ───────────────────────────────── */}
      {helpOpen && (
        <div className="benchmarks-help-modal" role="dialog" aria-modal="true">
          <div className="benchmarks-help-backdrop" onClick={() => setHelpOpen(false)} aria-hidden="true" />
          <div className="benchmarks-help-panel">
            <button type="button" className="benchmarks-help-close" aria-label="Close" onClick={() => setHelpOpen(false)}>×</button>
            <iframe title="Benchmarks walkthrough" src="/benchmark-walkthrough.html" />
          </div>
        </div>
      )}
    </div>
  );
}
