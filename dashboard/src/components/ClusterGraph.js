import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { CLUSTER_COLORS } from '../constants';
import { getPointColor, buildColorMap } from '../utils';

export default function ClusterGraph({
  data,
  colorBy = 'cluster',
  clusterStats,
  highlightedMethods,
  onPointClick,
}) {
  const graphData = useMemo(() => {
    if (!data || !clusterStats || clusterStats.length === 0) return null;

    const crossCols = ['Planning Method', 'End-effector Hardware', 'Input Data',
                       'Training Data', 'Object Configuration', 'Backbone'];

    // Group methods by cluster
    const clusterMembers = {};
    data.forEach((d, i) => {
      if (!clusterMembers[d.cluster]) clusterMembers[d.cluster] = [];
      clusterMembers[d.cluster].push(i);
    });

    // Compute cluster centroids (average UMAP position)
    const centroids = {};
    Object.entries(clusterMembers).forEach(([cId, members]) => {
      const cx = members.reduce((s, i) => s + data[i].x, 0) / members.length;
      const cy = members.reduce((s, i) => s + data[i].y, 0) / members.length;
      centroids[cId] = { x: cx, y: cy };
    });

    // Compute inter-cluster edge weights based on shared attribute values
    const clusterIds = Object.keys(clusterMembers).map(Number).sort((a, b) => a - b);
    const edges = [];

    for (let a = 0; a < clusterIds.length; a++) {
      for (let b = a + 1; b < clusterIds.length; b++) {
        const cA = clusterIds[a];
        const cB = clusterIds[b];
        const membersA = clusterMembers[cA];
        const membersB = clusterMembers[cB];

        // Count shared attribute values between clusters
        let sharedScore = 0;
        for (const col of crossCols) {
          const valsA = new Set();
          membersA.forEach(i => {
            (data[i].metadata[col] || '').split(',').forEach(v => {
              const t = v.trim().toLowerCase();
              if (t) valsA.add(t);
            });
          });
          const valsB = new Set();
          membersB.forEach(i => {
            (data[i].metadata[col] || '').split(',').forEach(v => {
              const t = v.trim().toLowerCase();
              if (t) valsB.add(t);
            });
          });
          // Jaccard-like overlap
          let overlap = 0;
          valsA.forEach(v => { if (valsB.has(v)) overlap++; });
          const union = new Set([...valsA, ...valsB]).size;
          if (union > 0) sharedScore += overlap / union;
        }

        // Normalize by number of columns
        const weight = sharedScore / crossCols.length;
        if (weight > 0.05) {
          edges.push({ source: cA, target: cB, weight });
        }
      }
    }

    return { clusterIds, centroids, edges, clusterMembers };
  }, [data, clusterStats]);

  if (!graphData) return null;

  const { clusterIds, centroids, edges, clusterMembers } = graphData;

  // Edge traces with thickness by weight
  const edgeTraces = edges.map(e => {
    const src = centroids[e.source];
    const tgt = centroids[e.target];
    return {
      x: [src.x, tgt.x], y: [src.y, tgt.y],
      mode: 'lines', type: 'scatter',
      line: {
        color: 'rgba(80,80,80,0.25)',
        width: Math.max(1, e.weight * 12),
      },
      hoverinfo: 'text',
      text: `${(e.weight * 100).toFixed(0)}% attribute overlap`,
      showlegend: false,
    };
  });

  // Find which cluster has highlighted methods
  const highlightedClusters = new Set();
  if (highlightedMethods && highlightedMethods.length > 0) {
    data.forEach(d => {
      if (highlightedMethods.includes(d.name)) {
        highlightedClusters.add(d.cluster);
      }
    });
  }

  // Node trace: one bubble per cluster, sized by member count
  const nodeTrace = {
    x: clusterIds.map(c => centroids[c].x),
    y: clusterIds.map(c => centroids[c].y),
    mode: 'markers+text',
    type: 'scatter',
    text: clusterIds.map(c => {
      const stat = clusterStats.find(s => s.id === c);
      const label = stat ? stat.label : `Cluster ${c}`;
      // Shorten label
      return label.length > 30 ? label.slice(0, 28) + '...' : label;
    }),
    textposition: 'top center',
    textfont: { size: 11, color: '#333', family: 'PT Sans, sans-serif' },
    hovertemplate: clusterIds.map(c => {
      const stat = clusterStats.find(s => s.id === c);
      const label = stat ? stat.label : `Cluster ${c}`;
      const methods = (clusterMembers[c] || []).map(i => data[i].name).slice(0, 5).join(', ');
      const more = (clusterMembers[c] || []).length > 5 ? ` +${(clusterMembers[c] || []).length - 5} more` : '';
      return `<b>${label}</b><br>${(clusterMembers[c] || []).length} methods<br>${methods}${more}<extra></extra>`;
    }),
    marker: {
      size: clusterIds.map(c => {
        const count = (clusterMembers[c] || []).length;
        return Math.max(25, Math.sqrt(count) * 18);
      }),
      color: clusterIds.map(c => {
        if (colorBy === 'cluster') return CLUSTER_COLORS[c] || '#999';
        // Use the most common value in this cluster for the color
        const members = clusterMembers[c] || [];
        if (members.length === 0) return '#999';
        const cm = buildColorMap(data, colorBy);
        // Pick color of the first member as representative
        return getPointColor(data[members[0]], colorBy, cm);
      }),
      opacity: clusterIds.map(c => {
        if (highlightedClusters.size === 0) return 0.85;
        return highlightedClusters.has(c) ? 1 : 0.3;
      }),
      line: {
        color: clusterIds.map(c =>
          highlightedClusters.has(c) ? '#333' : 'rgba(0,0,0,0.15)'
        ),
        width: clusterIds.map(c => highlightedClusters.has(c) ? 2.5 : 1),
      },
    },
    showlegend: false,
  };

  const layout = {
    xaxis: {
      zeroline: false, showgrid: false,
      showticklabels: false, showline: false, title: '',
    },
    yaxis: {
      zeroline: false, showgrid: false,
      showticklabels: false, showline: false, title: '',
    },
    hovermode: 'closest',
    height: 420,
    margin: { t: 20, b: 10, l: 10, r: 10 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: '#fafcfd',
    annotations: edges.filter(e => e.weight > 0.15).map(e => {
      const src = centroids[e.source];
      const tgt = centroids[e.target];
      const mx = (src.x + tgt.x) / 2;
      const my = (src.y + tgt.y) / 2;
      return {
        x: mx, y: my,
        text: `${(e.weight * 100).toFixed(0)}%`,
        showarrow: false,
        font: { size: 9, color: '#888' },
        bgcolor: 'rgba(255,255,255,0.7)',
      };
    }),
  };

  return (
    <Plot
      data={[...edgeTraces, nodeTrace]}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
    />
  );
}
