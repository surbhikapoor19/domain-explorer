import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { smartSplit, getPointColor, buildColorMap } from '../utils';
import { CLUSTER_COLORS } from '../constants';
import { useDomainConfig } from '../DomainContext';

export default function ScatterPlot({
  data,
  colorBy,
  highlightedMethods,
  hoveredIndex,
  activeCluster,
  onPointClick,
  onHover,
  onUnhover,
}) {
  const { shortNames } = useDomainConfig();
  const hasHighlights = highlightedMethods.length > 0;

  // Plotly can't read CSS custom properties, so pick a label color that adapts to
  // a dark host page (the CSS surfaces are already theme-aware). The plot background
  // is left transparent so it inherits the app's theme-aware surface instead of a
  // hardcoded light panel — otherwise the scatter renders dark-on-dark when embedded.
  const isDarkTheme = useMemo(() => {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (_) { return false; }
  }, []);
  const labelColor = isDarkTheme ? '#d5dae2' : '#333';

  const colorMap = useMemo(() => buildColorMap(data, colorBy), [data, colorBy]);

  let markerColors, useDiscreteColors;
  if (colorBy === 'index') {
    markerColors = data.map((_, i) => i);
    useDiscreteColors = false;
  } else {
    markerColors = data.map(d => getPointColor(d, colorBy, colorMap));
    useDiscreteColors = true;
  }

  const hasClusterFilter = activeCluster != null;

  const matchesFilter = (d) => {
    if (!hasClusterFilter) return true;
    if (typeof activeCluster === 'object' && activeCluster.type === 'column') {
      const parts = smartSplit(d.metadata[activeCluster.column] || '');
      return parts.some(p => p === activeCluster.value);
    }
    return d.cluster === activeCluster;
  };

  const markerSizes = data.map((d, i) => {
    if (i === hoveredIndex) return 20;
    if (hasHighlights && highlightedMethods.includes(d.name)) return 16;
    if (hasClusterFilter && matchesFilter(d)) return 12;
    return 10;
  });

  const markerOpacity = data.map((d, i) => {
    if (i === hoveredIndex) return 1;
    if (hasClusterFilter && !matchesFilter(d)) return 0.08;
    if (hasHighlights && !highlightedMethods.includes(d.name)) return 0.35;
    return 0.9;
  });

  const plotData = [{
    x: data.map(d => d.x),
    y: data.map(d => d.y),
    mode: 'markers+text',
    type: 'scatter',
    text: data.map(d => {
      if (hasHighlights && highlightedMethods.includes(d.name)) {
        return d.name.length > 22 ? d.name.slice(0, 20) + '...' : d.name;
      }
      return '';
    }),
    textposition: 'top center',
    textfont: { size: 9, color: labelColor },
    hovertemplate: '<b>%{customdata}</b><extra></extra>',
    customdata: data.map(d => d.name),
    marker: {
      size: markerSizes,
      color: markerColors,
      colorscale: useDiscreteColors ? undefined : 'Portland',
      showscale: !useDiscreteColors,
      opacity: markerOpacity,
      line: {
        color: data.map((d, i) => {
          if (i === hoveredIndex) return '#ff0000';
          if (hasHighlights && highlightedMethods.includes(d.name)) return '#667eea';
          return 'rgba(0,0,0,0.15)';
        }),
        width: data.map((d, i) => {
          if (i === hoveredIndex) return 3;
          if (hasHighlights && highlightedMethods.includes(d.name)) return 3;
          return 0.5;
        })
      },
      colorbar: useDiscreteColors ? undefined : {
        title: shortNames[colorBy] || colorBy,
      }
    },
    showlegend: false
  }];

  const layout = {
    xaxis: {
      zeroline: false, showgrid: false,
      showline: false, showticklabels: false, title: '',
    },
    yaxis: {
      zeroline: false, showgrid: false,
      showline: false, showticklabels: false, title: '',
    },
    hovermode: 'closest',
    height: 420,
    margin: { t: 12, b: 16, l: 12, r: 12 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent'
  };

  return (
    <Plot
      data={plotData}
      layout={layout}
      onClick={(event) => {
        if (event.points && event.points.length > 0) {
          onPointClick(data[event.points[0].pointIndex]);
        }
      }}
      onHover={(event) => {
        if (event.points && event.points.length > 0) {
          onHover(event.points[0].pointIndex);
        }
      }}
      onUnhover={onUnhover}
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: 'hover' }}
      useResizeHandler={true}
    />
  );
}
