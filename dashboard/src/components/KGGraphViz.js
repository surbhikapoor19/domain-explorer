/**
 * KGGraphViz — Knowledge graph visualization using Cytoscape.js + fCoSE.
 *
 * fCoSE computes layout once, then stops. No continuous simulation.
 * Hover is pure style changes, zero physics. No jitter.
 *
 * Node shapes by type, CSS-like styling, smooth zoom/pan/drag.
 */

import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';

// Register fCoSE layout
cytoscape.use(fcose);

// ─── Node type config ───
const TYPE_STYLES = {
  paper:         { shape: 'round-rectangle', color: '#16657d', width: 22, height: 15, label: 'Papers' },
  method:        { shape: 'ellipse',         color: '#2563eb', width: 14, height: 14, label: 'Methods' },
  technique:     { shape: 'ellipse',         color: '#7c3aed', width: 10, height: 10, label: 'Techniques' },
  contribution:  { shape: 'diamond',         color: '#63b3ed', width: 8,  height: 8,  label: 'Contributions' },
  comparison:    { shape: 'diamond',         color: '#c2410c', width: 8,  height: 8,  label: 'Comparisons' },
  limitation:    { shape: 'diamond',         color: '#b91c1c', width: 8,  height: 8,  label: 'Limitations' },
  problem:       { shape: 'diamond',         color: '#ca8a04', width: 8,  height: 8,  label: 'Problems' },
  claim:         { shape: 'diamond',         color: '#8691a0', width: 8,  height: 8,  label: 'Claims' },
  hardware:      { shape: 'ellipse',         color: '#16794e', width: 10, height: 10, label: 'Hardware' },
  attribute:     { shape: 'round-rectangle', color: '#475569', width: 10, height: 8,  label: 'Attributes' },
  figure:        { shape: 'round-rectangle', color: '#d97706', width: 8,  height: 6,  label: 'Figures' },
  table:         { shape: 'round-rectangle', color: '#0891b2', width: 8,  height: 6,  label: 'Tables' },
  impl_language: { shape: 'ellipse',         color: '#6366f1', width: 8,  height: 8,  label: 'Languages' },
  author:        { shape: 'ellipse',         color: '#be185d', width: 8,  height: 8,  label: 'Authors' },
  institution:   { shape: 'round-rectangle', color: '#0369a1', width: 12, height: 8,  label: 'Institutions' },
  reference:     { shape: 'round-rectangle', color: '#94a3b8', width: 8,  height: 6,  label: 'External refs' },
  equation:      { shape: 'diamond',         color: '#db2777', width: 8,  height: 8,  label: 'Equations' },
  dataset:       { shape: 'round-rectangle', color: '#0d9488', width: 12, height: 8,  label: 'Datasets' },
};

const SUBTYPE_COLORS = {
  backbone: '#5b21b6', loss: '#c026d3', dataset: '#0d9488', hardware: '#15803d',
};

const EDGE_COLORS = {
  cites: '#16657d', outperforms: '#d95a3e',
  uses_backbone: '#7c3aed', uses_loss: '#c026d3', trained_on: '#0d9488',
  uses_technique: '#7c3aed', uses_hardware: '#16794e',
  described_in: '#2563eb', contributes: '#63b3ed',
  has_limitation: '#b91c1c', compares: '#c2410c', addresses_problem: '#ca8a04',
  implements_step: '#a0aec0',
  has_figure: '#d97706', has_table: '#0891b2',
  implemented_in: '#6366f1', maintained_by: '#be185d',
  authored_by: '#be185d', affiliated_with: '#0369a1', published_from: '#0369a1',
  cites_external: '#94a3b8', has_equation: '#db2777',
  // Derived TEI relationships
  co_authored_with: '#ec4899', colleagues_with: '#0ea5e9',
  co_cited_with: '#64748b', shares_bibliography: '#94a3b8',
  author_works_on: '#a78bfa', uses_dataset: '#0d9488',
};

// ─── Cytoscape stylesheet ───
const STYLESHEET = [
  // Default node
  { selector: 'node', style: {
    'label': 'data(label)',
    'font-family': '"PT Sans", sans-serif',
    'font-size': '10px',
    'font-weight': 600,
    'text-valign': 'bottom',
    'text-halign': 'center',
    'text-margin-y': 4,
    'color': '#2a3142',
    'text-max-width': '80px',
    'text-wrap': 'ellipsis',
    'background-color': 'data(color)',
    'shape': 'data(shape)',
    'width': 'data(width)',
    'height': 'data(height)',
    'border-width': 1,
    'border-color': '#00000018',
    'transition-property': 'opacity, border-width, border-color',
    'transition-duration': '0.15s',
  }},
  // Sized by degree for techniques
  { selector: 'node[type="technique"]', style: {
    'width': 'mapData(degree, 0, 20, 12, 32)',
    'height': 'mapData(degree, 0, 20, 12, 32)',
  }},
  // Paper nodes slightly larger
  { selector: 'node[type="paper"]', style: {
    'width': 24, 'height': 16,
    'font-size': '9px',
  }},
  // Method nodes
  { selector: 'node[type="method"]', style: {
    'width': 16, 'height': 16,
    'font-size': '9px',
  }},
  // Default edge
  { selector: 'edge', style: {
    'width': 1,
    'line-color': '#d0d5dd',
    'curve-style': 'bezier',
    'opacity': 0.35,
    'transition-property': 'opacity, width, line-color',
    'transition-duration': '0.15s',
  }},
  // Typed edges
  ...Object.entries(EDGE_COLORS).map(([type, color]) => ({
    selector: `edge[type="${type}"]`,
    style: { 'line-color': color },
  })),
  // Citation edges slightly thicker
  { selector: 'edge[type="cites"]', style: { 'width': 1.5, 'opacity': 0.5 } },
  { selector: 'edge[type="outperforms"]', style: { 'width': 2, 'opacity': 0.6, 'line-style': 'dashed' } },
  // Inferred edges (from HGT link prediction) render dashed by default to
  // visually distinguish "predicted" from "observed" relationships. The
  // following per-type rules override color, and per-confidence rules drive
  // a continuous width + opacity ramp so the visual signal mirrors what the
  // model actually said (edge type + confidence) — no invented categories.
  { selector: 'edge[inferred = 1]', style: { 'line-style': 'dashed' } },
  { selector: 'edge[inferred = 1][type="outperforms"]', style: {
    'line-color': '#b14b1f',
    'target-arrow-color': '#b14b1f',
  }},
  { selector: 'edge[inferred = 1][type="compares"]', style: {
    'line-color': '#c2410c',
    'target-arrow-color': '#c2410c',
  }},
  { selector: 'edge[inferred = 1][type="compared_against"]', style: {
    'line-color': '#b14b1f',
    'target-arrow-color': '#b14b1f',
  }},
  { selector: 'edge[inferred = 1][type="contributes"]', style: {
    'line-color': '#2b6cb0',
    'target-arrow-color': '#2b6cb0',
  }},
  { selector: 'edge[inferred = 1][type="has_limitation"]', style: {
    'line-color': '#b91c1c',
    'target-arrow-color': '#b91c1c',
  }},
  { selector: 'edge[inferred = 1][type="addresses_problem"]', style: {
    'line-color': '#ca8a04',
    'target-arrow-color': '#ca8a04',
  }},
  { selector: 'edge[inferred = 1][type="uses_technique"]', style: {
    'line-color': '#7c3aed',
    'target-arrow-color': '#7c3aed',
  }},
  // Continuous width + opacity from confidence. The min_confidence cutoff
  // in the precompute is 0.55, and the model's max in current data is ~0.73,
  // so we map [0.55 → 0.80] across the visible width/opacity range. mapData
  // clamps at the bounds, so any future runs that produce stronger or
  // weaker scores still render sensibly.
  { selector: 'edge[inferred = 1]', style: {
    'width':   'mapData(confidence, 0.55, 0.80, 1.2, 3.5)',
    'opacity': 'mapData(confidence, 0.55, 0.80, 0.40, 0.95)',
  }},
  // Bidirectional inferred edges render arrowless: the model scored both
  // directions identically (within tolerance), which means it has no
  // signal to prefer one direction over the other. Showing arrows would
  // imply a directional claim the model cannot back up.
  { selector: 'edge[inferred = 1][bidirectional = 1]', style: {
    'target-arrow-shape': 'none',
    'source-arrow-shape': 'none',
  }},
  // Observed overlay edges (on the Predictions tab): thin gray so the
  // predicted purple reads as "new" against the observed baseline.
  { selector: 'edge[source_type = "observed"]', style: { 'width': 0.8, 'opacity': 0.35, 'line-color': '#94a3b8', 'target-arrow-color': '#94a3b8' } },
  // Hover highlight
  { selector: 'node.highlighted', style: {
    'border-width': 2.5,
    'border-color': '#16657d',
    'z-index': 10,
    'font-size': '11px',
    'text-background-color': '#ffffff',
    'text-background-opacity': 0.85,
    'text-background-padding': '2px',
  }},
  { selector: 'node.neighbor', style: {
    'opacity': 1,
    'border-width': 1.5,
    'border-color': '#16657d55',
  }},
  { selector: 'node.dimmed', style: { 'opacity': 0.08 } },
  { selector: 'edge.highlighted', style: { 'opacity': 0.7, 'width': 2 } },
  { selector: 'edge.dimmed', style: { 'opacity': 0.02 } },
  // Selected
  { selector: 'node.selected', style: {
    'border-width': 3,
    'border-color': '#d95a3e',
  }},
  // Hidden
  { selector: 'node.hidden', style: { 'display': 'none' } },
  { selector: 'edge.hidden', style: { 'display': 'none' } },
  { selector: 'node.hidden-low-degree', style: { 'display': 'none' } },
  { selector: 'edge.hidden-low-degree', style: { 'display': 'none' } },
  // External dim/highlight
  { selector: 'node.ext-dim', style: { 'opacity': 0.12 } },
  { selector: 'node.ext-hl', style: { 'opacity': 1, 'border-width': 2, 'border-color': '#1a202c' } },
  { selector: 'edge.ext-dim', style: { 'opacity': 0.06 } },
  { selector: 'edge.ext-hl', style: { 'opacity': 0.9, 'width': 2 } },
  { selector: 'node.ext-hl', style: { 'border-width': 3, 'border-color': '#d95a3e' } },
  // Search
  { selector: 'node.search-match', style: { 'border-width': 3, 'border-color': '#eab308', 'z-index': 999 } },
  { selector: '.search-dim', style: { 'opacity': 0.06 } },
];

// ─── fCoSE layout config ───
// The edge-weighted variants below pull paper↔method (described_in) and
// paper↔author/institution tight, while letting noisy high-degree types
// (references, citations) relax. This keeps a paper visually adjacent to
// its own method instead of clustering papers and methods separately.
const SHORT_EDGE_TYPES = new Set([
  'described_in',       // paper ↔ its method — most important
  'authored_by',        // paper ↔ author
  'published_from',     // paper ↔ institution
  'has_table', 'has_figure', 'has_equation',  // paper ↔ its own content
]);
const LONG_EDGE_TYPES = new Set([
  'cites_external',     // don't let external refs drag layout
  'similar_in_role', 'semantically_similar',
]);

const LAYOUT = {
  name: 'fcose',
  quality: 'default',
  randomize: true,
  animate: true,
  animationDuration: 700,
  animationEasing: 'ease-out',
  nodeRepulsion: 25000,
  idealEdgeLength: edge => {
    const t = edge.data('type');
    if (SHORT_EDGE_TYPES.has(t)) return 40;   // tight
    if (LONG_EDGE_TYPES.has(t)) return 260;   // loose
    return 140;                                // default
  },
  edgeElasticity: edge => {
    const t = edge.data('type');
    if (SHORT_EDGE_TYPES.has(t)) return 0.7;  // stiff → enforce closeness
    if (LONG_EDGE_TYPES.has(t)) return 0.05;  // floppy
    return 0.2;
  },
  nestingFactor: 0.1,
  gravity: 0.06,
  gravityRange: 7.0,
  numIter: 4000,
  tile: true,
  fit: true,
  padding: 15,
};

export default function KGGraphViz({
  onNodeClick, selectedNode, height = 420, dataUrl, postData,
  onNodeSelect, onEdgeSelect, refitTrigger,
  hiddenEdgeTypes, hiddenNodeTypes: extHiddenNodeTypes, highlightedLabels, dimUnhighlighted,
  minDegree = 0, searchTerm = '', viewName, minConfidence = 0,
}) {
  const cyRef = useRef(null);
  const containerRef = useRef(null);
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Default-hidden node types: noisy detail-level types that flood the landing view.
  // Users can click the legend to toggle any of them back on.
  const [hiddenTypes, setHiddenTypes] = useState(
    () => new Set(['figure', 'table', 'author', 'reference', 'equation', 'contribution', 'comparison', 'limitation', 'problem'])
  );
  const [tooltipNode, setTooltipNode] = useState(null);
  const [tooltipEdge, setTooltipEdge] = useState(null);
  const tooltipTimer = useRef(null);
  // Cooperative-gesture hint state. Briefly visible when a user scrolls
  // over the graph without the modifier — so they learn the requirement
  // instead of thinking the page is just unresponsive.
  const [zoomHint, setZoomHint] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const zoomHintTimer = useRef(null);

  // Load graph data from static JSON. When `postData` carries paperIds we
  // mirror the legacy /api/kg-subgraph behavior: load kg-full, build the
  // graphology graph, and run extractSubgraph(paperIds, intent) client-side
  // so the post-query view shows a focused subgraph instead of all 3,549 nodes.
  // Re-runs whenever the paperIds payload changes (stringified for stable dep).
  const postKey = postData ? JSON.stringify(postData) : '';
  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    const wantsSubgraph = !!(
      postData && Array.isArray(postData.paperIds) && postData.paperIds.length > 0
    );

    const finish = (data) => {
      if (cancelled) return;
      if (data && (data.nodes || data.success || Array.isArray(data))) {
        setGraphData(data.success ? data : {
          success: true,
          ...(Array.isArray(data) ? { nodes: [], links: data } : data),
        });
      }
      setLoading(false);
    };

    let loader;
    if (wantsSubgraph || dataUrl === 'kg-full' || (dataUrl || '').includes('kg-subgraph')) {
      // Load full KG, then either render whole-thing or extract focused subgraph.
      loader = Promise.all([
        import('../lib/data-loader').then(m => m.loadKgFull()),
        import('../lib/kg-graph'),
      ]).then(([full, kgLib]) => {
        if (!wantsSubgraph) return full;
        kgLib.initGraph(full);
        const sub = kgLib.extractSubgraph(postData.paperIds, postData.intent || 'general');
        return { success: true, nodes: sub.nodes, links: sub.links, stats: sub.stats };
      });
    } else if (dataUrl === 'kg-predictions' || (dataUrl || '').includes('kg-predictions')) {
      loader = import('../lib/data-loader').then(m => m.loadKgPredictions());
    } else {
      loader = import('../lib/data-loader').then(m => m.loadKgMacro());
    }
    loader.then(finish).catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl, postKey]);

  // Build Cytoscape elements. Node types in `hiddenTypes` are dropped up-front so
  // the initial fCoSE layout only positions visible nodes — critical for a clean
  // landing view when the graph has thousands of detail-level nodes (refs,
  // equations, figures, tables, authors).
  const elements = useMemo(() => {
    if (!graphData) return [];
    const visibleNodes = graphData.nodes.filter(n => !hiddenTypes.has(n.type));
    const visibleIds = new Set(visibleNodes.map(n => n.id));
    const nodes = visibleNodes.map(n => {
      const cfg = TYPE_STYLES[n.type] || TYPE_STYLES.claim;
      const color = SUBTYPE_COLORS[n.subtype] || cfg.color;
      return {
        data: {
          id: n.id,
          label: n.label || '',
          type: n.type,
          subtype: n.subtype || '',
          color: color,
          shape: cfg.shape,
          width: cfg.width,
          height: cfg.height,
          degree: n.degree || 0,
          value: n.value || '',
          paper_id: n.paper_id || '',
        },
      };
    });
    const edges = graphData.links
      .filter(e => {
        if (e.inferred && minConfidence > 0 && (e.confidence || 0) < minConfidence) return false;
        const srcId = e.source?.id || e.source;
        const tgtId = e.target?.id || e.target;
        return visibleIds.has(srcId) && visibleIds.has(tgtId);
      })
      .map((e, i) => ({
        data: {
          id: `e${i}`,
          source: e.source?.id || e.source,
          target: e.target?.id || e.target,
          type: e.type || '',
          inferred: e.inferred ? 1 : 0,
          bidirectional: e.bidirectional ? 1 : 0,
          confidence: e.confidence || 0,
          semantic_relevance: e.semantic_relevance || 0,
          source_type: e.source_type || '',
          sentiment: e.sentiment || '',
          contexts: e.contexts || [],
          mentions: e.mentions || 0,
          // Enrichment fields for predicted edges (paper↔paper). The
          // precompute baked these in on `kg-predictions.json`; we keep
          // them on the cy edge so the click handler can pass them
          // straight to the side panel without a re-fetch.
          comparability: e.comparability || null,
          shared_context: e.shared_context || [],
        },
      }));
    // Remove orphan nodes (no edges after confidence filtering)
    const connectedIds = new Set();
    edges.forEach(e => { connectedIds.add(e.data.source); connectedIds.add(e.data.target); });
    const filteredNodes = nodes.filter(n => connectedIds.has(n.data.id));
    return [...filteredNodes, ...edges];
  }, [graphData, hiddenTypes, minConfidence]);

  // Setup events after Cytoscape mounts
  const handleCy = useCallback(cy => {
    if (!cy || cyRef.current === cy) return;
    cyRef.current = cy;
    // Expose to window in dev so the Playwright UI tests can reach in
    // and tap nodes by label without depending on canvas pixel coords.
    // Wrapped in a localhost check so this never leaks to production.
    if (typeof window !== 'undefined' && window.location && window.location.hostname === 'localhost') {
      window.__kgCy = cy;
    }

    // Cooperative gestures: zoom is gated on a modifier key (cmd on macOS,
    // ctrl on Windows/Linux). Without the modifier, the wheel event is
    // allowed to bubble to the page so the user can scroll past the graph
    // without it zooming under their cursor. With the modifier held,
    // Cytoscape consumes the event normally and zooms.
    //
    // The earlier version of this handler ran in the bubble phase and
    // tried to toggle userZoomingEnabled per gesture. That race-conditioned
    // with Cytoscape's own wheel listener (which runs on the canvas inside
    // the container, before bubbling reaches us). Fixed by:
    //   1. Leaving userZoomingEnabled at its default (true).
    //   2. Registering OUR listener in the capture phase so we run BEFORE
    //      Cytoscape sees the event.
    //   3. When no modifier is held, stopImmediatePropagation() so the
    //      event never reaches Cytoscape (so it doesn't preventDefault,
    //      so the browser's native scroll fires normally).
    //   4. When the modifier is held, doing nothing — event continues
    //      down to Cytoscape which zooms as usual.
    //
    // This mirrors the Mapbox `cooperativeGestures` and Google Maps
    // `gestureHandling: 'cooperative'` pattern.
    const container = cy.container();
    if (container) {
      const wheelHandler = (ev) => {
        const wantsZoom = ev.metaKey || ev.ctrlKey;
        if (wantsZoom) return;
        // Stop the event from reaching Cytoscape's canvas-level listener
        // (which would preventDefault and consume the scroll). Both stops
        // are needed: stopPropagation blocks child-element listeners,
        // stopImmediatePropagation blocks same-element listeners.
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        setZoomHint(true);
        clearTimeout(zoomHintTimer.current);
        zoomHintTimer.current = setTimeout(() => setZoomHint(false), 1200);
      };
      container.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
      cy._coopWheelHandler = wheelHandler;
    }

    // Track which node is tap-selected so the hover mouseout doesn't
    // clear the persistent neighborhood highlight.
    let pinnedNode = null;

    const applyNeighborhoodHighlight = (node) => {
      const neighborhood = node.closedNeighborhood();
      cy.elements().not(neighborhood).addClass('dimmed');
      neighborhood.nodes().addClass('neighbor');
      node.addClass('highlighted').removeClass('neighbor');
      neighborhood.edges().addClass('highlighted');
    };

    const clearNeighborhoodHighlight = () => {
      cy.elements().removeClass('dimmed highlighted neighbor');
    };

    // Hover: highlight neighborhood (temporarily, unless a node is pinned)
    cy.on('mouseover', 'node', e => {
      const node = e.target;
      clearNeighborhoodHighlight();
      applyNeighborhoodHighlight(node);

      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = setTimeout(() => {
        setTooltipNode({ label: node.data('label'), type: node.data('type'), subtype: node.data('subtype'), degree: node.data('degree'), value: node.data('value') });
      }, 80);
    });

    cy.on('mouseout', 'node', () => {
      if (pinnedNode) {
        clearNeighborhoodHighlight();
        applyNeighborhoodHighlight(pinnedNode);
      } else {
        clearNeighborhoodHighlight();
      }
      clearTimeout(tooltipTimer.current);
      setTooltipNode(null);
    });

    // Hover an edge — surface a four-line orientation tooltip. For
    // predicted (inferred) edges this is the load-bearing UX: it tells
    // the user what HGT actually said before they decide to click in.
    // Per the no-redundancy rule, this stays orientation-only — the
    // full comparability table lives in the side panel on click.
    cy.on('mouseover', 'edge', e => {
      const edge = e.target;
      const srcNode = edge.source();
      const tgtNode = edge.target();
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = setTimeout(() => {
        setTooltipEdge({
          src: srcNode.data('label'),
          tgt: tgtNode.data('label'),
          src_type: srcNode.data('type'),
          tgt_type: tgtNode.data('type'),
          edge_type: edge.data('type'),
          inferred: !!edge.data('inferred'),
          bidirectional: !!edge.data('bidirectional'),
          confidence: edge.data('confidence') || 0,
          semantic_relevance: edge.data('semantic_relevance') || 0,
          sentiment: edge.data('sentiment') || '',
        });
      }, 80);
    });

    cy.on('mouseout', 'edge', () => {
      clearTimeout(tooltipTimer.current);
      setTooltipEdge(null);
    });

    // Tap an edge — fire onEdgeSelect with the full edge payload so the
    // parent can render a focused comparison side panel. Tapping an edge
    // also clears any prior node selection in the parent (mutual
    // exclusivity is enforced there).
    cy.on('tap', 'edge', e => {
      const edge = e.target;
      const srcNode = edge.source();
      const tgtNode = edge.target();
      if (onEdgeSelect) {
        onEdgeSelect({
          edge: {
            type: edge.data('type'),
            inferred: !!edge.data('inferred'),
            bidirectional: !!edge.data('bidirectional'),
            confidence: edge.data('confidence') || 0,
            semantic_relevance: edge.data('semantic_relevance') || 0,
            sentiment: edge.data('sentiment') || '',
            contexts: edge.data('contexts') || [],
            comparability: edge.data('comparability') || null,
            shared_context: edge.data('shared_context') || [],
          },
          src: {
            id: srcNode.data('id'), label: srcNode.data('label'),
            type: srcNode.data('type'), paper_id: srcNode.data('paper_id'),
          },
          tgt: {
            id: tgtNode.data('id'), label: tgtNode.data('label'),
            type: tgtNode.data('type'), paper_id: tgtNode.data('paper_id'),
          },
        });
      }
    });

    // Click: select node, pin neighborhood highlight, emit to parent
    cy.on('tap', 'node', e => {
      const node = e.target;
      cy.nodes().removeClass('selected');
      node.addClass('selected');

      pinnedNode = node;
      clearNeighborhoodHighlight();
      applyNeighborhoodHighlight(node);

      if (onNodeClick) onNodeClick({ id: node.data('id'), label: node.data('label'), type: node.data('type'), subtype: node.data('subtype') });

      if (onNodeSelect) {
        const neighbors = node.neighborhood().nodes().map(n => ({ ...n.data() }));
        const edges = node.connectedEdges().map(e => ({
          ...e.data(),
          source: e.data('source'), target: e.data('target'),
          inferred: !!e.data('inferred'),
        }));
        onNodeSelect({ node: { ...node.data() }, neighbors, edges, viewName });
      }
    });

    cy.on('tap', e => {
      if (e.target === cy) {
        pinnedNode = null;
        clearNeighborhoodHighlight();
        cy.nodes().removeClass('selected');
        if (onNodeSelect) onNodeSelect(null);
      }
    });
  }, [onNodeClick, onNodeSelect, onEdgeSelect, viewName]);

  // Re-fit on trigger change (also resize so Cytoscape recalculates its
  // viewport from the possibly-resized container, e.g. when the side
  // panel opens/closes).
  useEffect(() => {
    if (cyRef.current) {
      setTimeout(() => {
        cyRef.current?.resize();
        cyRef.current?.fit(undefined, 10);
      }, 250);
    }
  }, [refitTrigger]);

  // Auto-resize + fit when the container dimensions change (e.g. CSS
  // grid transition from side panel opening/closing).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cy = cyRef.current;
      if (cy) { cy.resize(); cy.fit(undefined, 10); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Toggle type visibility
  const toggleType = useCallback(type => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  // Hidden types now filter elements up-front. When toggling re-adds a type,
  // re-run the layout so new nodes get positioned instead of stacking at origin.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !graphData) return;
    cy.layout(LAYOUT).run();
  }, [hiddenTypes, graphData]);

  // Apply external edge-type filters
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const hidden = hiddenEdgeTypes instanceof Set ? hiddenEdgeTypes : new Set(hiddenEdgeTypes || []);
    cy.edges().forEach(e => {
      if (hidden.has(e.data('type'))) e.addClass('hidden');
      else e.removeClass('hidden');
    });
  }, [hiddenEdgeTypes, elements]);

  // External node-type filters (CSS-hide only; for transient UI toggles). Local
  // legend-driven `hiddenTypes` already filters elements up-front.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const hidden = extHiddenNodeTypes instanceof Set ? extHiddenNodeTypes : new Set(extHiddenNodeTypes || []);
    cy.nodes().forEach(n => {
      if (hidden.has(n.data('type'))) {
        n.addClass('hidden');
        n.connectedEdges().addClass('hidden');
      } else {
        n.removeClass('hidden');
      }
    });
  }, [extHiddenNodeTypes, elements]);

  // Minimum-degree filter: hide nodes with fewer neighbors than threshold
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().forEach(n => {
      const degree = n.data('degree') || 0;
      if (minDegree > 0 && degree < minDegree) {
        n.addClass('hidden-low-degree');
        n.connectedEdges().addClass('hidden-low-degree');
      } else {
        n.removeClass('hidden-low-degree');
        n.connectedEdges().removeClass('hidden-low-degree');
      }
    });
  }, [minDegree, elements]);

  // Search: focus on matching node + its neighborhood, dim everything else
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('search-match search-dim');
    const term = (searchTerm || '').trim().toLowerCase();
    if (!term) return;
    const matches = cy.nodes().filter(n => (n.data('label') || '').toLowerCase().includes(term));
    if (matches.length === 0) return;
    const keep = matches.closedNeighborhood();
    cy.elements().not(keep).addClass('search-dim');
    matches.addClass('search-match');
  }, [searchTerm, elements]);

  // Apply external highlighting across ALL node types so a sidebar click
  // (institution, author, technique, year, foundational work) lights up
  // the graph's connected cohort — papers, methods, entity itself —
  // and dims everything else. This is the "everything connects" pass.
  // Skip when a graph node is selected — the tap handler's neighborhood
  // highlight (dimmed/highlighted/neighbor classes) should be the sole
  // visual so the user sees every topological neighbor, not just the
  // cross-widget label matches.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass('ext-dim ext-hl');
    cy.edges().removeClass('ext-dim ext-hl');
    if (selectedNode) return;
    const labels = highlightedLabels instanceof Set ? highlightedLabels : new Set(highlightedLabels || []);
    if (labels.size === 0 || !dimUnhighlighted) return;
    const normalized = new Set([...labels].map(l => (l || '').toLowerCase()));
    const hlNodes = cy.collection();
    cy.nodes().forEach(n => {
      const lbl = (n.data('label') || '').toLowerCase();
      if (normalized.has(lbl)) {
        n.addClass('ext-hl');
        hlNodes.merge(n);
      } else {
        n.addClass('ext-dim');
      }
    });
    // Brighten edges between highlighted nodes so the cohort reads as a cluster
    cy.edges().forEach(e => {
      if (hlNodes.contains(e.source()) && hlNodes.contains(e.target())) {
        e.addClass('ext-hl');
      } else {
        e.addClass('ext-dim');
      }
    });
  }, [highlightedLabels, dimUnhighlighted, elements, selectedNode]);

  if (loading) return <div className="kgv-loading">Loading graph...</div>;
  if (!elements.length) return <div className="kgv-loading">No graph data</div>;

  // Count types from original graphData (not filtered elements) so the legend
  // keeps showing the total count for hidden types, signaling they're available.
  const typeCounts = {};
  if (graphData) {
    graphData.nodes.forEach(n => {
      if (n.type) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
    });
  }

  return (
    <div ref={containerRef} className="kgv-container" style={{ position: 'relative' }}>
      {/* Legend — collapsible overlay */}
      <div className={`kgv-legend ${legendOpen ? 'open' : ''}`}>
        <button className="kgv-legend-toggle" onClick={() => setLegendOpen(o => !o)}>
          Legend
          <span className="kgv-legend-chevron">{legendOpen ? '▾' : '▸'}</span>
        </button>
        <button className="kgv-fit-btn" onClick={() => cyRef.current?.fit(undefined, 10)}>Fit</button>

        {legendOpen && (
          <div className="kgv-legend-body">
            <div className="kgv-legend-col">
              <span className="kgv-legend-heading">Nodes</span>
              <div className="kgv-legend-grid">
                {Object.entries(TYPE_STYLES).map(([type, cfg]) => {
                  const count = typeCounts[type] || 0;
                  if (count === 0) return null;
                  const isHidden = hiddenTypes.has(type);
                  return (
                    <button key={type} className={`kgv-legend-btn ${isHidden ? 'off' : ''}`} onClick={() => toggleType(type)}>
                      <span className="kgv-legend-shape" style={{
                        background: isHidden ? 'var(--border)' : cfg.color,
                        borderRadius: cfg.shape === 'round-rectangle' ? '2px' : cfg.shape === 'diamond' ? '1px' : '50%',
                        transform: cfg.shape === 'diamond' ? 'rotate(45deg) scale(0.75)' : 'none',
                      }} />
                      {cfg.label}
                      <span className="kgv-legend-count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="kgv-legend-col">
              <span className="kgv-legend-heading">Edges</span>
              <div className="kgv-legend-grid">
                {[
                  { color: EDGE_COLORS.cites,             label: 'Cites',         dashed: false },
                  { color: EDGE_COLORS.outperforms,       label: 'Outperforms',   dashed: true },
                  { color: EDGE_COLORS.uses_backbone,     label: 'Uses technique', dashed: false },
                  { color: EDGE_COLORS.contributes,       label: 'Contributes',   dashed: false },
                  { color: EDGE_COLORS.has_limitation,    label: 'Limitation',    dashed: false },
                  { color: EDGE_COLORS.addresses_problem, label: 'Addresses',     dashed: false },
                  { color: EDGE_COLORS.compares,          label: 'Compares',      dashed: false },
                  { color: EDGE_COLORS.authored_by,       label: 'Authored by',   dashed: false },
                  { color: EDGE_COLORS.described_in,      label: 'Described in',  dashed: false },
                ].map(({ color, label, dashed }) => (
                  <span key={label} className="kgv-legend-btn static">
                    <span className={`kgv-legend-line ${dashed ? 'dashed' : 'solid'}`} style={{ borderTopColor: color }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Cytoscape graph */}
      <CytoscapeComponent
        elements={elements}
        stylesheet={STYLESHEET}
        layout={LAYOUT}
        style={{ width: '100%', height }}
        cy={handleCy}
      />

      {/* Cooperative-gesture hint (Mapbox pattern). Surfaces only when a
          user wheels over the graph without the modifier; teaches the
          requirement without permanently cluttering the chrome. */}
      {zoomHint && (
        <div className="kgv-coop-hint" role="status" aria-live="polite">
          Use {navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'} + scroll to zoom
        </div>
      )}

      {/* Tooltip */}
      {tooltipNode && (
        <div className="kgv-tooltip">
          <div className="kgv-tooltip-type" style={{ color: TYPE_STYLES[tooltipNode.type]?.color }}>
            {tooltipNode.subtype || tooltipNode.type}
          </div>
          <div className="kgv-tooltip-label">{tooltipNode.label}</div>
          {tooltipNode.degree > 0 && <div className="kgv-tooltip-degree">{tooltipNode.degree} connections</div>}
        </div>
      )}

      {/* Edge tooltip — orientation only (≤4 lines). Click opens the full
          comparison side panel; we do not duplicate that detail here. */}
      {tooltipEdge && !tooltipNode && (
        <div className="kgv-tooltip kgv-tooltip-edge">
          <div className="kgv-tooltip-edge-pair">
            <span>{tooltipEdge.src}</span>
            <span className="kgv-tooltip-edge-arrow">
              {tooltipEdge.bidirectional ? '↔' : '→'}
            </span>
            <span>{tooltipEdge.tgt}</span>
          </div>
          <div className="kgv-tooltip-edge-type">
            {tooltipEdge.inferred ? 'Predicted: ' : ''}{tooltipEdge.edge_type}
            {tooltipEdge.sentiment && !tooltipEdge.inferred && (
              <span className={`kgv-tooltip-stance stance-${tooltipEdge.sentiment}`}>
                {tooltipEdge.sentiment === 'builds_on' ? 'builds on'
                  : tooltipEdge.sentiment === 'differs_from' ? 'differs'
                  : 'neutral'}
              </span>
            )}
          </div>
          {tooltipEdge.inferred && (
            <div className="kgv-tooltip-edge-scores">
              Confidence {Math.round(tooltipEdge.confidence * 100)}%
              {tooltipEdge.semantic_relevance > 0 && (
                <> · Similarity {Math.round(tooltipEdge.semantic_relevance * 100)}%</>
              )}
            </div>
          )}
          <div className="kgv-tooltip-edge-hint">click to compare →</div>
        </div>
      )}
    </div>
  );
}
