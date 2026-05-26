import { closest, distance } from 'fastest-levenshtein';
import englishWords from 'an-array-of-english-words';

const englishSet = new Set(englishWords);
let domainVocab = null;

function buildDomainVocab(queryKeywords, methodNames) {
  const words = new Set();

  const { columnKeywords, colorByKeywords, attributeTerms } = queryKeywords;
  if (columnKeywords) {
    for (const kws of Object.values(columnKeywords)) {
      kws.forEach(kw => kw.split(/\s+/).forEach(w => {
        const c = w.toLowerCase().replace(/[^a-z-]/g, '');
        if (c.length >= 3) words.add(c);
      }));
    }
  }
  if (colorByKeywords) {
    for (const kws of Object.values(colorByKeywords)) {
      kws.forEach(kw => kw.split(/\s+/).forEach(w => {
        const c = w.toLowerCase().replace(/[^a-z-]/g, '');
        if (c.length >= 3) words.add(c);
      }));
    }
  }
  if (attributeTerms) {
    for (const termMap of Object.values(attributeTerms)) {
      for (const term of Object.keys(termMap)) {
        term.split(/\s+/).forEach(w => {
          const c = w.toLowerCase().replace(/[^a-z-]/g, '');
          if (c.length >= 3) words.add(c);
        });
      }
      for (const vals of Object.values(termMap)) {
        (Array.isArray(vals) ? vals : [vals]).forEach(v =>
          v.split(/[\s,]+/).forEach(w => {
            const c = w.toLowerCase().replace(/[^a-z-]/g, '');
            if (c.length >= 3) words.add(c);
          })
        );
      }
    }
  }
  if (methodNames) {
    methodNames.forEach(name => {
      name.replace(/[()]/g, ' ').split(/\s+/).forEach(w => {
        const c = w.toLowerCase().replace(/[^a-z-]/g, '');
        if (c.length >= 3) words.add(c);
      });
    });
  }

  ['grasp', 'grasping', 'gripper', 'grippers', 'robot', 'robotic', 'robotics',
   'suction', 'parallel', 'dexterous', 'clutter', 'cluttered', 'scene', 'scenes',
   'object', 'objects', 'point', 'cloud', 'depth', 'image', 'voxel', 'mesh',
   'diffusion', 'sampling', 'regression', 'analytical', 'reinforcement',
   'learning', 'generative', 'simulation', 'simulated', 'methods', 'method',
   'approach', 'technique', 'backbone', 'architecture', 'dataset', 'training',
   'evaluation', 'metric', 'accuracy', 'success', 'planning', 'detection',
   'prediction', 'network', 'neural', 'finger', 'multi-finger',
  ].forEach(w => words.add(w));

  return [...words];
}

function maxAllowedDistance(wordLen) {
  if (wordLen <= 4) return 1;
  if (wordLen <= 7) return 2;
  return 3;
}

function correctWordLocal(word, vocab) {
  const lower = word.toLowerCase();
  if (englishSet.has(lower)) return word;
  if (vocab.includes(lower)) return word;

  const maxDist = maxAllowedDistance(lower.length);
  const match = closest(lower, vocab);
  if (!match) return word;

  const dist = distance(lower, match);
  if (dist > maxDist || dist === 0) return word;

  if (word[0] === word[0].toUpperCase() && word.length > 1 && word.slice(1) === word.slice(1).toLowerCase()) {
    return match[0].toUpperCase() + match.slice(1);
  }
  if (word === word.toUpperCase() && word.length > 1) return match.toUpperCase();
  return match;
}

function localFallback(query, vocab) {
  const tokens = query.split(/(\s+)/);
  let corrected = false;
  const result = tokens.map(token => {
    if (/^\s+$/.test(token)) return token;
    const stripped = token.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    if (!stripped || stripped.length <= 2) return token;
    if (/\d/.test(stripped)) return token;
    if (/^[A-Z]{2,}$/.test(stripped)) return token;

    const fixed = correctWordLocal(stripped, vocab);
    if (fixed !== stripped) {
      corrected = true;
      return token.replace(stripped, fixed);
    }
    return token;
  });
  return { text: result.join(''), corrected };
}

async function llmCorrect(query, vocab) {
  const res = await fetch('/api/spell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, domainTerms: vocab.slice(0, 100) }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.changed) return null;
  return data.corrected;
}

export async function spellCorrectQuery(query, queryKeywords, methodNames) {
  if (!domainVocab) {
    domainVocab = buildDomainVocab(queryKeywords, methodNames);
  }

  // Primary: LLM-based sentence-level correction
  try {
    const llmResult = await llmCorrect(query, domainVocab);
    if (llmResult) {
      return { text: llmResult, corrected: true };
    }
  } catch (e) {
    // Fall through to local
  }

  // Fallback: per-word edit-distance correction
  return localFallback(query, domainVocab);
}
