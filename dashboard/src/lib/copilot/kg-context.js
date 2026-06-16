// Copilot knowledge-graph context. Extracted verbatim from ai-pipeline.js step 4
// (behaviour-preserving). The current serialization collapses the subgraph to
// per-edge-type COUNTS; the follow-up replaces that with resolved triples
// (subject —relation→ object) plus quotable contribution/comparison text, which
// is why this lives in its own unit-testable module.
import { initGraph, extractSubgraph } from '../kg-graph';

// Resolve the highlighted methods to their papers, extract the surrounding
// subgraph, and render an LLM-facing context string + the raw traversal (used
// by the graph-viz UI and the traversal narrative). Returns { kgContext,
// kgTraversal } — kgContext is '' when no method resolves to a paper.
export function buildKgContext(kgData, highlightMethods) {
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
  const sid = l => (l.source && l.source.id) || l.source;
  const tid = l => (l.target && l.target.id) || l.target;
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

  if (paperIds.length > 0) {
    const subgraph = extractSubgraph(paperIds);
    kgTraversal = [{
      step: 'subgraph',
      description: `Extracted subgraph around ${paperIds.length} papers`,
      detail: `${subgraph.nodes.length} nodes, ${subgraph.links.length} edges`,
      edges: subgraph.links,
      nodes: subgraph.nodes,
    }];

    // Build structured KG context
    const edgesByType = {};
    subgraph.links.forEach(e => {
      if (!edgesByType[e.type]) edgesByType[e.type] = [];
      edgesByType[e.type].push(e);
    });
    const contextParts = Object.entries(edgesByType).map(([type, edges]) =>
      `${type}: ${edges.length} relationships`
    );
    kgContext = contextParts.join('\n');
  }

  return { kgContext, kgTraversal };
}
