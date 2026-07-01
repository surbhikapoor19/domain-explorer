/* query-engine.structuredMatches — AUTHORED BY ORCHESTRATOR. Pins the per-attribute
 * matcher that grounds the copilot so a method matching a queried attribute (e.g. a
 * suction method) is never silently dropped from the answer. */
import { structuredMatches } from '../query-engine';

const METHODS = [
  { name: 'Dex-Net 3.0', metadata: { 'End-effector Hardware': 'Suction', 'Object Configuration': 'Singulated' } },
  { name: 'Dex-Net 4.0', metadata: { 'End-effector Hardware': 'Two-finger, Suction', 'Object Configuration': 'Piled' } },
  { name: 'GraspGen', metadata: { 'End-effector Hardware': 'Two-finger, Suction', 'Object Configuration': 'Singulated' } },
  { name: 'VGN', metadata: { 'End-effector Hardware': 'Two-finger', 'Object Configuration': 'Piled' } },
];
const ATTR = {
  'End-effector Hardware': { suction: ['Suction'] },
  'Object Configuration': { piled: ['Piled'] },
};

test('returns EVERY method matching each queried attribute (incl. GraspGen for suction)', () => {
  const res = structuredMatches('do suction methods work in piled scenes?', METHODS, ATTR);
  const hw = res.find(r => r.col === 'End-effector Hardware');
  const scene = res.find(r => r.col === 'Object Configuration');
  expect(hw.methods.slice().sort()).toEqual(['Dex-Net 3.0', 'Dex-Net 4.0', 'GraspGen']);
  expect(scene.methods.slice().sort()).toEqual(['Dex-Net 4.0', 'VGN']);
});

test('lists the most selective attribute first', () => {
  const res = structuredMatches('suction in piled scenes', METHODS, ATTR);
  expect(res[0].methods.length).toBeLessThanOrEqual(res[1].methods.length); // scene(2) before hardware(3)
});

test('omits attributes not named in the query; defensive on empty input', () => {
  expect(structuredMatches('what is the newest method?', METHODS, ATTR)).toEqual([]);
  expect(structuredMatches('', METHODS, {})).toEqual([]);
  expect(structuredMatches('suction', METHODS, null)).toEqual([]);
});
