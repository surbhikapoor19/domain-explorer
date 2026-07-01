// Pick the retrieved passage that actually SUPPORTS a cited claim.
//
// A citation [P#] is paper-level, and the RAG chunks were retrieved for the whole
// query — so the paper's top chunk often isn't the sentence backing the specific
// claim the marker is attached to. Given the claim sentence and the paper's
// retrieved chunks, this picks the chunk with the most shared content words (the
// likely supporting passage), reports how strongly it matches (so the UI can be
// honest when support is weak), and marks the shared terms for highlighting.
//
// Pure + unit-testable. No network.

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'by', 'as',
  'that', 'this', 'it', 'its', 'from', 'at', 'which', 'was', 'were', 'has', 'have', 'than', 'then',
  'using', 'use', 'used', 'we', 'our', 'can', 'into', 'also', 'more', 'most', 'such', 'these', 'those',
  'their', 'they', 'both', 'each', 'when', 'while', 'but', 'not', 'via', 'per', 'over', 'under', 'between',
]);

export function contentWords(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter(w => !STOP.has(w));
}

/**
 * bestChunkForClaim(chunks, claimText) -> { chunk, support, terms }
 *  - chunk: the chunk (from `chunks`) that best matches the claim
 *  - support: 0..1 fraction of the claim's content words found in that chunk
 *  - terms: the shared content words (for highlighting)
 */
export function bestChunkForClaim(chunks, claimText) {
  const claim = [...new Set(contentWords(claimText))];
  const claimSet = new Set(claim);
  if (!chunks || !chunks.length) return { chunk: null, support: 0, terms: [] };
  let best = null, bestTerms = [];
  for (const ch of chunks) {
    const words = new Set(contentWords(ch.text));
    const shared = claim.filter(w => words.has(w));
    if (shared.length > bestTerms.length) { best = ch; bestTerms = shared; }
  }
  const support = claimSet.size ? bestTerms.length / claimSet.size : 0;
  return { chunk: best || chunks[0], support, terms: bestTerms };
}

/**
 * splitHighlight(text, terms) -> [{ t, hit }] segments; `hit` marks a shared term.
 * Whole-word, case-insensitive, longest-first so overlapping terms don't clip.
 */
export function splitHighlight(text, terms) {
  const src = String(text || '');
  const uniq = [...new Set((terms || []).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!uniq.length) return [{ t: src, hit: false }];
  const esc = uniq.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(${esc.join('|')})\\b`, 'gi');
  const out = [];
  let last = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ t: src.slice(last, m.index), hit: false });
    out.push({ t: m[0], hit: true });
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < src.length) out.push({ t: src.slice(last), hit: false });
  return out;
}
