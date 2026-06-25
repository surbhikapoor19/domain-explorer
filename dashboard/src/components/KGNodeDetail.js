/**
 * KGNodeDetail — Detail panel for a selected graph node.
 *
 * For papers/methods, shows:
 *   - Method card (year, planning approach, hardware, input, scene)
 *   - Lineage: what this paper cites (predecessors) and what cites it (successors)
 *   - Connections grouped by type
 *
 * Surfaces method-comparability info for "which method should I adopt?" workflows.
 */

import React, { useState, useMemo, useEffect } from 'react';
import Tooltip from './Tooltip';
import { HighlightedText } from '../highlighter';

function trimToSentence(text) {
  if (!text) return text;
  let t = text.trim();
  // The extractor grabs a fixed-width window around the citation marker, so the
  // text often STARTS mid-word ("raining"→training, "pproaches"→approaches). Drop
  // that leading fragment: if it starts lowercase, jump to the next sentence start
  // (". A"), or failing that drop the leading partial word — so a quote never
  // begins mid-word.
  if (/^[a-z]/.test(t)) {
    const sent = t.match(/[.?!]\s+(?=[A-Z])/);
    if (sent && sent.index < t.length * 0.6) {
      t = t.slice(sent.index + sent[0].length);
    } else {
      const sp = t.indexOf(' ');
      if (sp > 0 && sp < 15) t = t.slice(sp + 1);
    }
  }
  // Trim a trailing partial sentence.
  const lastDot = t.lastIndexOf('.');
  const lastQ  = t.lastIndexOf('?');
  const lastEx = t.lastIndexOf('!');
  const cut = Math.max(lastDot, lastQ, lastEx);
  if (cut > t.length * 0.4) return t.slice(0, cut + 1);
  return t;
}

// Module-scoped cache for the full KG. The predictions view only loads ~109
// nodes into Cytoscape, so when a user clicks a node we still want to surface
// its observed-edge neighborhood from the full ~5,800-node graph. Fetching
// kg-full.json is ~9 MB; we do it once on first click and reuse.
let _kgFullPromise = null;
let _kgFullIndex = null; // { nodesById: Map, neighborsByNodeId: Map<id, Array<{node, edge}>> }

function ensureKgFullIndex() {
  if (_kgFullIndex) return Promise.resolve(_kgFullIndex);
  if (!_kgFullPromise) {
    _kgFullPromise = import('../lib/data-loader')
      .then(m => m.loadKgFull())
      .then(full => {
        const nodesById = new Map();
        (full.nodes || []).forEach(n => { if (n && n.id) nodesById.set(n.id, n); });
        const neighborsByNodeId = new Map();
        (full.links || []).forEach(e => {
          const sId = typeof e.source === 'object' ? e.source.id : e.source;
          const tId = typeof e.target === 'object' ? e.target.id : e.target;
          if (!sId || !tId) return;
          const sNode = nodesById.get(sId);
          const tNode = nodesById.get(tId);
          if (sNode && tNode) {
            if (!neighborsByNodeId.has(sId)) neighborsByNodeId.set(sId, []);
            if (!neighborsByNodeId.has(tId)) neighborsByNodeId.set(tId, []);
            neighborsByNodeId.get(sId).push({ node: tNode, edge: e, direction: 'out' });
            neighborsByNodeId.get(tId).push({ node: sNode, edge: e, direction: 'in' });
          }
        });
        _kgFullIndex = { nodesById, neighborsByNodeId };
        return _kgFullIndex;
      })
      .catch(err => {
        // Reset so a future click can retry
        _kgFullPromise = null;
        throw err;
      });
  }
  return _kgFullPromise;
}

// Parallel cache for kg-predictions.json. In the Predicted Relationships
// view, the Cytoscape graph filters to predicted edges that pass the
// current min-confidence slider — so `selection.edges` is the in-view
// subset (often ~10 edges per node), not the full ~810 predictions.
// Researchers care about the FULL set of predicted relationships per
// paper, not just whichever happened to clear the slider. We load the
// whole predictions file once and look up the selected node's predicted
// neighborhood from it.
let _kgPredPromise = null;
let _kgPredIndex = null; // { nodesById: Map, neighborsByNodeId: Map<id, Array<{node, edge, direction}>> }

function ensureKgPredictionsIndex() {
  if (_kgPredIndex) return Promise.resolve(_kgPredIndex);
  if (!_kgPredPromise) {
    _kgPredPromise = import('../lib/data-loader')
      .then(m => m.loadKgPredictions())
      .then(pred => {
        const nodesById = new Map();
        (pred.nodes || []).forEach(n => { if (n && n.id) nodesById.set(n.id, n); });
        const neighborsByNodeId = new Map();
        (pred.links || []).forEach(e => {
          const sId = typeof e.source === 'object' ? e.source.id : e.source;
          const tId = typeof e.target === 'object' ? e.target.id : e.target;
          if (!sId || !tId) return;
          const sNode = nodesById.get(sId);
          const tNode = nodesById.get(tId);
          if (sNode && tNode) {
            if (!neighborsByNodeId.has(sId)) neighborsByNodeId.set(sId, []);
            if (!neighborsByNodeId.has(tId)) neighborsByNodeId.set(tId, []);
            neighborsByNodeId.get(sId).push({ node: tNode, edge: e, direction: 'out' });
            neighborsByNodeId.get(tId).push({ node: sNode, edge: e, direction: 'in' });
          }
        });
        _kgPredIndex = { nodesById, neighborsByNodeId };
        return _kgPredIndex;
      })
      .catch(err => {
        _kgPredPromise = null;
        throw err;
      });
  }
  return _kgPredPromise;
}

const TYPE_LABELS = {
  paper: 'Paper', method: 'Method', technique: 'Technique',
  claim: 'Claim', hardware: 'Hardware', attribute: 'Attribute',
  figure: 'Figure', table: 'Table',
  impl_language: 'Language', author: 'Author',
  institution: 'Institution', reference: 'External ref', equation: 'Equation',
};

const TYPE_COLORS = {
  paper: '#16657d', method: '#2563eb', technique: '#7c3aed',
  claim: '#8691a0', hardware: '#16794e',
  figure: '#d97706', table: '#0891b2',
  impl_language: '#6366f1', author: '#be185d',
  institution: '#0369a1', reference: '#94a3b8', equation: '#db2777',
};

const EDGE_LABELS = {
  uses_backbone: 'uses', uses_loss: 'uses loss',
  // trained_on is Groq-extracted from paper text (paper → technique:dataset) — it
  // indicates the paper *mentions* the dataset, not that the model is actually
  // trained on it. Ground-truth training/evaluation is CSV-driven `evaluated_on`.
  trained_on: 'discusses',
  uses_technique: 'uses', described_in: 'described in', cites: 'cites',
  outperforms: 'outperforms', uses_hardware: 'uses hardware',
  contributes: 'contributes', implements_step: 'implements',
  has_limitation: 'limitation', compares: 'compares',
  addresses_problem: 'addresses',
  authored_by: 'author', affiliated_with: 'affiliated with',
  published_from: 'from', cites_external: 'cites',
  has_equation: 'equation', has_figure: 'figure', has_table: 'table',
  evaluated_on: 'evaluated on',  // CSV-derived, ground truth
  uses_dataset: 'uses dataset',  // TEI table mining
  // Paper-paper relations that previously had no row labels because they
  // were only surfaced by the citation-lineage block (which only handled
  // `cites`). Hub papers like VGN have dozens of these and they were
  // silently dropped from the panel.
  cited_by_external: 'cited by',
  co_cited_with: 'co-cited with',
  semantically_similar: 'semantically similar to',
  shares_bibliography: 'shares bibliography with',
  compared_against: 'compared against',
  cites_external_back: 'cited by external',
};

// Friendly group titles for the relation-grouped connections section.
// Keys are edge types; rendering falls back to the edge type itself.
const RELATION_TITLES = {
  cites: 'Cites (in corpus)',
  cites_external: 'Cites (external references)',
  cited_by_external: 'Cited by external papers',
  outperforms: 'Outperforms',
  compared_against: 'Compared against',
  semantically_similar: 'Semantically similar',
  co_cited_with: 'Co-cited with',
  shares_bibliography: 'Shares bibliography',
  uses_technique: 'Techniques used',
  uses_backbone: 'Backbone',
  uses_loss: 'Loss',
  uses_hardware: 'Hardware',
  uses_dataset: 'Datasets',
  trained_on: 'Discussed datasets',
  evaluated_on: 'Evaluated on',
  has_table: 'Tables',
  has_figure: 'Figures',
  has_equation: 'Equations',
  authored_by: 'Authors',
  affiliated_with: 'Institutions',
  contributes: 'Contributions',
  has_limitation: 'Limitations',
  addresses_problem: 'Problems addressed',
  compares: 'Comparison claims',
  implements_step: 'Implementation steps',
  described_in: 'Described in',
};

// One-line plain-language explainer per edge type. Surfaces under the
// header on entity-typed detail panels (technique, hardware, dataset,
// author, institution, reference) so the user knows what "uses_technique"
// or "evaluated_on" actually means without leaving the panel.
const EDGE_EXPLAINERS = {
  uses_technique: 'Papers that mention this technique as part of their method.',
  uses_backbone:  'Papers that build their model on this backbone.',
  uses_loss:      'Papers that train with this loss function.',
  uses_hardware:  'Papers that ran experiments on this hardware.',
  uses_dataset:   'Papers that used this dataset.',
  trained_on:     'Papers that mention training on this dataset.',
  evaluated_on:   'Papers that benchmark against this dataset.',
  authored_by:    'Papers credited to this author.',
  affiliated_with:'Authors based at this institution.',
  published_from: 'Papers from this institution.',
  cited_by_external: 'External (non-corpus) papers that cite this work.',
  cites_external: 'This corpus paper cites this external reference.',
  cites:          'In-corpus citation between two papers.',
  contributes:    'Contributions claimed by the source paper.',
  has_limitation: 'Limitations claimed by the source paper.',
  addresses_problem: 'Problem the source paper addresses.',
  compares:       'Comparison claim made by the source paper.',
  has_table:      'Table extracted from the source paper.',
  has_figure:     'Figure extracted from the source paper.',
  has_equation:   'Equation extracted from the source paper.',
  described_in:   'Method described in this paper.',
};

// Order in which relation groups appear when shown. Anything not listed
// falls through to the end in count-desc order.
const RELATION_ORDER = [
  'outperforms', 'compared_against',
  'cited_by_external', 'cites', 'cites_external',
  'co_cited_with', 'semantically_similar', 'shares_bibliography',
  'uses_technique', 'uses_backbone', 'uses_loss', 'trained_on', 'uses_dataset', 'evaluated_on',
  'uses_hardware',
  'authored_by', 'affiliated_with',
  'contributes', 'has_limitation', 'addresses_problem', 'compares',
  'has_table', 'has_figure', 'has_equation',
  'described_in', 'implements_step',
];

// Parse a pipe-delimited markdown table into rows of cells.
// Returns null if text doesn't look like a table we can parse cleanly.
function parseMarkdownTable(text) {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    if (!line.includes('|')) continue;
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line)) continue; // separator
    const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.length >= 2) rows.push(cells);
  }
  if (rows.length < 2) return null;
  // Normalize column count
  const maxCols = Math.max(...rows.map(r => r.length));
  return rows.map(r => {
    while (r.length < maxCols) r.push('');
    return r.slice(0, maxCols);
  });
}

export default function KGNodeDetail({
  selection, onClose, onNodeClick, onHoverEntity,
  query, anchorNames, termDictionary,
  // Layout props — when the panel is rendered as a side panel beside the
  // graph (placement='side'), papers/methods default to a COMPACT view
  // (first subheading only) with an Expand button. expanded=true reveals
  // the full layout (overlay-wide panel). Non-paper nodes always render
  // their single subheading and ignore expanded/onToggleExpanded.
  placement = 'side',
  expanded = false,
  onToggleExpanded,
}) {
  const [expandedGroups, setExpandedGroups] = useState({});
  // Full-KG context for views that only load a partial graph into Cytoscape
  // (e.g. the Predicted Edges view loads ~109 nodes, not the full ~5,800).
  // We lazily fetch kg-full.json once and look up the selected node's
  // observed-edge neighborhood there so users see the full picture.
  const [fullKgInfo, setFullKgInfo] = useState(null); // { degree, observed: [{node, edge, direction}] }
  const [fullKgLoading, setFullKgLoading] = useState(false);
  // Full predicted-edge neighborhood for the selected node — loaded only
  // in predictions view. We fan the "Compared with" rail and the
  // "Predicted · not observed" group list off of this instead of
  // `selection.edges`, which is filtered by the in-view min-confidence
  // slider and typically holds a small subset of the real prediction
  // set. Shape mirrors fullKgInfo: { degree, observed: [{node, edge, direction}] }.
  const [fullPredInfo, setFullPredInfo] = useState(null);
  // HGT metrics surfaced as small AUC/Hits@10 chips per relation group +
  // a single-line model-card footer in the inspector aside. Loaded once
  // when the predictions view opens; ~3KB so no real cost.
  const [hgtMetrics, setHgtMetrics] = useState(null);
  // Inspector selection — which predicted row's comparability we're
  // currently showing on the right. Defaults to the highest-confidence
  // row in the first group on each node change.
  const [inspectorRow, setInspectorRow] = useState(null);

  const { node, neighbors, edges, viewName } = selection || {};
  const needsFullKgLookup = viewName === 'predictions';
  const isPredictionsView = viewName === 'predictions';

  useEffect(() => {
    if (!node || !needsFullKgLookup) {
      setFullKgInfo(null);
      return;
    }
    let cancelled = false;
    setFullKgLoading(true);
    ensureKgFullIndex()
      .then(({ neighborsByNodeId }) => {
        if (cancelled) return;
        const all = neighborsByNodeId.get(node.id) || [];
        setFullKgInfo({ degree: all.length, observed: all });
      })
      .catch(() => { if (!cancelled) setFullKgInfo(null); })
      .finally(() => { if (!cancelled) setFullKgLoading(false); });
    return () => { cancelled = true; };
  }, [node, needsFullKgLookup]);

  // Load FULL predicted edges for the selected node — only fires in the
  // Predicted Relationships view. Module-cached after first call so
  // switching nodes doesn't re-fetch the file.
  useEffect(() => {
    if (!node || !isPredictionsView) {
      setFullPredInfo(null);
      return;
    }
    let cancelled = false;
    ensureKgPredictionsIndex()
      .then(({ neighborsByNodeId }) => {
        if (cancelled) return;
        const all = neighborsByNodeId.get(node.id) || [];
        setFullPredInfo({ degree: all.length, observed: all });
      })
      .catch(() => { if (!cancelled) setFullPredInfo(null); });
    return () => { cancelled = true; };
  }, [node, isPredictionsView]);

  // Lazy-load HGT model metrics on first entry to predictions view.
  useEffect(() => {
    if (!isPredictionsView || hgtMetrics) return;
    let cancelled = false;
    import('../lib/data-loader').then(({ loadHgtMetrics }) => {
      loadHgtMetrics().then(m => {
        if (!cancelled && m) setHgtMetrics(m);
      }).catch(() => {});
    });
    return () => { cancelled = true; };
  }, [isPredictionsView, hgtMetrics]);

  // Reset inspector + accordion state whenever the selected node changes.
  useEffect(() => { setInspectorRow(null); setExpandedGroups({}); }, [node]);

  // Role of this node in the current query's answer. Drives the eyebrow line
  // at the top of the panel — researchers should see at a glance why they
  // landed on this node.
  const queryRole = useMemo(() => {
    if (!node || !anchorNames || anchorNames.size === 0) return null;
    const labelMatch = anchorNames.has(node.label);
    if (labelMatch) {
      return { kind: 'anchor', text: 'Anchor for your query' };
    }
    // Does this node connect to any anchor?
    const connectedAnchors = new Set();
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      const otherId = sId === node.id ? tId : (tId === node.id ? sId : null);
      if (otherId == null) return;
      const other = (neighbors || []).find(n => n.id === otherId);
      if (other && anchorNames.has(other.label)) {
        connectedAnchors.add(other.label);
      }
    });
    if (connectedAnchors.size > 0) {
      const list = [...connectedAnchors].slice(0, 2).join(', ');
      const more = connectedAnchors.size > 2 ? ` +${connectedAnchors.size - 2}` : '';
      const verb = connectedAnchors.size > 1
        ? 'Shared by'
        : 'Connected to';
      return {
        kind: 'connected',
        text: `${verb} ${list}${more}`,
        anchors: [...connectedAnchors],
      };
    }
    return { kind: 'context', text: 'Supporting context — not directly answering your query' };
  }, [node, edges, neighbors, anchorNames]);

  // Group connections by RELATION (edge type) instead of just node type.
  // This is the only place the user can see paper↔paper relations like
  // `cited_by_external`, `outperforms`, `compared_against`, `co_cited_with`,
  // `semantically_similar`. Previously those edges were dropped because the
  // node-type grouping lumped every paper neighbor into one bucket which
  // was then hidden whenever any internal `cites` lineage existed.
  // Each entry is { type, neighbors: [{node, edge, direction}] } so the
  // renderer can show e.g. "Cited by external papers (18)".
  const connectionsByRelation = useMemo(() => {
    if (!node || !edges || !neighbors) return [];
    const byRelation = new Map();
    const neighborsById = new Map((neighbors || []).map(n => [n.id, n]));
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      let otherId;
      let direction;
      if (sId === node.id) { otherId = tId; direction = 'out'; }
      else if (tId === node.id) { otherId = sId; direction = 'in'; }
      else return;
      const other = neighborsById.get(otherId);
      if (!other) return;
      const type = e.type || 'other';
      if (!byRelation.has(type)) byRelation.set(type, []);
      byRelation.get(type).push({ node: other, edge: e, direction });
    });
    // Stable order: explicit RELATION_ORDER first, then anything else by
    // size descending. Within a group, dedupe neighbors so the same paper
    // doesn't appear twice if there are duplicate edge entries.
    const orderIndex = new Map(RELATION_ORDER.map((t, i) => [t, i]));
    const entries = [...byRelation.entries()].map(([type, arr]) => {
      const seen = new Set();
      const deduped = arr.filter(item => {
        if (seen.has(item.node.id)) return false;
        seen.add(item.node.id);
        return true;
      });
      return [type, deduped];
    });
    entries.sort((a, b) => {
      const ai = orderIndex.has(a[0]) ? orderIndex.get(a[0]) : 1000 + (-a[1].length);
      const bi = orderIndex.has(b[0]) ? orderIndex.get(b[0]) : 1000 + (-b[1].length);
      return ai - bi;
    });
    return entries;
  }, [node, edges, neighbors]);

  // ── Derived sets used by the Calli-style spec card and the narrative
  //    block. These pull values out of `neighbors`/`edges` so we can
  //    present the COMPARE-shaped table at the top instead of relegating
  //    the same info to a "Method Profile" card later in the panel.
  const paperFacts = useMemo(() => {
    if (!node) return {};
    // Find linked method node (paper -- described_in --> method).
    const linkedMethod = (neighbors || []).find(n => n.type === 'method');
    const meta = (linkedMethod && linkedMethod.meta) || node.meta || {};
    const authors = (neighbors || [])
      .filter(n => n.type === 'author')
      .map(n => n.label);
    const institutions = (neighbors || [])
      .filter(n => n.type === 'institution')
      .map(n => n.label);
    // Techniques are split by sub-edge-type so the chip ribbon can label
    // each group (Backbone / Technique / Loss). Earlier these three were
    // collapsed into one bucket, which meant a chip like "Binary CE"
    // rendered identically to "PointNet" even though one is a loss and
    // the other a backbone.
    const techniqueGroups = { backbone: [], technique: [], loss: [] };
    const benchmarks = [];
    const hardware = [];
    const datasets = [];
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      const otherId = sId === node.id ? tId : (tId === node.id ? sId : null);
      if (!otherId) return;
      const other = (neighbors || []).find(n => n.id === otherId);
      if (!other) return;
      if (e.type === 'uses_backbone') techniqueGroups.backbone.push(other.label);
      else if (e.type === 'uses_loss') techniqueGroups.loss.push(other.label);
      else if (e.type === 'uses_technique') techniqueGroups.technique.push(other.label);
      else if (e.type === 'evaluated_on') benchmarks.push(other.label);
      else if (e.type === 'uses_dataset' || e.type === 'trained_on') datasets.push(other.label);
      else if (e.type === 'uses_hardware') hardware.push(other.label);
    });
    // Stable dedupe + a flat techniques list (keeps any code that still
    // peeks at .techniques.length working without forcing every reader
    // to re-implement the union).
    const uniq = arr => Array.from(new Set(arr));
    const dedupedGroups = {
      backbone: uniq(techniqueGroups.backbone),
      technique: uniq(techniqueGroups.technique),
      loss: uniq(techniqueGroups.loss),
    };
    const techniques = uniq([
      ...dedupedGroups.backbone,
      ...dedupedGroups.technique,
      ...dedupedGroups.loss,
    ]);
    return {
      meta,
      authors: uniq(authors),
      institutions: uniq(institutions),
      techniques,
      techniqueGroups: dedupedGroups,
      benchmarks: uniq(benchmarks),
      datasets: uniq(datasets),
      hardware: uniq(hardware),
      year: meta.year || node.year,
    };
  }, [node, neighbors, edges]);

  // Pull contribution / limitation / problem claim nodes the paper has, so
  // the narrative block can render a 3-column "what this paper says about
  // itself" view. Each claim node carries a `value` (sentence-level claim
  // text) and an optional subtype.
  const claimSets = useMemo(() => {
    const sets = { contribution: [], limitation: [], problem: [] };
    const addClaim = (other, edgeType) => {
      if (edgeType === 'contributes' && other.type === 'contribution') {
        sets.contribution.push(other);
      } else if (edgeType === 'has_limitation' && other.type === 'limitation') {
        sets.limitation.push(other);
      } else if (edgeType === 'addresses_problem' && other.type === 'problem') {
        sets.problem.push(other);
      }
    };
    // Primary source: in-graph edges from Cytoscape selection
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      if (sId !== node?.id) return;
      const other = (neighbors || []).find(n => n.id === tId);
      if (!other) return;
      addClaim(other, e.type);
    });
    // Fallback: claim nodes may be hidden in Cytoscape (filtered by legend
    // toggle). Pull them from the full KG or full predictions index instead.
    if (sets.contribution.length + sets.limitation.length + sets.problem.length === 0) {
      const seenIds = new Set();
      const sources = [
        ...(fullKgInfo?.observed || []),
        ...(fullPredInfo?.observed || []),
      ];
      sources.forEach(({ node: other, edge: e }) => {
        if (!other || seenIds.has(other.id)) return;
        const sId = typeof e.source === 'object' ? e.source.id : e.source;
        if (sId !== node?.id) return;
        seenIds.add(other.id);
        addClaim(other, e.type);
      });
    }
    return sets;
  }, [node, edges, neighbors, fullKgInfo, fullPredInfo]);

  // Asymmetric "Compared with" rail: outperforms / compared_against /
  // semantically_similar. These are the rows that carry a TEI-table pull
  // quote when the model picked them up from a structured benchmark
  // table; we render that quote inline so the panel earns the KG work
  // visually instead of just listing types.
  const comparedWith = useMemo(() => {
    if (!node) return [];
    const rows = [];
    // In predictions view, prefer the FULL predicted-edge set loaded from
    // kg-predictions.json over `selection.edges` (which is filtered by the
    // min-confidence slider and typically only contains a handful of
    // in-view edges). Falls back to in-view edges if the full data isn't
    // loaded yet (first paint) or we're not in predictions view.
    const useFullPred = isPredictionsView && fullPredInfo && fullPredInfo.observed.length > 0;
    if (useFullPred) {
      fullPredInfo.observed.forEach(({ node: other, edge: e, direction }) => {
        if (!other) return;
        if (!['outperforms', 'compared_against', 'semantically_similar'].includes(e.type)) return;
        rows.push({
          other,
          type: e.type,
          direction,
          metric: e.metric,
          margin: e.margin,
          winner_value: e.winner_value,
          loser_value: e.loser_value,
          confidence: e.confidence ?? e.intent_confidence,
          table_caption: e.table_caption,
        });
      });
    } else {
      (edges || []).forEach(e => {
        const sId = typeof e.source === 'object' ? e.source.id : e.source;
        const tId = typeof e.target === 'object' ? e.target.id : e.target;
        let otherId, direction;
        if (sId === node.id) { otherId = tId; direction = 'out'; }
        else if (tId === node.id) { otherId = sId; direction = 'in'; }
        else return;
        const other = (neighbors || []).find(n => n.id === otherId);
        if (!other) return;
        if (!['outperforms', 'compared_against', 'semantically_similar'].includes(e.type)) return;
        rows.push({
          other,
          type: e.type,
          direction,
          metric: e.metric,
          margin: e.margin,
          winner_value: e.winner_value,
          loser_value: e.loser_value,
          confidence: e.confidence ?? e.intent_confidence,
          table_caption: e.table_caption,
        });
      });
    }
    // Sort by confidence so the strongest predicted comparisons surface first
    rows.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return rows;
  }, [node, edges, neighbors, isPredictionsView, fullPredInfo]);

  // Citation timeline: per-year bins of citation events, stacked by
  // stance. Pulled from `cites` (in-corpus, stance from TEI), `cited_by_external`
  // (S2-derived, no stance), and `cites_external`. The timeline tells a
  // researcher when this paper was active in the citation web and how
  // its reception evolved — replacing the previous one-line hub summary
  // with something worth looking at.
  const citeTimeline = useMemo(() => {
    if (!node || !edges || !neighbors) return null;
    const byYear = new Map(); // year → { builds_on, neutral, differs_from, external }
    const neighborsById = new Map((neighbors || []).map(n => [n.id, n]));
    const recordYear = (yr, key) => {
      if (!Number.isFinite(yr) || yr < 1990 || yr > 2030) return;
      if (!byYear.has(yr)) byYear.set(yr, { builds_on: 0, neutral: 0, differs_from: 0, external: 0 });
      byYear.get(yr)[key] = (byYear.get(yr)[key] || 0) + 1;
    };
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      const otherId = sId === node.id ? tId : (tId === node.id ? sId : null);
      if (!otherId) return;
      const other = neighborsById.get(otherId);
      if (!other) return;
      const yr = Number.parseInt(String(other.year || other.meta?.year || '').match(/\d{4}/)?.[0] || '', 10);
      if (e.type === 'cites' || e.type === 'cites_external') {
        recordYear(yr, e.sentiment || 'neutral');
      } else if (e.type === 'cited_by_external') {
        recordYear(yr, 'external');
      }
    });
    if (byYear.size === 0) return null;
    const years = [...byYear.keys()].sort();
    const yMin = years[0]; const yMax = years[years.length - 1];
    const bars = [];
    for (let y = yMin; y <= yMax; y += 1) {
      const v = byYear.get(y) || { builds_on: 0, neutral: 0, differs_from: 0, external: 0 };
      bars.push({ year: y, ...v, total: v.builds_on + v.neutral + v.differs_from + v.external });
    }
    const peak = Math.max(...bars.map(b => b.total), 1);
    return { yMin, yMax, bars, peak };
  }, [node, edges, neighbors]);

  // ── Entity detail: universal pattern for non-paper node types
  // (technique, hardware, dataset, author, institution, reference,
  // claim subtypes, figure/table/equation). Computes:
  //   - the dominant relation type connecting this entity to papers
  //     (so the header reads "Used by N papers" / "From N papers" / etc.)
  //   - the list of connected papers (clickable, dedupe by id)
  //   - year range, top co-occurring nodes (only meaningful for technique)
  //   - the edge-type explainer line
  // Returns null if there's literally nothing to show — caller (the
  // hasContent gate below) uses that to decide whether to render at all.
  const entityDetail = useMemo(() => {
    if (!node || !edges || !neighbors) return null;
    if (node.type === 'paper' || node.type === 'method') return null; // those use the rich paper layout
    const neighborsById = new Map((neighbors || []).map(n => [n.id, n]));
    const connectedPapers = []; // { paper, edgeType, direction }
    const otherNeighbors = [];  // non-paper connections
    const edgeTypeCounts = {};
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      let otherId, direction;
      if (sId === node.id) { otherId = tId; direction = 'out'; }
      else if (tId === node.id) { otherId = sId; direction = 'in'; }
      else return;
      const other = neighborsById.get(otherId);
      if (!other) return;
      const t = e.type || 'other';
      edgeTypeCounts[t] = (edgeTypeCounts[t] || 0) + 1;
      if (other.type === 'paper' || other.type === 'method') {
        connectedPapers.push({ paper: other, edgeType: t, direction });
      } else {
        otherNeighbors.push({ node: other, edgeType: t, direction });
      }
    });
    // Group papers by edge type — that's where the signal is. A
    // technique connected to 12 papers via a mix of uses_backbone /
    // uses_technique / uses_loss tells you HOW it's used, not just
    // that it's used. Within a group, dedupe by paper id (a paper that
    // uses the same technique twice in different sections still shows
    // once per group). Across groups, the same paper can appear if it
    // genuinely uses the entity at multiple "levels" (e.g. PointNet as
    // both backbone and a referenced technique).
    const papersByRelation = new Map();
    const seenPerRelation = new Map(); // edgeType -> Set<paperId>
    connectedPapers.forEach(({ paper, edgeType, direction }) => {
      if (!papersByRelation.has(edgeType)) papersByRelation.set(edgeType, []);
      if (!seenPerRelation.has(edgeType)) seenPerRelation.set(edgeType, new Set());
      const seen = seenPerRelation.get(edgeType);
      if (seen.has(paper.id)) return;
      seen.add(paper.id);
      papersByRelation.get(edgeType).push({ paper, edge: { type: edgeType }, direction });
    });
    // Total unique papers across all relations (drives the header count).
    const allPaperIds = new Set();
    connectedPapers.forEach(({ paper }) => allPaperIds.add(paper.id));
    const dedupedPapers = [...allPaperIds].map(pid => ({
      paper: connectedPapers.find(c => c.paper.id === pid).paper,
    }));
    // Dominant edge type → drives the header verb.
    const dominantEdgeType = Object.entries(edgeTypeCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    // Order relations by frequency descending; this is what the panel
    // walks to render the per-relation sections.
    const relationOrder = [...papersByRelation.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k]) => k);
    // Year span over connected papers
    const years = dedupedPapers
      .map(({ paper }) => Number.parseInt(String(paper.year || paper.meta?.year || '').match(/\d{4}/)?.[0] || '', 10))
      .filter(y => Number.isFinite(y) && y >= 1990 && y <= 2030);
    const yearMin = years.length ? Math.min(...years) : null;
    const yearMax = years.length ? Math.max(...years) : null;
    // For techniques: top 3 co-occurring techniques (techniques used
    // by the same papers as this one)
    let coOccurring = [];
    if (node.type === 'technique' && dedupedPapers.length > 0) {
      const occCounts = {};
      const paperIds = new Set(dedupedPapers.map(p => p.paper.id));
      (edges || []).forEach(e => {
        if (e.type !== 'uses_technique' && e.type !== 'uses_backbone' && e.type !== 'uses_loss') return;
        const sId = typeof e.source === 'object' ? e.source.id : e.source;
        const tId = typeof e.target === 'object' ? e.target.id : e.target;
        const paperId = sId === node.id ? null : (paperIds.has(sId) ? sId : (paperIds.has(tId) ? tId : null));
        const techId = tId === node.id ? null : (paperIds.has(tId) ? sId : (paperIds.has(sId) ? tId : null));
        if (!paperId || !techId) return;
        const tech = neighborsById.get(techId);
        if (!tech || tech.id === node.id) return;
        occCounts[tech.id] = occCounts[tech.id] || { node: tech, count: 0 };
        occCounts[tech.id].count += 1;
      });
      coOccurring = Object.values(occCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
    }
    return {
      dominantEdgeType,
      connectedPapers: dedupedPapers,
      papersByRelation,
      relationOrder,
      otherNeighbors,
      yearMin,
      yearMax,
      coOccurring,
      explainer: dominantEdgeType ? EDGE_EXPLAINERS[dominantEdgeType] : null,
    };
  }, [node, edges, neighbors]);

  // Header verb for non-paper entities. Different relations read
  // differently: "Used by N papers" vs "Cited by N papers" vs "From N papers".
  const entityHeaderText = useMemo(() => {
    if (!entityDetail) return null;
    const n = entityDetail.connectedPapers.length;
    if (n === 0) return null;
    const t = entityDetail.dominantEdgeType;
    const word = n === 1 ? 'paper' : 'papers';
    if (t === 'authored_by') return `Authored ${n} ${word}`;
    if (t === 'affiliated_with' || t === 'published_from') return `${n} ${word} from this institution`;
    if (t === 'cited_by_external') return `Cited by ${n} external ${word}`;
    if (t === 'has_table' || t === 'has_figure' || t === 'has_equation') return `Extracted from ${n} ${word}`;
    if (t === 'contributes' || t === 'has_limitation' || t === 'addresses_problem' || t === 'compares') return `Claimed by ${n} ${word}`;
    if (t === 'evaluated_on' || t === 'trained_on' || t === 'uses_dataset') return `Used by ${n} ${word}`;
    if (t === 'uses_technique' || t === 'uses_backbone' || t === 'uses_loss') return `Used by ${n} ${word}`;
    if (t === 'uses_hardware') return `Used by ${n} ${word}`;
    if (t === 'described_in') return `Described in ${n} ${word}`;
    if (t === 'cites_external') return `Cited by ${n} corpus ${word}`;
    return `Connected to ${n} ${word}`;
  }, [entityDetail]);

  // Counts for the provenance footer.
  // Earlier this counted observed edges from `edges` (the in-view set).
  // On the Predictions tab, `edges` only contains predicted edges, so
  // observed always read as 0 — even when the paper has 247 real edges
  // in the underlying KG. Fix: when the full-KG lookup has run, count
  // observed from that authoritative number minus the in-view predicted.
  // PREDICTION CONFIDENCE was also misleading on paper-node views (it
  // averaged a handful of in-view predictions and presented as the
  // paper's "score"). Now only surface it on the Predictions view AND
  // only when there are actually predicted edges to average.
  const provenance = useMemo(() => {
    const inViewPredicted = (edges || []).filter(e => e.inferred);
    const inViewObserved = (edges || []).filter(e => !e.inferred);
    const fullDegree = fullKgInfo ? fullKgInfo.degree : null;
    // Prefer full-KG-derived observed when we have it; otherwise fall
    // back to in-view observed only when we are NOT on the predictions
    // view (where in-view is misleading by design).
    let observed = 0;
    if (fullDegree !== null) {
      observed = Math.max(0, fullDegree - inViewPredicted.length);
    } else if (!needsFullKgLookup) {
      observed = inViewObserved.length;
    }
    const confs = inViewPredicted
      .map(e => e.confidence)
      .filter(c => typeof c === 'number' && c > 0);
    return {
      observed,
      predicted: inViewPredicted.length,
      avgConf: (needsFullKgLookup && confs.length > 0)
        ? (confs.reduce((s, c) => s + c, 0) / confs.length)
        : null,
    };
  }, [edges, fullKgInfo, needsFullKgLookup]);

  // Hub summary: when a node has many connections, the "X of many" list is
  // hard to read at a glance. Surface aggregate stats — top connected
  // type and a year histogram pulled from neighbors carrying a year — so
  // the user gets the shape of the hub before drilling into individual rows.
  const hubSummary = useMemo(() => {
    const all = neighbors || [];
    const HUB_THRESHOLD = 20;
    if (all.length < HUB_THRESHOLD) return null;
    // Top connected type + count
    const typeCounts = {};
    all.forEach(n => {
      const t = n.type || 'other';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
    // Year histogram from any neighbor carrying a `year` (papers + refs do).
    // Skip values like 'nan' / 0 / non-numeric.
    const years = [];
    all.forEach(n => {
      const y = n.year ?? n.meta?.year;
      const num = Number.parseInt(String(y || '').match(/\d{4}/)?.[0] || '', 10);
      if (Number.isFinite(num) && num >= 1990 && num <= 2030) years.push(num);
    });
    let yearMin = null, yearMax = null, hist = null;
    if (years.length >= 3) {
      yearMin = Math.min(...years);
      yearMax = Math.max(...years);
      const buckets = {};
      years.forEach(y => { buckets[y] = (buckets[y] || 0) + 1; });
      const range = yearMax - yearMin;
      const peakCount = Math.max(...Object.values(buckets));
      hist = [];
      for (let y = yearMin; y <= yearMax; y += 1) {
        hist.push({ year: y, count: buckets[y] || 0 });
      }
      // Cap to a reasonable bar count so the strip stays readable.
      if (hist.length > 16) {
        // Bin by 2-year groups when the range is wide.
        const step = Math.ceil(hist.length / 16);
        const binned = [];
        for (let i = 0; i < hist.length; i += step) {
          const slice = hist.slice(i, i + step);
          const ys = slice.map(h => h.year);
          const c = slice.reduce((s, h) => s + h.count, 0);
          binned.push({
            year: ys[0] === ys[ys.length - 1] ? `${ys[0]}` : `${ys[0]}–${ys[ys.length - 1]}`,
            count: c,
          });
        }
        hist = binned;
      }
      // Normalize bar heights to peak.
      const maxC = Math.max(...hist.map(b => b.count), 1);
      hist = hist.map(b => ({ ...b, h: Math.max(0.05, b.count / maxC) }));
      void range; void peakCount;
    }
    return { total: all.length, topType, yearMin, yearMax, hist };
  }, [neighbors]);

  // Separate citation lineage, carrying stance + in-text context from TEI
  const lineage = useMemo(() => {
    if (!node) return { citesOut: [], citesIn: [], stanceCounts: { builds_on: 0, neutral: 0, differs_from: 0 } };
    const citesOut = []; // papers THIS node cites (predecessors/influences)
    const citesIn = [];  // papers that cite THIS node (successors/descendants)
    const stanceCounts = { builds_on: 0, neutral: 0, differs_from: 0 };

    (edges || []).forEach(e => {
      if (e.type !== 'cites') return;
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      const enriched = {
        sentiment: e.sentiment || 'neutral',
        contexts: e.contexts || [],
        mentions: e.mentions || 0,
      };

      if (src === node.id) {
        const target = (neighbors || []).find(n => n.id === tgt);
        if (target) {
          citesOut.push({ ...target, ...enriched });
          stanceCounts[enriched.sentiment] = (stanceCounts[enriched.sentiment] || 0) + 1;
        }
      } else if (tgt === node.id) {
        const source = (neighbors || []).find(n => n.id === src);
        if (source) {
          citesIn.push({ ...source, ...enriched });
        }
      }
    });
    return { citesOut, citesIn, stanceCounts };
  }, [node, edges, neighbors]);

  if (!selection) return null;

  const hasLineage = lineage.citesOut.length > 0 || lineage.citesIn.length > 0;

  const toggleGroup = (key) => {
    setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Observed neighbors from the full KG that aren't already rendered in the
  // current Cytoscape view. Grouped by node type to mirror the in-view section.
  const observedExtra = (() => {
    if (!needsFullKgLookup || !fullKgInfo) return null;
    const inViewIds = new Set((neighbors || []).map(n => n.id).filter(Boolean));
    inViewIds.add(node.id);
    const groups = {};
    fullKgInfo.observed.forEach(({ node: other, edge, direction }) => {
      if (!other || inViewIds.has(other.id)) return;
      const t = other.type || 'other';
      if (!groups[t]) groups[t] = [];
      groups[t].push({ other, edge, direction });
    });
    return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  })();
  const observedExtraTotal = observedExtra
    ? observedExtra.reduce((sum, [, arr]) => sum + arr.length, 0)
    : 0;

  const INITIAL_SHOW = 5;

  // HGT predictions involving this node (inferred edges).
  // Symmetric-in-practice relations (outperforms, compares, co_cited_with) score
  // both directions identically since the model reasons from structural features —
  // we dedupe those into one bidirectional row per pair so the list isn't echoing itself.
  const SYMMETRIC_PRED_TYPES = new Set(['outperforms', 'compares', 'co_cited_with', 'shares_bibliography', 'co_authored_with', 'colleagues_with']);
  // Prefer the FULL predictions for this node when in predictions view —
  // same reasoning as comparedWith above (the in-view edges are clipped
  // by the min-confidence slider, the full set is what the researcher
  // actually wants to see in the side panel).
  const predictionRows = (() => {
    const useFullPred = isPredictionsView && fullPredInfo && fullPredInfo.observed.length > 0;
    if (useFullPred) {
      return fullPredInfo.observed
        .filter(({ edge: e }) => e.inferred || e.source_type === 'hgt')
        .map(({ node: other, edge: e, direction }) => ({
          type: e.type || 'unknown',
          other,
          otherId: other && other.id,
          confidence: e.confidence || 0,
          semantic: e.semantic_relevance || 0,
          direction,
        }));
    }
    return (edges || [])
      .filter(e => e.inferred || e.source_type === 'hgt')
      .map(e => {
        const s = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        const otherId = s === node.id ? tgt : s;
        return {
          type: e.type || 'unknown',
          other: (neighbors || []).find(n => n.id === otherId),
          otherId,
          confidence: e.confidence || 0,
          semantic: e.semantic_relevance || 0,
          direction: s === node.id ? 'out' : 'in',
        };
      });
  })();
  // Keep predictionEdges around for the legacy `predictionEdges.length`
  // gate that decides whether to render the panel at all.
  const predictionEdges = predictionRows;
  const predictionsByType = {};
  const pairSeen = new Map(); // `${type}|${otherId}` → list index, for dedup
  predictionRows.forEach(row => {
    const t = row.type;
    if (!predictionsByType[t]) predictionsByType[t] = [];
    if (SYMMETRIC_PRED_TYPES.has(t)) {
      const key = `${t}|${row.otherId}`;
      const prevIdx = pairSeen.get(key);
      if (prevIdx != null) {
        const existing = predictionsByType[t][prevIdx];
        if (row.confidence > existing.confidence) {
          predictionsByType[t][prevIdx] = { ...row, direction: 'bi' };
        } else {
          existing.direction = 'bi';
        }
        return;
      }
      pairSeen.set(key, predictionsByType[t].length);
    }
    predictionsByType[t].push(row);
  });

  // Per-relation descriptions — what this prediction actually signifies to a researcher.
  const PRED_VERB_LABEL = {
    outperforms: 'likely comparison pair',
    compares: 'likely comparison pair',
    uses_technique: 'likely technique usage',
    co_cited_with: 'likely intellectual peers',
    shares_bibliography: 'likely shared foundations',
    co_authored_with: 'likely collaborators',
    colleagues_with: 'likely institutional peers',
    author_works_on: 'likely research interest',
  };
  const PRED_MEANING = {
    outperforms: 'Papers that likely belong in a head-to-head benchmark with this one — same datasets and overlapping techniques, but no direct comparison in the literature yet.',
    compares: 'Papers positioned for direct comparison with this work but not yet compared in the literature.',
    compared_against: 'Papers likely benchmarked against this one based on shared experimental context.',
    uses_technique: 'Techniques this paper likely uses based on how similar papers in the landscape use them.',
    contributes: 'Research contributions likely associated with this paper.',
    has_limitation: 'Limitations likely relevant to this work based on similar methods.',
    addresses_problem: 'Research problems this paper likely addresses.',
    co_cited_with: 'Works that likely share a citation context with this paper.',
    shares_bibliography: 'Works that likely draw from an overlapping bibliographic base.',
  };

  // ── Merged-row list for the compact HGT panel (predictions view only).
  // Collapses outperforms/compared_against/compares against the same
  // target paper into a single row with multiple relation tags, so the
  // user doesn't see "Geometric Object Grasper" repeated 3× back-to-back.
  // We also retain the full underlying edge so the inspector can render
  // the comparability table for it.
  const mergedPredRows = (() => {
    if (!isPredictionsView) return [];
    // Use the FULL predicted edge set when available; selection.edges
    // alone is filtered by the in-view min-confidence slider.
    const useFull = fullPredInfo && fullPredInfo.observed.length > 0;
    const source = useFull
      ? fullPredInfo.observed.map(({ node: other, edge, direction }) => ({ other, edge, direction }))
      : (edges || [])
          .filter(e => e.inferred || e.source_type === 'hgt')
          .map(e => {
            const s = typeof e.source === 'object' ? e.source.id : e.source;
            const tgt = typeof e.target === 'object' ? e.target.id : e.target;
            const otherId = s === node.id ? tgt : s;
            return {
              other: (neighbors || []).find(n => n.id === otherId),
              edge: e,
              direction: s === node.id ? 'out' : 'in',
            };
          });
    const byTargetType = new Map(); // `${type}|${otherId}` → row (dedup symmetric pairs)
    const byTarget = new Map();      // otherId → merged row
    source.forEach(({ other, edge, direction }) => {
      if (!other) return;
      const t = edge.type || 'unknown';
      if (SYMMETRIC_PRED_TYPES.has(t)) {
        const key = `${t}|${other.id}`;
        if (byTargetType.has(key)) {
          // Dedup: keep the higher-confidence direction, mark bidir
          const prev = byTargetType.get(key);
          if ((edge.confidence || 0) > (prev.edge.confidence || 0)) {
            byTargetType.set(key, { other, edge, direction: 'bi' });
          } else {
            prev.direction = 'bi';
          }
          return;
        }
        byTargetType.set(key, { other, edge, direction });
      } else {
        byTargetType.set(`${t}|${other.id}`, { other, edge, direction });
      }
    });
    // Now merge across types — one row per target paper, with all relation tags
    for (const { other, edge, direction } of byTargetType.values()) {
      const key = other.id;
      if (!byTarget.has(key)) {
        byTarget.set(key, {
          other,
          types: [],
          edges: [], // {type, edge, direction}
          topConfidence: 0,
        });
      }
      const row = byTarget.get(key);
      row.types.push(edge.type);
      row.edges.push({ type: edge.type, edge, direction });
      row.topConfidence = Math.max(row.topConfidence, edge.confidence || 0);
    }
    return Array.from(byTarget.values())
      .filter(r => r.topConfidence > 0.01)
      .sort((a, b) => b.topConfidence - a.topConfidence);
  })();

  // Group merged rows. Two buckets, both grounded in what a robotics
  // researcher actually cares about:
  //   - "Likely comparison pair": paper↔paper predictions (OUTPERFORMS /
  //     COMPARED_AGAINST / COMPARES) — "you should have benchmarked
  //     against these"
  //   - "Likely technique usage": paper↔technique predictions
  //     (USES_TECHNIQUE) — "the model thinks you used these"
  //
  // Claim/contribution/limitation/problem target types are deliberately
  // dropped. The HGT often predicts a paper's OWN claim node back, which
  // is a trivial self-recovery, not a research hypothesis. When the model
  // predicts ANOTHER paper's claim, the row shows truncated unattributed
  // text that demands an inspector reveal the model can't provide
  // (paper↔claim edges don't have comparability data). The three judges
  // converged on cutting this bucket entirely; we follow their advice.
  const mergedGroups = (() => {
    if (!isPredictionsView) return [];
    const groups = {
      'paper': { label: 'Likely comparison pair', meaning: PRED_MEANING.outperforms, types: new Set(), rows: [] },
      'technique': { label: 'Likely technique usage', meaning: PRED_MEANING.uses_technique, types: new Set(), rows: [] },
    };
    mergedPredRows.forEach(row => {
      const otype = row.other?.type;
      let bucket = null;
      if (otype === 'paper' || otype === 'method') bucket = 'paper';
      else if (otype === 'technique') bucket = 'technique';
      if (!bucket) return; // skip claim / contribution / problem / limitation / etc.
      groups[bucket].rows.push(row);
      row.types.forEach(t => groups[bucket].types.add(t));
    });
    return Object.values(groups).filter(g => g.rows.length > 0);
  })();

  // Auto-select the top row of the first group on first render so the
  // inspector is never empty.
  const autoInspectorRow = inspectorRow || (mergedGroups[0] && mergedGroups[0].rows[0]) || null;

  // Helper: lookup test AUC + Hits@10 for the dominant edge type in a group
  const groupMetrics = (group) => {
    if (!hgtMetrics || !hgtMetrics.per_type) return null;
    // Pick the highest-n_pos type from the group's types (most stable signal)
    let best = null;
    for (const t of group.types) {
      const stats = hgtMetrics.per_type[t];
      if (!stats) continue;
      if (!best || (stats.n_pos > (best.n_pos || 0))) best = { ...stats, type: t };
    }
    return best;
  };

  // Final gate: does this node have ANY meaningful content to show? If
  // not, return null so the panel literally doesn't open. Reason: an
  // empty panel for a node with no surfaceable info reads as "the app
  // is broken." Better to do nothing.
  const hasContent = (() => {
    if (node.type === 'paper' || node.type === 'method') return true; // rich layout always renders
    if (entityDetail && entityDetail.connectedPapers.length > 0) return true;
    if (node.value && node.value !== node.label) return true; // claim/equation/reference text
    if (Array.isArray(node.cells) && node.cells.length > 0) return true; // table cells
    if (node.latex) return true;
    return false;
  })();
  if (!hasContent) return null;

  // The paper-only sections (spec card, compared-with rail, chip ribbons,
  // narrative block, lineage + timeline) all assume the clicked node is
  // a paper or its 1:1 method twin. For any other node type the entity
  // block above is the entire panel content. Gate each paper-only block
  // on this flag so technique / hardware / dataset / author / institution
  // / reference / claim / figure / table / equation nodes don't leak
  // paper-shaped content. Found by: clicking a technique node and seeing
  // the chip ribbon stuff connected papers in as if they were techniques.
  const isPaper = node.type === 'paper' || node.type === 'method';

  // Compact key/value pairs for the spec card. Order follows the COMPARE
  // grasp-planning sheet (robot-manipulation.org) so a roboticist's eye
  // lands on the same fields they already scan there.
  const specRows = isPaper ? [
    { key: 'Input',         value: paperFacts.meta?.input },
    { key: 'Output',        value: paperFacts.meta?.output },
    { key: 'End-effector',  value: paperFacts.meta?.effector },
    { key: 'Object config', value: paperFacts.meta?.scene },
    { key: 'Planning',      value: paperFacts.meta?.planning },
    { key: 'Training',      value: paperFacts.meta?.training },
    { key: 'Datasets',      value: paperFacts.datasets.length ? paperFacts.datasets.join(', ') : null },
    { key: 'Hardware',      value: paperFacts.hardware.length ? paperFacts.hardware.join(', ') : null },
  ].filter(r => r.value && r.value !== 'nan' && r.value !== 'undefined') : [];
  const hasSpec = specRows.length > 0;

  const isCompact = false;

  return (
    <div className={`kgnd-panel ${placement === 'side' ? 'kgnd-panel-side' : ''} ${expanded ? 'kgnd-panel-expanded' : ''}`}>
      {/* Header bar — title + (Expand toggle, paper/method only) + close.
          The full identity (year, authors, venue, institution) sits in a
          thin strip below to keep the dark banner reserved for the title
          alone. */}
      <div className="detail-panel-header">
        <h3>{node.label}</h3>
        <div className="kgnd-panel-actions">
          {isPaper && onToggleExpanded && placement === 'side' && (
            <button
              className="kgnd-panel-expand"
              onClick={onToggleExpanded}
              title="Open full-width view below the graph for the complete 2-column layout"
            >
              ↗ Expand
            </button>
          )}
          {placement === 'bottom' && onToggleExpanded && (
            <button
              className="kgnd-panel-expand"
              onClick={onToggleExpanded}
              title="Collapse back to the side panel"
            >
              ↙ Collapse
            </button>
          )}
          <button className="kgnd-panel-close" onClick={onClose}>&times;</button>
        </div>
      </div>

      <div className="detail-panel-body">
        {/* Identity strip — Calli's spreadsheet-style "what is this thing"
            line: year · venue · authors · institution. Single row, no
            decoration. The `kgnd-id-strip` class is read by the body grid
            in App.css to span full width. */}
        <div className="kgnd-id-strip">
          <span className="kgnd-id-type" style={{ background: TYPE_COLORS[node.type] || '#8691a0' }}>
            {TYPE_LABELS[node.type] || node.type}
          </span>
          {paperFacts.year && <span className="kgnd-id-fact">{paperFacts.year}</span>}
          {paperFacts.authors.length > 0 && (
            <span className="kgnd-id-fact kgnd-id-authors">
              {paperFacts.authors.slice(0, 3).join(', ')}
              {paperFacts.authors.length > 3 && ` +${paperFacts.authors.length - 3}`}
            </span>
          )}
          {paperFacts.institutions.length > 0 && (
            <span className="kgnd-id-fact kgnd-id-inst">
              {paperFacts.institutions.slice(0, 2).join(' · ')}
            </span>
          )}
          <span className="kgnd-id-degree">
            {needsFullKgLookup && fullKgInfo
              ? `${fullKgInfo.degree} edges · ${(neighbors || []).length} in view`
              : `${(neighbors || []).length} edges`}
          </span>
        </div>

        {/* Why this node is in your query's subgraph */}
        {queryRole && (
          <div className={`kgnd-role kgnd-role-${queryRole.kind}`}>
            <span className="kgnd-role-dot" aria-hidden />
            <span className="kgnd-role-text">{queryRole.text}</span>
            {query && <span className="kgnd-role-query">"{query}"</span>}
          </div>
        )}

        {/* Entity detail block — non-paper nodes (technique, hardware,
            dataset, author, institution, reference, claim subtypes,
            figures/tables/equations). Single universal pattern: a
            header verb + optional explainer + connected-papers list +
            optional co-occurring chips + year span. The hasContent
            gate above guarantees we only render when this list has
            entries or the node carries text/cells/latex. */}
        {entityDetail && entityHeaderText && (
          <div className="kgnd-entity">
            <div className="kgnd-entity-head">
              <span className="kgnd-entity-count">{entityHeaderText}</span>
              {entityDetail.yearMin && entityDetail.yearMax && (
                <span className="kgnd-entity-years">
                  {entityDetail.yearMin === entityDetail.yearMax
                    ? entityDetail.yearMin
                    : `${entityDetail.yearMin}–${entityDetail.yearMax}`}
                </span>
              )}
            </div>
            {entityDetail.coOccurring.length > 0 && (
              <div className="kgnd-entity-cooccur">
                <span className="kgnd-entity-cooccur-label">Often appears with</span>
                <div className="kgnd-chips">
                  {entityDetail.coOccurring.map(({ node: n, count }, i) => (
                    <span
                      key={i}
                      className="kgnd-chip kgnd-chip-tech"
                      onClick={() => onNodeClick && onNodeClick(n)}
                      title={`Co-occurs in ${count} ${count === 1 ? 'paper' : 'papers'}`}
                    >
                      {n.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* Per-edge-type sections — the signal is HOW the entity is
                used (backbone vs. mentioned technique vs. loss), not just
                a flat paper list. Each group has its own header, the
                explainer line for that relation, and a collapsible list
                of papers under it. */}
            {entityDetail.relationOrder.map(relationType => {
              const items = entityDetail.papersByRelation.get(relationType) || [];
              if (items.length === 0) return null;
              const titleVerb = (function () {
                switch (relationType) {
                  case 'uses_backbone':    return 'Used as backbone';
                  case 'uses_technique':   return 'Used as technique component';
                  case 'uses_loss':        return 'Used as loss';
                  case 'uses_dataset':     return 'Used as dataset';
                  case 'trained_on':       return 'Mentioned for training';
                  case 'evaluated_on':     return 'Used for evaluation';
                  case 'uses_hardware':    return 'Used as hardware';
                  case 'authored_by':      return 'Papers authored';
                  case 'affiliated_with':  return 'Papers affiliated';
                  case 'published_from':   return 'Papers from this institution';
                  case 'cited_by_external':return 'Cited by external papers';
                  case 'cites_external':   return 'External reference cited by';
                  case 'has_table':        return 'Source paper (table)';
                  case 'has_figure':       return 'Source paper (figure)';
                  case 'has_equation':     return 'Source paper (equation)';
                  case 'contributes':      return 'Claimed by';
                  case 'has_limitation':   return 'Claimed by';
                  case 'addresses_problem':return 'Claimed by';
                  case 'compares':         return 'Claimed by';
                  case 'described_in':     return 'Described in';
                  default: return RELATION_TITLES[relationType] || relationType;
                }
              })();
              const expandKey = `entityRel-${relationType}`;
              const isExpanded = !!expandedGroups[expandKey];
              const showCount = isExpanded ? items.length : 5;
              const explainer = EDGE_EXPLAINERS[relationType];
              return (
                <div key={relationType} className="kgnd-entity-rel">
                  <div className="kgnd-entity-rel-head">
                    <span className="kgnd-entity-rel-title">{titleVerb}</span>
                    <span className="kgnd-entity-rel-count">{items.length}</span>
                  </div>
                  {explainer && (
                    <div className="kgnd-entity-rel-explainer">{explainer}</div>
                  )}
                  <div className="kgnd-entity-papers">
                    {items.slice(0, showCount).map(({ paper }, i) => (
                      <div
                        key={i}
                        className="kgnd-entity-paper"
                        onClick={() => onNodeClick && onNodeClick(paper)}
                        onMouseEnter={() => onHoverEntity && onHoverEntity(paper)}
                        onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                      >
                        {paper.label}
                      </div>
                    ))}
                  </div>
                  {items.length > 5 && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup(expandKey)}>
                      {isExpanded ? 'Show less' : `Show all ${items.length}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* HERO — Method spec card. Two-column key/value grid in the
            COMPARE column order. This is the first thing a roboticist
            wants to see when comparing methods, so it earns the visual
            weight here instead of being relegated below the graph. */}
        {hasSpec && (
          <div className="kgnd-spec-card kgnd-slot-left">
            <div className="kgnd-spec-eyebrow">Method spec</div>
            <div className="kgnd-spec-grid">
              {specRows.map(({ key, value }) => (
                <div key={key} className="kgnd-spec-row">
                  <span className="kgnd-spec-key">{key}</span>
                  <span className="kgnd-spec-val">{value}</span>
                </div>
              ))}
            </div>
            {paperFacts.meta?.description && paperFacts.meta.description !== 'nan' && (
              <p className="kgnd-spec-desc">
                <HighlightedText
                  text={paperFacts.meta.description}
                  termDictionary={termDictionary}
                  query={query}
                />
              </p>
            )}
          </div>
        )}

        {/* Compared-with rail — outperforms / compared_against / semantic
            similarity, with TEI-table provenance inline as a pull quote
            when the edge carries it. This is the move that pays for the
            table extractor visually: the user sees the actual metric and
            margin that drove the relation, not just the relation type. */}
        {!isCompact && isPaper && !isPredictionsView && comparedWith.length > 0 && (() => {
          const cwKey = 'comparedWith';
          const cwExpanded = !!expandedGroups[cwKey];
          const CW_INITIAL = 8;
          const cwVisible = cwExpanded ? comparedWith : comparedWith.slice(0, CW_INITIAL);
          const cwHasMore = comparedWith.length > CW_INITIAL;
          return (
          <div className="kgnd-compared kgnd-slot-right">
            <div className="kgnd-compared-eyebrow">
              Compared with
              <span className="kgnd-compared-count"> · {comparedWith.length}</span>
            </div>
            {cwVisible.map((row, i) => {
              const arrow = row.direction === 'out' ? '→'
                : row.direction === 'in' ? '←'
                : '↔';
              const verb = row.type === 'outperforms'
                ? (row.direction === 'in' ? 'outperformed by' : 'outperforms')
                : row.type === 'compared_against'
                  ? 'compared against'
                  : 'similar to';
              return (
                <div
                  key={i}
                  className={`kgnd-cmp-row kgnd-cmp-${row.type}`}
                  onClick={() => onNodeClick && onNodeClick(row.other)}
                  onMouseEnter={() => onHoverEntity && onHoverEntity(row.other)}
                  onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                >
                  <span className="kgnd-cmp-arrow">{arrow}</span>
                  <span className="kgnd-cmp-target">{row.other.label}</span>
                  <span className="kgnd-cmp-verb">{verb}</span>
                  {row.metric && (
                    <span className="kgnd-cmp-metric">
                      {row.metric}
                      {typeof row.winner_value === 'number' && typeof row.loser_value === 'number' && (
                        <span className="kgnd-cmp-values">
                          {' '}{row.winner_value} vs {row.loser_value}
                        </span>
                      )}
                    </span>
                  )}
                  {row.table_caption && (
                    <div className="kgnd-cmp-quote">"{row.table_caption}"</div>
                  )}
                </div>
              );
            })}
            {cwHasMore && (
              <button
                className="kgnd-show-all"
                onClick={() => setExpandedGroups(g => ({ ...g, [cwKey]: !cwExpanded }))}
              >
                {cwExpanded ? `Show top ${CW_INITIAL}` : `Show all ${comparedWith.length}`}
              </button>
            )}
          </div>
          );
        })()}

        {/* Predicted relationships — inferred by graph-learning model.
            Only renders for paper / method nodes. The lede paragraph,
            Pattern score / Content match legend, and "likely technique
            usage" / "likely comparison pair" copy are all written from
            a paper's perspective ("this paper sits relative to others
            ... techniques worth checking"). On a technique / hardware /
            dataset / author / institution node that copy reads as
            nonsense (the clicked node IS the technique, so "techniques
            this paper is likely to use" is incoherent). Surfacing
            predicted relationships from non-paper entities needs its
            own type-appropriate copy and is a separate UX. */}
        {/* ── Compact HGT panel — predictions view only.
            Fixed-height dual-pane: scannable merged-row list on the left
            (one row per target paper, all relation tags collapsed), live
            inspector on the right showing the model's structured
            reasoning (shared topics + comparability table) for whichever
            row is hovered/clicked. Per-group AUC/Hits@10 chips and a
            single-line model card give the user immediate signal on how
            much to trust each prediction without blowing the panel up.
            Replaces the old vertical-stack of "Compared with" + paragraph
            explainer + per-type sub-lists, which sprawled and underused
            horizontal space. */}
        {!isCompact && isPaper && isPredictionsView && fullPredInfo && mergedGroups.length > 0 && (
          <div className="kgnd-hgt-panel">
            <div className="kgnd-hgt-rail" aria-hidden />
            <div className="kgnd-hgt-head">
              <div className="kgnd-hgt-eyebrow">Suggested relationships</div>
              <p className="kgnd-hgt-lede">
                Connections not yet documented but likely based on shared techniques, benchmarks, and research context. Click a row for details.
              </p>
            </div>
            <div className="kgnd-hgt-grid">
              <div className="kgnd-hgt-list">
                {mergedGroups.map((group, gi) => {
                  const metrics = groupMetrics(group);
                  const groupKey = `pred_group_${gi}`;
                  const isExpanded = !!expandedGroups[groupKey];
                  const SHOW_INITIAL = 6;
                  const visible = isExpanded ? group.rows : group.rows.slice(0, SHOW_INITIAL);
                  const hasMore = group.rows.length > SHOW_INITIAL;
                  return (
                    <div key={gi} className="kgnd-hgt-group">
                      <div className="kgnd-hgt-group-head">
                        <span className="kgnd-hgt-group-label">{group.label}</span>
                        <span className="kgnd-hgt-group-count">{group.rows.length}</span>
                      </div>
                      {visible.map((row, i) => {
                        const isSelected = autoInspectorRow && autoInspectorRow.other?.id === row.other?.id;
                        // Show one tag per relation type the row collapses
                        const tagSet = Array.from(new Set(row.types));
                        return (
                          <div
                            key={i}
                            className={`kgnd-hgt-row ${isSelected ? 'selected' : ''}`}
                            onClick={() => {
                              setInspectorRow(row);
                              if (row.other && onNodeClick) onNodeClick(row.other);
                            }}
                            onMouseEnter={() => {
                              setInspectorRow(row);
                              if (onHoverEntity) onHoverEntity(row.other);
                            }}
                            onMouseLeave={() => { if (onHoverEntity) onHoverEntity(null); }}
                          >
                            <span className="kgnd-hgt-row-name">{row.other?.label || '?'}</span>
                            <span className="kgnd-hgt-row-tags">
                              {tagSet.map(t => (
                                <span key={t} className={`kgnd-hgt-tag tag-${t}`}>{t.replace(/_/g, ' ')}</span>
                              ))}
                            </span>
                            <span className="kgnd-hgt-row-conf" title={`Confidence: ${Math.round(row.topConfidence * 100)}% — how likely this connection is based on shared research context`}>
                              <span className="kgnd-hgt-conf-bar">
                                <span style={{ width: `${row.topConfidence * 100}%` }} />
                              </span>
                              <span className="kgnd-hgt-conf-num">{Math.round(row.topConfidence * 100)}</span>
                            </span>
                          </div>
                        );
                      })}
                      {hasMore && (
                        <button
                          className="kgnd-hgt-more"
                          onClick={() => setExpandedGroups(g => ({ ...g, [groupKey]: !isExpanded }))}
                        >
                          {isExpanded ? `Show top ${SHOW_INITIAL}` : `Show all ${group.rows.length}`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <aside className="kgnd-hgt-inspector">
                {autoInspectorRow ? (() => {
                  const row = autoInspectorRow;
                  // Pick the highest-confidence edge of the merged row
                  const topEdge = row.edges.slice().sort((a, b) => (b.edge.confidence || 0) - (a.edge.confidence || 0))[0];
                  const e = topEdge.edge;
                  const isPaperPair = row.other?.type === 'paper' || row.other?.type === 'method';
                  const shared = (e.shared_context || []).slice(0, 5);
                  const cmp = e.comparability || {};
                  const cmpShared = (cmp.shared || []).slice(0, 3);
                  const cmpDiffers = (cmp.differs || []).slice(0, 4);
                  const cmpGaps = (cmp.gaps || []).slice(0, 2);
                  const dirSym = topEdge.direction === 'bi' ? '↔' : (topEdge.direction === 'out' ? '→' : '←');
                  return (
                    <>
                      <div className="kgnd-hgt-insp-pair">
                        <span className="kgnd-hgt-insp-a">{node.label}</span>
                        <span className="kgnd-hgt-insp-arrow">{dirSym}</span>
                        <span className="kgnd-hgt-insp-b">{row.other?.label}</span>
                      </div>
                      <div className="kgnd-hgt-insp-scores">
                        <div className="kgnd-hgt-insp-score" title="How likely this connection is based on shared techniques, benchmarks, and citation patterns across the literature.">
                          <span className="kgnd-hgt-insp-score-lbl">RELATIONSHIP STRENGTH</span>
                          <span className="kgnd-hgt-insp-score-bar">
                            <span style={{ width: `${(e.confidence || 0) * 100}%` }} />
                          </span>
                          <span className="kgnd-hgt-insp-score-num">{Math.round((e.confidence || 0) * 100)}<span className="kgnd-hgt-insp-score-unit">%</span></span>
                        </div>
                        {isPaperPair && (e.semantic_relevance || 0) > 0.05 && (
                          <div className="kgnd-hgt-insp-score" title="How similar the research content of these two papers is, based on their abstracts and full text.">
                            <span className="kgnd-hgt-insp-score-lbl">RESEARCH SIMILARITY</span>
                            <span className="kgnd-hgt-insp-score-bar alt">
                              <span style={{ width: `${(e.semantic_relevance || 0) * 100}%` }} />
                            </span>
                            <span className="kgnd-hgt-insp-score-num">{Math.round((e.semantic_relevance || 0) * 100)}<span className="kgnd-hgt-insp-score-unit">%</span></span>
                          </div>
                        )}
                      </div>
                      {shared.length > 0 && (
                        <div className="kgnd-hgt-insp-block">
                          <div className="kgnd-hgt-insp-eyebrow">Shared research context</div>
                          <div className="kgnd-hgt-insp-chips">
                            {shared.map((s, i) => (
                              <span key={i} className="kgnd-hgt-chip">{s.label}</span>
                            ))}
                            {(e.shared_context || []).length > 5 && (
                              <span className="kgnd-hgt-chip more">+{(e.shared_context || []).length - 5}</span>
                            )}
                          </div>
                        </div>
                      )}
                      {cmpShared.length > 0 && (
                        <div className="kgnd-hgt-insp-block">
                          <div className="kgnd-hgt-insp-eyebrow">In common</div>
                          <div className="kgnd-hgt-insp-cmp">
                            {cmpShared.map((c, i) => (
                              <div key={i} className="kgnd-hgt-insp-cmp-row shared">
                                <span className="kgnd-hgt-insp-cmp-k">{c.label}</span>
                                <span className="kgnd-hgt-insp-cmp-v">{c.value_a}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {cmpDiffers.length > 0 && (
                        <div className="kgnd-hgt-insp-block">
                          <div className="kgnd-hgt-insp-eyebrow">Where they differ</div>
                          <div className="kgnd-hgt-insp-cmp">
                            {cmpDiffers.map((c, i) => (
                              <div key={i} className="kgnd-hgt-insp-cmp-row differs">
                                <span className="kgnd-hgt-insp-cmp-k">{c.label}</span>
                                <span className="kgnd-hgt-insp-cmp-v left">{c.value_a || '—'}</span>
                                <span className="kgnd-hgt-insp-cmp-vs">vs</span>
                                <span className="kgnd-hgt-insp-cmp-v right">{c.value_b || '—'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {cmpGaps.length > 0 && (
                        <div className="kgnd-hgt-insp-block">
                          <div className="kgnd-hgt-insp-eyebrow">Data gaps</div>
                          <div className="kgnd-hgt-insp-cmp">
                            {cmpGaps.map((c, i) => (
                              <div key={i} className="kgnd-hgt-insp-cmp-row gap">
                                <span className="kgnd-hgt-insp-cmp-k">{c.label}</span>
                                <span className="kgnd-hgt-insp-cmp-v">{c.value_a || c.value_b || '—'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {hgtMetrics && (
                        <div className="kgnd-hgt-insp-footer">
                          Based on analysis of {hgtMetrics.n_nodes?.toLocaleString() || '4,174'} entities and {hgtMetrics.n_edges?.toLocaleString() || '5,700'}+ documented relationships across the literature
                        </div>
                      )}
                    </>
                  );
                })() : (
                  <div className="kgnd-hgt-insp-empty">Click a row to see why these methods may be connected.</div>
                )}
              </aside>
            </div>
          </div>
        )}

        {!isCompact && isPaper && !isPredictionsView && predictionEdges.length > 0 && (
          <div className="kgnd-pred-panel">
            <div className="kgnd-pred-rail" aria-hidden />
            {/* Two-column layout: prediction groups on the left, explainer
                (eyebrow + lede + Pattern score / Content match legend) on the
                right. Earlier these stacked vertically across the full width
                of the panel, which left half the page as whitespace and
                pushed every group below the fold. Layout collapses to a
                single column on narrow viewports via CSS. */}
            <div className="kgnd-pred-grid">
              <div className="kgnd-pred-groups">
                {Object.entries(predictionsByType).map(([etype, preds]) => {
                  const verbLabel = PRED_VERB_LABEL[etype] || etype.replace(/_/g, ' ');
                  const meaning = PRED_MEANING[etype];
                  const groupKey = `pred_${etype}`;
                  const isExpanded = !!expandedGroups[groupKey];
                  const SHOW_INITIAL = 8;
                  const sorted = preds.slice().sort((a, b) => b.confidence - a.confidence);
                  const visible = isExpanded ? sorted : sorted.slice(0, SHOW_INITIAL);
                  const hasMore = sorted.length > SHOW_INITIAL;
                  return (
                    <div key={etype} className="kgnd-pred-group">
                      <div className="kgnd-pred-group-head">
                        <span className="kgnd-pred-verb">{verbLabel}</span>
                        <span className="kgnd-pred-sub">
                          {preds.length} candidate{preds.length > 1 ? 's' : ''}
                        </span>
                      </div>
                      {meaning && <p className="kgnd-pred-meaning">{meaning}</p>}
                      {visible.map((p, i) => {
                        const dirSym = p.direction === 'bi' ? '↔' : (p.direction === 'out' ? '→' : '←');
                        return (
                          <div
                            key={i}
                            className="kgnd-pred-row"
                            onClick={() => p.other && onNodeClick && onNodeClick(p.other)}
                            onMouseEnter={() => onHoverEntity && onHoverEntity(p.other)}
                            onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                          >
                            <span className="kgnd-pred-dir">{dirSym}</span>
                            <span className="kgnd-pred-target">{p.other?.label || '?'}</span>
                            <span className="kgnd-pred-conf" title={`Confidence: ${(p.confidence * 100).toFixed(0)}%`}>
                              <span className="kgnd-pred-bar">
                                <span style={{ width: `${p.confidence * 100}%` }} />
                              </span>
                              <span className="kgnd-pred-conf-num">{(p.confidence * 100).toFixed(0)}</span>
                            </span>
                            {p.semantic > 0 && (
                              <span className="kgnd-pred-sem" title={`Research similarity: ${(p.semantic * 100).toFixed(0)}%`}>
                                {(p.semantic * 100).toFixed(0)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {hasMore && (
                        <button
                          className="kgnd-pred-more"
                          onClick={() => setExpandedGroups(g => ({ ...g, [groupKey]: !isExpanded }))}
                        >
                          {isExpanded
                            ? `Show top ${SHOW_INITIAL}`
                            : `Show all ${sorted.length}`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <aside className="kgnd-pred-aside">
                <div className="kgnd-pred-eyebrow">Suggested relationships</div>
                <p className="kgnd-pred-lede">
                  Connections not yet documented in the literature but likely based on
                  shared techniques, benchmarks, citations, and research patterns.
                  Treat these as <strong>research hypotheses</strong>: pairs
                  worth looking at, comparisons worth running, techniques worth checking.
                  Direction is often ambiguous (shown as&nbsp;<span style={{color:'#7c3aed',fontWeight:700}}>↔</span>)
                  because these are inferred from patterns, not explicit claims.
                </p>
                <dl className="kgnd-pred-legend">
                  <div>
                    <dt>Confidence</dt>
                    <dd>how likely this connection is based on shared research context</dd>
                  </div>
                  <div>
                    <dt>Research similarity</dt>
                    <dd>how similar the content of the two papers is</dd>
                  </div>
                </dl>
              </aside>
            </div>
          </div>
        )}

        {/* Description / Table body / Equation / External ref */}
        {(() => {
          // Structured table cells from TEI (preferred)
          if (node.type === 'table' && Array.isArray(node.cells) && node.cells.length > 0) {
            const [head, ...body] = node.cells;
            return (
              <div className="kgnd-table-wrap">
                {node.caption && <div className="kgnd-table-caption">{node.caption}</div>}
                <table className="kgnd-table">
                  <thead><tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                  <tbody>
                    {body.map((r, i) => (
                      <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                {node.paper_id && (
                  <div className="kgnd-table-source">From paper: <strong>{node.paper_id}</strong></div>
                )}
              </div>
            );
          }
          // Equation: render latex monospaced
          if (node.type === 'equation' && node.latex) {
            return <pre className="kgnd-equation">{node.latex}</pre>;
          }
          // External reference: structured citation card
          if (node.type === 'reference') {
            return (
              <div className="kgnd-reference">
                {Array.isArray(node.authors) && node.authors.length > 0 && (
                  <div className="kgnd-ref-authors">{node.authors.join(', ')}</div>
                )}
                <div className="kgnd-ref-title">{node.label}</div>
                <div className="kgnd-ref-meta">
                  {node.year && <span>{node.year}</span>}
                  {node.venue && <span>{node.venue}</span>}
                  {node.doi && <a href={`https://doi.org/${node.doi}`} target="_blank" rel="noreferrer">DOI</a>}
                  {node.arxiv && <a href={`https://arxiv.org/abs/${node.arxiv}`} target="_blank" rel="noreferrer">arXiv</a>}
                </div>
              </div>
            );
          }
          // Author: show institution
          if (node.type === 'author' && node.institution) {
            return <p className="detail-description"><strong>Institution:</strong> {node.institution}</p>;
          }
          // Fallback: legacy markdown parse for pre-TEI tables, else plain text
          if (node.value && node.value !== node.label) {
            const tableRows = node.type === 'table' ? parseMarkdownTable(node.value) : null;
            if (tableRows) {
              const [head, ...body] = tableRows;
              return (
                <div className="kgnd-table-wrap">
                  <table className="kgnd-table">
                    <thead><tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                    <tbody>
                      {body.map((r, i) => (
                        <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {node.paper_id && (
                    <div className="kgnd-table-source">From paper: <strong>{node.paper_id}</strong></div>
                  )}
                </div>
              );
            }
            return (
              <p className="detail-description">
                <HighlightedText text={node.value} termDictionary={termDictionary} query={query} />
              </p>
            );
          }
          return null;
        })()}

        {/* Chip ribbons — Techniques / Benchmarks. Hardware was previously
            duplicated here AND in the spec card; per the no-redundant-info
            rule the spec card carries it (Calli's COMPARE mental model)
            and chips stay for the scan-and-filter affordances. Tufte
            data-ink ratio: don't repeat ink that already exists. */}
        {isPaper && (paperFacts.techniques.length + paperFacts.benchmarks.length) > 0 && (
          <div className="kgnd-ribbons kgnd-slot-left">
            {paperFacts.techniques.length > 0 && (
              <div className="kgnd-ribbon">
                <span className="kgnd-ribbon-label">Techniques</span>
                {/* Sub-grouped by edge type so the user can tell whether
                    something like "Binary CE" is a backbone, a method
                    component, or a loss. Sub-headers are inline pills
                    with a small colon; only renders for groups that have
                    chips. */}
                <div className="kgnd-chip-subgroups">
                  {paperFacts.techniqueGroups.backbone.length > 0 && (
                    <div className="kgnd-chip-subgroup">
                      <span className="kgnd-chip-subgroup-label">Backbone</span>
                      <div className="kgnd-chips">
                        {paperFacts.techniqueGroups.backbone.map((t, i) => (
                          <span key={i} className="kgnd-chip kgnd-chip-tech">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {paperFacts.techniqueGroups.technique.length > 0 && (
                    <div className="kgnd-chip-subgroup">
                      <span className="kgnd-chip-subgroup-label">Technique</span>
                      <div className="kgnd-chips">
                        {paperFacts.techniqueGroups.technique.map((t, i) => (
                          <span key={i} className="kgnd-chip kgnd-chip-tech">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {paperFacts.techniqueGroups.loss.length > 0 && (
                    <div className="kgnd-chip-subgroup">
                      <span className="kgnd-chip-subgroup-label">Loss</span>
                      <div className="kgnd-chips">
                        {paperFacts.techniqueGroups.loss.map((t, i) => (
                          <span key={i} className="kgnd-chip kgnd-chip-tech">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {paperFacts.benchmarks.length > 0 && (
              <div className="kgnd-ribbon">
                <span className="kgnd-ribbon-label">Benchmarks</span>
                <div className="kgnd-chips">
                  {paperFacts.benchmarks.slice(0, 8).map((b, i) => (
                    <span key={i} className="kgnd-chip kgnd-chip-bench">{b}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Narrative block — Contributions / Limitations / Problems
            Addressed. Three-column grid where each bullet is the
            sentence-level claim text the LLM extractor pulled from the
            paper, with the claim-node id available for traceback. This
            is the only narrative-shaped section; everything above is
            table-shaped. */}
        {!isCompact && isPaper && (claimSets.contribution.length + claimSets.limitation.length + claimSets.problem.length) > 0 && (
          <div className="kgnd-narrative kgnd-slot-right">
            {claimSets.contribution.length > 0 && (
              <div className="kgnd-narr-col">
                <div className="kgnd-narr-head">Contributions</div>
                <ul className="kgnd-narr-list">
                  {claimSets.contribution.slice(0, expandedGroups.contribution ? 20 : 4).map((c, i) => (
                    <li key={i} onClick={() => onNodeClick && onNodeClick(c)}>{c.value || c.label}</li>
                  ))}
                </ul>
                {claimSets.contribution.length > 4 && (
                  <button className="kgnd-show-all" onClick={() => toggleGroup('contribution')}>
                    {expandedGroups.contribution ? 'Show less' : `Show all ${claimSets.contribution.length}`}
                  </button>
                )}
              </div>
            )}
            {claimSets.limitation.length > 0 && (
              <div className="kgnd-narr-col">
                <div className="kgnd-narr-head">Limitations</div>
                <ul className="kgnd-narr-list">
                  {claimSets.limitation.slice(0, expandedGroups.limitation ? 20 : 4).map((c, i) => (
                    <li key={i} onClick={() => onNodeClick && onNodeClick(c)}>{c.value || c.label}</li>
                  ))}
                </ul>
                {claimSets.limitation.length > 4 && (
                  <button className="kgnd-show-all" onClick={() => toggleGroup('limitation')}>
                    {expandedGroups.limitation ? 'Show less' : `Show all ${claimSets.limitation.length}`}
                  </button>
                )}
              </div>
            )}
            {claimSets.problem.length > 0 && (
              <div className="kgnd-narr-col">
                <div className="kgnd-narr-head">Problem addressed</div>
                <ul className="kgnd-narr-list">
                  {claimSets.problem.slice(0, expandedGroups.problem ? 20 : 4).map((c, i) => (
                    <li key={i} onClick={() => onNodeClick && onNodeClick(c)}>{c.value || c.label}</li>
                  ))}
                </ul>
                {claimSets.problem.length > 4 && (
                  <button className="kgnd-show-all" onClick={() => toggleGroup('problem')}>
                    {expandedGroups.problem ? 'Show less' : `Show all ${claimSets.problem.length}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Lineage + timeline row. Lineage on the left (citation rows
            with stance), timeline on the right (yearly stance-coded bars).
            Both fall to one column on narrow viewports. */}
        {!isCompact && isPaper && (hasLineage || citeTimeline) && (
          <div className="kgnd-lineage-row kgnd-slot-right">
        {hasLineage && (() => {
          const sc = lineage.stanceCounts || { builds_on: 0, neutral: 0, differs_from: 0 };
          const totalOut = lineage.citesOut.length;
          const renderCite = (n, i, dirArrow) => {
            const key = `cite-${i}-${n.id}`;
            const stance = n.sentiment || 'neutral';
            const ctxExpanded = !!expandedGroups[key];
            const hasCtx = Array.isArray(n.contexts) && n.contexts.length > 0;
            return (
              <div key={key} className={`kgnd-cite-item stance-${stance}`}>
                <div
                  className="kgnd-cite-row"
                  onClick={() => onNodeClick && onNodeClick(n)}
                  onMouseEnter={() => onHoverEntity && onHoverEntity(n)}
                  onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                >
                  <span className="kgnd-cite-arrow">{dirArrow}</span>
                  <span className="kgnd-cite-name">{n.label}</span>
                  <span className={`kgnd-cite-stance stance-${stance}`}>
                    {stance === 'builds_on' ? 'builds on' : stance === 'differs_from' ? 'differs' : 'neutral'}
                  </span>
                  {n.mentions > 1 && (
                    <span className="kgnd-cite-mentions">{n.mentions}×</span>
                  )}
                  {hasCtx && (
                    <button
                      className="kgnd-cite-ctx-btn"
                      onClick={(ev) => { ev.stopPropagation(); toggleGroup(key); }}
                      title="Show in-text context"
                    >{ctxExpanded ? '−' : '“”'}</button>
                  )}
                </div>
                {hasCtx && ctxExpanded && (
                  <div className="kgnd-cite-ctx">
                    <div className="kgnd-cite-ctx-caption">Sentence(s) where this citation occurs — the cited paper appears as one of the bracketed [n] reference markers, not by name.</div>
                    {n.contexts.map((c, j) => (
                      <blockquote key={j} className="kgnd-cite-ctx-quote">{trimToSentence(c)}</blockquote>
                    ))}
                  </div>
                )}
              </div>
            );
          };
          return (
            <div className="kgnd-lineage">
              <div className="kgnd-lineage-title">Paper Lineage <Tooltip text="Each row is a paper in this one's citation chain (the two lists are labelled by direction). The colored tag is that citation's stance: 'builds on' = extends the work, 'differs' = contrasts with it, 'neutral' = references it without taking a side. The N× badge = how many times it's cited in the text — higher means deeper engagement." wide><span className="chart-help">?</span></Tooltip></div>

              {totalOut > 0 && (
                <div className="kgnd-lineage-section">
                  <div className="kgnd-lineage-label">
                    <span className="kgnd-lineage-arrow">&#8592;</span>
                    This paper cites — earlier work ({totalOut})
                  </div>
                  {/* Stance breakdown for outgoing citations */}
                  {(sc.builds_on + sc.differs_from) > 0 && (
                    <div className="kgnd-stance-strip">
                      {sc.builds_on > 0 && <span className="stance-chip stance-builds_on">{sc.builds_on} extends</span>}
                      {sc.neutral > 0 && <span className="stance-chip stance-neutral">{sc.neutral} neutral</span>}
                      {sc.differs_from > 0 && <span className="stance-chip stance-differs_from">{sc.differs_from} contrasts</span>}
                    </div>
                  )}
                  {lineage.citesOut
                    .slice()
                    .sort((a, b) => {
                      const rank = { differs_from: 0, builds_on: 1, neutral: 2 };
                      return (rank[a.sentiment || 'neutral'] - rank[b.sentiment || 'neutral']);
                    })
                    .slice(0, expandedGroups.citesOut ? 20 : 4)
                    .map((n, i) => renderCite(n, i, '\u2190'))}
                  {totalOut > 4 && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup('citesOut')}>
                      {expandedGroups.citesOut ? 'Show less' : `Show all ${totalOut}`}
                    </button>
                  )}
                </div>
              )}

              {lineage.citesIn.length > 0 && (
                <div className="kgnd-lineage-section">
                  <div className="kgnd-lineage-label">
                    <span className="kgnd-lineage-arrow">&#8594;</span>
                    Cited by — later work ({lineage.citesIn.length})
                  </div>
                  {lineage.citesIn
                    .slice(0, expandedGroups.citesIn ? 20 : 4)
                    .map((n, i) => renderCite(n, i + 1000, '\u2192'))}
                  {lineage.citesIn.length > 4 && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup('citesIn')}>
                      {expandedGroups.citesIn ? 'Show less' : `Show all ${lineage.citesIn.length}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Citation timeline — stance-coded yearly bars. Sits next to
            lineage when the panel is wide enough; replaces the old
            one-line hub summary (which left the right of the panel
            empty). Built from cites + cites_external + cited_by_external. */}
        {citeTimeline && (
          <div className="kgnd-cite-time">
            <div className="kgnd-cite-time-eyebrow">Citation activity</div>
            <div className="kgnd-cite-time-bars" aria-hidden>
              {citeTimeline.bars.map((b, i) => {
                const h = (px) => `${(px / citeTimeline.peak) * 100}%`;
                return (
                  <div key={i} className="kgnd-cite-time-bar" title={`${b.year}: ${b.builds_on} extends · ${b.neutral} neutral · ${b.differs_from} contrasts · ${b.external} cited by external`}>
                    {b.builds_on > 0    && <span className="kgnd-cite-time-seg builds_on"    style={{height: h(b.builds_on)}}    />}
                    {b.neutral > 0      && <span className="kgnd-cite-time-seg neutral"      style={{height: h(b.neutral)}}      />}
                    {b.differs_from > 0 && <span className="kgnd-cite-time-seg differs_from" style={{height: h(b.differs_from)}} />}
                    {b.external > 0     && <span className="kgnd-cite-time-seg external"     style={{height: h(b.external)}}     />}
                  </div>
                );
              })}
            </div>
            <div className="kgnd-cite-time-axis">
              <span>{citeTimeline.yMin}</span>
              <span>{citeTimeline.yMax}</span>
            </div>
            <div className="kgnd-cite-time-legend">
              <span><i style={{background:'#16794e'}} /> extends</span>
              <span><i style={{background:'#94a3b8'}} /> neutral</span>
              <span><i style={{background:'#c2410c'}} /> contrasts</span>
              <span><i style={{background:'var(--primary, #185A7C)', opacity: 0.55}} /> cited externally</span>
            </div>
          </div>
        )}
          </div>
        )}

        {/* Connections grouped by RELATION (edge type). The lineage block
            above already covers internal `cites` with stance info, so skip
            that one type here to avoid duplication. Everything else \u2014 every
            paper\u2194paper relation (cited_by_external, outperforms,
            compared_against, semantically_similar, co_cited_with), every
            paper\u2192entity relation (uses_technique, has_table, authored_by,
            etc.) \u2014 appears here as its own collapsible group with the
            actual neighbor rows underneath. */}
        {/* connectionsByRelation only renders for paper / method nodes.
            For non-paper entities the entityDetail block above already
            owns the per-edge-type breakdown; rendering this group set
            would duplicate the same paper list under different titles. */}
        {!isCompact && connectionsByRelation.length > 0 && (node.type === 'paper' || node.type === 'method') && (
          <div className="kgnd-connections kgnd-slot-left">
            {connectionsByRelation.map(([relationType, items]) => {
              if (relationType === 'cites' && hasLineage) return null;
              // Edge types now covered by the dedicated panel sections
              // above — skip them here so the user doesn't see the same
              // info twice in different formats.
              const COVERED_BY_OTHER_BLOCKS = new Set([
                'uses_technique', 'uses_backbone', 'uses_loss',
                'evaluated_on', 'uses_dataset', 'trained_on',
                'uses_hardware',
                'authored_by', 'affiliated_with', 'published_from',
                'contributes', 'has_limitation', 'addresses_problem',
                'outperforms', 'compared_against', 'semantically_similar',
                'described_in',
              ]);
              if (COVERED_BY_OTHER_BLOCKS.has(relationType)) return null;
              const isExpanded = expandedGroups[relationType];
              const showCount = isExpanded ? items.length : INITIAL_SHOW;
              const hasMore = items.length > INITIAL_SHOW;
              const groupTitle = RELATION_TITLES[relationType] || (EDGE_LABELS[relationType] || relationType);
              // Color the group dot by the dominant node type in the group
              // (most rows in a paper-cites-paper group are paper-typed,
              // so the color stays meaningful).
              const dominantNodeType = items[0]?.node?.type || 'other';
              return (
                <div key={relationType} className="kgnd-group">
                  <div className="kgnd-group-head" onClick={() => hasMore && toggleGroup(relationType)} style={{ cursor: hasMore ? 'pointer' : 'default' }}>
                    <span className="kgnd-group-dot" style={{ background: TYPE_COLORS[dominantNodeType] || '#8691a0' }} />
                    <span className="kgnd-group-title">{groupTitle}</span>
                    <span className="kgnd-group-n">{items.length}</span>
                    {hasMore && <span className="kgnd-group-toggle">{isExpanded ? '\u25BE' : '\u25B8'}</span>}
                  </div>
                  {items.slice(0, showCount).map(({ node: n, edge, direction }, i) => {
                    // Direction-aware verb: "cited by external" reads
                    // differently when this node is the citer vs. the
                    // cited. We only flip the label when the relation is
                    // asymmetric and we're on the receiving end.
                    let verb = EDGE_LABELS[relationType] || relationType;
                    if (direction === 'in') {
                      if (relationType === 'cites' || relationType === 'cites_external') verb = 'cited by';
                      else if (relationType === 'outperforms') verb = 'outperformed by';
                      else if (relationType === 'cited_by_external') verb = 'cites this';
                      else if (relationType === 'authored_by') verb = 'wrote';
                    }
                    // Provenance for outperforms: surface the metric name
                    // and margin so the row carries why the model thinks
                    // so, not just the bare claim.
                    const metricNote = edge?.metric ? ` \u00B7 ${edge.metric}` : '';
                    return (
                      <div
                        key={i}
                        className="kgnd-conn"
                        onClick={() => onNodeClick && onNodeClick(n)}
                        onMouseEnter={() => onHoverEntity && onHoverEntity(n)}
                        onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                      >
                        <span className="metadata-key">{verb}{metricNote}</span>
                        <span className="metadata-val">{n.label}</span>
                      </div>
                    );
                  })}
                  {hasMore && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup(relationType)}>
                      {isExpanded ? 'Show less' : `Show all ${items.length}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Observed neighbors from the full KG that aren't currently rendered
            in this view. Collapsed by default — earlier this dumped 200+
            rows into the panel and dominated the layout. Now it shows
            a single header pill with the count; click to expand into
            the full grouped breakdown. */}
        {needsFullKgLookup && (
          <div className="kgnd-observed">
            <div
              className="kgnd-observed-head"
              onClick={() => toggleGroup('observedFullKg')}
              style={{ cursor: 'pointer' }}
            >
              <span className="kgnd-observed-title">Observed in the full KG</span>
              {fullKgLoading && <span className="kgnd-observed-status">loading…</span>}
              {!fullKgLoading && fullKgInfo && (
                <span className="kgnd-observed-status">
                  {observedExtraTotal} not in this view {expandedGroups.observedFullKg ? '▾' : '▸'}
                </span>
              )}
            </div>
            {!fullKgLoading && fullKgInfo && observedExtraTotal === 0 && (
              <div className="kgnd-observed-empty">All observed neighbors are already shown in this view.</div>
            )}
            {!fullKgLoading && expandedGroups.observedFullKg && observedExtra && observedExtra.length > 0 && (
              <div className="kgnd-connections">
                {observedExtra.map(([type, rows]) => {
                  const groupKey = `obs-${type}`;
                  const isExpanded = expandedGroups[groupKey];
                  const showCount = isExpanded ? rows.length : INITIAL_SHOW;
                  const hasMore = rows.length > INITIAL_SHOW;
                  return (
                    <div key={groupKey} className="kgnd-group">
                      <div className="kgnd-group-head" onClick={() => hasMore && toggleGroup(groupKey)} style={{ cursor: hasMore ? 'pointer' : 'default' }}>
                        <span className="kgnd-group-dot" style={{ background: TYPE_COLORS[type] || '#8691a0' }} />
                        <span className="kgnd-group-title">{TYPE_LABELS[type] || type}</span>
                        <span className="kgnd-group-n">{rows.length}</span>
                        {hasMore && <span className="kgnd-group-toggle">{isExpanded ? '▾' : '▸'}</span>}
                      </div>
                      {rows.slice(0, showCount).map((row, i) => {
                        const edgeLabel = EDGE_LABELS[row.edge?.type] || row.edge?.type || '';
                        return (
                          <div
                            key={i}
                            className="kgnd-conn"
                            onMouseEnter={() => onHoverEntity && onHoverEntity(row.other)}
                            onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                          >
                            <span className="metadata-key">{edgeLabel}</span>
                            <span className="metadata-val">{row.other.label}</span>
                          </div>
                        );
                      })}
                      {hasMore && (
                        <button className="kgnd-show-all" onClick={() => toggleGroup(groupKey)}>
                          {isExpanded ? 'Show less' : `Show all ${rows.length}`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Provenance footer — Harrison's lab consistently surfaces
            "how was this assembled" in the UI rather than tooltips.
            One thin strip with: observed vs predicted edge counts and
            avg confidence. Always visible, always last. */}
        <div className="kgnd-provenance">
          <span className="kgnd-prov-item">
            <span className="kgnd-prov-key">documented connections</span>
            <span className="kgnd-prov-val">{provenance.observed}</span>
          </span>
          {provenance.predicted > 0 && (
            <span className="kgnd-prov-item">
              <span className="kgnd-prov-key">suggested</span>
              <span className="kgnd-prov-val">{provenance.predicted}</span>
            </span>
          )}
          {provenance.avgConf !== null && (
            <span className="kgnd-prov-item">
              <span className="kgnd-prov-key">avg. confidence</span>
              <span className="kgnd-prov-val">{Math.round(provenance.avgConf * 100)}%</span>
            </span>
          )}
          {paperFacts.meta?.year && (
            <span className="kgnd-prov-item">
              <span className="kgnd-prov-key">paper</span>
              <span className="kgnd-prov-val">{node.paper_id || node.id}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
