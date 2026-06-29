import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Tooltip from './Tooltip';
import PdfViewer from './PdfViewer';
import { HighlightedText } from '../highlighter';
import KGGraphViz from './KGGraphViz';
import KGNodeDetail from './KGNodeDetail';
import KGLanding from './KGLanding';
import AnswerBlock, { computeAnchorMethods } from './AnswerBlock';
import ProofBlock from './ProofBlock';

const EDGE_TYPES = [
  { key: 'cites', label: 'Cites' },
  { key: 'contributes', label: 'Contributes' },
  { key: 'implements_step', label: 'Implements' },
  { key: 'compares', label: 'Compares' },
  { key: 'outperforms', label: 'Outperforms' },
  { key: 'has_limitation', label: 'Has limitation' },
  { key: 'uses_hardware', label: 'Uses hardware' },
  { key: 'uses_backbone', label: 'Uses backbone' },
  { key: 'uses_loss', label: 'Uses loss' },
  { key: 'trained_on', label: 'Trained on' },
  { key: 'described_in', label: 'Described in' },
  { key: 'has_figure', label: 'Has figure' },
  { key: 'has_table', label: 'Has table' },
  { key: 'implemented_in', label: 'Implemented in' },
  { key: 'maintained_by', label: 'Maintained by' },
];
const NODE_TYPES = [
  { key: 'method', label: 'Methods' },
  { key: 'paper', label: 'Papers' },
  { key: 'technique', label: 'Techniques' },
  { key: 'hardware', label: 'Hardware' },
  { key: 'claim', label: 'Claims' },
  { key: 'attribute', label: 'Attributes' },
  { key: 'figure', label: 'Figures' },
  { key: 'table', label: 'Tables' },
  { key: 'impl_language', label: 'Languages' },
  { key: 'author', label: 'Authors' },
];

const CONTENT_COLORS = { theory: '#16657d', implementation: '#47a36d', evaluation: '#E86C4B', general: '#8691a0' };
const CONTENT_LABELS = { theory: 'How It Works', implementation: 'How To Build It', evaluation: 'How It Performs', general: 'General' };
const ROLE_LABELS = {
  algorithm_description: 'Method Design', experimental_setup: 'Experiment Setup',
  result: 'Results', comparison: 'Comparisons', problem_statement: 'Problem Definition',
  limitation: 'Limitations', definition: 'Definitions', general: 'General',
};


function formatPaperId(id) {
  const s = id == null ? '' : String(id);
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}



/* ─── EQUATIONS ─── */
function EquationsPanel({ equations }) {
  if (!equations || equations.length === 0) return null;
  const seen = new Set();
  const unique = equations.filter(eq => { const k = eq.latex; if (seen.has(k)) return false; seen.add(k); return true; });
  return (
    <div className="gr-card">
      <div className="gr-card-header">
        <h3 className="gr-card-title">Equations</h3>
        <span className="gr-count-badge">{unique.length}</span>
      </div>
      <div className="gr-card-body">
        {unique.map((eq, i) => (
          <div key={i} className="gr-equation">
            <div className="gr-equation-top">
              <div className="gr-equation-latex">{eq.latex}</div>
              {eq.relevance != null && (
                <span className={`gr-equation-score ${eq.relevance >= 0.5 ? 'high' : eq.relevance >= 0.3 ? 'med' : 'low'}`}>
                  {Math.round(eq.relevance * 100)}%
                </span>
              )}
            </div>
            {eq.explanation && <div className="gr-equation-explanation">{eq.explanation}</div>}
            <div className="gr-equation-meta">
              <span className="gr-equation-paper">{eq.paper}</span>
              {eq.context && <span className="gr-equation-context">{eq.context}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── PAPER EVIDENCE ─── */
function EvidencePanel({ citations, filterRole, filterContent, onFilterRole, onFilterContent, openPaperId }) {
  const [expandedKey, setExpandedKey] = useState(null);
  const [pdfOpen, setPdfOpen] = useState(null);
  const itemRefs = useRef({});

  const roles = useMemo(() => {
    if (!citations || !citations.length) return [];
    const counts = {};
    citations.forEach(c => { counts[c.rhetorical_role || 'general'] = (counts[c.rhetorical_role || 'general'] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [citations]);

  const contentTypes = useMemo(() => {
    if (!citations || !citations.length) return [];
    const counts = {};
    citations.forEach(c => { counts[c.content_type || 'general'] = (counts[c.content_type || 'general'] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [citations]);

  // Deep-link from an answer citation [n]: expand that paper's passage + scroll to it.
  useEffect(() => {
    if (!openPaperId || !(citations || []).some(c => c.paper_id === openPaperId)) return;
    setExpandedKey(openPaperId);
    const node = itemRefs.current[openPaperId];
    if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [openPaperId, citations]);

  if (!citations || citations.length === 0) return null;
  const filtered = citations.filter(c => {
    if (filterRole && (c.rhetorical_role || 'general') !== filterRole) return false;
    if (filterContent && (c.content_type || 'general') !== filterContent) return false;
    return true;
  });
  const hasFilter = filterRole || filterContent;

  return (
    <div className="gr-card">
      <div className="gr-card-header">
        <h3 className="gr-card-title">Paper Evidence</h3>
        <span className="gr-count-badge">{hasFilter ? `${filtered.length}/${citations.length}` : citations.length}</span>
      </div>
      <div className="gr-filter-bar">
        <div className="gr-filter-group">
          <span className="gr-filter-label">Content</span>
          {contentTypes.map(([key, count]) => (
            <button key={key} className={`gr-filter-tag ${filterContent === key ? 'active' : ''}`}
              style={{ borderColor: CONTENT_COLORS[key] || '#ccc', background: filterContent === key ? CONTENT_COLORS[key] : 'transparent', color: filterContent === key ? '#fff' : CONTENT_COLORS[key] }}
              onClick={() => onFilterContent(filterContent === key ? null : key)}>
              {CONTENT_LABELS[key] || key} ({count})
            </button>
          ))}
        </div>
        <div className="gr-filter-group">
          <span className="gr-filter-label">Purpose</span>
          {roles.map(([key, count]) => (
            <button key={key} className={`gr-filter-tag ${filterRole === key ? 'active' : ''}`}
              style={{ borderColor: 'var(--primary)', background: filterRole === key ? 'var(--primary)' : 'transparent', color: filterRole === key ? '#fff' : 'var(--primary)' }}
              onClick={() => onFilterRole(filterRole === key ? null : key)}>
              {ROLE_LABELS[key] || key} ({count})
            </button>
          ))}
        </div>
        {hasFilter && <button className="gr-filter-clear" onClick={() => { onFilterRole(null); onFilterContent(null); }}>Clear</button>}
      </div>
      <div className="gr-card-body">
        {filtered.map((cite, i) => {
          const fullText = cite.full_text || cite.snippet || '';
          const summary = fullText.substring(0, 140) + (fullText.length > 140 ? '…' : '');
          const isExpanded = expandedKey === cite.paper_id;
          return (
            <div
              key={i}
              className={`gr-evidence-item ${isExpanded ? 'expanded' : ''}`}
              ref={el => { if (el) itemRefs.current[cite.paper_id] = el; }}
              style={{ borderLeftColor: CONTENT_COLORS[cite.content_type] || '#ccc' }}
            >
              {/* The whole header IS the toggle — click the paper name to open the passage. */}
              <button
                type="button"
                className="gr-evidence-head"
                onClick={() => setExpandedKey(isExpanded ? null : cite.paper_id)}
                aria-expanded={isExpanded}
              >
                <span className="gr-evidence-paper">{cite.paper_title || formatPaperId(cite.paper_id)}</span>
                <span className="gr-evidence-score">{Math.round(cite.score * 100)}%</span>
                <span className={`gr-evidence-caret ${isExpanded ? 'open' : ''}`} aria-hidden="true">▾</span>
              </button>
              <div className="gr-evidence-meta">
                <span className="gr-evidence-tag section">{cite.section}</span>
                {cite.rhetorical_role && <span className="gr-evidence-tag role">{ROLE_LABELS[cite.rhetorical_role] || cite.rhetorical_role}</span>}
              </div>
              {isExpanded ? (
                <>
                  <div className="gr-evidence-full">{fullText}</div>
                  <div className="gr-evidence-actions">
                    {cite.paper_id && (
                      <button className="gr-evidence-pdf" onClick={() => setPdfOpen({ paperId: cite.paper_id, page: Math.max(1, cite.page || 1) })}>
                        View PDF
                      </button>
                    )}
                    <button className="gr-evidence-toggle" onClick={() => setExpandedKey(null)}>Collapse</button>
                  </div>
                </>
              ) : (
                <div className="gr-evidence-summary">{summary}</div>
              )}
            </div>
          );
        })}
      </div>
      {pdfOpen && (
        <PdfViewer paperId={pdfOpen.paperId} page={pdfOpen.page} keywords={[]} onClose={() => setPdfOpen(null)} />
      )}
    </div>
  );
}

/* ─── QUERY GUIDE ─── */
function QueryGuide() {
  const categories = [
    { title: 'Comparison Queries', description: 'Traverses outperforms edges and shared technique nodes to find how methods relate.', examples: ['"Compare Contact-GraspNet and AnyGrasp"'], traverses: 'method \u2192 paper \u2192 comparison claims, shared techniques' },
    { title: 'Limitation Queries', description: 'Walks paper\u2192limitation edges extracted from the text. Each limitation is a specific claim the authors acknowledged.', examples: ['"What are the limitations of diffusion-based methods?"'], traverses: 'method \u2192 paper \u2192 limitation nodes' },
    { title: 'Technical Queries', description: 'Retrieves key contributions and methodology steps from method sections.', examples: ['"How does DexDiffuser generate grasps?"'], traverses: 'method \u2192 paper \u2192 contributions, methodology steps' },
    { title: 'Hardware & Setup', description: 'Finds specific robot arms, grippers, sensors mentioned in experimental sections.', examples: ['"What hardware is used for dexterous grasping?"'], traverses: 'method \u2192 paper \u2192 hardware nodes' },
    { title: 'Evaluation Queries', description: 'Surfaces quantitative claims, equations, and benchmark results from papers.', examples: ['"What success rates do methods achieve on cluttered scenes?"'], traverses: 'method \u2192 paper \u2192 comparisons, equations' },
  ];
  return (
    <div className="gr-guide">
      <div className="gr-guide-header"><h3>What kind of questions work best?</h3></div>
      <div className="gr-guide-grid">
        {categories.map((cat, i) => (
          <div key={i} className="gr-guide-card">
            <div className="gr-guide-card-title">{cat.title}</div>
            <p className="gr-guide-card-desc">{cat.description}</p>
            <div className="gr-guide-card-examples">{cat.examples.map((ex, j) => <span key={j} className="gr-guide-example">{ex}</span>)}</div>
            <div className="gr-guide-card-path"><span className="gr-guide-path-label">Traverses:</span> {cat.traverses}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── MAIN PAGE ─── */
export default function GraphReasoningPage({
  query, suggestion, querying, termDictionary,
  data, weights, defaultWeights, aiAdjustedCols, colorBy,
  highlightedMethods, selectedPoint, hoveredIndex,
  onSelect, onHover, onUnhover,
  onColorByChange, onWeightsChange, onWeightsReset, onFilter,
}) {
  const [filterRole, setFilterRole] = useState(null);
  const [filterContent, setFilterContent] = useState(null);
  const [subgraphSelection, setSubgraphSelection] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState(new Set());
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState(new Set());
  const [dimOrphans, setDimOrphans] = useState(true);

  const toggleEdge = useCallback(k => setHiddenEdgeTypes(prev => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n;
  }), []);
  const toggleNode = useCallback(k => setHiddenNodeTypes(prev => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n;
  }), []);
  const clearFilters = useCallback(() => {
    setHiddenEdgeTypes(new Set()); setHiddenNodeTypes(new Set()); setDimOrphans(true);
  }, []);

  const traversal = suggestion?.kgTraversal || [];
  const kgContext = suggestion?.kgContext || '';
  const allCitations = suggestion?.ragCitations || [];
  const equations = suggestion?.equations || [];
  const queryIntent = traversal.find(t => t.step === 'query_intent')?.description?.match(/as (\w+)/)?.[1] || 'general';

  // Anchor methods drive the comparison table, the proof section, and the
  // subgraph's "queried-method" highlighting — compute once, share.
  const anchorMethods = useMemo(
    () => computeAnchorMethods(suggestion, data),
    [suggestion, data],
  );
  const anchorNames = useMemo(
    () => new Set(anchorMethods.map(m => m.name)),
    [anchorMethods],
  );

  // Cluster maps for the same Copilot-style highlighting used in InsightCard
  // (method names colored by cluster, cluster labels resolved to IDs).
  const methodClusterMap = useMemo(() => {
    const map = {};
    (data || []).forEach(d => { if (d.name != null) map[d.name] = d.cluster; });
    return map;
  }, [data]);
  const clusterLabelMap = useMemo(() => {
    const map = {};
    (suggestion?.clusterStats || []).forEach(cs => {
      if (cs.label) map[cs.label] = cs.id;
    });
    return map;
  }, [suggestion?.clusterStats]);
  const handleMethodClick = useCallback((name) => {
    const point = (data || []).find(d => d.name === name);
    if (point && onSelect) onSelect(point);
  }, [data, onSelect]);

  // Clicking a citation [n] in the answer opens that paper's passage in the Paper
  // Evidence panel (clear filters so it's visible, then expand + scroll there).
  const [openPaperId, setOpenPaperId] = useState(null);
  const handleCiteClick = useCallback((paperId) => {
    if (!paperId) return;
    setFilterRole(null);
    setFilterContent(null);
    setOpenPaperId(null);
    // re-trigger the effect even if the same paper is clicked twice
    requestAnimationFrame(() => setOpenPaperId(paperId));
  }, []);

  const traversalKey = traversal.length;
  const allCitationsKey = allCitations.length;

  const traversedPapers = useMemo(() => {
    const papers = new Set();
    traversal.forEach(step => {
      (step.edges || []).forEach(edge => {
        const srcMatch = (edge.source_id || '').match(/^paper:(.+)/);
        const tgtMatch = (edge.target_id || '').match(/^paper:(.+)/);
        if (srcMatch) papers.add(srcMatch[1]);
        if (tgtMatch) papers.add(tgtMatch[1]);
      });
    });
    return papers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traversalKey]);

  const citations = useMemo(() => {
    if (traversedPapers.size === 0) return allCitations;
    const filtered = allCitations.filter(c => {
      const pid = (c.paper_id || '').toLowerCase();
      return traversedPapers.has(pid);
    });
    return filtered.length > 0 ? filtered : allCitations;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCitationsKey, traversedPapers]);

  useEffect(() => {
    setFilterRole(null);
    setFilterContent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traversalKey]);

  // Scope scatter data to methods touched by the traversal
  const tableData = useMemo(() => {
    if (!data || !data.length) return [];
    if (traversedPapers.size === 0) return data;
    return data.filter(d => {
      const method = (d.method || d.name || '').toLowerCase().replace(/\s+/g, '-');
      const name = (d.method || d.name || '').toLowerCase();
      return traversedPapers.has(method) || traversedPapers.has(name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, traversedPapers]);

  const tableHighlightLabels = useMemo(() => {
    const s = new Set();
    (tableData || []).forEach(d => { const n = d.method || d.name; if (n) s.add(n); });
    return s;
  }, [tableData]);

  if (!suggestion && !querying) {
    return (
      <div className="graph-reasoning-page">
        <KGLanding
          scatterData={data}
          scatterHighlights={highlightedMethods}
          selectedPoint={selectedPoint}
          hoveredIndex={hoveredIndex}
          onSelect={onSelect}
          onHover={onHover}
          onUnhover={onUnhover}
          onFilter={onFilter}
        />
      </div>
    );
  }

  if (querying) {
    return (
      <div className="graph-reasoning-page">
        <div className="gr-loading"><div className="gr-loading-bar" /><span>Traversing knowledge graph...</span></div>
      </div>
    );
  }

  return (
    <div className="graph-reasoning-page">
      <div className="gr-page-header">
        <h2>How we found your answer</h2>
        <p>Query: <em>{query}</em></p>
      </div>

      <div className="gr-main-content">

      {/* Layer 1: AnswerBlock — ANSWER (synthesis) first, then the comparison
          table. Interactive plots/charts (subgraph, proof, evidence, equations)
          follow in Layers 2-3 below. */}
      <AnswerBlock
        suggestion={suggestion}
        query={query}
        anchorMethods={anchorMethods}
        termDictionary={termDictionary}
        methodClusterMap={methodClusterMap}
        clusterLabelMap={clusterLabelMap}
        onMethodClick={handleMethodClick}
        onCiteClick={handleCiteClick}
      />

      {/* Layer 2: Two-column — subgraph + proof */}
      <div className="gr-layout">
        <div className="gr-left">
          {/* Subgraph */}
          {traversedPapers.size > 0 && (
            <div className={`kgl-graph-row ${subgraphSelection ? 'has-detail' : ''}`}>
              <div className="gr-card kgl-graph-card">
                <div className="gr-card-header">
                  <h3 className="gr-card-title">
                    Knowledge Subgraph
                    <Tooltip text={`This shows the portion of the full knowledge graph traversed to answer your query. Papers sharing techniques or citations with the queried methods are pulled in to show the broader context. Click any node to see its connections.`} wide>
                      <span className="chart-help">?</span>
                    </Tooltip>
                  </h3>
                  <div className="gr-subgraph-actions">
                    <span className="gr-count-badge">
                      {subgraphSelection ? subgraphSelection.node.label : `${traversedPapers.size} papers`}
                    </span>
                    <button
                      className={`gr-filter-toggle-btn ${filtersOpen ? 'active' : ''}`}
                      onClick={() => setFiltersOpen(f => !f)}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M1.5 2.5h13M3.5 6h9M5.5 9.5h5M7 13h2" />
                      </svg>
                      {filtersOpen ? 'Hide Filters' : 'Filters'}
                      {(hiddenEdgeTypes.size > 0 || hiddenNodeTypes.size > 0) && !filtersOpen && (
                        <span className="gr-filter-dot" />
                      )}
                    </button>
                  </div>
                </div>
                {filtersOpen && (
                  <div className="gr-graph-filter-panel">
                    <div className="gr-gfp-section">
                      <div className="gr-gfp-title">
                        Edge types
                        <Tooltip text="Show or hide specific relationship types in the subgraph." wide>
                          <span className="chart-help">?</span>
                        </Tooltip>
                      </div>
                      <div className="gr-gfp-checks">
                        {EDGE_TYPES.map(t => (
                          <label key={t.key} className="gr-gfp-check">
                            <input type="checkbox" checked={!hiddenEdgeTypes.has(t.key)} onChange={() => toggleEdge(t.key)} />
                            <span>{t.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="gr-gfp-section">
                      <div className="gr-gfp-title">
                        Node types
                        <Tooltip text="Toggle visibility of node categories." wide>
                          <span className="chart-help">?</span>
                        </Tooltip>
                      </div>
                      <div className="gr-gfp-checks">
                        {NODE_TYPES.map(t => (
                          <label key={t.key} className="gr-gfp-check">
                            <input type="checkbox" checked={!hiddenNodeTypes.has(t.key)} onChange={() => toggleNode(t.key)} />
                            <span>{t.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="gr-gfp-section gr-gfp-row">
                      <label className="gr-gfp-check">
                        <input type="checkbox" checked={dimOrphans} onChange={() => setDimOrphans(d => !d)} />
                        <span>Dim non-matching methods</span>
                      </label>
                      {(hiddenEdgeTypes.size > 0 || hiddenNodeTypes.size > 0) && (
                        <button className="gr-gfp-reset" onClick={clearFilters}>Reset all</button>
                      )}
                    </div>
                  </div>
                )}
                <KGGraphViz
                  height={460}
                  dataUrl="kg-full"
                  postData={{ paperIds: [...traversedPapers], intent: queryIntent }}
                  onNodeSelect={setSubgraphSelection}
                  refitTrigger={!!subgraphSelection}
                  hiddenEdgeTypes={hiddenEdgeTypes}
                  highlightedLabels={anchorNames.size > 0 ? anchorNames : tableHighlightLabels}
                  dimUnhighlighted={dimOrphans}
                />
              </div>
              {subgraphSelection && (
                <KGNodeDetail
                  selection={subgraphSelection}
                  onClose={() => setSubgraphSelection(null)}
                  onNodeClick={(n) => setSubgraphSelection(null)}
                  query={query}
                  anchorNames={anchorNames}
                  termDictionary={termDictionary}
                  methodClusterMap={methodClusterMap}
                  clusterLabelMap={clusterLabelMap}
                />
              )}
            </div>
          )}
        </div>

        <div className="gr-right">
          <ProofBlock
            suggestion={suggestion}
            anchorMethods={anchorMethods}
            query={query}
            termDictionary={termDictionary}
            onMethodClick={handleMethodClick}
          />
        </div>
      </div>

      {/* Layer 3: Two-column — paper evidence + equations/contradictions */}
      <div className="gr-layout">
        <div className="gr-left">
          <EvidencePanel citations={citations} filterRole={filterRole} filterContent={filterContent} onFilterRole={setFilterRole} onFilterContent={setFilterContent} openPaperId={openPaperId} />
        </div>

        <div className="gr-right">
          <EquationsPanel equations={equations} />
          {/* ContradictionPanel removed: the token-overlap "contradictions" were
              ~100% false positives (unrelated sentences sharing words like
              "grasp/6d/pose"), per the domain-expert data audit — it misled more
              than it informed. Re-introduce only with a real entailment signal. */}
        </div>
      </div>

      </div>

    </div>
  );
}
