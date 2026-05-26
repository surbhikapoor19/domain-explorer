import React, { useState, useEffect } from 'react';
import Plot from 'react-plotly.js';
import Tooltip from './Tooltip';

const PAPER_COLORS = [
  '#16657d', '#E86C4B', '#47a36d', '#7c6daa', '#2a9d8f',
  '#d4851e', '#c0392b', '#5b8c5a', '#8ab5cc', '#b07d4f',
  '#6b7280', '#1a5c3a', '#8a4a1e', '#4a6fa5', '#a0522d',
  '#2e86ab', '#a23b72', '#f18f01', '#3d5a80', '#ee6c4d',
  '#6a994e', '#bc6c25', '#606c38', '#283618', '#dda15e',
  '#9b2226', '#005f73', '#0a9396', '#94d2bd', '#e9d8a6',
  '#ca6702', '#ae2012', '#bb3e03', '#001219',
];

function paperColor(paperId, paperList) {
  return PAPER_COLORS[paperList.indexOf(paperId) % PAPER_COLORS.length];
}

function formatPaperId(id) {
  const s = id == null ? '' : String(id);
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const CONTENT_LABELS = { theory: 'How It Works', implementation: 'How To Build It', evaluation: 'How It Performs', general: 'General' };
const CONTENT_COLORS = { theory: '#16657d', implementation: '#47a36d', evaluation: '#E86C4B', general: '#8691a0' };
const ROLE_LABELS = {
  algorithm_description: 'Method Design', experimental_setup: 'Experiment Setup',
  result: 'Results', comparison: 'Comparisons', problem_statement: 'Problem Definition',
  limitation: 'Limitations', definition: 'Definitions', general: 'General',
};

/* ─── STAT CARDS ─── */
function StatCards({ stats }) {
  if (!stats) return null;
  const cards = [
    { n: stats.total_papers, label: 'Papers Indexed' },
    { n: stats.total_chunks, label: 'Text Passages' },
    { n: (stats.layers || []).find(l => l.layer === 'mid')?.count || 0, label: 'Section-Level' },
    { n: (stats.layers || []).find(l => l.layer === 'fine')?.count || 0, label: 'Paragraph-Level' },
    { n: (stats.topics || []).length, label: 'Topics Found' },
  ];
  return (
    <div className="rag-stat-row">
      {cards.map((c, i) => (
        <div key={i} className="rag-stat">
          <span className="rag-stat-n">{c.n}</span>
          <span className="rag-stat-l">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── CHUNK MAP ─── */
function ChunkMap({ chunks, papers, selectedPaper, relevantPapers, onSelect }) {
  if (!chunks || !chunks.length || !chunks[0].x) return null;

  const hasSelection = selectedPaper || (relevantPapers && relevantPapers.length > 0);

  const traces = papers.map(pid => {
    const pts = chunks.filter(c => c.paper_id === pid);
    const isSelected = selectedPaper === pid;
    const isRelevant = relevantPapers && relevantPapers.includes(pid);
    const active = isSelected || isRelevant;
    const dim = hasSelection && !active;
    return {
      x: pts.map(c => c.x), y: pts.map(c => c.y),
      mode: 'markers', type: 'scatter',
      name: formatPaperId(pid),
      hovertemplate: `<b>${formatPaperId(pid)}</b><br>%{text}<extra></extra>`,
      text: pts.map(c => `${c.section}: ${c.snippet.slice(0, 60)}...`),
      marker: {
        size: active ? 9 : 5,
        color: paperColor(pid, papers),
        opacity: dim ? 0.08 : (active ? 0.9 : 0.5),
        line: { width: isSelected ? 1.5 : (isRelevant ? 1 : 0), color: '#333' },
      },
      showlegend: false,
    };
  });

  return (
    <Plot
      data={traces}
      layout={{
        xaxis: { zeroline: false, showgrid: false, showticklabels: false, showline: false, title: '' },
        yaxis: { zeroline: false, showgrid: false, showticklabels: false, showline: false, title: '' },
        hovermode: 'closest', height: 400,
        margin: { t: 5, b: 5, l: 5, r: 5 },
        paper_bgcolor: 'transparent', plot_bgcolor: '#f8fafb',
      }}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
    />
  );
}

/* ─── HORIZONTAL BARS ─── */
function HorizontalBars({ items, labelMap, colorFn, title, activeKey, onBarClick }) {
  if (!items || !items.length) return null;
  const max = items[0].count;
  return (
    <div className="rag-bars">
      {title && <div className="rag-bars-title">{title} {activeKey && <span className="rag-bars-clear" onClick={() => onBarClick && onBarClick(null)}>&times; clear</span>}</div>}
      {items.map((it, i) => {
        const key = it.topic || it.role || it.type || it.layer || it.section || '';
        const label = labelMap ? (labelMap[key] || key) : key;
        const pct = max > 0 ? (it.count / max) * 100 : 0;
        const color = colorFn ? colorFn(key) : '#16657d';
        const isActive = activeKey === key;
        const isDimmed = activeKey && !isActive;
        return (
          <div
            key={i}
            className={`rag-bar-row clickable ${isActive ? 'active' : ''} ${isDimmed ? 'dimmed' : ''}`}
            onClick={() => onBarClick && onBarClick(isActive ? null : key)}
          >
            <span className="rag-bar-label">{label}</span>
            <div className="rag-bar-track">
              <div className="rag-bar-fill" style={{ width: `${pct}%`, backgroundColor: color }} />
            </div>
            <span className="rag-bar-count">{it.count}</span>
          </div>
        );
      })}
    </div>
  );
}

function cleanPdfText(text) {
  if (!text) return '';
  // All heavy cleaning is done server-side in pdf_parser.clean_extracted_text.
  // Frontend just trims whitespace for display.
  return text.replace(/\s+/g, ' ').trim();
}

/* ─── PAPER ANATOMY ─── */
function PaperAnatomy({ paperId, papers, onClose, filterContentType, filterRole, filterLayer, onFilterContentType, onFilterLayer }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedChunk, setExpandedChunk] = useState(null);

  useEffect(() => {
    if (!paperId) return;
    setLoading(true);
    import('../lib/data-loader').then(({ loadRagChunks }) => {
      loadRagChunks().then(allChunks => {
        const paperChunks = allChunks.filter(c => c.metadata?.paper_id === paperId);
        paperChunks.sort((a, b) => (a.metadata?.position || 0) - (b.metadata?.position || 0));
        setData({ success: true, chunks: paperChunks, paperId });
        setLoading(false);
      }).catch(() => setLoading(false));
    });
  }, [paperId]);

  if (!paperId) return null;

  const hasFilter = filterContentType || filterRole || filterLayer;
  const filteredChunks = data?.chunks?.filter(ch => {
    if (filterContentType && ch.content_type !== filterContentType) return false;
    if (filterRole && ch.rhetorical_role !== filterRole) return false;
    if (filterLayer && ch.layer !== filterLayer) return false;
    return true;
  });

  const CONTENT_ITEMS = [
    { key: 'theory', color: '#16657d', label: 'How it works' },
    { key: 'implementation', color: '#47a36d', label: 'Implementation' },
    { key: 'evaluation', color: '#E86C4B', label: 'Results' },
    { key: 'general', color: '#8691a0', label: 'General' },
  ];
  const LAYER_ITEMS = [
    { key: 'coarse', label: 'Overview', desc: 'Abstract or section summary' },
    { key: 'mid', label: 'Section', desc: 'Topically coherent passage' },
    { key: 'fine', label: 'Detail', desc: 'Individual paragraph' },
  ];

  return (
    <div className="rag-card rag-anatomy">
      <div className="rag-anatomy-head">
        <div style={{flex:1}}>
          <h3 className="rag-card-title">
            {formatPaperId(paperId)}
            <Tooltip text="These are text chunks extracted from the paper. Each chunk is a meaningful passage — an abstract summary, a section about methods, or a detailed paragraph. Together they show how the paper's content breaks down by topic, purpose, and depth of detail." wide>
              <span className="chart-help">?</span>
            </Tooltip>
          </h3>
          {hasFilter && filteredChunks && (
            <div className="rag-anatomy-filter-info">Showing {filteredChunks.length} of {data.chunks.length} chunks</div>
          )}
          <div className="rag-anatomy-legend">
            <div className="rag-anatomy-legend-section">
              <span className="rag-anatomy-legend-heading">Content Type (left border) {filterContentType && <span className="rag-legend-clear" onClick={() => onFilterContentType && onFilterContentType(null)}>&times;</span>}</span>
              {CONTENT_ITEMS.map(it => (
                <span
                  key={it.key}
                  className={`rag-anatomy-legend-item clickable ${filterContentType === it.key ? 'active' : ''} ${filterContentType && filterContentType !== it.key ? 'dimmed' : ''}`}
                  onClick={() => onFilterContentType && onFilterContentType(filterContentType === it.key ? null : it.key)}
                >
                  <span className="rag-legend-swatch" style={{background: it.color}} /> {it.label}
                </span>
              ))}
            </div>
            <div className="rag-anatomy-legend-section">
              <span className="rag-anatomy-legend-heading">Extraction Level (badge) {filterLayer && <span className="rag-legend-clear" onClick={() => onFilterLayer && onFilterLayer(null)}>&times;</span>}</span>
              {LAYER_ITEMS.map(it => (
                <span
                  key={it.key}
                  className={`rag-anatomy-legend-item clickable ${filterLayer === it.key ? 'active' : ''} ${filterLayer && filterLayer !== it.key ? 'dimmed' : ''}`}
                  onClick={() => onFilterLayer && onFilterLayer(filterLayer === it.key ? null : it.key)}
                >
                  <strong>{it.label}</strong> {it.desc}
                </span>
              ))}
            </div>
          </div>
        </div>
        {onClose && <button className="rag-anatomy-close" onClick={onClose}>&times;</button>}
      </div>
      {loading && <p className="rag-loading">Loading paper chunks...</p>}
      {filteredChunks && (
        <div className="rag-anatomy-list">
          {filteredChunks.map((ch, i) => {
            const isExpanded = expandedChunk === i;
            const chunkText = cleanPdfText(ch.text);
            const needsTruncate = chunkText.length > 250;
            return (
              <div key={i} className="rag-anatomy-item" style={{ borderLeftColor: CONTENT_COLORS[ch.content_type] || '#ccc' }}>
                <div className="rag-anatomy-meta">
                  <span className="rag-anatomy-layer">{ch.layer === 'coarse' ? 'Overview' : ch.layer === 'mid' ? 'Section' : 'Detail'}</span>
                  <span className="rag-anatomy-section">{cleanPdfText(ch.section)}</span>
                  <span className="rag-anatomy-role">{ROLE_LABELS[ch.rhetorical_role] || ch.rhetorical_role}</span>
                  <span className="rag-anatomy-tok">~{ch.token_count} words</span>
                </div>
                <div
                  className={`rag-anatomy-text ${needsTruncate ? 'expandable' : ''}`}
                  onClick={() => needsTruncate && setExpandedChunk(isExpanded ? null : i)}
                >
                  {isExpanded ? chunkText : chunkText.slice(0, 250)}{!isExpanded && needsTruncate ? '...' : ''}
                </div>
                {needsTruncate && (
                  <button className="rag-chunk-toggle" onClick={() => setExpandedChunk(isExpanded ? null : i)}>
                    {isExpanded ? 'Collapse' : 'Read full passage'}
                  </button>
                )}
                {ch.domain_topics && (
                  <div className="rag-anatomy-tags">
                    {ch.domain_topics.split(', ').filter(Boolean).slice(0, 6).map((t, j) => (
                      <span key={j} className="rag-tag">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── QUERY-RELEVANT CHUNKS ─── */
function QueryRelevantChunks({ citations, query }) {
  const [expanded, setExpanded] = useState(null);
  if (!citations || !citations.length) return null;

  return (
    <div className="rag-card rag-query-results">
      <h3 className="rag-card-title">Relevant Passages for: "{query}"</h3>
      <p className="rag-card-sub">{citations.length} passages found across {new Set(citations.map(c => c.paper_id)).size} papers</p>
      <div className="rag-query-list">
        {citations.map((cit, i) => {
          const isExpanded = expanded === i;
          const snippet = cit.snippet || cit.text || '';
          const displayText = isExpanded ? snippet : snippet.slice(0, 200) + (snippet.length > 200 ? '...' : '');
          return (
            <div key={i} className="rag-query-item" style={{ borderLeftColor: CONTENT_COLORS[cit.content_type] || '#ccc' }}>
              <div className="rag-query-item-head">
                <span className="rag-query-paper">{formatPaperId(cit.paper_id)}</span>
                <span className="rag-query-section">{cit.section}</span>
                {cit.score && <span className="rag-query-score">{(cit.score * 100).toFixed(0)}% match</span>}
              </div>
              <div className="rag-query-text" onClick={() => setExpanded(isExpanded ? null : i)}>
                {displayText}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── MAIN PAGE ─── */
export default function RAGInsightsPage({ query, suggestion, querying }) {
  const [chunks, setChunks] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [filterContentType, setFilterContentType] = useState(null);
  const [filterRole, setFilterRole] = useState(null);
  const [filterLayer, setFilterLayer] = useState(null);

  useEffect(() => {
    import('../lib/data-loader').then(({ loadRagChunks, loadPapersIndex }) => {
      Promise.all([loadRagChunks(), loadPapersIndex()])
        .then(([ragChunks, papersIndex]) => {
          if (ragChunks && ragChunks.length) {
            setChunks(ragChunks);
            const paperSet = [...new Set(ragChunks.map(c => c.metadata?.paper_id).filter(Boolean))];
            setStats({ papers: paperSet.map(id => ({ id, title: id })), totalChunks: ragChunks.length });
          }
          setLoading(false);
        })
        .catch(() => setLoading(false));
    });
  }, []);

  const papers = stats?.papers || [];

  // Extract paper IDs mentioned in query results
  const relevantPapers = React.useMemo(() => {
    if (!suggestion || !suggestion.ragCitations || !suggestion.ragCitations.length) return [];
    const ids = [...new Set(suggestion.ragCitations.map(c => c.paper_id).filter(Boolean))];
    return ids;
  }, [suggestion]);

  // Auto-select the first relevant paper when a query comes in
  useEffect(() => {
    if (relevantPapers.length > 0 && !selectedPaper) {
      setSelectedPaper(relevantPapers[0]);
    }
  }, [relevantPapers, selectedPaper]);

  if (loading) {
    return (
      <div className="rag-page">
        <p className="rag-loading">Analyzing paper content and computing similarity map...</p>
      </div>
    );
  }

  return (
    <div className="rag-page">
      {/* Query results from shared copilot */}
      {suggestion && suggestion.ragCitations && suggestion.ragCitations.length > 0 && (
        <QueryRelevantChunks citations={suggestion.ragCitations} query={query} />
      )}

      <StatCards stats={stats} />

      {/* Main grid: map + sidebar */}
      <div className="rag-main">
        {/* Left: chunk map + paper selector */}
        <div className="rag-map-col">
          <div className="rag-card">
            <h3 className="rag-card-title">
              Chunk Embedding Space
              <Tooltip text="Every text passage extracted from the 34 papers was converted to a 384-dimensional vector using a sentence-transformer model, then projected to 2D using UMAP. Passages covering similar topics appear close together, regardless of which paper they came from. This reveals conceptual overlap between papers." wide>
                <span className="chart-help">?</span>
              </Tooltip>
            </h3>
            <p className="rag-card-sub">Each dot is a text passage from a paper. Nearby dots cover similar content. Click a paper name to highlight its chunks.</p>
            <ChunkMap chunks={chunks} papers={papers} selectedPaper={selectedPaper} relevantPapers={relevantPapers} onSelect={setSelectedPaper} />
            <div className="rag-paper-chips">
              {/* Show relevant papers first when there's a query */}
              {(relevantPapers.length > 0
                ? [...relevantPapers, ...papers.filter(p => !relevantPapers.includes(p))]
                : papers
              ).map(p => {
                const isRelevant = relevantPapers.includes(p);
                const isSelected = selectedPaper === p;
                const isDimmed = relevantPapers.length > 0 && !isRelevant && !isSelected;
                return (
                  <button
                    key={p}
                    className={`rag-chip ${isSelected ? 'active' : ''} ${isDimmed ? 'dimmed' : ''}`}
                    style={{
                      '--chip-color': paperColor(p, papers),
                      borderColor: paperColor(p, papers),
                      background: isSelected ? paperColor(p, papers) : 'transparent',
                      color: isSelected ? '#fff' : paperColor(p, papers),
                    }}
                    onClick={() => setSelectedPaper(selectedPaper === p ? null : p)}
                  >
                    {formatPaperId(p)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: anatomy (always shown, random sample or selected paper) */}
        <div className="rag-side-col">
          {selectedPaper ? (
            <PaperAnatomy paperId={selectedPaper} papers={papers} onClose={() => setSelectedPaper(null)} filterContentType={filterContentType} filterRole={filterRole} filterLayer={filterLayer} onFilterContentType={setFilterContentType} onFilterLayer={setFilterLayer} />
          ) : (
            <PaperAnatomy paperId={papers.length > 0 ? papers[Math.floor(papers.length / 3)] : null} papers={papers} onClose={null} filterContentType={filterContentType} filterRole={filterRole} filterLayer={filterLayer} onFilterContentType={setFilterContentType} onFilterLayer={setFilterLayer} />
          )}
        </div>
      </div>

      {/* Breakdowns: always visible below */}
      <div className="rag-bottom-row">
        <div className="rag-card">
          <h3 className="rag-card-title">
            Topic Coverage
            <Tooltip text="Each chunk was scanned for 80+ domain-specific keywords (e.g., 'point cloud', '6-DoF', 'sim-to-real'). This shows which technical concepts appear most frequently across all 1,074 text passages in the knowledge base." wide>
              <span className="chart-help">?</span>
            </Tooltip>
          </h3>
          <p className="rag-card-sub">Most frequent domain terms across all chunks</p>
          <HorizontalBars items={(stats?.topics || []).slice(0, 12)} title="" />
        </div>

        <div className="rag-card">
          <h3 className="rag-card-title">
            Content Breakdown
            <Tooltip text="Each text chunk was automatically classified by what it describes. 'How It Works' covers algorithms and math. 'How To Build It' covers training and implementation details. 'How It Performs' covers experimental results." wide>
              <span className="chart-help">?</span>
            </Tooltip>
          </h3>
          <HorizontalBars
            items={stats?.content_types}
            labelMap={CONTENT_LABELS}
            colorFn={k => CONTENT_COLORS[k] || '#888'}
            title="By Focus"
            activeKey={filterContentType}
            onBarClick={setFilterContentType}
          />
          <HorizontalBars
            items={stats?.roles}
            labelMap={ROLE_LABELS}
            colorFn={() => '#E86C4B'}
            title="By Purpose"
            activeKey={filterRole}
            onBarClick={setFilterRole}
          />
          <HorizontalBars
            items={stats?.layers}
            labelMap={{ coarse: 'Overview (abstract/summary)', mid: 'Section-level', fine: 'Paragraph-level' }}
            colorFn={() => '#47a36d'}
            title="By Extraction Level"
            activeKey={filterLayer}
            onBarClick={setFilterLayer}
          />
        </div>
      </div>

      <ChunkingExplainer />
    </div>
  );
}

/* ─── CHUNKING EXPLAINER TOGGLE ─── */
function ChunkingExplainer() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rag-explainer">
      <button className="rag-explainer-toggle" onClick={() => setOpen(!open)}>
        <span>How the Knowledge Base Works</span>
        <span className="rag-explainer-arrow">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div className="rag-explainer-content">
          <div className="rag-explainer-grid">
            <div className="rag-explainer-step">
              <div className="rag-explainer-step-num">1</div>
              <div>
                <h4>PDF Parsing</h4>
                <p>Each research paper (PDF) is processed to extract structured text. The parser identifies section boundaries (Abstract, Methods, Experiments, etc.), figure captions, and equations using font size heuristics and heading patterns.</p>
              </div>
            </div>

            <div className="rag-explainer-step">
              <div className="rag-explainer-step-num">2</div>
              <div>
                <h4>Three-Level Text Extraction</h4>
                <p><strong>Overview</strong> passages capture the paper's abstract and one summary per section. <strong>Section-level</strong> passages are created by detecting topic shifts within sections: sentences are compared for semantic similarity, and boundaries are placed where the topic changes. <strong>Detail</strong> passages are individual paragraphs for precise retrieval.</p>
              </div>
            </div>

            <div className="rag-explainer-step">
              <div className="rag-explainer-step-num">3</div>
              <div>
                <h4>Content Classification</h4>
                <p>Each passage is automatically classified by what it describes. "How it works" covers algorithms and mathematical formulations. "Implementation" covers training procedures and hardware details. "Results" covers experimental findings and benchmarks. Domain-specific keywords (e.g., "point cloud", "6-DoF", "sim-to-real") are also extracted from each passage.</p>
              </div>
            </div>

            <div className="rag-explainer-step">
              <div className="rag-explainer-step-num">4</div>
              <div>
                <h4>Similarity Indexing</h4>
                <p>Every passage is converted into a numerical representation (a vector) that captures its meaning. These vectors are stored in a searchable database. When you ask a question, your question is converted into the same kind of vector and compared against all stored passages to find the most relevant content across all papers.</p>
              </div>
            </div>

            <div className="rag-explainer-step">
              <div className="rag-explainer-step-num">5</div>
              <div>
                <h4>Overlap Between Passages</h4>
                <p>Adjacent section-level passages share a 15% overlap: the last few sentences of one passage are repeated at the start of the next. This ensures that concepts spanning a boundary are not lost during retrieval.</p>
              </div>
            </div>

            <div className="rag-explainer-step">
              <div className="rag-explainer-step-num">6</div>
              <div>
                <h4>Query Answering</h4>
                <p>When you ask a question on the Explorer page, the system retrieves the most relevant passages, feeds them to a language model along with the method metadata and clustering results, and generates an insight that cites specific papers. The language model only interprets results that were already computed: it does not guess or fabricate information.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
