/**
 * KGSubgraph — Interactive force-directed subgraph visualization.
 * Adapted from melaunch graph-viz-package GraphCanvas pattern.
 *
 * Shows only query-relevant nodes with typed shapes/colors.
 * Hover highlights neighbors, click shows detail.
 */

import React, { useRef, useCallback, useState, useEffect } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const NODE_COLORS = {
  paper: '#16657d',
  method: '#2563eb',
  technique: '#7c3aed',
  claim: '#8691a0',
  attribute: '#475569',
  hardware: '#16794e',
  comparison: '#c2410c',
  limitation: '#b91c1c',
  problem: '#ca8a04',
  figure: '#d97706',
  table: '#0891b2',
  impl_language: '#6366f1',
  author: '#be185d',
  institution: '#0369a1',
  reference: '#94a3b8',
  equation: '#db2777',
};

const NODE_SIZES = {
  paper: 8,
  method: 7,
  technique: 5,
  claim: 4,
  attribute: 4,
  hardware: 5,
  comparison: 4,
  limitation: 4,
  problem: 4,
  figure: 4,
  table: 4,
  impl_language: 4,
  author: 5,
  institution: 6,
  reference: 3,
  equation: 4,
};

export default function KGSubgraph({ paperIds, onNodeClick, height = 380 }) {
  const graphRef = useRef();
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [hoverNode, setHoverNode] = useState(null);
  const [loading, setLoading] = useState(false);
  const [highlightNodes, setHighlightNodes] = useState(new Set());
  const [highlightLinks, setHighlightLinks] = useState(new Set());

  // Configure physics after mount
  useEffect(() => {
    if (graphRef.current) {
      graphRef.current.d3Force('charge').strength(-120).distanceMax(300);
      graphRef.current.d3Force('link').distance(50);
      graphRef.current.d3Force('center').strength(0.05);
    }
  });

  // Fetch subgraph when paperIds change
  useEffect(() => {
    if (!paperIds || paperIds.length === 0) {
      setGraphData({ nodes: [], links: [] });
      return;
    }
    setLoading(true);
    import('../lib/data-loader').then(({ loadKgFull }) => {
      loadKgFull().then(kgData => {
        const { initGraph, extractSubgraph } = require('../lib/kg-graph');
        initGraph(kgData);
        const result = extractSubgraph(paperIds);
        const nodes = result.nodes.map(n => ({
          ...n,
          _color: NODE_COLORS[n.type] || '#8691a0',
          _size: NODE_SIZES[n.type] || 4,
        }));
        setGraphData({ nodes, links: result.links });
        setTimeout(() => { if (graphRef.current) graphRef.current.zoomToFit(400, 40); }, 500);
        setLoading(false);
      }).catch(() => setLoading(false));
    });
  }, [paperIds]);

  // Hover: highlight node + neighbors
  const handleNodeHover = useCallback(node => {
    setHoverNode(node);
    if (!node) {
      setHighlightNodes(new Set());
      setHighlightLinks(new Set());
      return;
    }
    const neighbors = new Set([node.id]);
    const links = new Set();
    graphData.links.forEach(link => {
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
      if (srcId === node.id || tgtId === node.id) {
        neighbors.add(srcId);
        neighbors.add(tgtId);
        links.add(link);
      }
    });
    setHighlightNodes(neighbors);
    setHighlightLinks(links);
  }, [graphData.links]);

  // Custom node painting
  const paintNode = useCallback((node, ctx, globalScale) => {
    const isHighlighted = highlightNodes.size === 0 || highlightNodes.has(node.id);
    const size = node._size;

    ctx.globalAlpha = isHighlighted ? 1 : 0.12;

    if (node.type === 'paper') {
      // Rounded rectangle for papers
      const w = size * 2.2;
      const h = size * 1.4;
      ctx.fillStyle = node._color;
      ctx.beginPath();
      ctx.roundRect(node.x - w / 2, node.y - h / 2, w, h, 2);
      ctx.fill();
    } else {
      // Circle for everything else
      ctx.fillStyle = node._color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Labels: show when zoomed in or hovered
    if (globalScale > 1.8 || highlightNodes.has(node.id)) {
      ctx.globalAlpha = isHighlighted ? 1 : 0.3;
      const label = node.label || '';
      const truncated = label.length > 20 ? label.substring(0, 18) + '...' : label;
      ctx.font = `${Math.max(3, 10 / globalScale)}px PT Sans, sans-serif`;
      ctx.fillStyle = '#2a3142';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(truncated, node.x, node.y + size + 2);
    }

    ctx.globalAlpha = 1;
  }, [highlightNodes]);

  // Custom link painting
  const paintLink = useCallback((link, ctx) => {
    const isHighlighted = highlightLinks.has(link);
    ctx.strokeStyle = link.inferred
      ? (isHighlighted ? 'rgba(217,90,62,0.6)' : 'rgba(217,90,62,0.08)')
      : (isHighlighted ? 'rgba(22,101,125,0.5)' : 'rgba(0,0,0,0.06)');
    ctx.lineWidth = isHighlighted ? 1.5 : 0.3;

    if (link.inferred) {
      ctx.setLineDash([3, 3]);
    } else {
      ctx.setLineDash([]);
    }

    const src = link.source;
    const tgt = link.target;
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [highlightLinks]);

  if (loading) {
    return <div className="kg-subgraph-loading">Loading subgraph...</div>;
  }

  if (graphData.nodes.length === 0) {
    return <div className="kg-subgraph-empty">No subgraph data</div>;
  }

  return (
    <div className="kg-subgraph-container">
      <div className="kg-subgraph-legend">
        {Object.entries(NODE_COLORS).filter(([t]) => graphData.nodes.some(n => n.type === t)).map(([type, color]) => (
          <span key={type} className="kg-legend-item">
            <span className="kg-legend-dot" style={{ background: color }} />
            {type}
          </span>
        ))}
      </div>
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={undefined}
        height={height}
        nodeCanvasObject={paintNode}
        linkCanvasObject={paintLink}
        onNodeHover={handleNodeHover}
        onNodeClick={node => onNodeClick && onNodeClick(node)}
        cooldownTicks={150}
        d3AlphaDecay={0.025}
        d3VelocityDecay={0.35}
        enableNodeDrag={true}
        nodeRelSize={1}
        onEngineStop={() => graphRef.current && graphRef.current.zoomToFit(400, 50)}
      />
      {hoverNode && (
        <div className="kg-subgraph-tooltip">
          <strong>{hoverNode.label}</strong>
          <span className="kg-tooltip-type">{hoverNode.type}</span>
          {hoverNode.value && <p>{hoverNode.value}</p>}
        </div>
      )}
    </div>
  );
}
