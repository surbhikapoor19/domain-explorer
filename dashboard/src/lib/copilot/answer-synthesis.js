// Copilot structured-answer helpers — the single-source-of-truth core.
//
// The model returns ONE JSON object {answer, methods, citations}. `answer` is the
// markdown prose; `methods` is the set the answer discusses, MOST RELEVANT FIRST.
// We resolve `methods` to real dataset methods and use them to drive BOTH the
// highlight set and the comparison table, so the prose and the table can never
// name different methods (the old bug). Pure + unit-testable; nothing throws.

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'on', 'with',
  'is', 'are', 'as', 'by', 'how', 'what', 'which', 'that', 'this', 'methods', 'method',
  'grasp', 'grasping', 'planning', 'robot', 'robotic', 'scenes', 'scene', 'using', 'use']);

function norm(s) {
  return String(s || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}
function slug(s) {
  return String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
}
function tokens(s) {
  return new Set((String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 2 && !STOP.has(t)));
}

/** Stable candidate id for a method name, e.g. "Volumetric Grasping Network (VGN)" -> "m_volumetric-grasping-network-vgn". */
export function methodId(name) {
  return 'm_' + slug(name);
}

/**
 * parseStructuredAnswer(raw) -> {answer, discussed:[{id,why}], citations} | null.
 * Robust to code fences, leading/trailing prose, and minor noise: extracts the
 * outermost {...} and JSON.parses it. Accepts `discussed` ([{id,why}] or [id]) and
 * tolerates a legacy `methods` (array of strings) by mapping it onto discussed.
 * Returns null if there is no usable object with a non-empty `answer`.
 */
export function parseStructuredAnswer(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  let obj;
  try {
    obj = JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.answer !== 'string' || !obj.answer.trim()) {
    return null;
  }
  const rawDiscussed = Array.isArray(obj.discussed) ? obj.discussed
    : Array.isArray(obj.methods) ? obj.methods : [];
  const discussed = rawDiscussed.map(d => {
    if (typeof d === 'string') return { id: d.trim(), why: '' };
    if (d && typeof d === 'object') return { id: String(d.id || d.method || '').trim(), why: String(d.why || '').trim() };
    return null;
  }).filter(d => d && d.id);
  return {
    answer: obj.answer.trim(),
    discussed,
    citations: Array.isArray(obj.citations)
      ? obj.citations.filter(c => c && typeof c === 'object').map(c => ({
          marker: String(c.marker || c.paper_id || '').trim(),
          paper_id: String(c.paper_id || c.marker || '').trim(),
          paper_title: String(c.paper_title || '').trim(),
        }))
      : [],
  };
}

/** Ids of the form m_<slug> actually written as [m_...] markers in the prose. */
export function markerIdsInProse(answer) {
  const out = new Set();
  const re = /\[(m_[a-z0-9-]+)\]/gi;
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) out.add(m[1].toLowerCase());
  return out;
}

/**
 * resolveDiscussed(discussed, candidatesById) -> ordered list of {id, name} for the
 * selected methods, by EXACT id lookup against the candidate set we supplied (ids
 * never cross a string-matching boundary). Unknown ids are dropped. Deduped.
 */
export function resolveDiscussed(discussed, candidatesById) {
  const out = [];
  const seen = new Set();
  for (const d of (discussed || [])) {
    // Models often echo the id WITH its [brackets] ("[m_vgn]") — strip them so the
    // canonical candidate id ("m_vgn") matches; push the canonical key, not the raw.
    const id = String(d.id || '').replace(/[[\]\s]/g, '').toLowerCase();
    const cand = candidatesById.get ? candidatesById.get(id) : candidatesById[id];
    if (cand && !seen.has(id)) { seen.add(id); out.push({ id, name: cand.name, why: d.why || '' }); }
  }
  return out;
}

/**
 * resolveMethods(llmMethods, allMethods) -> dataset method names (in the model's
 * order, deduped) that resolve. Match: exact-normalized, then no-separator, then
 * strong token-subset (handles "(VGN)" suffixes, emoji prefixes, minor renames).
 */
export function resolveMethods(llmMethods, allMethods) {
  const names = (allMethods || []).map(m => (m && m.name) || m).filter(Boolean);
  const byNorm = new Map();
  const tokIndex = names.map(n => ({ name: n, tok: tokens(n), norm: norm(n) }));
  names.forEach(n => { if (!byNorm.has(norm(n))) byNorm.set(norm(n), n); });

  const out = [];
  const seen = new Set();
  for (const raw of (llmMethods || [])) {
    const want = String(raw || '');
    const wn = norm(want);
    if (!wn) continue;
    let hit = byNorm.get(wn);
    if (!hit) {
      // strong token-subset: the LLM name's tokens are a subset of a method's (or vice versa)
      const wt = tokens(want);
      if (wt.size) {
        let best = null;
        for (const cand of tokIndex) {
          if (!cand.tok.size) continue;
          const inter = [...wt].filter(t => cand.tok.has(t)).length;
          const subset = inter === wt.size || inter === cand.tok.size;
          if (subset && inter >= 1) {
            const score = inter / Math.max(wt.size, cand.tok.size);
            if (!best || score > best.score) best = { name: cand.name, score };
          }
        }
        if (best && best.score >= 0.5) hit = best.name;
      }
    }
    if (hit && !seen.has(hit)) { seen.add(hit); out.push(hit); }
  }
  return out;
}

/**
 * rankCandidates(allMethods, {filterMethods, ragPapers, ragCitations, query}) ->
 * method names ordered by query relevance, so the prompt's candidate list LEADS
 * with relevant methods (not array order) and the model can actually pick them.
 */
export function rankCandidates(allMethods, { filterMethods = [], ragPapers = [], ragCitations = [], query = '' } = {}) {
  const filterSet = new Set(filterMethods || []);
  const ragSet = new Set((ragPapers || []).map(slug));
  const citeText = (ragCitations || []).map(c => `${c.paper_title || ''} ${c.paper_id || ''}`.toLowerCase());
  const qTok = tokens(query);

  return (allMethods || [])
    .map((m, idx) => {
      const name = m.name;
      const mtok = tokens(name);
      let score = 0;
      if (filterSet.has(name)) score += 4;
      if (ragSet.has(slug(name))) score += 3;
      if (citeText.some(ct => [...mtok].some(t => ct.includes(t)))) score += 2;
      if ([...mtok].some(t => qTok.has(t))) score += 1;
      return { name, score, idx };
    })
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map(x => x.name);
}
