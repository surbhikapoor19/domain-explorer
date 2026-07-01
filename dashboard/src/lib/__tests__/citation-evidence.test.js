/* citation-evidence — AUTHORED BY ORCHESTRATOR. A citation must open the passage
 * that actually supports the cited claim, and be honest when it doesn't. */
import { bestChunkForClaim, splitHighlight } from '../citation-evidence';

test('picks the chunk with the most shared content words with the claim', () => {
  const chunks = [
    { text: 'We evaluate on the YCB object set in cluttered scenes.' },
    { text: 'A contact-point loss trains the grasp quality network with binary cross-entropy.' },
  ];
  const { chunk, terms, support } = bestChunkForClaim(
    chunks, 'The method uses a contact-point loss trained with binary cross-entropy.');
  expect(chunk.text).toMatch(/contact-point loss/);
  expect(terms).toEqual(expect.arrayContaining(['contact-point', 'loss', 'binary', 'cross-entropy']));
  expect(support).toBeGreaterThan(0.3);
});

test('reports LOW support when no chunk actually contains the claim (the reported bug)', () => {
  const chunks = [{ text: 'The dataset contains 1000 objects rendered in simulation.' }];
  const { support } = bestChunkForClaim(
    chunks, 'It achieves 92% grasp success on real hardware with a suction gripper.');
  expect(support).toBeLessThan(0.12);
});

test('defensive on empty chunks', () => {
  expect(bestChunkForClaim([], 'anything')).toEqual({ chunk: null, support: 0, terms: [] });
  expect(bestChunkForClaim(null, 'x').chunk).toBe(null);
});

test('splitHighlight marks whole-word matches case-insensitively and preserves the text', () => {
  const segs = splitHighlight('Uses a contact-point Loss here', ['contact-point', 'loss']);
  expect(segs.filter(s => s.hit).map(s => s.t.toLowerCase())).toEqual(['contact-point', 'loss']);
  expect(segs.map(s => s.t).join('')).toBe('Uses a contact-point Loss here');
});
