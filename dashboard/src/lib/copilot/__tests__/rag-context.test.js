/* Copilot RAG context — AUTHORED BY ORCHESTRATOR (TEST AUTHOR). Implementers must NOT modify.
 *
 * Encodes the CONTRACT for rag-context.js:
 *   1) formatRagContext(chunks): up to 6 chunks → ragText with RANK-AWARE caps.
 *      Ranks 1-3 keep up to 1500 chars of chunk.text; ranks 4-6 up to 900 chars.
 *      ragCitations is unchanged (full_text full, snippet 200).
 *   2) buildMethodSummaries(methods, opts): opts.limit caps output lines (default: no cap);
 *      opts.prioritize stable-sorts named methods to the front; both default to current behavior.
 *   3) DEFAULT_SUMMARY_COLUMNS and DEFAULT_SHORT_NAMES remain exported.
 *
 * This file is EXPECTED TO FAIL until the implementation lands (TDD). Do not weaken.
 */
import {
  formatRagContext,
  buildMethodSummaries,
  DEFAULT_SUMMARY_COLUMNS,
  DEFAULT_SHORT_NAMES,
} from '../rag-context';

// ---- helpers --------------------------------------------------------------

// A chunk whose text is exactly `len` chars, made of a repeated marker so we can
// both measure length and detect mid-sentence truncation precisely.
const makeChunk = (len, { paper = 'Paper', section = 'Methods', score = 0.5, idChar = 'x' } = {}) => ({
  text: idChar.repeat(len),
  score,
  metadata: { paper_title: paper, section, paper_id: paper + '-id' },
});

// Extract just the body text of each rendered chunk block in ragText. Each block is
// `[header] (relevance: X)\n<body>`; blocks are joined by '\n\n'. We split on the
// header line to isolate bodies robustly regardless of body content.
const bodiesOf = (ragText) =>
  ragText
    .split(/\[[^\]]*\] \(relevance: [^)]*\)\n/)
    .slice(1) // first split element is '' before the first header
    .map((b) => b.replace(/\n\n$/, '').replace(/\n*$/, ''));

// ===========================================================================
// CONTRACT 1: formatRagContext — rank-aware caps + unchanged citations
// ===========================================================================

describe('formatRagContext — rank-aware caps on ragText', () => {
  test('empty / missing input yields empty ragText and no citations', () => {
    expect(formatRagContext(null)).toEqual({ ragText: '', ragCitations: [] });
    expect(formatRagContext([])).toEqual({ ragText: '', ragCitations: [] });
  });

  test('a 1200-char chunk at rank 1 appears IN FULL (not cut to 400)', () => {
    const { ragText } = formatRagContext([makeChunk(1200, { idChar: 'a' })]);
    // The full 1200-char body must be present verbatim.
    expect(ragText).toContain('a'.repeat(1200));
    // Regression guard: the 401st char survives — i.e. the old 400-char cap is gone.
    expect(ragText).toContain('a'.repeat(401));
  });

  test('rank 1 keeps the FULL 1200 chars — explicit length check on the body', () => {
    const { ragText } = formatRagContext([makeChunk(1200, { idChar: 'a' })]);
    const [body] = bodiesOf(ragText);
    expect(body.length).toBe(1200); // not 400
  });

  test('a 3000-char chunk at rank 1 is capped at 1500 or fewer chars', () => {
    const { ragText } = formatRagContext([makeChunk(3000, { idChar: 'b' })]);
    const [body] = bodiesOf(ragText);
    expect(body.length).toBeLessThanOrEqual(1500);
    // It must include the leading 1500 chars (cap, not a smaller truncation).
    expect(ragText).toContain('b'.repeat(1500));
    // And must NOT include a 1501st char of body.
    expect(ragText).not.toContain('b'.repeat(1501));
  });

  test('ranks 1-3 use the 1500 cap; ranks 4-6 use the 900 cap', () => {
    // Six chunks, each 3000 chars, with distinct fill chars so we can measure each body.
    const fills = ['p', 'q', 'r', 's', 't', 'u'];
    const chunks = fills.map((c) => makeChunk(3000, { idChar: c }));
    const { ragText } = formatRagContext(chunks);
    const bodies = bodiesOf(ragText);

    expect(bodies).toHaveLength(6);
    // Ranks 1-3 → 1500
    expect(bodies[0].length).toBe(1500);
    expect(bodies[1].length).toBe(1500);
    expect(bodies[2].length).toBe(1500);
    // Ranks 4-6 → 900
    expect(bodies[3].length).toBe(900);
    expect(bodies[4].length).toBe(900);
    expect(bodies[5].length).toBe(900);
  });

  test('a chunk shorter than its rank cap is emitted in full (no padding/cut)', () => {
    // rank 4 cap is 900; a 500-char chunk there should stay 500.
    const chunks = [
      makeChunk(10, { idChar: 'm' }),
      makeChunk(10, { idChar: 'n' }),
      makeChunk(10, { idChar: 'o' }),
      makeChunk(500, { idChar: 'z' }), // rank 4, under the 900 cap
    ];
    const { ragText } = formatRagContext(chunks);
    const bodies = bodiesOf(ragText);
    expect(bodies[3].length).toBe(500);
    expect(ragText).toContain('z'.repeat(500));
  });

  test('renders at most 6 chunks into ragText', () => {
    const chunks = Array.from({ length: 8 }, (_, i) =>
      makeChunk(50, { idChar: String.fromCharCode(97 + i) })
    );
    const { ragText } = formatRagContext(chunks);
    expect(bodiesOf(ragText)).toHaveLength(6);
    // 7th and 8th chunk fill chars must not appear in ragText.
    expect(ragText).not.toContain('g'.repeat(50)); // chunk index 6
    expect(ragText).not.toContain('h'.repeat(50)); // chunk index 7
  });

  test('header still carries paper title, section, and 3-decimal relevance score', () => {
    const { ragText } = formatRagContext([
      makeChunk(100, { paper: 'GraspNet', section: 'Approach', score: 0.4242, idChar: 'k' }),
    ]);
    expect(ragText).toContain('[GraspNet - Approach]');
    expect(ragText).toContain('(relevance: 0.424)');
  });

  test('ragCitations is UNCHANGED: full_text is full, snippet is 200, rank is 1-based', () => {
    const longText = 'c'.repeat(3000);
    const chunks = [
      {
        text: longText,
        score: 0.9,
        metadata: {
          paper_id: 'p1',
          paper_title: 'Paper One',
          section: 'Intro',
          layer: 'L1',
          content_type: 'text',
          rhetorical_role: 'background',
        },
      },
    ];
    const { ragCitations } = formatRagContext(chunks);
    expect(ragCitations).toHaveLength(1);
    const c = ragCitations[0];
    expect(c.rank).toBe(1);
    expect(c.full_text).toBe(longText); // full, NOT capped to 1500
    expect(c.full_text.length).toBe(3000);
    expect(c.snippet).toBe('c'.repeat(200)); // snippet still exactly 200
    expect(c.snippet.length).toBe(200);
    expect(c.paper_id).toBe('p1');
    expect(c.paper_title).toBe('Paper One');
    expect(c.section).toBe('Intro');
    expect(c.layer).toBe('L1');
    expect(c.content_type).toBe('text');
    expect(c.rhetorical_role).toBe('background');
    expect(c.score).toBe(0.9);
  });

  test('citations are produced for ALL chunks (not capped at 6 like ragText)', () => {
    const chunks = Array.from({ length: 8 }, (_, i) => makeChunk(50, { idChar: String.fromCharCode(97 + i) }));
    const { ragCitations } = formatRagContext(chunks);
    expect(ragCitations).toHaveLength(8);
    expect(ragCitations[7].rank).toBe(8);
  });
});

// ===========================================================================
// CONTRACT 2: buildMethodSummaries — opts.limit + opts.prioritize
// ===========================================================================

const FOUR_METHODS = [
  { name: 'Alpha', metadata: { 'Planning Type': 'A', 'Middleware': 'mwA' } },
  { name: 'Bravo', metadata: { 'Planning Type': 'B', 'Middleware': 'mwB' } },
  { name: 'Charlie', metadata: { 'Planning Type': 'C', 'Middleware': 'mwC' } },
  { name: 'Delta', metadata: { 'Planning Type': 'D', 'Middleware': 'mwD' } },
];
const COLS_OPTS = {
  summaryColumns: ['Planning Type', 'Middleware'],
  shortNames: { 'Planning Type': 'Plan', 'Middleware': 'MW' },
};

describe('buildMethodSummaries — backward-compatible defaults', () => {
  test('with no opts.limit, emits one line per method (no cap)', () => {
    const out = buildMethodSummaries(FOUR_METHODS, COLS_OPTS);
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toBe(
      '- Alpha: Plan=A; MW=mwA\n' +
        '- Bravo: Plan=B; MW=mwB\n' +
        '- Charlie: Plan=C; MW=mwC\n' +
        '- Delta: Plan=D; MW=mwD'
    );
  });

  test('with no opts.prioritize, original method order is preserved', () => {
    const out = buildMethodSummaries(FOUR_METHODS, COLS_OPTS);
    const names = out.split('\n').map((l) => l.split(':')[0].replace('- ', ''));
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });
});

describe('buildMethodSummaries — opts.limit', () => {
  test('limit < methods.length emits only the first `limit` lines', () => {
    const out = buildMethodSummaries(FOUR_METHODS, { ...COLS_OPTS, limit: 2 });
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Alpha');
    expect(lines[1]).toContain('Bravo');
    expect(out).not.toContain('Charlie');
    expect(out).not.toContain('Delta');
  });

  test('limit >= methods.length emits all methods (no over-trim)', () => {
    const out = buildMethodSummaries(FOUR_METHODS, { ...COLS_OPTS, limit: 10 });
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('Delta');
  });
});

describe('buildMethodSummaries — opts.prioritize (stable sort to front)', () => {
  test('named methods move to the front in the order they are named', () => {
    const out = buildMethodSummaries(FOUR_METHODS, { ...COLS_OPTS, prioritize: ['Charlie', 'Alpha'] });
    const names = out.split('\n').map((l) => l.split(':')[0].replace('- ', ''));
    // Charlie then Alpha (prioritize order), then the rest in stable original order.
    expect(names).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
  });

  test('prioritize is a STABLE sort: non-prioritized keep original relative order', () => {
    const out = buildMethodSummaries(FOUR_METHODS, { ...COLS_OPTS, prioritize: ['Delta'] });
    const names = out.split('\n').map((l) => l.split(':')[0].replace('- ', ''));
    expect(names).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie']);
  });

  test('prioritize names not present in methods are ignored (no crash, no phantom lines)', () => {
    const out = buildMethodSummaries(FOUR_METHODS, { ...COLS_OPTS, prioritize: ['Zulu', 'Bravo'] });
    const names = out.split('\n').map((l) => l.split(':')[0].replace('- ', ''));
    expect(names).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
    expect(out).not.toContain('Zulu');
  });

  test('prioritize + limit compose: prioritize first, THEN cut to limit', () => {
    const out = buildMethodSummaries(FOUR_METHODS, {
      ...COLS_OPTS,
      prioritize: ['Delta', 'Charlie'],
      limit: 2,
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    const names = lines.map((l) => l.split(':')[0].replace('- ', ''));
    expect(names).toEqual(['Delta', 'Charlie']); // the prioritized two survive the cut
    expect(out).not.toContain('Alpha');
    expect(out).not.toContain('Bravo');
  });
});

// ===========================================================================
// CONTRACT 3: exports preserved
// ===========================================================================

describe('module exports unchanged', () => {
  test('DEFAULT_SUMMARY_COLUMNS is exported with the grasp fallbacks', () => {
    expect(DEFAULT_SUMMARY_COLUMNS).toEqual([
      'Planning Method',
      'End-effector Hardware',
      'Input Data',
      'Training Data',
      'Object Configuration',
    ]);
  });

  test('DEFAULT_SHORT_NAMES is exported and maps known grasp columns', () => {
    expect(DEFAULT_SHORT_NAMES['Planning Method']).toBe('Plan');
    expect(DEFAULT_SHORT_NAMES['Input Data']).toBe('Input');
    expect(DEFAULT_SHORT_NAMES['Training Data']).toBe('Train');
  });
});
