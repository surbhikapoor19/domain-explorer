/* UMAP filtered-view indexing — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * A filtered subset must project from ITS OWN feature rows (via _row), not the
 * first-N rows of the full corpus. */
// umap-js / ml-kmeans are ESM and aren't transformed by CRA's jest — mock them
// so the test exercises recomputeUmap's row-slicing logic deterministically.
jest.mock('umap-js', () => ({ UMAP: class { fit(f) { return f.map((_, i) => [i, i]); } } }));
jest.mock('ml-kmeans', () => ({ kmeans: (f, k) => ({ clusters: f.map((_, i) => i % k) }) }));
import { recomputeUmap } from '../umap';

test('filtered view projects from the filtered rows, strips _row, preserves order', () => {
  // 6-row corpus of description embeddings; filter to 3 specific rows (2,4,0).
  const desc = Array.from({ length: 6 }, (_, i) => [i, i * 0.5]);
  const methods = [
    { name: 'C', _row: 2 }, { name: 'E', _row: 4 }, { name: 'A', _row: 0 },
  ];
  const out = recomputeUmap({}, desc, { Description: 1 }, methods, 2);
  expect(out.length).toBe(3);
  // With 3 points runUmap uses its deterministic line layout (x = i*2-(n-1)).
  // This only equals [-2,0,2] if the features were SLICED to 3 rows; if the bug
  // re-ran UMAP on all 6 corpus rows, the coords would not be this line.
  expect(out.map(o => o.x)).toEqual([-2, 0, 2]);
  expect(out.map(o => o.name)).toEqual(['C', 'E', 'A']);   // order preserved
  expect(out.every(o => !('_row' in o))).toBe(true);        // _row stripped from output
});

test('full corpus (no _row mismatch) still works', () => {
  const desc = Array.from({ length: 3 }, (_, i) => [i, 1]);
  const methods = desc.map((_, i) => ({ name: String(i), _row: i }));
  const out = recomputeUmap({}, desc, { Description: 1 }, methods, 2);
  expect(out.length).toBe(3);
  expect(out.every(o => typeof o.x === 'number' && typeof o.cluster === 'number')).toBe(true);
});
