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
import AdminPage from './components/AdminPage';
import SettingsPanel from './components/SettingsPanel';
import { loadAllData, loadTfidfMatrices, loadDescriptionEmbeddings, loadUmapDefault, setDataPrefix } from './lib/data-loader';
import { recomputeUmap } from './lib/umap';
import { runAIQuery } from './lib/ai-pipeline';
import useTruncationTitles from './lib/useTruncationTitles';
import './App.css';

function detectDomainFromPath() {
  const path = window.location.pathname.replace(/^\//, '').split('/')[0];
  if (path === 'admin') return { page: 'admin', dataPrefix: '/data-grasp-planning', domainSlug: null };
  if (path && path !== '' && path !== 'index.html') {
    return { page: 'explorer', dataPrefix: `/data-${path}`, domainSlug: path };
  }
  return { page: 'redirect', dataPrefix: '/data-grasp-planning', domainSlug: 'grasp-planning' };
}

function App() {
  useTruncationTitles();

  const detected = useMemo(() => detectDomainFromPath(), []);
  useMemo(() => setDataPrefix(detected.dataPrefix), [detected.dataPrefix]);

  useEffect(() => {
    const isIframe = window.self !== window.top;
    if (detected.page === 'redirect' && !isIframe) {
      window.location.replace('/grasp-planning');
    }
  }, [detected.page]);

  const [page, setPage] = useState(detected.page === 'redirect' ? 'explorer' : detected.page);
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
  const [suggestion, setSuggestion] = useState(null);
  const [queryError, setQueryError] = useState(null);

  const [highlightedMethods, setHighlightedMethods] = useState([]);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [selectedPoint, setSelectedPoint] = useState(null);

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
        const methods = filterMethods
          ? allMethodsRef.current.filter(m => filterMethods.includes(m.name))
          : allMethodsRef.current;
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
          setDomainCfg(cfg);
          if (domainConfig.defaultWeights) {
            defaultWeightsRef.current = domainConfig.defaultWeights;
          }
        }

        const isIframe = window.self !== window.top;
        const sessionKey = domainConfig?.domain || 'grasp-explorer';
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

  const handleQuerySubmit = async (e) => {
    e.preventDefault();
    if (!query.trim() || querying) return;
    setQuerying(true);
    setQueryError(null);
    setSuggestion(null);
    try {
      const queryText = query.trim();
      const [tfidf, descEmb] = await Promise.all([loadTfidfMatrices(), loadDescriptionEmbeddings()]);
      const result = await runAIQuery(
        queryText, allMethodsRef.current, tfidf, descEmb,
        queryKeywordsRef.current || {}, defaultKRef.current,
        { defaultWeights: defaultWeightsRef.current, branding }
      );
      applyQueryResult(queryText, result);
      try {
        sessionStorage.setItem('grasp-explorer-query', queryText);
        sessionStorage.setItem('grasp-explorer-result', JSON.stringify(result));
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
    const key = domainCfg.branding?.domain || 'grasp-explorer';
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
    <div className="sticky-top">
      <header className="copilot-header">
        <div className="header-content">
          <h1>{branding.productName}</h1>
          <span className="badge">{branding.tagline}</span>
          <span className="header-subtitle">{branding.ecosystem}</span>
          <button className="settings-btn" onClick={() => setShowSettings(true)} title="AI Settings">&#9881;</button>
          <button
            className={`nav-link ${page === 'explorer' ? 'active' : ''}`}
            onClick={() => setPage('explorer')}
          >
            Explorer
          </button>
          <button
            className={`nav-link ${page === 'graph-reasoning' ? 'active' : ''}`}
            onClick={() => setPage('graph-reasoning')}
          >
            Graph Reasoning
          </button>
          <button
            className={`nav-link nav-link-admin ${page === 'admin' ? 'active' : ''}`}
            onClick={() => setPage('admin')}
            title="Domain administration"
          >
            Admin
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
        </div>
      </header>

      <section className="query-section">
        <div className="query-label">Ask a question about {branding.methodNoun}s in this domain</div>
        <form onSubmit={handleQuerySubmit} className="query-form">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={branding.queryHint}
            disabled={querying}
            className="query-input"
          />
          <button type="submit" disabled={querying || !query.trim()} className="query-btn">
            {querying ? 'Searching...' : 'Ask'}
          </button>
        </form>
        {suggestion?.spellCorrection && (
          <div className="spell-correction-notice">
            Showing results for <strong>{suggestion.spellCorrection.corrected}</strong>
            <span className="spell-original"> (searched: <em>{suggestion.spellCorrection.original}</em>)</span>
          </div>
        )}
      </section>
    </div>
  );

  if (page === 'admin') {
    return (
      <DomainContext.Provider value={domainCfg}>
      <div className="copilot-app">
        {sharedHeader}
        <AdminPage />
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
        {suggestion && (
          <InsightCard
            suggestion={suggestion}
            weights={weights}
            query={query}
            data={data}
            termDictionary={termDictionary}
            onClose={() => setSuggestion(null)}
            onMethodClick={() => {}}
          />
        )}

        {/* MethodTable — identical render to Explorer (sibling of .copilot-app, full width) */}
        <MethodTable
          data={activeCluster != null
            ? data.filter(d => {
                if (typeof activeCluster === 'object' && activeCluster.type === 'column') {
                  const parts = (d.metadata?.[activeCluster.column] || '').split(',').map(s => s.trim());
                  return parts.some(p => p === activeCluster.value);
                }
                return d.cluster === activeCluster;
              })
            : data}
          allData={data}
          highlightedMethods={highlightedMethods}
          selectedPoint={selectedPoint}
          hoveredIndex={hoveredIndex}
          onSelect={setSelectedPoint}
          onHover={setHoveredIndex}
          onUnhover={() => setHoveredIndex(null)}
          onFilter={(methods) => {
            if (methods && methods.length >= 3) {
              setFilterActive(true);
              setFilterCount(methods.length);
              fetchUmap(null, methods);
            } else {
              setFilterActive(false);
              setFilterCount(null);
              fetchUmap();
            }
          }}
        />

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
          onFilter={(methods) => {
            if (methods && methods.length >= 3) {
              setFilterActive(true);
              setFilterCount(methods.length);
              fetchUmap(null, methods);
            } else {
              setFilterActive(false);
              setFilterCount(null);
              fetchUmap();
            }
          }}
        />
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
        data={activeCluster != null
          ? data.filter(d => {
              if (typeof activeCluster === 'object' && activeCluster.type === 'column') {
                const parts = (d.metadata?.[activeCluster.column] || '').split(',').map(s => s.trim());
                return parts.some(p => p === activeCluster.value);
              }
              return d.cluster === activeCluster;
            })
          : data}
        allData={data}
        highlightedMethods={highlightedMethods}
        selectedPoint={selectedPoint}
        hoveredIndex={hoveredIndex}
        onSelect={setSelectedPoint}
        onHover={setHoveredIndex}
        onUnhover={() => setHoveredIndex(null)}
        onFilter={(methods) => {
          if (methods && methods.length >= 3) {
            setFilterActive(true);
            setFilterCount(methods.length);
            fetchUmap(null, methods);
          } else {
            setFilterActive(false);
            setFilterCount(null);
            fetchUmap();
          }
        }}
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

      <DetailPanel point={selectedPoint} onClose={() => setSelectedPoint(null)} />

      <footer className="copilot-footer">
        <span>COMPARE Project &middot; Worcester Polytechnic Institute &middot; NSF POSE</span>
      </footer>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
    </DomainContext.Provider>
  );
}

export default App;
