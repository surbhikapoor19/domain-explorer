import React, { useState, useEffect, useMemo } from 'react';
import Plot from 'react-plotly.js';
import Tooltip from './Tooltip';
import AgreementView from './AgreementView';
import { loadBenchmarkComparisons } from '../lib/data-loader';

// Reusable help affordance, matching the rest of the app's "?" tooltips.
const Help = ({ text }) => (
  <Tooltip text={text} wide><span className="chart-help">?</span></Tooltip>
);

// --- helpers -----------------------------------------------------------------

function gradeClass(grade) {
  if (!grade) return '';
  const g = grade.toUpperCase();
  if (g === 'A') return 'benchmarks-grade-a';
  if (g === 'B') return 'benchmarks-grade-b';
  return 'benchmarks-grade-c';
}

function cvLabel(cv, n_reports) {
  if (!cv || n_reports < 2) return '';
  return `${Math.round(cv * 100)}%`;
}

// -----------------------------------------------------------------------------

export default function BenchmarksPage({ data, selectedPoint, onSelect, minConfidence = 0.70 }) {
  const [benchmarkData, setBenchmarkData] = useState(null);
  const [loading, setLoading]             = useState(true);
  const [selectedKey, setSelectedKey]     = useState(null);   // leaderboard key
  const [showLowConf, setShowLowConf]     = useState(false);  // "Show low-confidence" toggle
  // activeTab is null until data arrives, then defaults to the Agreement view
  // whenever there are independently-reproduced (consistent) results to show.
  // With no consistent cross-validations there is nothing for the agreement
  // hero to celebrate, so we fall back to the Leaderboards tab.
  const [activeTab, setActiveTab]         = useState(null);
  const [expandedSourceRow, setExpandedSourceRow] = useState(null); // method name or null

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadBenchmarkComparisons()
      .then(d => {
        if (!cancelled) {
          setBenchmarkData(d);
          // Set the first leaderboard key in the same tick so currentLb is
          // available on the very first render after data arrives.
          const keys = Object.keys(d?.leaderboards || {});
          if (keys.length > 0) setSelectedKey(k => k || keys[0]);
          // Land on the Agreement view by default when there is at least one
          // independently-reproduced result; otherwise show Leaderboards.
          const hasConsistent = (d?.cross_validations || [])
            .some(v => v.status === 'consistent');
          setActiveTab(t => t || (hasConsistent ? 'agreement' : 'leaderboards'));
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Build ordered list of leaderboard keys from v2 leaderboards map
  const leaderboardKeys = useMemo(() => {
    if (!benchmarkData?.leaderboards) return [];
    return Object.keys(benchmarkData.leaderboards);
  }, [benchmarkData]);

  const methodIndex      = benchmarkData?.method_index || {};
  const crossValidations = benchmarkData?.cross_validations || [];
  const stats            = benchmarkData?.stats || {};
  const quarantine       = benchmarkData?.quarantine || {};

  // Current leaderboard object (v2: {metric_label, condition, entries: [...], ...})
  const currentLb = useMemo(() => {
    if (!benchmarkData?.leaderboards || !selectedKey) return null;
    return benchmarkData.leaderboards[selectedKey] || null;
  }, [benchmarkData, selectedKey]);

  // Filter by the global minimum-confidence threshold. Below it, the extracted
  // numbers are likely unreliable (grade C / weak / disputed) and are hidden.
  // The local "show all" toggle is an escape hatch that ignores the threshold.
  const passesConf = (x) => (typeof x?.confidence === 'number' ? x.confidence : 1) >= minConfidence;
  const visibleEntries = useMemo(() => {
    if (!currentLb?.entries) return [];
    if (showLowConf) return currentLb.entries;
    return currentLb.entries.filter(passesConf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLb, showLowConf, minConfidence]);

  const visibleCrossValidations = useMemo(() => {
    if (showLowConf) return crossValidations;
    return crossValidations.filter(passesConf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossValidations, showLowConf, minConfidence]);

  // Win/loss summary for Head-to-Head tab
  const winLossSummary = useMemo(() => {
    const keep = (c) => (typeof c?.confidence === 'number' ? c.confidence : 1) >= (showLowConf ? 0 : minConfidence);
    return Object.entries(methodIndex)
      .map(([name, info]) => {
        const wins = (info.wins || []).filter(keep);
        const losses = (info.losses || []).filter(keep);
        return { name, ...info, wins, losses, n_wins: wins.length, n_losses: losses.length };
      })
      .filter(e => e.n_wins > 0 || e.n_losses > 0)   // drop methods with no comparisons above threshold
      .sort((a, b) => b.n_wins - a.n_wins);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methodIndex, minConfidence, showLowConf]);

  // Helper: label for dropdown option
  function lbOptionLabel(key) {
    const lb = benchmarkData.leaderboards[key];
    if (!lb) return key;
    const { metric_label, condition, dataset_id, entries } = lb;
    let label = metric_label || key;
    if (condition)  label += ` — ${condition}`;
    if (dataset_id) label += ` / ${dataset_id}`;
    label += ` (${entries.length} method${entries.length !== 1 ? 's' : ''})`;
    return label;
  }

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

  if (!benchmarkData || leaderboardKeys.length === 0) {
    return (
      <div className="benchmarks-page">
        <div className="benchmarks-empty">
          No benchmark comparison data available for this domain yet.
        </div>
      </div>
    );
  }

  // Chart data for leaderboard bar chart
  const chartEntries = [...visibleEntries].reverse();

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
          <span className="benchmarks-stat-label">benchmarks <Help text="Distinct metric + condition leaderboards (e.g. success rate on pile scenes) with at least two methods to rank." /></span>
        </div>
        <div className="benchmarks-stat">
          <span className="benchmarks-stat-value">{stats.n_methods_indexed ?? '—'}</span>
          <span className="benchmarks-stat-label">methods</span>
        </div>
        <div className="benchmarks-stat">
          <span className="benchmarks-stat-value">{stats.n_cross_validations ?? '—'}</span>
          <span className="benchmarks-stat-label">cross-paper <Help text="Numbers reported for the same method + metric by 2+ independent papers — the basis for the CV consistency check." /></span>
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <div className="benchmarks-tabs">
        <button
          className={`benchmarks-tab ${activeTab === 'agreement' ? 'active' : ''}`}
          onClick={() => setActiveTab('agreement')}
        >
          Agreement
        </button>
        <button
          className={`benchmarks-tab ${activeTab === 'leaderboards' ? 'active' : ''}`}
          onClick={() => setActiveTab('leaderboards')}
        >
          Leaderboards
        </button>
        <button
          className={`benchmarks-tab ${activeTab === 'head-to-head' ? 'active' : ''}`}
          onClick={() => setActiveTab('head-to-head')}
        >
          Head-to-Head
        </button>
      </div>

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
      {/* LEADERBOARDS TAB                                               */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {activeTab === 'leaderboards' && (
        <div className="benchmarks-leaderboard-section">

          {/* Metric selector */}
          <div className="benchmarks-metric-selector">
            <label>Metric / Benchmark:</label>
            <select
              value={selectedKey || ''}
              onChange={e => setSelectedKey(e.target.value)}
            >
              {leaderboardKeys.map(k => (
                <option key={k} value={k}>{lbOptionLabel(k)}</option>
              ))}
            </select>
          </div>

          {visibleEntries.length === 0 ? (
            <div className="benchmarks-empty benchmarks-empty-filtered">
              Nothing meets the {Math.round(minConfidence * 100)}% confidence threshold for this selection — pick a lower tier on the <em>Evidence</em> filter in the header (or &ldquo;All&rdquo;) to see every extracted result.
            </div>
          ) : (
            <>
              {/* Bar chart */}
              <div className="benchmarks-chart-container">
                <Plot
                  data={[{
                    type: 'bar',
                    orientation: 'h',
                    y: chartEntries.map(e => e.method),
                    x: chartEntries.map(e => e.value),
                    text: chartEntries.map(e =>
                      `${e.value}${e.n_reports > 1 ? ` (${e.n_reports} reports)` : ''}`
                    ),
                    textposition: 'outside',
                    marker: {
                      color: chartEntries.map((_, i, arr) =>
                        i === arr.length - 1 ? '#16657d' : '#93c5d6'
                      ),
                    },
                    hovertemplate: '%{y}: %{x}<br>Source: %{customdata}<extra></extra>',
                    customdata: chartEntries.map(e =>
                      (e.source_papers || []).join(', ').replace(/-/g, ' ')
                    ),
                  }]}
                  layout={{
                    title: {
                      text: currentLb
                        ? `${currentLb.metric_label}${currentLb.condition ? ' — ' + currentLb.condition : ''}`
                        : selectedKey,
                      font: { size: 14, color: '#2a3142' },
                    },
                    margin: { l: 200, r: 80, t: 40, b: 40 },
                    height: Math.max(250, visibleEntries.length * 36 + 80),
                    xaxis: {
                      title: currentLb?.metric_label || selectedKey,
                      gridcolor: '#ebeef2',
                    },
                    yaxis: { automargin: true },
                    plot_bgcolor: '#ffffff',
                    paper_bgcolor: '#ffffff',
                    font: { family: 'PT Sans, sans-serif', size: 11, color: '#2a3142' },
                  }}
                  config={{ displayModeBar: false, responsive: true }}
                  style={{ width: '100%' }}
                />
              </div>

              {/* Leaderboard table */}
              <div className="benchmarks-table-container">
                <table className="benchmarks-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Method</th>
                      <th>Score <Help text="The method's best reported value for this metric and condition, across every paper that reports it." /></th>
                      <th>Grade <Help text="Evidence grade — how much to trust this number. A = corroborated by multiple papers with consistent values; B = a single solid report (or minor spread); C = low-confidence (single weak report, or papers disagree)." /></th>
                      <th>CV% <Help text="Coefficient of Variation: the standard deviation divided by the mean of this method's score across independent papers, as a percent. Low = papers agree (trustworthy); high = they disagree. Shown only when 2+ papers report it." /></th>
                      <th>Source Paper(s) <Help text="The paper(s) the number was extracted from. Click 'Source' to see the exact table cell, caption, and a crop of the source table." /></th>
                      <th>Reports <Help text="How many distinct papers independently report this number. More papers = stronger corroboration. Several cells from one table count as a single report, not many." /></th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEntries.map((entry, i) => {
                      const isExpanded = expandedSourceRow === entry.method;
                      return (
                        <React.Fragment key={entry.method}>
                          <tr
                            className={[
                              i === 0 ? 'benchmarks-rank-1' : '',
                              selectedPoint?.name === entry.method ? 'benchmarks-selected' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => {
                              const match = (data || []).find(d => d.name === entry.method);
                              if (match && onSelect) onSelect(match);
                            }}
                          >
                            <td className="benchmarks-rank">{i + 1}</td>
                            <td className="benchmarks-method">{entry.method}</td>
                            <td className="benchmarks-score">{entry.value}</td>
                            <td className="benchmarks-grade-cell">
                              {entry.grade && (
                                <span className={`benchmarks-grade-badge ${gradeClass(entry.grade)}`}>
                                  {entry.grade}
                                </span>
                              )}
                            </td>
                            <td className="benchmarks-cv-cell">
                              {cvLabel(entry.cv, entry.n_reports)}
                            </td>
                            <td className="benchmarks-paper">
                              {(entry.source_papers || []).join(', ').replace(/-/g, ' ')}
                            </td>
                            <td className="benchmarks-reports">{entry.n_reports}</td>
                            <td className="benchmarks-source-col" onClick={e => e.stopPropagation()}>
                              {entry.sources && entry.sources.length > 0 && (
                                <button
                                  className={`benchmarks-source-btn${isExpanded ? ' active' : ''}`}
                                  onClick={() => setExpandedSourceRow(isExpanded ? null : entry.method)}
                                  aria-expanded={isExpanded}
                                >
                                  Source
                                </button>
                              )}
                            </td>
                          </tr>
                          {isExpanded && entry.sources && entry.sources.length > 0 && (
                            <tr className="benchmarks-source-row">
                              <td colSpan={8} className="benchmarks-source-panel-cell">
                                <div className="benchmarks-source-panel">
                                  {entry.sources.map((src, si) => (
                                    <div key={si} className="benchmarks-source-item">
                                      <div className="benchmarks-source-meta">
                                        <span className="benchmarks-source-value-str">{src.value_str}</span>
                                        <span className={`benchmarks-source-extractor-badge`}>{src.extractor}</span>
                                        <span className="benchmarks-source-paper">{(src.paper || '').replace(/-/g, ' ')}</span>
                                        {src.page != null && (
                                          <span className="benchmarks-source-page">p.{src.page}</span>
                                        )}
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
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* HEAD-TO-HEAD TAB                                               */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {activeTab === 'head-to-head' && (
        <div className="benchmarks-h2h-section">
          {winLossSummary.length === 0 ? (
            <div className="benchmarks-empty">No head-to-head comparison data available.</div>
          ) : (
            <>
              <div className="benchmarks-h2h-chart">
                <Plot
                  data={[
                    {
                      type: 'bar',
                      name: 'Wins',
                      orientation: 'h',
                      y: winLossSummary.slice(0, 20).reverse().map(e => e.name),
                      x: winLossSummary.slice(0, 20).reverse().map(e => e.n_wins),
                      marker: { color: '#47a36d' },
                      hovertemplate: '%{y}: %{x} wins<extra></extra>',
                    },
                    {
                      type: 'bar',
                      name: 'Losses',
                      orientation: 'h',
                      y: winLossSummary.slice(0, 20).reverse().map(e => e.name),
                      x: winLossSummary.slice(0, 20).reverse().map(e => -e.n_losses),
                      marker: { color: '#d95a3e' },
                      hovertemplate: '%{y}: %{customdata} losses<extra></extra>',
                      customdata: winLossSummary.slice(0, 20).reverse().map(e => e.n_losses),
                    },
                  ]}
                  layout={{
                    title: { text: 'Win / Loss Record (Top 20)', font: { size: 14, color: '#2a3142' } },
                    barmode: 'relative',
                    margin: { l: 200, r: 40, t: 40, b: 40 },
                    height: Math.max(300, Math.min(20, winLossSummary.length) * 32 + 80),
                    xaxis: { title: 'Comparison pairs', gridcolor: '#ebeef2', zeroline: true, zerolinecolor: '#d8dde4' },
                    yaxis: { automargin: true },
                    plot_bgcolor: '#ffffff',
                    paper_bgcolor: '#ffffff',
                    font: { family: 'PT Sans, sans-serif', size: 11, color: '#2a3142' },
                    legend: { orientation: 'h', y: 1.08 },
                    showlegend: true,
                  }}
                  config={{ displayModeBar: false, responsive: true }}
                  style={{ width: '100%' }}
                />
              </div>

              <div className="benchmarks-table-container">
                <table className="benchmarks-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Wins <Help text="Number of head-to-head comparisons (within a single paper, same metric and condition) where this method beat another." /></th>
                      <th>Losses <Help text="Number of head-to-head comparisons where another method beat this one." /></th>
                      <th>Net <Help text="Wins minus losses — a quick tally of how often this method comes out ahead in direct comparisons." /></th>
                      <th>Metrics <Help text="The distinct metrics this method has been compared on (e.g. success rate, latency)." /></th>
                    </tr>
                  </thead>
                  <tbody>
                    {winLossSummary.map(entry => (
                      <tr
                        key={entry.name}
                        className={selectedPoint?.name === entry.name ? 'benchmarks-selected' : ''}
                        onClick={() => {
                          const match = (data || []).find(d => d.name === entry.name);
                          if (match && onSelect) onSelect(match);
                        }}
                      >
                        <td className="benchmarks-method">{entry.name}</td>
                        <td className="benchmarks-wins">{entry.n_wins}</td>
                        <td className="benchmarks-losses">{entry.n_losses}</td>
                        <td className={`benchmarks-net ${entry.n_wins - entry.n_losses > 0 ? 'positive' : entry.n_wins - entry.n_losses < 0 ? 'negative' : ''}`}>
                          {entry.n_wins - entry.n_losses > 0 ? '+' : ''}{entry.n_wins - entry.n_losses}
                        </td>
                        <td className="benchmarks-metric-list">
                          {(entry.metrics || []).slice(0, 3).join(', ')}
                          {(entry.metrics || []).length > 3 ? ` +${entry.metrics.length - 3}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* AGREEMENT (CROSS-PAPER REPRODUCIBILITY) TAB — default landing  */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {activeTab === 'agreement' && (
        <AgreementView
          crossValidations={visibleCrossValidations}
          totalCrossValidations={crossValidations.length}
          minConfidence={minConfidence}
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
