// Relevance display helper.
//
// Retrieval/similarity scores (cosine, BM25) are small in ABSOLUTE terms — a top
// passage often scores ~0.03 — so printing `score * 100` reads as a misleading
// "3% relevant" even when it's the best match. We instead show RELATIVE relevance:
// the most-relevant item in a list is 100% and the rest scale against it. This keeps
// a meaningful ranking signal without the deceptive near-zero absolute numbers.

/**
 * relativePct(score, max) -> integer 0..100.
 * The item whose score equals the list max reads 100%; others are proportional.
 * Guards: non-numeric -> 0; max <= 0 (no signal) -> 0; result clamped to [0, 100].
 */
export function relativePct(score, max) {
  const s = Number(score);
  const m = Number(max);
  if (!Number.isFinite(s) || !Number.isFinite(m) || m <= 0) return 0;
  const pct = Math.round((Math.max(0, s) / m) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** maxScore(items, get) -> the largest (finite, non-negative) score in a list, or 0. */
export function maxScore(items, get = (x) => x && x.score) {
  let max = 0;
  for (const it of items || []) {
    const v = Number(get(it));
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}
