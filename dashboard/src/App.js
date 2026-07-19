import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { mergeDomainBranding } from './branding';
import DomainContext, { GRASP_DEFAULTS } from './DomainContext';
import InsightCard from './components/InsightCard';
import { ClusterLegend, ClusterInsight } from './components/ClusterOverview';
import WeightSliders from './components/WeightSliders';
import ScatterPlot from './components/ScatterPlot';
import MethodTable from './components/MethodTable';
import DetailPanel from './components/DetailPanel';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import NetworkGraph from './components/NetworkGraph';
import ClusterGraph from './components/ClusterGraph';

import GraphReasoningPage from './components/GraphReasoningPage';
import BenchmarksPage from './components/BenchmarksPage';
import AdminPage from './components/AdminPage';
import SettingsPanel from './components/SettingsPanel';
import ManualButton from './components/ManualButton';
import { loadAllData, loadTfidfMatrices, loadDescriptionEmbeddings, loadUmapDefault, setDataPrefix } from './lib/data-loader';
import { recomputeUmap } from './lib/umap';
import { runAIQuery } from './lib/ai-pipeline';
import useTruncationTitles from './lib/useTruncationTitles';
import './App.css';

function detectDomainFromPath() {
  const path = window.location.pathname.replace(/^\//, '').split('/')[0];
  if (path === 'admin') return { page: 'admin', dataPrefix: '/data-grasp-planning', domainSlug: null };
  if (path && path !== '' && path !== 'index.html') {
    return { page: 'graph-reasoning', dataPrefix: `/data-${path}`, domainSlug: path };
  }
  return { page: 'redirect', dataPrefix: '/data-grasp-planning', domainSlug: 'grasp-planning' };
}

function App() {
  useTruncationTitles();

  const detected = useMemo(() => detectDomainFromPath(), []);
  // Hide internal-only controls (Admin) when the app is embedded on another site.
  const isEmbedded = useMemo(() => { try { return window.self !== window.top; } catch (_) { return true; } }, []);
  useMemo(() => setDataPrefix(detected.dataPrefix), [detected.dataPrefix]);

  useEffect(() => {
    const isIframe = window.self !== window.top;
    if (detected.page === 'redirect' && !isIframe) {
      window.location.replace('/grasp-planning');
    }
  }, [detected.page]);

  const [page, setPage] = useState(detected.page === 'redirect' ? 'graph-reasoning' : detected.page);
  // Explorer-tab visibility resolves in precedence order: a ?explorer=1/0 URL
  // override (survives the cross-origin iframe boundary, unlike storage) > a local
  // localStorage override > the domain config shipped with the data > off. The URL
  // param and localStorage are read synchronously here; domainCfg.explorerEnabled is
  // applied in an effect once the config loads (only when neither override is set).
  const explorerUrlParam = useMemo(() => {
    try {
      const raw = new URLSearchParams(window.location.search).get('explorer');
      if (raw == null) return null;
      return raw === '1' || raw === 'true';
    } catch (_) { return null; }
  }, []);
  const explorerLocalPref = useMemo(() => {
    try {
      const v = localStorage.getItem('explorer-enabled');
      return v == null ? null : v === 'true';
    } catch (_) { return null; }
  }, []);
  const [explorerEnabled, setExplorerEnabled] = useState(
    explorerUrlParam != null ? explorerUrlParam
      : explorerLocalPref != null ? explorerLocalPref
      : false
  );
  const [termDictionary, setTermDictionary] = useState(null);
  const [data, setData] = useState([]);
  const [vizMode, setVizMode] = useState('scatter');
  const [weights, setWeights] = useState({});
  const [colorBy, setColorBy] = useState('cluster');
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [error, setError] = useState(null);
  const [filterActive, setFilterActive] = useState(false);
  const [filterCount, setFilterCount] = useState(null);

  const [query, setQuery] = useState('');
  const [querying, setQuerying] = useState(false);
  const [lastQuery, setLastQuery] = useState('');           // the previously ANSWERED query (follow-up context)
  const [queryStage, setQueryStage] = useState(null);       // 'retrieving' | 'grounding' | 'writing' | 'done'
  const [suggestion, setSuggestion] = useState(null);
  const [queryError, setQueryError] = useState(null);

  const [highlightedMethods, setHighlightedMethods] = useState([]);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [selectedPoint, setSelectedPoint] = useState(null);

  // Global minimum-confidence filter for inferred/extracted metrics. Below this,
  // numbers are likely unreliable (grade C / weak / disputed) and are hidden.
  const [minConfidence, setMinConfidence] = useState(() => {
    try { const v = parseFloat(window.localStorage.getItem('min-confidence')); return isNaN(v) ? 0.70 : v; }
    catch (_) { return 0.70; }
  });
  const updateMinConfidence = (v) => {
    setMinConfidence(v);
    try { window.localStorage.setItem('min-confidence', String(v)); } catch (_) {}
  };

  const [clusterInsight, setClusterInsight] = useState(null);
  const [clusterStats, setClusterStats] = useState([]);
  const [activeCluster, setActiveCluster] = useState(null);

  const [weightsOpen, setWeightsOpen] = useState(false);
  const [aiAdjustedCols, setAiAdjustedCols] = useState(new Set());
  const [showSettings, setShowSettings] = useState(false);

  const [domainCfg, setDomainCfg] = useState(GRASP_DEFAULTS);
  const branding = useMemo(() => mergeDomainBranding(domainCfg.branding), [domainCfg]);
  const defaultWeightsRef = useRef(GRASP_DEFAULTS.defaultWeights);

  const queryKeywordsRef = useRef(null);
  const defaultKRef = useRef(7);
  const allMethodsRef = useRef([]);

  const applyQueryResult = useCallback((queryText, result) => {
    setLastQuery(queryText);
    setSuggestion(result);
    setData(result.umapData);
    setWeights(result.weights);
    setColorBy(result.colorBy);
    if (result.colorBy !== 'cluster') {
      setVizMode('scatter');
    }
    const highlights = result.filterMethods || result.highlightMethods || [];
    setHighlightedMethods(highlights);
    setSelectedPoint(null);
    setFilterActive(!!result.filterMethods);
    setFilterCount(result.filterMethods ? result.filterMethods.length : null);
    if (result.clusterStats) setClusterStats(result.clusterStats);
    const adjusted = new Set();
    const dw = defaultWeightsRef.current;
    for (const [col, val] of Object.entries(result.weights)) {
      if (val !== dw[col]) adjusted.add(col);
    }
    setAiAdjustedCols(adjusted);
    setQuery(queryText);
  }, []);

  const fetchUmap = useCallback(async (customWeights = null, filterMethods = null) => {
    setRecomputing(true);
    try {
      if (!customWeights && !filterMethods) {
        const umapDefault = await loadUmapDefault();
        setData(umapDefault.data);
        setWeights(umapDefault.config.weights);
        if (umapDefault.clusterStats) setClusterStats(umapDefault.clusterStats);
        allMethodsRef.current = umapDefault.data;
        defaultKRef.current = umapDefault.nClusters || 7;
        setFilterActive(false);
        setFilterCount(null);
      } else {
        const [tfidf, descEmb, umapDefault] = await Promise.all([
          loadTfidfMatrices(), loadDescriptionEmbeddings(), loadUmapDefault(),
        ]);
        const indexed = allMethodsRef.current.map((m, i) => ({ ...m, _row: i }));
        const methods = filterMethods
          ? indexed.filter(m => filterMethods.includes(m.name))
          : indexed;
        const recomputed = recomputeUmap(tfidf, descEmb, customWeights || defaultWeightsRef.current, methods, defaultKRef.current);
        setData(recomputed);
        if (customWeights) setWeights(customWeights);
        setFilterActive(!!filterMethods);
        setFilterCount(filterMethods ? recomputed.length : null);
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
    setRecomputing(false);
  }, []);

  // Shared MethodTable filter handler (identical across every page's table): a
  // 3+-method selection recomputes the map on that subset, anything smaller resets.
  const handleFilter = useCallback((methods) => {
    if (methods && methods.length >= 3) {
      setFilterActive(true);
      setFilterCount(methods.length);
      fetchUmap(null, methods);
    } else {
      setFilterActive(false);
      setFilterCount(null);
      fetchUmap();
    }
  }, [fetchUmap]);

  // Explorer's cluster-legend filter narrows the method table to one cluster/facet.
  // Applied ONLY in the Explorer render (below) so it never leaks onto the Graph
  // Reasoning / Benchmarks tables, which have no legend and no way to clear it.
  const clusterFilteredData = useMemo(() => {
    if (activeCluster == null) return data;
    return data.filter(d => {
      if (typeof activeCluster === 'object' && activeCluster.type === 'column') {
        const parts = (d.metadata?.[activeCluster.column] || '').split(',').map(s => s.trim());
        return parts.some(p => p === activeCluster.value);
      }
      return d.cluster === activeCluster;
    });
  }, [data, activeCluster]);

  useEffect(() => {
    if (typeof document !== 'undefined' && branding.productName) {
      document.title = branding.productName;
    }
  }, [branding]);

  useEffect(() => {
    setLoading(true);
    async function init() {
      try {
        const { umapDefault, termDictionary: td, queryKeywords, domainConfig, clusterInsight: ci } = await loadAllData();
        queryKeywordsRef.current = queryKeywords;
        defaultKRef.current = umapDefault.nClusters || 7;
        allMethodsRef.current = umapDefault.data;
        if (td) setTermDictionary(td);
        if (ci) {
          if (ci.insight) setClusterInsight(ci.insight);
          if (ci.clusterStats) setClusterStats(ci.clusterStats);
        }

        if (domainConfig) {
          const cfg = { ...GRASP_DEFAULTS };
          if (domainConfig.shortNames) cfg.shortNames = domainConfig.shortNames;
          if (domainConfig.defaultWeights) cfg.defaultWeights = domainConfig.defaultWeights;
          if (domainConfig.weightColumns) cfg.weightColumns = domainConfig.weightColumns;
          if (domainConfig.tableColumns) cfg.tableColumns = domainConfig.tableColumns;
          if (domainConfig.colorByOptions) cfg.colorByOptions = domainConfig.colorByOptions;
          if (domainConfig.branding) cfg.branding = domainConfig.branding;
          if (domainConfig.methodNoun) cfg.methodNoun = domainConfig.methodNoun;
          if (domainConfig.priorityDims) cfg.priorityDims = domainConfig.priorityDims;
          if (typeof domainConfig.explorerEnabled === 'boolean') cfg.explorerEnabled = domainConfig.explorerEnabled;
          setDomainCfg(cfg);
          if (domainConfig.defaultWeights) {
            defaultWeightsRef.current = domainConfig.defaultWeights;
          }
        }

        const isIframe = window.self !== window.top;
        const sessionKey = domainConfig?.domain || 'domain-explorer';
        try {
          const cachedQuery = isIframe && sessionStorage.getItem(`${sessionKey}-query`);
          const cachedResult = isIframe && sessionStorage.getItem(`${sessionKey}-result`);
          if (cachedQuery && cachedResult) {
            try {
              applyQueryResult(cachedQuery, JSON.parse(cachedResult));
              setLoading(false);
              return;
            } catch (_) {}
          }
          if (!isIframe) {
            sessionStorage.removeItem(`${sessionKey}-query`);
            sessionStorage.removeItem(`${sessionKey}-result`);
          }
        } catch (_) {}
        setData(umapDefault.data);
        setWeights(umapDefault.config.weights);
        if (umapDefault.clusterStats) setClusterStats(umapDefault.clusterStats);
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    }
    init();
  }, [applyQueryResult]);

  // Domain config is the source of truth for Explorer visibility in embeds (where
  // localStorage is partitioned/blocked). Apply it once the config loads — but only
  // when neither a ?explorer URL param nor a local override is present (those already
  // won at init and must not be clobbered by the config value).
  useEffect(() => {
    if (explorerUrlParam != null || explorerLocalPref != null) return;
    if (typeof domainCfg.explorerEnabled === 'boolean') {
      setExplorerEnabled(domainCfg.explorerEnabled);
    }
  }, [domainCfg.explorerEnabled, explorerUrlParam, explorerLocalPref]);

  const handleQuerySubmit = async (e) => {
    e.preventDefault();
    if (!query.trim() || querying) return;
    // Asking from Admin (or any page without a result surface) would produce no
    // visible outcome — land the user where the answer renders.
    if (page === 'admin' || page === 'explorer') setPage('graph-reasoning');
    setQuerying(true);
    setQueryError(null);
    // Keep the PREVIOUS answer visible (dimmed by the progress bar) instead of
    // blanking the page for the 5-15s generation.
    const prevSuggestion = suggestion;
    try {
      const queryText = query.trim();
      // Method-summary columns + short names come from the active domain config
      // (priorityDims are the domain's most meaningful method-describing columns),
      // so the copilot's "RELEVANT METHODS" block is correct for any domain.
      const summaryColumns = (domainCfg.priorityDims || [])
        .map(d => d.key).filter(k => k && k !== 'Description').slice(0, 6);
      const result = await runAIQuery(
        queryText, allMethodsRef.current,
        queryKeywordsRef.current || {},
        {
          defaultWeights: defaultWeightsRef.current, branding,
          summaryColumns, shortNames: domainCfg.shortNames,
          // Follow-up context: the previous turn gives pronouns a referent.
          history: prevSuggestion && prevSuggestion.insight
            ? { prevQuery: lastQuery, prevAnswer: prevSuggestion.insight }
            : null,
          // Staged progress so the user sees WHAT is happening during generation.
          onStage: (stage) => setQueryStage(stage),
        }
      );
      applyQueryResult(queryText, result);
      try {
        const sk = domainCfg?.domain || 'domain-explorer';
        sessionStorage.setItem(`${sk}-query`, queryText);
        sessionStorage.setItem(`${sk}-result`, JSON.stringify(result));
      } catch (_) {}
    } catch (err) {
      setQueryError(err.message);
    } finally {
      setQuerying(false);
    }
  };

  const handleReset = () => {
    setHighlightedMethods([]);
    setSelectedPoint(null);
    setSuggestion(null);
    setFilterActive(false);
    setFilterCount(null);
    setActiveCluster(null);
    setAiAdjustedCols(new Set());
    setWeightsOpen(false);
    setColorBy('cluster');
    const key = domainCfg?.domain || 'domain-explorer';
    try { sessionStorage.removeItem(`${key}-query`); sessionStorage.removeItem(`${key}-result`); } catch (_) {}
    fetchUmap();
  };

  const handleMethodClick = (methodName) => {
    const point = data.find(d => d.name === methodName);
    if (point) {
      setSelectedPoint(point);
      setHighlightedMethods([methodName]);
    }
  };

  if (loading) {
    return (
      <DomainContext.Provider value={domainCfg}>
        <div className="copilot-app">
          <div className="loading-screen">
            <div className="spinner" />
            <p>Loading visualization...</p>
          </div>
        </div>
      </DomainContext.Provider>
    );
  }

  if (error) {
    return (
      <DomainContext.Provider value={domainCfg}>
        <div className="copilot-app">
          <div className="error-screen">Error: {error}</div>
        </div>
      </DomainContext.Provider>
    );
  }

  const hasHighlights = highlightedMethods.length > 0;

  const sharedHeader = (
    <>
    <div className="sticky-top">
      <header className="copilot-header">
        <div className="header-bar">
          <div className="header-brand">
            <h1>{branding.productName}</h1>
            <span className="badge">{branding.tagline}</span>
            <span className="header-subtitle">{branding.ecosystem}</span>
          </div>
          <div className="header-actions">
            <div className="conf-filter" title="Hide extracted metrics below this evidence tier (grades map to confidence: A≈0.9, B≈0.78, C≈0.45)">
              <span className="conf-filter-label">Evidence</span>
              <div className="conf-seg">
                {[['All', 0], ['Hide weak', 0.6], ['Strong only', 0.85]].map(([lab, v], i) => {
                  const tier = minConfidence >= 0.85 ? 2 : minConfidence >= 0.55 ? 1 : 0;
                  return (
                    <button key={lab} type="button"
                      className={`conf-seg-btn ${tier === i ? 'active' : ''}`}
                      onClick={() => updateMinConfidence(v)}>{lab}</button>
                  );
                })}
              </div>
            </div>
            {/* Settings exposes provider/API-key plumbing — internal, hidden in embeds. */}
            {!isEmbedded && (
              <button className="settings-btn" onClick={() => setShowSettings(true)} title="AI Settings">&#9881;</button>
            )}
            {/* Admin (CSV upload, triggering builds) is intentionally NOT in the
                header — maintainers reach it via the password-gated link in the
                Manual's footer (or /admin directly). Keeps internal tooling out of
                the public product surface. */}
            <ManualButton />
          </div>
        </div>
        <nav className="header-nav">
          {explorerEnabled && (
            <button
              className={`nav-tab ${page === 'explorer' ? 'active' : ''}`}
              onClick={() => setPage('explorer')}
            >
              Explorer
            </button>
          )}
          <button
            className={`nav-tab ${page === 'graph-reasoning' ? 'active' : ''}`}
            onClick={() => setPage('graph-reasoning')}
          >
            Graph Reasoning
          </button>
          <button
            className={`nav-tab ${page === 'benchmarks' ? 'active' : ''}`}
            onClick={() => setPage('benchmarks')}
          >
            Benchmarks
          </button>
          {(recomputing || filterActive || hasHighlights) && (
            <div className="header-status">
              {recomputing && <span className="status-computing">Computing...</span>}
              {!recomputing && filterActive && (
                <span className="status-filter">{filterCount} methods</span>
              )}
              {!recomputing && hasHighlights && (
                <span className="status-highlights">{highlightedMethods.length} highlighted</span>
              )}
              {!recomputing && (filterActive || hasHighlights) && (
                <button className="reset-btn" onClick={handleReset}>Reset</button>
              )}
            </div>
          )}
        </nav>
      </header>

      <section className="query-section">
        <div className="query-label">Ask a question about {branding.methodNoun}s in this domain</div>
        {/* First-run orientation: purpose + clickable example questions, gone after
            the first answer (they've served their job by then). */}
        {!suggestion && !querying && (
          <div className="query-onboard">
            <span className="query-purpose">{branding.purposeLine}</span>
            <span className="query-examples">
              {(branding.exampleQueries || []).slice(0, 4).map(ex => (
                <button key={ex} type="button" className="query-example-chip"
                  onClick={() => setQuery(ex)}>
                  {ex}
                </button>
              ))}
            </span>
          </div>
        )}
        <form onSubmit={handleQuerySubmit} className="query-form">
          <span className="query-icon" aria-hidden="true">&#128269;</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={branding.queryHint}
            disabled={querying}
            className="query-input"
          />
          <button type="submit" disabled={querying || !query.trim()} className="query-btn">
            {querying ? 'Working…' : 'Ask'}
          </button>
        </form>
        {querying && (
          <div className="query-progress" role="status" aria-live="polite">
            {[['retrieving', 'Retrieving evidence'], ['grounding', 'Checking benchmarks & facts'], ['writing', 'Writing the answer']].map(([k, label], i) => {
              const order = { retrieving: 0, grounding: 1, writing: 2, done: 3 };
              const cur = order[queryStage] ?? 0;
              const state = i < cur ? 'done' : i === cur ? 'active' : 'pending';
              return (
                <span key={k} className={`query-step ${state}`}>
                  <span className="query-step-dot" aria-hidden="true">{state === 'done' ? '✓' : ''}</span>
                  {label}
                </span>
              );
            })}
          </div>
        )}
        {suggestion?.spellCorrection && (
          <div className="spell-correction-notice">
            Showing results for <strong>{suggestion.spellCorrection.corrected}</strong>
            <span className="spell-original"> (searched: <em>{suggestion.spellCorrection.original}</em>)</span>
          </div>
        )}
      </section>
    </div>
    {/* AI Settings modal — part of the shared header so the gear works on EVERY
        page (it previously only rendered on Explorer). */}
    {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </>
  );

  if (page === 'admin') {
    return (
      <DomainContext.Provider value={domainCfg}>
      <div className="copilot-app">
        {sharedHeader}
        <AdminPage explorerEnabled={explorerEnabled} onToggleExplorer={(v) => {
          // Local override for THIS browser only. Embeds must use the domain-config
          // explorerEnabled field or ?explorer=1 (localStorage can't cross iframes).
          try { localStorage.setItem('explorer-enabled', v ? 'true' : 'false'); } catch (_) {}
          setExplorerEnabled(v);
        }} />
      </div>
      </DomainContext.Provider>
    );
  }

  if (page === 'graph-reasoning') {
    return (
      <DomainContext.Provider value={domainCfg}>
      <div className="copilot-app">
        {sharedHeader}
        {queryError && <div className="query-error">{queryError}</div>}

        {/* MethodTable — identical render to Explorer (sibling of .copilot-app, full
            width). ORDER: on the landing the table leads (it pairs with the KG
            cross-highlighting below); once a question is ANSWERED the answer is the
            most valuable thing on the page, so it renders first and the table
            follows — no more scrolling past 56 rows to reach the answer. */}
        {!suggestion && <MethodTable
          data={data}
          allData={data}
          highlightedMethods={highlightedMethods}
          selectedPoint={selectedPoint}
          hoveredIndex={hoveredIndex}
          onSelect={setSelectedPoint}
          onHover={setHoveredIndex}
          onUnhover={() => setHoveredIndex(null)}
          onFilter={handleFilter}
        />}

        <GraphReasoningPage
          query={query}
          suggestion={suggestion}
          querying={querying}
          termDictionary={termDictionary}
          data={data}
          weights={weights}
          defaultWeights={defaultWeightsRef.current}
          aiAdjustedCols={aiAdjustedCols}
          colorBy={colorBy}
          highlightedMethods={highlightedMethods}
          selectedPoint={selectedPoint}
          hoveredIndex={hoveredIndex}
          onSelect={setSelectedPoint}
          onHover={setHoveredIndex}
          onUnhover={() => setHoveredIndex(null)}
          onColorByChange={setColorBy}
          onWeightsChange={(w) => { setWeights(w); fetchUmap(w); }}
          onWeightsReset={() => { setAiAdjustedCols(new Set()); setWeights(defaultWeightsRef.current); fetchUmap(); }}
          onFilter={handleFilter}
        />

        {/* Answered state: the table follows the answer (see order note above). */}
        {suggestion && <MethodTable
          data={data}
          allData={data}
          highlightedMethods={highlightedMethods}
          selectedPoint={selectedPoint}
          hoveredIndex={hoveredIndex}
          onSelect={setSelectedPoint}
          onHover={setHoveredIndex}
          onUnhover={() => setHoveredIndex(null)}
          onFilter={handleFilter}
        />}
      </div>
      </DomainContext.Provider>
    );
  }

  if (page === 'benchmarks') {
    return (
      <DomainContext.Provider value={domainCfg}>
      <div className="copilot-app">
        {sharedHeader}

        <MethodTable
          data={data}
          allData={data}
          highlightedMethods={highlightedMethods}
          selectedPoint={selectedPoint}
          hoveredIndex={hoveredIndex}
          onSelect={setSelectedPoint}
          onHover={setHoveredIndex}
          onUnhover={() => setHoveredIndex(null)}
          onFilter={handleFilter}
        />

        <BenchmarksPage
          data={data}
          selectedPoint={selectedPoint}
          onSelect={setSelectedPoint}
          minConfidence={minConfidence}
          incomingPageRef={suggestion?.benchmarkPageRef || null}
          queryMethods={suggestion?.highlightMethods || null}
          suggestion={suggestion}
          query={query}
          termDictionary={termDictionary}
        />

        {selectedPoint && <DetailPanel point={selectedPoint} onClose={() => setSelectedPoint(null)} minConfidence={minConfidence} />}
      </div>
      </DomainContext.Provider>
    );
  }

  return (
    <DomainContext.Provider value={domainCfg}>
    <div className="copilot-app">
      {sharedHeader}

      {queryError && <div className="query-error">{queryError}</div>}

      {/* Copilot Insight (appears after query) */}
      {suggestion && (
        <InsightCard
          suggestion={suggestion}
          weights={weights}
          query={query}
          data={data}
          termDictionary={termDictionary}
          onClose={() => setSuggestion(null)}
          onMethodClick={handleMethodClick}
        />
      )}

      {/* Method Table: full width */}
      <MethodTable
        data={clusterFilteredData}
        allData={data}
        highlightedMethods={highlightedMethods}
        selectedPoint={selectedPoint}
        hoveredIndex={hoveredIndex}
        onSelect={setSelectedPoint}
        onHover={setHoveredIndex}
        onUnhover={() => setHoveredIndex(null)}
        onFilter={handleFilter}
      />

      {/* Scatter plot + cluster legend */}
      <div className="scatter-section">
        <div className="viz-toolbar">
          <button
            className={`viz-toggle-btn ${vizMode === 'scatter' ? 'active' : ''}`}
            onClick={() => setVizMode('scatter')}
          >
            Similarity Map
          </button>
          <button
            className={`viz-toggle-btn ${vizMode === 'network' ? 'active' : ''} ${colorBy !== 'cluster' ? 'disabled' : ''}`}
            onClick={() => colorBy === 'cluster' && setVizMode('network')}
            title={colorBy !== 'cluster' ? 'Switch to Cluster coloring to see method connections' : ''}
          >
            Method Connections
          </button>
          <button
            className={`viz-toggle-btn ${vizMode === 'clusters' ? 'active' : ''} ${colorBy !== 'cluster' ? 'disabled' : ''}`}
            onClick={() => colorBy === 'cluster' && setVizMode('clusters')}
            title={colorBy !== 'cluster' ? 'Switch to Cluster coloring to see cluster relations' : ''}
          >
            Cluster Relations
          </button>
          <button
            className={`viz-toggle-btn weights-toggle ${weightsOpen ? 'active' : ''}`}
            onClick={() => setWeightsOpen(!weightsOpen)}
          >
            {weightsOpen ? 'Hide Weights' : 'Weights'}
          </button>
          <div className="color-by-header">
            <label htmlFor="color-by-select">Color by</label>
            <select
              id="color-by-select"
              value={colorBy}
              onChange={(e) => {
                const val = e.target.value;
                setColorBy(val);
                setActiveCluster(null);
                if (val !== 'cluster' && (vizMode === 'network' || vizMode === 'clusters')) {
                  setVizMode('scatter');
                }
              }}
            >
              {domainCfg.colorByOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
        {weightsOpen && (
          <WeightSliders
            weights={weights}
            defaultWeights={defaultWeightsRef.current}
            aiAdjustedCols={aiAdjustedCols}
            onChange={(newWeights) => { setWeights(newWeights); fetchUmap(newWeights); }}
            onReset={() => { setAiAdjustedCols(new Set()); setWeights(defaultWeightsRef.current); setWeightsOpen(false); fetchUmap(); }}
          />
        )}
        <div className="scatter-content">
        <div className="scatter-panel">
          {vizMode === 'scatter' && (
            <ScatterPlot
              data={data}
              colorBy={colorBy}
              highlightedMethods={highlightedMethods}
              hoveredIndex={hoveredIndex}
              activeCluster={activeCluster}
              onPointClick={setSelectedPoint}
              onHover={setHoveredIndex}
              onUnhover={() => setHoveredIndex(null)}
            />
          )}
          {vizMode === 'network' && (
            <NetworkGraph
              data={data}
              colorBy={colorBy}
              highlightedMethods={highlightedMethods}
              hoveredIndex={hoveredIndex}
              onPointClick={setSelectedPoint}
              onHover={setHoveredIndex}
              onUnhover={() => setHoveredIndex(null)}
            />
          )}
          {vizMode === 'clusters' && (
            <ClusterGraph
              data={data}
              colorBy={colorBy}
              clusterStats={clusterStats}
              highlightedMethods={highlightedMethods}
              onPointClick={setSelectedPoint}
            />
          )}
        </div>
        <div className="legend-and-description">
          <ClusterLegend stats={clusterStats} activeCluster={activeCluster} onClusterClick={setActiveCluster} colorBy={colorBy} data={data} />
          <div className="viz-description">
            {vizMode === 'scatter' && (
              <p>Each dot is one {branding.productShort.replace(/s$/, '')}, positioned by similarity across all attributes.
                {colorBy === 'cluster'
                  ? ' Colors indicate automatically discovered groups.'
                  : ` Colors show ${domainCfg.shortNames[colorBy] || colorBy}.`
                }
                {highlightedMethods.length > 0 && ' Highlighted methods match your query.'}
                {' '}Hover to identify, click for details.</p>
            )}
            {vizMode === 'network' && (
              <p><strong>Colored lines</strong> connect methods in the same group. <strong>Gray dashed lines</strong> connect methods in different groups that share 3 or more attributes, revealing relationships the grouping alone does not show.</p>
            )}
            {vizMode === 'clusters' && (
              <p>Each bubble represents one group of methods, sized by member count. <strong>Line thickness</strong> indicates how many attributes are shared between groups. Percentages show the degree of overlap. Hover a bubble to see its methods.</p>
            )}
          </div>
        </div>
        </div>
      </div>

      {!suggestion && colorBy === 'cluster' && aiAdjustedCols.size === 0 &&
        Object.entries(weights).every(([col, val]) => val === defaultWeightsRef.current[col]) && (
        <ClusterInsight
          insight={clusterInsight}
          loading={false}
          stats={clusterStats}
          onMethodClick={handleMethodClick}
          data={data}
        />
      )}

      {/* Post-query sections */}
      {suggestion && (
        <AnalyticsDashboard suggestion={suggestion} />
      )}

      <DetailPanel point={selectedPoint} onClose={() => setSelectedPoint(null)} minConfidence={minConfidence} />

      <footer className="copilot-footer">
        <span>COMPARE Project &middot; Worcester Polytechnic Institute &middot; NSF POSE</span>
      </footer>

    </div>
    </DomainContext.Provider>
  );
}

export default App;
