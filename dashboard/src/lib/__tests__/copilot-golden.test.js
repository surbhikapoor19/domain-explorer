/* COPILOT GOLDEN-QUERY EVAL — AUTHORED BY ORCHESTRATOR.
 * A small regression harness over the deterministic copilot layers (no LLM, no
 * network): intent routing, named-method detection, query-focus directives, and
 * hybrid retrieval on a mini-corpus. Prompt/retrieval changes that break common
 * researcher phrasings fail HERE instead of shipping blind. Add a row when a
 * user-reported miss gets fixed — this file is the memory of those bugs. */
import { classifyFormatIntent, methodsNamedInQuery, findUngroundedNumbers } from '../ai-pipeline';
import { queryFocusDirective } from '../copilot/prompt-builder';
import { bm25Search, expandQueryTerms, dedupeChunks } from '../copilot/retrieval';

// ── Golden intent routes: query -> expected FORMAT intent ──
const INTENT_GOLD = [
  ['compare graspQP to graspVLA bringing out the pros and cons of each', 'comparison'],
  ['GIGA vs VGN', 'comparison'],
  ['do suction grippers perform better in piled scenes?', 'comparison'],
  ['give an overview of the motion landscape methods', 'overview'],
  ['what methods are there?', 'overview'],
  ['survey of grasp planning algorithms', 'overview'],
  ['which method has the highest success rate?', 'ranking'],
  ['what is the fastest planner?', 'ranking'],
  ['which methods for cluttered scenes?', 'recommendation'],
  ['recommend approaches for transparent objects', 'recommendation'],
  ['how does grasp planning work?', 'default'],
];

test.each(INTENT_GOLD)('intent: %s -> %s', (q, expected) => {
  expect(classifyFormatIntent(q)).toBe(expected);
});

// ── Named-method detection (the GraspQP class of bug) ──
const METHODS = [
  { name: '🤖 GraspQP' }, { name: '🤖 GraspVLA' },
  { name: '🤖 Volumetric Grasping Network (VGN)' }, { name: '🤖 Dex-Net 2.0 (GQ-CNN)' },
];
test('golden: every explicitly-named method is detected, no false positives on generic words', () => {
  const names = (q) => methodsNamedInQuery(q, METHODS).map(m => m.name);
  expect(names('compare graspqp and VGN')).toEqual(expect.arrayContaining(['🤖 GraspQP', '🤖 Volumetric Grasping Network (VGN)']));
  expect(names('is dex-net 2.0 still competitive?')).toContain('🤖 Dex-Net 2.0 (GQ-CNN)');
  expect(names('what is grasp planning')).toHaveLength(0);
});

// ── Query-focus: the specific ask reaches the model ──
test('golden: pros/cons and when-to-use asks produce a focus directive', () => {
  expect(queryFocusDirective('pros and cons of A vs B')).toMatch(/Strengths/);
  expect(queryFocusDirective('when should I use sampling-based planners?')).toMatch(/Best when/i);
  expect(queryFocusDirective('describe A')).toBe('');
});

// ── Retrieval on a mini-corpus: synonym expansion + layer coverage + dedup ──
const CHUNKS = [
  { id: 'c1', text: 'The two-finger gripper achieves stable grasps on household objects.', metadata: { layer: 'fine', paper_id: 'p1' } },
  { id: 'c2', text: 'Latency of the planner is 40 ms per grasp on GPU.', metadata: { layer: 'mid', paper_id: 'p2' } },
  { id: 'c3', text: 'This survey reviews learning-based manipulation broadly.', metadata: { layer: 'coarse', paper_id: 'p3' } },
  { id: 'c4', text: 'The two-finger gripper achieves stable grasps on household objects.', metadata: { layer: 'coarse', paper_id: 'p1' } }, // dup of c1 at another layer
];

test('golden: "end-effector" finds the gripper chunk via synonym expansion', () => {
  expect(expandQueryTerms(['end-effector'])).toEqual(expect.arrayContaining(['gripper']));
  const hits = bm25Search('end-effector stability', CHUNKS, { topK: 4 });
  expect(hits.some(c => c.id === 'c1' || c.id === 'c4')).toBe(true);
});

test('golden: a broad query still reaches mid/fine layers (no hard layer filter)', () => {
  // "how do methods work" classifies broad; the latency chunk lives in "mid".
  const hits = bm25Search('how fast are the planners latency', CHUNKS, { topK: 4 });
  expect(hits.some(c => c.id === 'c2')).toBe(true);
});

test('golden: near-duplicate passages collapse to one evidence slot', () => {
  const deduped = dedupeChunks([CHUNKS[0], CHUNKS[3], CHUNKS[1]]);
  expect(deduped).toHaveLength(2);
});

// ── Numeric grounding enforcement ──
test('golden: fabricated figures are flagged, evidence-backed and exempt ones are not', () => {
  const ctx = 'AnyGrasp reported 86.9 [grade A] ... latency 40 ms';
  expect(findUngroundedNumbers('It achieves 86.9% success [P1].', ctx)).toEqual([]);           // grounded
  expect(findUngroundedNumbers('It achieves 93.7% success [P1].', ctx)).toEqual(['93.7']);    // fabricated
  expect(findUngroundedNumbers('Published in 2023, it lists 3 variants.', ctx)).toEqual([]);  // year + small count exempt
});
