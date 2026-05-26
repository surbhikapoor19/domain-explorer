import React from 'react';
import Plot from 'react-plotly.js';
import Tooltip from './Tooltip';

// Human-friendly labels for content types and rhetorical roles
const CONTENT_TYPE_LABELS = {
  theory: 'How It Works',
  implementation: 'How To Build It',
  evaluation: 'How It Performs',
  general: 'General',
};

const ROLE_LABELS = {
  algorithm_description: 'Method Design',
  experimental_setup: 'Experiment Setup',
  result: 'Results & Metrics',
  comparison: 'Comparisons',
  problem_statement: 'Problem Definition',
  limitation: 'Limitations',
  definition: 'Definitions',
  general: 'General',
};

const CONTENT_COLORS = {
  'How It Works': '#185A7C',
  'How To Build It': '#47a36d',
  'How It Performs': '#E86C4B',
  'General': '#94a3b8',
};

const ROLE_COLORS = {
  'Method Design': '#185A7C',
  'Experiment Setup': '#47a36d',
  'Results & Metrics': '#E86C4B',
  'Comparisons': '#c0392b',
  'Problem Definition': '#7c6daa',
  'Limitations': '#d4851e',
  'Definitions': '#2a9d8f',
  'General': '#94a3b8',
};

function MethodRelevanceChart({ methodRelevance }) {
  if (!methodRelevance || methodRelevance.length === 0) return null;
  const top = methodRelevance.slice(0, 10);
  const names = top.map(m => m.name.length > 35 ? m.name.slice(0, 33) + '...' : m.name);
  const scores = top.map(m => m.score);
  const maxScore = Math.max(...scores);

  return (
    <div className="analytics-card">
      <h3 className="analytics-card-title">
        Query-Method Similarity
        <Tooltip text="Each method's text description was converted to a vector using a sentence-transformer model, then compared to your query vector using cosine similarity. Higher scores mean the method's description is more semantically related to what you asked." wide>
          <span className="chart-help">?</span>
        </Tooltip>
      </h3>
      <p className="analytics-card-subtitle">How closely each method's description matches your query</p>
      <Plot
        data={[{
          type: 'bar',
          x: scores,
          y: names,
          orientation: 'h',
          marker: {
            color: scores.map(s => {
              const ratio = s / maxScore;
              return ratio > 0.9 ? '#185A7C' : ratio > 0.7 ? '#2a7da5' : '#8ab5cc';
            }),
            line: { width: 0 },
          },
          text: scores.map(s => (s * 100).toFixed(0) + '%'),
          textposition: 'outside',
          textfont: { size: 11, color: '#555' },
          hovertemplate: '%{y}: %{x:.1%}<extra></extra>',
        }]}
        layout={{
          margin: { l: 210, r: 50, t: 5, b: 25 },
          height: Math.max(180, top.length * 26),
          xaxis: {
            title: { text: 'Relevance Score', font: { size: 10, color: '#888' } },
            range: [0, maxScore * 1.2],
            showgrid: true, gridcolor: '#f0f0f0',
          },
          yaxis: { autorange: 'reversed', tickfont: { size: 11 } },
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
      />
    </div>
  );
}

function PaperSourcesChart({ paperSources }) {
  if (!paperSources || paperSources.length === 0) return null;
  const names = paperSources.map(p => p.name.length > 35 ? p.name.slice(0, 33) + '...' : p.name);
  const counts = paperSources.map(p => p.count);

  return (
    <div className="analytics-card">
      <h3 className="analytics-card-title">
        Papers Referenced
        <Tooltip text="When you ask a question, the system searches a vector database of text chunks extracted from the research papers. This chart shows which papers had the most passages matching your query. More passages means the paper is more relevant to your question." wide>
          <span className="chart-help">?</span>
        </Tooltip>
      </h3>
      <p className="analytics-card-subtitle">Number of relevant passages retrieved from each paper</p>
      <Plot
        data={[{
          type: 'bar',
          x: counts,
          y: names,
          orientation: 'h',
          marker: { color: '#47a36d', line: { width: 0 } },
          text: counts.map(String),
          textposition: 'outside',
          textfont: { size: 11, color: '#555' },
          hovertemplate: '%{y}: %{x} passages<extra></extra>',
        }]}
        layout={{
          margin: { l: 220, r: 40, t: 5, b: 25 },
          height: Math.max(140, paperSources.length * 32),
          xaxis: {
            title: { text: 'Passages Found', font: { size: 10, color: '#888' } },
            dtick: 1, showgrid: true, gridcolor: '#f0f0f0',
          },
          yaxis: { autorange: 'reversed', tickfont: { size: 11 } },
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
      />
    </div>
  );
}

function DomainTopicsChart({ domainTopics }) {
  if (!domainTopics || domainTopics.length === 0) return null;
  const top = domainTopics.slice(0, 12);

  return (
    <div className="analytics-card">
      <h3 className="analytics-card-title">
        Key Topics in Evidence
        <Tooltip text="Each retrieved paper passage was scanned for domain-specific technical terms (like 'point cloud', 'gripper', '6-DoF'). Larger, darker tags appear more frequently across the evidence, showing what concepts dominate the retrieved content." wide>
          <span className="chart-help">?</span>
        </Tooltip>
      </h3>
      <p className="analytics-card-subtitle">Technical terms found across retrieved paper passages</p>
      <div className="topic-cloud">
        {top.map((t, i) => {
          const ratio = t.count / top[0].count;
          return (
            <span
              key={i}
              className="topic-tag"
              style={{
                fontSize: `${0.72 + ratio * 0.4}rem`,
                background: ratio > 0.6 ? '#667eea' : ratio > 0.3 ? '#e8ecf1' : '#f7f8fc',
                color: ratio > 0.6 ? 'white' : '#4a5568',
              }}
            >
              {t.topic}
              <span className="topic-count" style={{
                background: ratio > 0.6 ? 'rgba(255,255,255,0.3)' : '#667eea',
                color: 'white',
              }}>{t.count}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function EvidenceTypeChart({ contentTypes, rhetoricalRoles }) {
  if ((!contentTypes || contentTypes.length === 0) &&
      (!rhetoricalRoles || rhetoricalRoles.length === 0)) return null;

  // Build stacked bar for "What kind of evidence did we find?"
  const typeData = (contentTypes || []).map(c => ({
    label: CONTENT_TYPE_LABELS[c.type] || c.type,
    count: c.count,
    color: CONTENT_COLORS[CONTENT_TYPE_LABELS[c.type]] || '#cbd5e0',
  }));

  const roleData = (rhetoricalRoles || []).map(r => ({
    label: ROLE_LABELS[r.role] || r.role,
    count: r.count,
    color: ROLE_COLORS[ROLE_LABELS[r.role]] || '#cbd5e0',
  }));

  const totalChunks = typeData.reduce((sum, d) => sum + d.count, 0) || 1;

  return (
    <div className="analytics-card">
      <h3 className="analytics-card-title">
        What Kind of Evidence?
        <Tooltip text="Each paper passage is automatically classified by what it describes. 'How It Works' covers algorithms and math. 'How To Build It' covers training details and implementation. 'How It Performs' covers experimental results and benchmarks. This shows what type of content the system found for your query." wide>
          <span className="chart-help">?</span>
        </Tooltip>
      </h3>
      <p className="analytics-card-subtitle">Breakdown of retrieved content by type and purpose</p>

      {typeData.length > 0 && (
        <div className="evidence-type-section">
          <span className="evidence-type-label">Content Focus</span>
          <div className="stacked-bar">
            {typeData.map((d, i) => (
              <div
                key={i}
                className="stacked-bar-segment"
                style={{
                  width: `${(d.count / totalChunks) * 100}%`,
                  background: d.color,
                }}
                title={`${d.label}: ${d.count} passages`}
              >
                {d.count / totalChunks > 0.15 && (
                  <span className="segment-label">{d.label}</span>
                )}
              </div>
            ))}
          </div>
          <div className="evidence-type-legend">
            {typeData.map((d, i) => (
              <span key={i} className="legend-item">
                <span className="legend-dot" style={{ background: d.color }}></span>
                {d.label} ({d.count})
              </span>
            ))}
          </div>
        </div>
      )}

      {roleData.length > 0 && (
        <div className="evidence-type-section">
          <span className="evidence-type-label">Paper Section Purpose</span>
          <div className="stacked-bar">
            {roleData.map((d, i) => (
              <div
                key={i}
                className="stacked-bar-segment"
                style={{
                  width: `${(d.count / totalChunks) * 100}%`,
                  background: d.color,
                }}
                title={`${d.label}: ${d.count} passages`}
              >
                {d.count / totalChunks > 0.15 && (
                  <span className="segment-label">{d.label}</span>
                )}
              </div>
            ))}
          </div>
          <div className="evidence-type-legend">
            {roleData.map((d, i) => (
              <span key={i} className="legend-item">
                <span className="legend-dot" style={{ background: d.color }}></span>
                {d.label} ({d.count})
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CitedReferencesChart({ citedReferences }) {
  if (!citedReferences || citedReferences.length === 0) return null;

  // Filter to only author-year citations (skip numbered [1], [2] which are noisy)
  const authorCites = citedReferences.filter(r => !r.name.startsWith('['));
  const numbered = citedReferences.filter(r => r.name.startsWith('['));

  const toShow = authorCites.length > 0 ? authorCites.slice(0, 10) : numbered.slice(0, 10);
  if (toShow.length === 0) return null;

  const names = toShow.map(r => r.name);
  const counts = toShow.map(r => r.count);

  return (
    <div className="analytics-card">
      <h3 className="analytics-card-title">
        Cited References in Evidence
        <Tooltip text="These are academic papers that were cited WITHIN the retrieved passages. For example, if a retrieved chunk says 'as shown by (Smith et al., 2022)', that reference is counted here. This reveals which foundational works are most relevant to your query, even papers outside the dataset." wide>
          <span className="chart-help">?</span>
        </Tooltip>
      </h3>
      <p className="analytics-card-subtitle">Papers referenced inside the retrieved evidence passages</p>
      <Plot
        data={[{
          type: 'bar',
          x: counts,
          y: names,
          orientation: 'h',
          marker: { color: '#7c6daa', line: { width: 0 } },
          text: counts.map(c => `${c}x`),
          textposition: 'outside',
          textfont: { size: 11, color: '#555' },
          hovertemplate: '%{y}: cited %{x} times<extra></extra>',
        }]}
        layout={{
          margin: { l: 180, r: 40, t: 5, b: 25 },
          height: Math.max(140, toShow.length * 28),
          xaxis: {
            title: { text: 'Times Cited', font: { size: 10, color: '#888' } },
            dtick: 1, showgrid: true, gridcolor: '#f0f0f0',
          },
          yaxis: { autorange: 'reversed', tickfont: { size: 11 } },
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
      />
      {toShow.length > 0 && toShow[0].source_papers && (
        <div className="cited-refs-note">
          Found across: {[...new Set(toShow.flatMap(r => r.source_papers))].slice(0, 3).join(', ')}
          {[...new Set(toShow.flatMap(r => r.source_papers))].length > 3 && ' and more'}
        </div>
      )}
    </div>
  );
}

export default function AnalyticsDashboard({ suggestion }) {
  if (!suggestion) return null;

  const analytics = suggestion.ragAnalytics || {};
  const methodRelevance = suggestion.methodRelevance || [];
  const hasData = methodRelevance.length > 0 ||
    (analytics.paperSources && analytics.paperSources.length > 0);

  if (!hasData) return null;

  return (
    <div className="analytics-dashboard">
      <div className="analytics-header">
        <span className="analytics-header-icon">AI</span>
        <span className="analytics-header-title">Analytics</span>
      </div>
      <div className="analytics-grid">
        <MethodRelevanceChart methodRelevance={methodRelevance} />
        <CitedReferencesChart citedReferences={analytics.citedReferences} />
        <PaperSourcesChart paperSources={analytics.paperSources} />
        <DomainTopicsChart domainTopics={analytics.domainTopics} />
        <EvidenceTypeChart
          contentTypes={analytics.contentTypes}
          rhetoricalRoles={analytics.rhetoricalRoles}
        />
      </div>
    </div>
  );
}
