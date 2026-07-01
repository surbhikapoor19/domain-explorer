/* classifyFormatIntent — AUTHORED BY ORCHESTRATOR. The router must recognize
 * comparative-performance phrasing ("do X perform better in Y") as a COMPARISON,
 * not fall through to default — the gap that made the suction query render flat. */
import { classifyFormatIntent } from '../ai-pipeline';

test('comparative-performance phrasing -> comparison (the reported "perform better" case)', () => {
  expect(classifyFormatIntent('do suction hardware of multi-finger perform better in piled scenes?')).toBe('comparison');
  expect(classifyFormatIntent('is Contact-GraspNet better than GIGA?')).toBe('comparison');
  expect(classifyFormatIntent('compare VGN and GIGA')).toBe('comparison');
  expect(classifyFormatIntent('which method is better for clutter?')).toBe('comparison');
});

test('explicit ranking / recommendation / default still classify correctly', () => {
  expect(classifyFormatIntent('what is the best method?')).toBe('ranking');
  expect(classifyFormatIntent('which methods for cluttered scenes?')).toBe('recommendation');
  expect(classifyFormatIntent('how does grasp planning work?')).toBe('default');
});
