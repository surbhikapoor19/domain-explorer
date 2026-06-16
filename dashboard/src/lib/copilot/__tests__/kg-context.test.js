/* Copilot KG context — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * CONTRACT (TDD — these tests are EXPECTED TO FAIL until the implementation lands):
 *   The kgContext string must be RESOLVED TRIPLES, not an edge-type histogram.
 *   The current bug emits lines like "uses_backbone: 3 relationships" — an integer
 *   count with zero usable signal. The replacement renders subgraph.nodes +
 *   subgraph.links into triples of the form  SUBJECTLABEL -EDGETYPE-> OBJECTLABEL
 *   plus quotable contribution/comparison claim text.
 *
 * Units under test (both pure JS — no component rendering needed):
 *   1) serializeSubgraph(subgraph, highlightLabels = [], opts = {})  — pure
 *   2) buildKgContext(kgData, highlightMethods, opts = {})           — delegates to (1)
 *
 * Field names verified against:
 *   - src/lib/kg-graph.js  (subgraph node = {id,label,type,value,...};
 *     link = {source,target,type}; source/target are string ids in the
 *     materialized subgraph, but link.source/target MAY be an object with .id
 *     in raw kgData — the sid/tid helpers in kg-context.js handle both)
 *   - public/data-grasp-planning/kg-full.json  (real edge types include
 *     uses_backbone, outperforms, compares, contributes, evaluated_on,
 *     uses_dataset, requires_input, described_in; node types contribution &
 *     comparison carry a `value` string)
 */
import { serializeSubgraph, buildKgContext } from '../kg-context';

// ── Synthetic subgraph (NO real KG). Mirrors the materialized shape from
// extractSubgraph(): nodes carry {id,label,type,value}; links carry
// {source,target,type} as STRING ids. ─────────────────────────────────────────
const SUBGRAPH = {
  nodes: [
    { id: 'm1', label: 'VGN', type: 'method' },
    { id: 'b1', label: 'PointNet++', type: 'entity' },
    { id: 'p1', label: 'paperA', type: 'paper' },
    { id: 'c1', type: 'contribution', value: 'end-to-end grasp network' },
  ],
  links: [
    { source: 'm1', target: 'b1', type: 'uses_backbone' },
    { source: 'm1', target: 'p1', type: 'described_in' },
    { source: 'p1', target: 'c1', type: 'contributes' },
  ],
};

// ── serializeSubgraph: triples, not counts ────────────────────────────────────

describe('serializeSubgraph — resolved triples', () => {
  test('renders a link as a single SUBJECT -EDGETYPE-> OBJECT triple line', () => {
    const out = serializeSubgraph(SUBGRAPH, []);
    // VGN -uses_backbone-> PointNet++  must appear on ONE line, with both labels
    // resolved from the nodeId→label map and the edge type between them.
    const lines = out.split('\n');
    const tripleLine = lines.find(
      (l) => l.includes('VGN') && l.includes('PointNet++') && l.includes('uses_backbone')
    );
    expect(tripleLine).toBeDefined();
    // The exact triple shape required by the contract.
    expect(out).toContain('VGN -uses_backbone-> PointNet++');
  });

  test('surfaces quotable contribution value text on its own line', () => {
    const out = serializeSubgraph(SUBGRAPH, []);
    expect(out).toContain('end-to-end grasp network');
  });

  test('MUST NOT contain the word "relationships" and MUST NOT be bare counts', () => {
    const out = serializeSubgraph(SUBGRAPH, []);
    expect(out).not.toMatch(/relationships/i);
    // The buggy histogram emitted lines like "uses_backbone: 3"; a resolved
    // triple line for that edge type must instead carry the arrow form.
    expect(out).not.toMatch(/uses_backbone:\s*\d+/);
  });

  test('resolves object-form source/target ({id:...}) to labels', () => {
    const objSubgraph = {
      nodes: SUBGRAPH.nodes,
      links: [
        { source: { id: 'm1' }, target: { id: 'b1' }, type: 'uses_backbone' },
      ],
    };
    const out = serializeSubgraph(objSubgraph, []);
    expect(out).toContain('VGN -uses_backbone-> PointNet++');
    // No raw ids should leak through when a label exists.
    expect(out).not.toContain('m1 -uses_backbone-> b1');
  });

  test('is a PURE function — does not mutate its inputs', () => {
    const snapshot = JSON.stringify(SUBGRAPH);
    serializeSubgraph(SUBGRAPH, ['VGN']);
    expect(JSON.stringify(SUBGRAPH)).toBe(snapshot);
  });

  test('returns a string for an empty subgraph without throwing', () => {
    expect(typeof serializeSubgraph({ nodes: [], links: [] }, [])).toBe('string');
  });
});

// ── serializeSubgraph: capping + prioritization ───────────────────────────────

describe('serializeSubgraph — opts.maxLines cap and prioritization', () => {
  // A large subgraph: 1 highlighted-incident high-signal edge + many low-signal
  // edges. The cap must keep the highlighted/high-signal triple and drop excess.
  const BIG = {
    nodes: [
      { id: 'm1', label: 'VGN', type: 'method' },
      { id: 'b1', label: 'PointNet++', type: 'entity' },
      { id: 'd1', label: 'YCB', type: 'dataset' },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `x${i}`,
        label: `Filler${i}`,
        type: 'entity',
      })),
    ],
    links: [
      { source: 'm1', target: 'b1', type: 'uses_backbone' }, // high-signal, incident to VGN
      { source: 'm1', target: 'd1', type: 'evaluated_on' }, // high-signal, incident to VGN
      ...Array.from({ length: 40 }, (_, i) => ({
        source: `x${i}`,
        target: `x${(i + 1) % 40}`,
        type: 'co_cited_with', // low-signal noise
      })),
    ],
  };

  test('caps output to opts.maxLines', () => {
    const out = serializeSubgraph(BIG, ['VGN'], { maxLines: 5 });
    const nonEmpty = out.split('\n').filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(5);
  });

  test('prioritizes edges incident to a highlighted-label node under a tight cap', () => {
    const out = serializeSubgraph(BIG, ['VGN'], { maxLines: 3 });
    // The VGN-incident high-signal triples must survive the cull ahead of the
    // 40 co_cited_with filler edges.
    expect(out).toContain('VGN -uses_backbone-> PointNet++');
    expect(out).toContain('VGN -evaluated_on-> YCB');
  });

  test('defaults the cap to roughly 18 lines when opts.maxLines is omitted', () => {
    const out = serializeSubgraph(BIG, ['VGN']);
    const nonEmpty = out.split('\n').filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(18);
  });
});

// ── buildKgContext: delegates to serializeSubgraph + keeps traversal shape ─────

// Minimal raw kgData the implementation can traverse. method VGN -described_in->
// paperA so method→paper resolution succeeds; the rest feeds the subgraph.
const KG_DATA = {
  nodes: [
    { id: 'method:vgn', label: 'VGN', type: 'method' },
    { id: 'paper:paperA', label: 'paperA', type: 'paper', paper_id: 'paperA' },
    { id: 'tech:backbone:PointNet++', label: 'PointNet++', type: 'technique' },
    { id: 'contribution:c1', type: 'contribution', value: 'end-to-end grasp network' },
  ],
  links: [
    { source: 'method:vgn', target: 'paper:paperA', type: 'described_in' },
    { source: 'paper:paperA', target: 'tech:backbone:PointNet++', type: 'uses_backbone' },
    { source: 'paper:paperA', target: 'contribution:c1', type: 'contributes' },
  ],
};

describe('buildKgContext — uses serializeSubgraph for kgContext', () => {
  test('kgContext is resolved triples, never a count histogram', () => {
    const { kgContext } = buildKgContext(KG_DATA, ['VGN']);
    expect(kgContext).not.toMatch(/relationships/i);
    expect(kgContext).not.toMatch(/uses_backbone:\s*\d+/);
    // A real resolved triple from the traversed subgraph.
    expect(kgContext).toMatch(/PointNet\+\+/);
    expect(kgContext).toContain('-uses_backbone->');
  });

  test('kgContext surfaces the quotable contribution claim text', () => {
    const { kgContext } = buildKgContext(KG_DATA, ['VGN']);
    expect(kgContext).toContain('end-to-end grasp network');
  });

  test('keeps the kgTraversal return shape identical (step/description/detail/edges/nodes)', () => {
    const { kgTraversal } = buildKgContext(KG_DATA, ['VGN']);
    expect(Array.isArray(kgTraversal)).toBe(true);
    expect(kgTraversal.length).toBeGreaterThan(0);
    const step = kgTraversal[0];
    expect(step).toHaveProperty('step', 'subgraph');
    expect(step).toHaveProperty('description');
    expect(step).toHaveProperty('detail');
    expect(step).toHaveProperty('edges');
    expect(step).toHaveProperty('nodes');
    expect(Array.isArray(step.edges)).toBe(true);
    expect(Array.isArray(step.nodes)).toBe(true);
  });

  test('returns empty context (no traversal) when kgData has no nodes', () => {
    const { kgContext, kgTraversal } = buildKgContext({ nodes: [], links: [] }, ['VGN']);
    expect(kgContext).toBe('');
    expect(kgTraversal).toEqual([]);
  });
});

describe('buildKgContext — opts.seedPaperIds fallback', () => {
  // kgData with NO method→paper edge and a non-matching method name, so method
  // resolution yields ZERO papers. seedPaperIds must rescue the traversal.
  const KG_NO_RESOLVE = {
    nodes: [
      { id: 'method:other', label: 'SomethingElse', type: 'method' },
      { id: 'paper:paperA', label: 'paperA', type: 'paper', paper_id: 'paperA' },
      { id: 'tech:backbone:PointNet++', label: 'PointNet++', type: 'technique' },
    ],
    links: [
      { source: 'paper:paperA', target: 'tech:backbone:PointNet++', type: 'uses_backbone' },
    ],
  };

  test('falls back to opts.seedPaperIds when method→paper resolution yields no papers', () => {
    const { kgContext, kgTraversal } = buildKgContext(
      KG_NO_RESOLVE,
      ['VGN'],
      { seedPaperIds: ['paperA'] }
    );
    // With the seed, the subgraph around paperA is extracted and serialized.
    expect(kgTraversal.length).toBeGreaterThan(0);
    expect(kgContext).toContain('-uses_backbone->');
    expect(kgContext).toContain('PointNet++');
  });

  test('without seedPaperIds, an unresolvable query produces no context', () => {
    const { kgContext, kgTraversal } = buildKgContext(KG_NO_RESOLVE, ['VGN']);
    expect(kgContext).toBe('');
    expect(kgTraversal).toEqual([]);
  });
});
