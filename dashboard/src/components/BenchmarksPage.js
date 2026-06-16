import React, { useState, useEffect, useMemo } from 'react';
import Tooltip from './Tooltip';
import ReproducibilityView from './ReproducibilityView';
import ComparisonsView from './ComparisonsView';
import ConditionSpine from './ConditionSpine';
import { loadBenchmarkComparisons } from '../lib/data-loader';
import { buildCells, findCells } from '../lib/benchmark-cells';

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
  // The page has two views: the default "reproducibility" landing and the
  // cell-scoped "comparisons" drill-down. activeView starts on reproducibility.
  const [activeView, setActiveView]       = useState('reproducibility');
  // The cell-scoped drill-down targets ONE (metric × condition) cell by key.
  const [activeCellKey, setActiveCellKey] = useState(null);
  // The condition spine's facet filter: { metricId?, scene?, success_criterion? }.
  const [conditionFilter, setConditionFilter] = useState({});

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

  // ── Deep-link handshake: incomingPageRef opens a view / cell / filter. ──────
  // pageRef shape: { view: "reproducibility"|"comparisons", cellKey, conditionFilter }.
  useEffect(() => {
    if (!incomingPageRef) return;
    const { view, cellKey, conditionFilter: cf } = incomingPageRef;
    if (cf && typeof cf === 'object') {
      // conditionFilter from a pageRef uses facet names (scene / success_criterion).
      const next = {};
      if (cf.metricId != null) next.metricId = cf.metricId;
      if (cf.scene != null) next.scene = cf.scene;
      if (cf.success_criterion != null) next.success_criterion = cf.success_criterion;
      setConditionFilter(next);
    }
    if (cellKey != null) setActiveCellKey(cellKey);
    if (view === 'comparisons') {
      setActiveView('comparisons');
    } else if (view === 'reproducibility') {
      setActiveView('reproducibility');
    }
  }, [incomingPageRef]);

  const crossValidations = benchmarkData?.cross_validations || [];
  const stats            = benchmarkData?.stats || {};
  const quarantine       = benchmarkData?.quarantine || {};

  // All merged cells (metric × condition) from the shared alignment module.
  const allCells = useMemo(() => buildCells(benchmarkData), [benchmarkData]);

  // When the whole domain has a single metric, the metric is a constant — it is
  // stated once in the spine and we don't repeat it on every card (which also
  // keeps each metric label in one canonical place on the page).
  const showMetricOnCards = useMemo(() => {
    const ids = new Set(allCells.map(c => c.metric_id));
    return ids.size > 1;
  }, [allCells]);

  // The spine filter narrows the visible cells via findCells(). With no facets
  // selected, every cell is in scope.
  const visibleCells = useMemo(() => {
    if (!benchmarkData) return [];
    const hasFacets =
      (conditionFilter.metricId != null && conditionFilter.metricId !== '') ||
      (conditionFilter.scene != null && conditionFilter.scene !== '') ||
      (conditionFilter.success_criterion != null && conditionFilter.success_criterion !== '');
    if (!hasFacets) return allCells;
    const { matched } = findCells(benchmarkData, {
      metricId: conditionFilter.metricId,
      facets: {
        scene: conditionFilter.scene,
        success_criterion: conditionFilter.success_criterion,
      },
    });
    return matched;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchmarkData, allCells, conditionFilter]);

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

  // Open the cell-scoped Comparisons view for a given cell key.
  const openCell = (cellKey) => {
    setActiveCellKey(cellKey);
    setActiveView('comparisons');
  };

  const backToReproducibility = () => {
    setActiveView('reproducibility');
  };

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

  return (
    <div className="benchmarks-page">

      {/* ── Stats bar ──────────────────────────────────────────────────── */}
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

      {/* ── Tabs (views) ───────────────────────────────────────────────── */}
      <div className="benchmarks-tabs">
        <button
          className={`benchmarks-tab ${activeView === 'reproducibility' ? 'active' : ''}`}
          onClick={() => setActiveView('reproducibility')}
        >
          Reproducibility
        </button>
        <button
          className={`benchmarks-tab ${activeView === 'comparisons' ? 'active' : ''}`}
          onClick={() => setActiveView('comparisons')}
          disabled={!activeCellKey}
          title={activeCellKey ? '' : 'Pick a cell from the spine or a result to compare'}
        >
          Comparisons
        </button>
      </div>

      {/* ── Condition spine (persistent facet filter bar) ──────────────────
       * Persists across the reproducibility landing, where it picks among the
       * (metric × condition) cells. Inside a single cell-scoped Comparisons
       * drill-down the spine is hidden, because the cell header already states
       * the exact conditions — re-showing the facet chips there would be
       * redundant (and would double the scene/criterion tokens on screen). */}
      {activeView === 'reproducibility' && (
        <ConditionSpine
          benchmarkData={benchmarkData}
          value={conditionFilter}
          onChange={setConditionFilter}
        />
      )}

      {/* ── Confidence filter (driven by the global Min-confidence control) ─── */}
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

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* REPRODUCIBILITY VIEW — default landing                          */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {activeView === 'reproducibility' && (
        <ReproducibilityView
          crossValidations={visibleCrossValidations}
          totalCrossValidations={crossValidations.length}
          minConfidence={minConfidence}
          unreproducedCells={unreproducedCells}
          onOpenCell={openCell}
          showMetric={showMetricOnCards}
        />
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* COMPARISONS VIEW — cell-scoped drill-down                       */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {activeView === 'comparisons' && (
        <ComparisonsView
          cell={activeCell}
          data={data}
          selectedPoint={selectedPoint}
          onSelect={onSelect}
          onBack={backToReproducibility}
        />
      )}

      {/* ── Quarantine footnote ─────────────────────────────────────── */}
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
    </div>
  );
}
