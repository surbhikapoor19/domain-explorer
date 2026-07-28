/* answer-synthesis — AUTHORED BY ORCHESTRATOR. The single-source-of-truth core:
 * one structured LLM object yields the answer AND the method selection, so the
 * prose and the comparison table can never name different methods. */
import {
  parseStructuredAnswer, salvageAnswer, resolveDiscussed, methodId, markerIdsInProse, rankCandidates,
} from '../answer-synthesis';

describe('parseStructuredAnswer', () => {
  test('parses a clean structured object', () => {
    const o = parseStructuredAnswer(JSON.stringify({
      answer: 'Use **VGN** [m_vgn].',
      discussed: [{ id: 'm_vgn', why: 'voxel grid' }],
      citations: [{ marker: 'P1', paper_id: 'vgn', paper_title: 'VGN' }],
    }));
    expect(o.answer).toMatch(/VGN/);
    expect(o.discussed).toEqual([{ id: 'm_vgn', why: 'voxel grid' }]);
    expect(o.citations[0]).toEqual({ marker: 'P1', paper_id: 'vgn', paper_title: 'VGN' });
  });

  test('tolerates a ```json code fence and surrounding prose', () => {
    const raw = 'Sure, here you go:\n```json\n{"answer":"hi","discussed":["m_a"]}\n```\nDone.';
    const o = parseStructuredAnswer(raw);
    expect(o.answer).toBe('hi');
    expect(o.discussed).toEqual([{ id: 'm_a', why: '' }]); // string ids normalized to {id,why}
  });

  test('returns null for non-JSON / answerless output', () => {
    expect(parseStructuredAnswer('no json here')).toBeNull();
    expect(parseStructuredAnswer(JSON.stringify({ discussed: ['m_a'] }))).toBeNull();
    expect(parseStructuredAnswer('')).toBeNull();
    expect(parseStructuredAnswer(null)).toBeNull();
  });

  test('salvages the answer from a TRUNCATED response (model hit its token limit)', () => {
    // No closing quote or brace; escaped \n and a bold marker sit mid-string. This is the
    // exact shape of the prod bug (raw {"answer":"...\n\n* ... cut off).
    const raw = '{"answer":"Multiple methods work in **piled** scenes.\\n\\n* Edge Grasp Network clears 5-object piles, achieving';
    const o = parseStructuredAnswer(raw);
    expect(o).not.toBeNull();
    expect(o.answer).toContain('Multiple methods work in **piled** scenes.');
    expect(o.answer).toContain('\n\n* Edge Grasp Network');   // \n decoded to real newlines
    expect(o.answer).not.toContain('{"answer"');              // envelope never leaks
    expect(o.answer).not.toContain('\\n');                    // no literal backslash-n
    expect(o.discussed).toEqual([]);                          // truncated -> no reliable methods
  });

  test('salvage honors escaped quotes inside a truncated answer', () => {
    const raw = '{"answer":"He said \\"grasp\\" then the JSON was cut';
    expect(parseStructuredAnswer(raw).answer).toBe('He said "grasp" then the JSON was cut');
  });

  test('salvageAnswer returns empty when there is no answer key to recover', () => {
    expect(salvageAnswer('{"discussed":["m_a"]}')).toBe('');
    expect(salvageAnswer('plain prose, not json')).toBe('');
    expect(salvageAnswer('')).toBe('');
  });
});

describe('methodId', () => {
  test('slugs a method name into a stable id', () => {
    expect(methodId('Volumetric Grasping Network (VGN)')).toBe('m_volumetric-grasping-network-vgn');
    expect(methodId('🤖 Equivariant Volumetric Grasping')).toBe('m_equivariant-volumetric-grasping');
  });
});

describe('resolveDiscussed — exact id lookup (no cross-boundary string matching)', () => {
  const byId = new Map([['m_a', { id: 'm_a', name: 'Alpha' }], ['m_b', { id: 'm_b', name: 'Beta' }]]);
  test('resolves ids in order, drops unknown ids, dedupes', () => {
    const out = resolveDiscussed(
      [{ id: 'm_b' }, { id: 'm_x' }, { id: 'm_a' }, { id: 'm_b' }], byId);
    expect(out.map(d => d.name)).toEqual(['Beta', 'Alpha']);
  });
  test('empty / unknown -> empty', () => {
    expect(resolveDiscussed([{ id: 'm_z' }], byId)).toEqual([]);
    expect(resolveDiscussed([], byId)).toEqual([]);
  });
  test('tolerates ids echoed WITH their [brackets] (the model does this)', () => {
    const out = resolveDiscussed([{ id: '[m_a]' }, { id: ' m_b ' }], byId);
    expect(out.map(d => ({ id: d.id, name: d.name }))).toEqual([
      { id: 'm_a', name: 'Alpha' }, { id: 'm_b', name: 'Beta' },
    ]);
  });
});

describe('markerIdsInProse', () => {
  test('extracts every [m_*] marker written in the answer', () => {
    const s = markerIdsInProse('Use **VGN** [m_vgn] and **GIGA** [m_giga]; also [P1].');
    expect([...s].sort()).toEqual(['m_giga', 'm_vgn']);
  });
});

describe('rankCandidates — query-relevant ordering (not array order)', () => {
  const methods = [
    { name: 'Zeta Method' },
    { name: 'Contact GraspNet' },
    { name: 'VGN' },
  ];
  test('filter + RAG-paper + query-token matches rank above the unrelated array head', () => {
    const ranked = rankCandidates(methods, {
      filterMethods: ['VGN'],
      ragPapers: ['contact-graspnet'],
      ragCitations: [],
      query: 'contact grasp in clutter',
    });
    // VGN (filter) and Contact GraspNet (rag paper + query token) outrank Zeta (array head, no signal)
    expect(ranked.indexOf('Zeta Method')).toBe(ranked.length - 1);
    expect(ranked.slice(0, 2).sort()).toEqual(['Contact GraspNet', 'VGN']);
  });
});
