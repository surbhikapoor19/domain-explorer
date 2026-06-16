// Copilot knowledge-graph context. Extracted verbatim from ai-pipeline.js step 4
// (behaviour-preserving). The current serialization collapses the subgraph to
// per-edge-type COUNTS; this replaces that with resolved triples
// (subject -relation-> object) plus quotable contribution/comparison text, which
// is why this lives in its own unit-testable module.
import { initGraph, extractSubgraph } from '../kg-graph';

// link.source / link.target may be a bare string id OR an object carrying an
// `.id` field (raw kgData uses the latter; the materialized subgraph uses the
// former). Mirror the sid/tid helpers used elsewhere so both forms resolve.
const sid = (l) => (l.source && l.source.id) || l.source;
const tid = (l) => (l.target && l.target.id) || l.target;

// Edge types that carry real reasoning signal — prioritized when capping.
const HIGH_SIGNAL_EDGES = new Set([
  'outperforms', 'compares', 'contributes', 'uses_backbone', 'uses_loss',
  'evaluated_on', 'uses_dataset', 'requires_input', 'described_in',
]);

// Node types that carry quotable claim text in their `value` field. The raw KG
// uses 'contribution'/'comparison'; extractSubgraph viz-renames both to 'claim'
// (preserving the original under `subtype`), so accept that too.
const CLAIM_NODE_TYPES = new Set(['contribution', 'comparison', 'claim']);

const DEFAULT_MAX_LINES = 18;

/**
 * Render subgraph.nodes + subgraph.links into the LLM-facing kgContext string as
 * RESOLVED TRIPLES (subject -edgetype-> object) plus quotable contribution /
 * comparison claim text. Pure: never mutates its inputs.
 *
 * @param {{nodes:Array, links:Array}} subgraph
 * @param {string[]} highlightLabels  labels whose incident edges are prioritized
 * @param {{maxLines?:number}} opts
 * @returns {string}
 */
export function serializeSubgraph(subgraph, highlightLabels = [], opts = {}) {
  if (!subgraph || !Array.isArray(subgraph.nodes) || !Array.isArray(subgraph.links)) {
    return '';
  }
  const maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : DEFAULT_MAX_LINES;

  // nodeId -> label map (fall back to the id when no label exists).
  const labelById = new Map();
  for (const n of subgraph.nodes) {
    if (n && n.id != null) labelById.set(n.id, (n.label != null && n.label !== '') ? n.label : n.id);
  }
  const labelOf = (id) => (labelById.has(id) ? labelById.get(id) : id);

  // Set of highlighted labels (case-insensitive) for prioritization.
  const highlightSet = new Set(
    (highlightLabels || []).map((l) => String(l).toLowerCase().trim())
  );
  const isHighlightedLabel = (label) =>
    highlightSet.has(String(label).toLowerCase().trim());

  // Score each edge so the cap keeps the most useful triples:
  //   +2 if incident to a highlighted-label node
  //   +1 if a high-signal edge type
  // Higher score sorts first; ties keep original order (stable).
  const edgeItems = [];
  subgraph.links.forEach((l, idx) => {
    const s = sid(l);
    const t = tid(l);
    if (s == null || t == null) return;
    const subjLabel = labelOf(s);
    const objLabel = labelOf(t);
    let score = 0;
    if (isHighlightedLabel(subjLabel) || isHighlightedLabel(objLabel)) score += 2;
    if (HIGH_SIGNAL_EDGES.has(l.type)) score += 1;
    edgeItems.push({
      line: `${subjLabel} -${l.type}-> ${objLabel}`,
      score,
      idx,
    });
  });
  edgeItems.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  // Quotable claim text from contribution / comparison nodes.
  const claimItems = [];
  subgraph.nodes.forEach((n, idx) => {
    if (n && CLAIM_NODE_TYPES.has(n.type) && n.value != null && String(n.value).trim() !== '') {
      claimItems.push({ line: String(n.value).trim(), idx });
    }
  });

  // Edges first (they are the structural backbone), then claim text, capped.
  const lines = [...edgeItems.map((e) => e.line), ...claimItems.map((c) => c.line)];
  return lines.slice(0, maxLines).join('\n');
}

// Resolve the highlighted methods to their papers, extract the surrounding
// subgraph, and render an LLM-facing context string + the raw traversal (used
// by the graph-viz UI and the traversal narrative). Returns { kgContext,
// kgTraversal } — kgContext is '' when no method resolves to a paper.
export function buildKgContext(kgData, highlightMethods, opts = {}) {
  let kgContext = '';
  let kgTraversal = [];
  if (!kgData || !kgData.nodes || !kgData.nodes.length) return { kgContext, kgTraversal };

  initGraph(kgData);
  // Resolve the query's methods to their papers via method -> described_in ->
  // paper edges (precise), instead of a letters-only label substring that
  // mis-linked short names / acronyms. Fall back to a TIGHTENED (>=4 char)
  // label match only if no edge is found.
  const methodNames = highlightMethods.slice(0, 5);
  const wanted = new Set(methodNames.map(m => m.toLowerCase().trim()));
  const methodNodeIds = new Set(
    kgData.nodes.filter(n => n.type === 'method' && wanted.has((n.label || '').toLowerCase().trim())).map(n => n.id)
  );
  let paperIds = (kgData.links || [])
    .filter(l => l.type === 'described_in' && methodNodeIds.has(sid(l)))
    .map(l => tid(l));
  if (!paperIds.length) {
    paperIds = kgData.nodes.filter(n => n.type === 'paper' && methodNames.some(m => {
      const c = m.toLowerCase().replace(/[^a-z0-9]/g, '');
      return c.length >= 4 && (n.label || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(c);
    })).map(n => n.id);
  }

  // Resolve paper node ids to the unprefixed ids extractSubgraph expects
  // (it re-prefixes with "paper:"). Fall back to the caller-provided
  // seedPaperIds when method->paper resolution yields nothing.
  let seedIds = paperIds
    .map(pid => {
      const node = kgData.nodes.find(n => n.id === pid);
      return (node && node.paper_id) || (typeof pid === 'string' ? pid.replace(/^paper:/, '') : pid);
    });
  if (!seedIds.length && Array.isArray(opts.seedPaperIds) && opts.seedPaperIds.length) {
    seedIds = opts.seedPaperIds.slice();
  }

  if (seedIds.length > 0) {
    const subgraph = extractSubgraph(seedIds);
    if (subgraph.nodes.length || subgraph.links.length) {
      kgTraversal = [{
        step: 'subgraph',
        description: `Extracted subgraph around ${seedIds.length} papers`,
        detail: `${subgraph.nodes.length} nodes, ${subgraph.links.length} edges`,
        edges: subgraph.links,
        nodes: subgraph.nodes,
      }];

      // Render resolved triples + quotable claim text (no count histogram).
      kgContext = serializeSubgraph(subgraph, methodNames, opts);
    }
  }

  return { kgContext, kgTraversal };
}
