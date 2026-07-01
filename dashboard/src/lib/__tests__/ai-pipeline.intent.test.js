/* classifyFormatIntent — AUTHORED BY ORCHESTRATOR. The router must recognize
 * comparative-performance phrasing ("do X perform better in Y") as a COMPARISON,
 * not fall through to default — the gap that made the suction query render flat. */
import { classifyFormatIntent, answerCacheKey } from '../ai-pipeline';

test('comparative-performance phrasing -> comparison (the reported "perform better" case)', () => {
  expect(classifyFormatIntent('do suction hardware of multi-finger perform better in piled scenes?')).toBe('comparison');
  expect(classifyFormatIntent('is Contact-GraspNet better than GIGA?')).toBe('comparison');
  expect(classifyFormatIntent('compare VGN and GIGA')).toBe('comparison');
  expect(classifyFormatIntent('which method is better for clutter?')).toBe('comparison');
});

test('overview / landscape phrasing -> overview (the reported motion case)', () => {
  expect(classifyFormatIntent('give an overview of the motion landscape methods')).toBe('overview');
  expect(classifyFormatIntent('what methods are there?')).toBe('overview');
  expect(classifyFormatIntent('list all approaches')).toBe('overview');
  expect(classifyFormatIntent('survey of grasp planning algorithms')).toBe('overview');
});

test('explicit ranking / recommendation / default still classify correctly', () => {
  expect(classifyFormatIntent('what is the best method?')).toBe('ranking');
  expect(classifyFormatIntent('which methods for cluttered scenes?')).toBe('recommendation');
  expect(classifyFormatIntent('how does grasp planning work?')).toBe('default');
});

test('answerCacheKey: repeat + near-duplicate queries collide; corpus change invalidates', () => {
  const methods = [{ name: 'VGN' }, { name: 'GIGA' }];
  // same query, different case/spacing/trailing punctuation -> same key (same answer)
  expect(answerCacheKey('Give an overview.', methods)).toBe(answerCacheKey('  give an overview  ', methods));
  // a different corpus (method set) -> different key, so a rebuild invalidates the cache
  expect(answerCacheKey('x', methods)).not.toBe(answerCacheKey('x', [{ name: 'VGN' }]));
});
