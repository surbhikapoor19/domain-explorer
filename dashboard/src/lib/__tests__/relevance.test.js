/* relevance — AUTHORED BY ORCHESTRATOR. Relative-relevance display: the top item in a
 * list reads 100% and the rest scale against it, so tiny absolute cosine scores never
 * surface as a misleading "3% relevant". */
import { relativePct, maxScore } from '../relevance';

describe('relativePct', () => {
  test('the top-scoring item reads 100%', () => {
    expect(relativePct(0.03, 0.03)).toBe(100);
  });

  test('others scale proportionally against the max', () => {
    expect(relativePct(0.015, 0.03)).toBe(50);
    expect(relativePct(0.006, 0.03)).toBe(20);
  });

  test('turns tiny absolute cosine scores into a meaningful relative number', () => {
    // raw would have shown 3% / 2% / 2%; relative shows 100 / 82 / 64
    expect(relativePct(0.041, 0.041)).toBe(100);
    expect(relativePct(0.0336, 0.041)).toBe(82);
    expect(relativePct(0.0262, 0.041)).toBe(64);
  });

  test('guards: no signal, zero, negative, and non-numeric all yield 0', () => {
    expect(relativePct(0.03, 0)).toBe(0);      // max is 0 -> no signal
    expect(relativePct(0, 0.03)).toBe(0);
    expect(relativePct(-0.5, 0.03)).toBe(0);   // negative clamped up to 0
    expect(relativePct('x', 0.03)).toBe(0);
    expect(relativePct(0.03, 'y')).toBe(0);
    expect(relativePct(undefined, undefined)).toBe(0);
  });

  test('clamps to 100 if a score somehow exceeds the given max', () => {
    expect(relativePct(0.05, 0.03)).toBe(100);
  });
});

describe('maxScore', () => {
  test('returns the largest score in a list', () => {
    expect(maxScore([{ score: 0.01 }, { score: 0.03 }, { score: 0.02 }])).toBe(0.03);
  });

  test('empty / missing -> 0', () => {
    expect(maxScore([])).toBe(0);
    expect(maxScore(null)).toBe(0);
    expect(maxScore([{ score: NaN }, { foo: 1 }])).toBe(0);
  });

  test('ignores non-finite and negative scores', () => {
    expect(maxScore([{ score: NaN }, { score: 0.02 }, { score: -1 }])).toBe(0.02);
  });

  test('accepts a custom accessor', () => {
    expect(maxScore([{ relevance: 5 }, { relevance: 9 }], (x) => x.relevance)).toBe(9);
  });
});
