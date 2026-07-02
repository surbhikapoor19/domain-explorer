/* computeAnchorMethods — AUTHORED BY ORCHESTRATOR. A discussed method must attach
 * its metadata even when the LLM echoed the user's casing ("graspQP") and the data
 * row is "🤖 GraspQP" — otherwise its comparison column shows "not specified"
 * despite full metadata existing (the reported GraspQP bug). */
import { computeAnchorMethods } from '../AnswerBlock';

const DATA = [
  { name: '🤖 GraspQP', cluster: 1, metadata: { 'Planning Method': 'Analytical, Sampling', 'Training Data': 'Training-less' } },
  { name: '🤖 GraspVLA', cluster: 2, metadata: { 'Planning Method': 'Generative', 'Training Data': 'Sim' } },
];

test('resolves a mis-cased / emoji-less discussed name to the data row + its metadata', () => {
  const suggestion = { paperRelevance: [{ name: 'graspQP', score: 0.9 }, { name: 'GraspVLA', score: 0.8 }] };
  const anchors = computeAnchorMethods(suggestion, DATA);
  const qp = anchors.find(a => /graspqp/i.test(a.name));
  expect(qp).toBeTruthy();
  expect(qp.meta['Planning Method']).toBe('Analytical, Sampling');   // NOT empty -> no "not specified"
  expect(qp.name).toBe('🤖 GraspQP');                                 // canonical name adopted
});
