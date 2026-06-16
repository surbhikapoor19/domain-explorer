/**
 * Client-side KG traversal — mirrors backend/app.py::get_kg_subgraph()
 * exactly so the dashboard's static-data path returns the same focused
 * subgraph the live API used to. Any divergence here = orphans on screen.
 */
import Graph from 'graphology';

let graph = null;

export function initGraph(kgData) {
  graph = new Graph({ multi: true, type: 'directed' });
  for (const node of (kgData.nodes || [])) {
    if (!graph.hasNode(node.id)) graph.addNode(node.id, node);
  }
  for (const edge of (kgData.links || [])) {
    const src = typeof edge.source === 'object' ? edge.source.id : edge.source;
    const tgt = typeof edge.target === 'object' ? edge.target.id : edge.target;
    if (graph.hasNode(src) && graph.hasNode(tgt)) {
      graph.addEdge(src, tgt, { type: edge.type, ...edge });
    }
  }
  return graph;
}

// Mirrors backend INTENT_CONFIG. Each intent re-weights what gets pulled into
// the focused subgraph so a "comparison" query brings in outperforms/cites
// edges + comparison claims, while a "hardware" query brings in hardware
// nodes + uses_hardware/trained_on edges.
const INTENT_CONFIG = {
  comparison: {
    structural: new Set(['paper', 'method', 'technique']),
    claim_edges: new Set(['compares', 'outperforms', 'contributes']),
    max_claims: 8,
  },
  limitation: {
    structural: new Set(['paper', 'method', 'technique']),
    claim_edges: new Set(['has_limitation', 'addresses_problem', 'contributes']),
    max_claims: 10,
  },
  hardware: {
    structural: new Set(['paper', 'method', 'technique', 'hardware']),
    claim_edges: new Set(['contributes', 'compares']),
    max_claims: 5,
  },
  technical: {
    structural: new Set(['paper', 'method', 'technique']),
    claim_edges: new Set(['contributes', 'implements_step', 'addresses_problem']),
    max_claims: 8,
  },
  evaluation: {
    structural: new Set(['paper', 'method', 'technique', 'hardware']),
    claim_edges: new Set(['compares', 'outperforms', 'contributes']),
    max_claims: 8,
  },
};

const DEFAULT_CFG = {
  structural: new Set(['paper', 'method', 'technique', 'hardware']),
  claim_edges: new Set(['has_limitation', 'compares', 'contributes', 'addresses_problem']),
  max_claims: 5,
};

const FALLBACK_CLAIM_EDGES = new Set([
  'has_limitation', 'compares', 'contributes', 'addresses_problem',
]);

const CLAIM_VIZ_TYPES = new Set([
  'contribution', 'comparison', 'limitation', 'problem',
]);

function nodeAttrs(g, id) {
  return g.hasNode(id) ? g.getNodeAttributes(id) : {};
}

/**
 * Build the focused subgraph for a query. paperIds are unprefixed (e.g.
 * "dex-net"); we resolve them to the canonical "paper:<id>" node in the KG.
 *
 *   1-hop: queried paper + neighbors whose type is in cfg.structural
 *   2-hop via shared techniques: every paper that uses a technique used by
 *     a queried paper + that paper's method
 *   2-hop via citations: papers cited by / citing a queried paper
 *   Claims: up to cfg.max_claims per queried paper, prioritized by
 *     cfg.claim_edges and falling back to FALLBACK_CLAIM_EDGES
 *
 * Then every edge whose endpoints are both in the relevant set is kept,
 * with viz-friendly node renaming (contribution|comparison|… → claim).
 */
export function extractSubgraph(paperIds, intent = 'general') {
  const g = graph;
  if (!g) return { nodes: [], links: [], stats: { n_nodes: 0, n_links: 0 } };

  const cfg = INTENT_CONFIG[intent] || DEFAULT_CFG;
  const STRUCTURAL = cfg.structural;
  const CLAIM_EDGES = cfg.claim_edges;
  const MAX_CLAIMS = cfg.max_claims;

  const relevant = new Set();
  const paperNodes = paperIds
    .map(pid => `paper:${pid}`)
    .filter(p => g.hasNode(p));

  // 1-hop structural neighbors
  for (const paperNode of paperNodes) {
    relevant.add(paperNode);
    g.forEachNeighbor(paperNode, (nb) => {
      if (STRUCTURAL.has(nodeAttrs(g, nb).type)) relevant.add(nb);
    });
  }

  // 2-hop via shared techniques: every paper that touches a technique
  // already in `relevant` gets pulled in, along with its method node.
  const queriedTechniques = new Set();
  relevant.forEach(nid => {
    if (nodeAttrs(g, nid).type === 'technique') queriedTechniques.add(nid);
  });
  queriedTechniques.forEach(techNode => {
    g.forEachInNeighbor(techNode, (pred) => {
      if (nodeAttrs(g, pred).type !== 'paper') return;
      relevant.add(pred);
      g.forEachInNeighbor(pred, (p2) => {
        if (nodeAttrs(g, p2).type === 'method') relevant.add(p2);
      });
    });
  });

  // 2-hop via citations: papers cited by / citing a queried paper
  for (const paperNode of paperNodes) {
    g.forEachOutEdge(paperNode, (_e, attrs, _s, target) => {
      if (attrs.type === 'cites') relevant.add(target);
    });
    g.forEachInEdge(paperNode, (_e, attrs, source) => {
      if (attrs.type === 'cites') relevant.add(source);
    });
  }

  // Claims, prioritized by intent then backfilled from a fixed fallback set,
  // capped at MAX_CLAIMS per paper.
  for (const paperNode of paperNodes) {
    let claimCount = 0;
    g.forEachOutEdge(paperNode, (_e, attrs, _s, target) => {
      if (claimCount >= MAX_CLAIMS) return;
      if (CLAIM_EDGES.has(attrs.type)) {
        if (!relevant.has(target)) {
          relevant.add(target);
          claimCount += 1;
        } else {
          claimCount += 1; // count it even if already added, matches backend
        }
      }
    });
    g.forEachOutEdge(paperNode, (_e, attrs, _s, target) => {
      if (claimCount >= MAX_CLAIMS) return;
      if (FALLBACK_CLAIM_EDGES.has(attrs.type) && !relevant.has(target)) {
        relevant.add(target);
        claimCount += 1;
      }
    });
  }

  // Materialize nodes — viz-rename claim subtypes, copy per-type body fields
  // so KGNodeDetail can render tables/equations/references inline.
  const nodes = [];
  relevant.forEach(nid => {
    if (!g.hasNode(nid)) return;
    const nd = g.getNodeAttributes(nid);
    const ntype = nd.type || '';
    const vizType = CLAIM_VIZ_TYPES.has(ntype) ? 'claim' : ntype;
    let degree = 0;
    g.forEachNeighbor(nid, (n) => { if (relevant.has(n)) degree += 1; });
    const valRaw = nd.value || '';
    const valField = ['table', 'figure', 'equation'].includes(ntype)
      ? valRaw
      : valRaw.slice(0, 100);
    const node = {
      id: nid,
      label: nd.label || (nid.split(':').pop()),
      type: vizType,
      subtype: nd.subtype || nd.original_type || ntype,
      value: valField,
      section: nd.section || '',
      paper_id: nd.paper_id || '',
      degree,
    };
    if (ntype === 'table' && nd.cells) {
      node.cells = nd.cells;
      node.caption = nd.caption || '';
    }
    if (ntype === 'equation' && nd.latex) node.latex = nd.latex;
    if (ntype === 'reference') {
      node.year = nd.year || '';
      node.authors = nd.authors || [];
      node.venue = nd.venue || '';
    }
    if (ntype === 'author') node.institution = nd.institution || '';
    nodes.push(node);
  });

  // Edges: keep every edge whose endpoints are both relevant. Dedup by
  // (source, target) pair so multi-edges don't clutter the canvas — this
  // matches the backend's behavior of one link per pair.
  const links = [];
  const seen = new Set();
  g.forEachEdge((_e, attrs, src, tgt) => {
    if (!relevant.has(src) || !relevant.has(tgt)) return;
    const key = `${src}|${tgt}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      source: src,
      target: tgt,
      type: attrs.type || '',
      inferred: !!attrs.inferred,
    });
  });

  return { nodes, links, stats: { n_nodes: nodes.length, n_links: links.length } };
}
