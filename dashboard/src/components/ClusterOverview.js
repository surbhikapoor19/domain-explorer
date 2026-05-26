import React, { useMemo } from 'react';
import InsightBullets from './InsightBullets';
import { CLUSTER_COLORS } from '../constants';
import { useDomainConfig } from '../DomainContext';
import { smartSplit, buildColorMap, getPointColor } from '../utils';

const COLUMN_COLORS = [
  '#0C3383', '#0A88BA', '#F2D338', '#F28F38', '#D91E1E',
  '#7B2D8E', '#3F681C', '#E75480', '#1B998B', '#FF6B6B',
  '#4A90D9', '#D4A017', '#8B4513', '#2E8B57', '#CD5C5C',
];

export function ClusterLegend({ stats, activeCluster, onClusterClick, colorBy, data }) {
  const { shortNames } = useDomainConfig();
  const columnLegend = useMemo(() => {
    if (!colorBy || colorBy === 'cluster' || colorBy === 'index' || !data || !data.length) return null;
    const valueCounts = {};
    data.forEach(d => {
      const parts = smartSplit(d.metadata?.[colorBy] || '');
      const primary = parts.length > 0 ? parts[0] : 'N/A';
      valueCounts[primary] = (valueCounts[primary] || 0) + 1;
    });
    return Object.entries(valueCounts).sort((a, b) => b[1] - a[1]).map(([val, count], i) => ({
      value: val, count, color: COLUMN_COLORS[i % COLUMN_COLORS.length],
    }));
  }, [colorBy, data]);

  if (!stats && !columnLegend) return null;

  if (columnLegend) {
    const displayName = shortNames[colorBy] || colorBy;
    const activeValue = activeCluster && typeof activeCluster === 'object' ? activeCluster.value : null;
    return (
      <div className="cluster-legend-compact">
        <div className="cluster-legend-title">
          Colored by: {displayName}
          {activeValue != null && <span className="cluster-legend-clear" onClick={() => onClusterClick && onClusterClick(null)}>&times; clear</span>}
        </div>
        {columnLegend.map((item, i) => {
          const isActive = activeValue === item.value;
          const isDimmed = activeValue != null && !isActive;
          return (
            <div
              key={i}
              className={`cluster-legend-row clickable ${isActive ? 'active' : ''} ${isDimmed ? 'dimmed' : ''}`}
              onClick={() => onClusterClick && onClusterClick(isActive ? null : { type: 'column', column: colorBy, value: item.value })}
            >
              <span className="cluster-color-dot" style={{ background: item.color }} />
              <span className="cluster-legend-label">{item.value}</span>
              <span className="cluster-legend-count">{item.count}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="cluster-legend-compact">
      <div className="cluster-legend-title">Clusters {activeCluster != null && <span className="cluster-legend-clear" onClick={() => onClusterClick && onClusterClick(null)}>&times; clear</span>}</div>
      {stats.map(cs => {
        const isActive = activeCluster === cs.id;
        const isDimmed = activeCluster != null && !isActive;
        return (
          <div
            key={cs.id}
            className={`cluster-legend-row clickable ${isActive ? 'active' : ''} ${isDimmed ? 'dimmed' : ''}`}
            onClick={() => onClusterClick && onClusterClick(isActive ? null : cs.id)}
          >
            <span className="cluster-color-dot" style={{ background: CLUSTER_COLORS[cs.id] || '#999' }} />
            <span className="cluster-legend-label">{cs.label}</span>
            <span className="cluster-legend-count">{cs.size}</span>
          </div>
        );
      })}
    </div>
  );
}

function buildColumnSummary(data, colorBy, shortNames = {}) {
  if (!data || !data.length || !colorBy || colorBy === 'cluster') return null;
  const displayName = shortNames[colorBy] || colorBy;

  // Group methods by their primary value for this column
  const groups = {};
  data.forEach(d => {
    const parts = smartSplit(d.metadata?.[colorBy] || '');
    const primary = parts.length > 0 ? parts[0] : 'N/A';
    if (!groups[primary]) groups[primary] = [];
    groups[primary].push(d);
  });

  // Compute spatial coherence: for each group, measure how tightly its members
  // cluster in UMAP space vs. the overall spread. Low ratio = spatially concentrated,
  // high ratio = dispersed across the landscape.
  const allX = data.map(d => d.x);
  const allY = data.map(d => d.y);
  const globalSpread = Math.sqrt(variance(allX) + variance(allY));

  const groupStats = Object.entries(groups)
    .filter(([, members]) => members.length >= 2)
    .map(([val, members]) => {
      const gx = members.map(d => d.x);
      const gy = members.map(d => d.y);
      const groupSpread = Math.sqrt(variance(gx) + variance(gy));
      const ratio = globalSpread > 0 ? groupSpread / globalSpread : 1;
      return { val, count: members.length, ratio };
    })
    .sort((a, b) => a.ratio - b.ratio);

  if (groupStats.length === 0) return null;

  // Classify groups
  const tight = groupStats.filter(g => g.ratio < 0.55);
  const dispersed = groupStats.filter(g => g.ratio > 0.85);
  const avgRatio = groupStats.reduce((s, g) => s + g.ratio, 0) / groupStats.length;

  const bullets = [];

  // Overall assessment
  if (avgRatio < 0.5) {
    bullets.push(`- **${displayName}** aligns strongly with UMAP similarity — methods with the same ${displayName.toLowerCase()} tend to be similar overall, suggesting this attribute correlates with other method characteristics.`);
  } else if (avgRatio > 0.8) {
    bullets.push(`- **${displayName}** is largely independent of overall method similarity — methods that are close in the scatter plot often differ on this attribute, making it a useful dimension to explore orthogonally.`);
  } else {
    bullets.push(`- **${displayName}** partially aligns with the UMAP layout — some values form spatial clusters while others are spread across the landscape.`);
  }

  // Highlight tightest group(s)
  if (tight.length > 0) {
    const top = tight.slice(0, 2).map(g => `"${g.val}" (${g.count})`).join(' and ');
    bullets.push(`- Spatially concentrated: ${top} — these methods cluster together in UMAP space, meaning they also share other attributes.`);
  }

  // Highlight most dispersed group(s)
  if (dispersed.length > 0) {
    const top = dispersed.slice(0, 2).map(g => `"${g.val}" (${g.count})`).join(' and ');
    bullets.push(`- Spatially dispersed: ${top} — these methods appear across the landscape despite sharing this ${displayName.toLowerCase()} value, suggesting they differ on other attributes.`);
  }

  return bullets.join('\n');
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

function buildMethodColorMap(data, colorBy) {
  if (!data || !data.length) return {};
  const cm = buildColorMap(data, colorBy);
  const map = {};
  data.forEach(d => {
    const color = getPointColor(d, colorBy, cm);
    // Store as a pseudo cluster ID that InsightBullets can use
    map[d.name] = color;
  });
  return map;
}

export function ClusterInsight({ insight, loading, stats, onMethodClick, colorBy = 'cluster', data }) {
  const { shortNames } = useDomainConfig();
  const isColumnMode = colorBy && colorBy !== 'cluster' && colorBy !== 'index';

  const columnSummary = useMemo(
    () => isColumnMode ? buildColumnSummary(data, colorBy, shortNames) : null,
    [data, colorBy, isColumnMode, shortNames]
  );

  const displayInsight = isColumnMode ? columnSummary : insight;
  const title = isColumnMode ? `${shortNames[colorBy] || colorBy} Overview` : 'Cluster Overview';

  // Build method -> color map
  const { methodClusterMap, clusterLabelMap, useDirectColors } = useMemo(() => {
    if (isColumnMode && data) {
      // Direct color strings instead of cluster IDs
      const directMap = buildMethodColorMap(data, colorBy);
      // Build group label map
      const groups = {};
      data.forEach(d => {
        const parts = smartSplit(d.metadata?.[colorBy] || '');
        const primary = parts.length > 0 ? parts[0] : 'N/A';
        if (!groups[primary]) groups[primary] = getPointColor(d, colorBy, buildColorMap(data, colorBy));
      });
      return { methodClusterMap: directMap, clusterLabelMap: groups, useDirectColors: true };
    }
    const mcm = {};
    const clm = {};
    // Build from stats first (has emoji-prefixed names)
    if (stats) {
      stats.forEach(cs => {
        cs.methods.forEach(name => { mcm[name] = cs.id; });
        if (cs.label) clm[cs.label] = cs.id;
      });
    }
    // Also build from live data (covers all 56 methods including those without papers)
    if (data) {
      data.forEach(d => {
        if (d.name && d.cluster !== undefined && !mcm[d.name]) {
          mcm[d.name] = d.cluster;
        }
      });
    }
    return { methodClusterMap: mcm, clusterLabelMap: clm, useDirectColors: false };
  }, [stats, data, colorBy, isColumnMode]);

  if (!displayInsight && !loading) return null;

  return (
    <div className="cluster-insight-card">
      <div className="cluster-insight-header">
        <span className="cluster-insight-icon">AI</span>
        <span className="cluster-insight-title">{title}</span>
      </div>
      <div className="cluster-insight-body">
        {loading ? (
          <p className="cluster-insight-loading">Analyzing clusters...</p>
        ) : (
          <InsightBullets
            text={displayInsight}
            methodClusterMap={methodClusterMap}
            clusterLabelMap={clusterLabelMap}
            onMethodClick={onMethodClick}
            useDirectColors={useDirectColors}
          />
        )}
      </div>
    </div>
  );
}

