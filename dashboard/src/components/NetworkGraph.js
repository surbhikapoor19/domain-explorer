import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { CLUSTER_COLORS } from '../constants';
import { getPointColor, buildColorMap } from '../utils';

export default function NetworkGraph({
  data,
  colorBy = 'cluster',
  highlightedMethods,
  hoveredIndex,
  onPointClick,
  onHover,
  onUnhover,
}) {
  const hasHighlights = highlightedMethods.length > 0;

  // Build edges: within-cluster (HDBSCAN) + cross-cluster (shared attributes)
  // Use UMAP coordinates directly (same as scatter plot)
  const { intraEdges, crossEdges } = useMemo(() => {
    if (!data || data.length === 0) return { intraEdges: [], crossEdges: [] };

    const n = data.length;
    const intra = [];
    const cross = [];

    // Within-cluster: connect all pairs in the same HDBSCAN cluster
    const clusters = {};
    data.forEach((d, i) => {
      if (!clusters[d.cluster]) clusters[d.cluster] = [];
      clusters[d.cluster].push(i);
    });

    Object.values(clusters).forEach(members => {
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) {
          intra.push({ source: members[a], target: members[b] });
        }
      }
    });

    // Cross-cluster: connect methods in DIFFERENT clusters that share attribute values
    const crossCols = ['Planning Method', 'End-effector Hardware', 'Input Data',
                       'Training Data', 'Object Configuration', 'Backbone'];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (data[i].cluster === data[j].cluster) continue;
        let shared = 0;
        for (const col of crossCols) {
          const a = (data[i].metadata[col] || '').toLowerCase();
          const b = (data[j].metadata[col] || '').toLowerCase();
          if (!a || !b) continue;
          const aVals = a.split(',').map(v => v.trim());
          const bVals = b.split(',').map(v => v.trim());
          if (aVals.some(v => bVals.includes(v))) shared++;
        }
        if (shared >= 3) {
          cross.push({ source: i, target: j, shared });
        }
      }
    }

    return { intraEdges: intra, crossEdges: cross };
  }, [data]);

  const colorMap = useMemo(() => buildColorMap(data || [], colorBy), [data, colorBy]);

  if (!data || data.length === 0) return null;

  // Intra-cluster edge traces (one per cluster, cluster colored)
  const clusterEdgeCoords = {};
  intraEdges.forEach(e => {
    const cluster = data[e.source].cluster;
    if (!clusterEdgeCoords[cluster]) clusterEdgeCoords[cluster] = { x: [], y: [] };
    clusterEdgeCoords[cluster].x.push(data[e.source].x, data[e.target].x, null);
    clusterEdgeCoords[cluster].y.push(data[e.source].y, data[e.target].y, null);
  });

  const intraTraces = Object.entries(clusterEdgeCoords).map(([clusterId, coords]) => ({
    x: coords.x, y: coords.y,
    mode: 'lines', type: 'scatter',
    line: { color: CLUSTER_COLORS[parseInt(clusterId)] || '#ccc', width: 0.7 },
    opacity: 0.12,
    hoverinfo: 'none', showlegend: false,
  }));

  // Cross-cluster edge trace (gray dashed, shows interdependency)
  const crossX = [], crossY = [];
  crossEdges.forEach(e => {
    crossX.push(data[e.source].x, data[e.target].x, null);
    crossY.push(data[e.source].y, data[e.target].y, null);
  });

  const crossTrace = crossX.length > 0 ? [{
    x: crossX, y: crossY,
    mode: 'lines', type: 'scatter',
    line: { color: 'rgba(100,100,100,0.25)', width: 1, dash: 'dot' },
    hoverinfo: 'none', showlegend: false,
  }] : [];

  const edgeTraces = [...intraTraces, ...crossTrace];

  // Node trace
  const markerSizes = data.map((d, i) => {
    if (i === hoveredIndex) return 20;
    if (hasHighlights && highlightedMethods.includes(d.name)) return 16;
    return 10;
  });

  const markerColors = data.map(d => getPointColor(d, colorBy, colorMap));

  const markerOpacity = data.map((d, i) => {
    if (i === hoveredIndex) return 1;
    if (hasHighlights && !highlightedMethods.includes(d.name)) return 0.3;
    return 0.85;
  });

  const nodeTrace = {
    x: data.map(d => d.x),
    y: data.map(d => d.y),
    mode: 'markers+text',
    type: 'scatter',
    text: data.map(d => {
      if (hasHighlights && highlightedMethods.includes(d.name)) {
        return d.name.length > 20 ? d.name.slice(0, 18) + '...' : d.name;
      }
      return '';
    }),
    textposition: 'top center',
    textfont: { size: 9, color: '#333' },
    hovertemplate: '<b>%{customdata}</b><extra></extra>',
    customdata: data.map(d => d.name),
    marker: {
      size: markerSizes,
      color: markerColors,
      opacity: markerOpacity,
      line: {
        color: data.map((d, i) => {
          if (i === hoveredIndex) return '#ff0000';
          if (hasHighlights && highlightedMethods.includes(d.name)) return '#16657d';
          return 'rgba(0,0,0,0.12)';
        }),
        width: data.map((d, i) => {
          if (i === hoveredIndex) return 3;
          if (hasHighlights && highlightedMethods.includes(d.name)) return 2.5;
          return 0.5;
        }),
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
    margin: { t: 8, b: 8, l: 8, r: 8 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: '#fafcfd',
  };

  return (
    <Plot
      data={[...edgeTraces, nodeTrace]}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
      onClick={(e) => {
        if (e.points && e.points.length > 0 && e.points[0].curveNumber === edgeTraces.length) {
          onPointClick(data[e.points[0].pointIndex]);
        }
      }}
      onHover={(e) => {
        if (e.points && e.points.length > 0 && e.points[0].curveNumber === edgeTraces.length) {
          onHover(e.points[0].pointIndex);
        }
      }}
      onUnhover={onUnhover}
    />
  );
}
