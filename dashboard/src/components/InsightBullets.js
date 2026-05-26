import React, { useMemo } from 'react';
import Tooltip from './Tooltip';
import { CLUSTER_COLORS } from '../constants';
import ACRONYMS, { expandKeywordsWithAcronyms } from '../acronyms';

// ─── STOP WORDS (for query keyword extraction) ───
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'not', 'so', 'yet', 'both', 'all', 'any',
  'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
  'about', 'up', 'out', 'if', 'then', 'also', 'how', 'what', 'which',
  'who', 'when', 'where', 'why', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our',
  'used', 'using', 'across', 'methods', 'method', 'approach', 'based', 'use',
  'does', 'many', 'between', 'each', 'after', 'before',
  'grasp', 'grasping', 'robot', 'robotic', 'robotics',
  'planning', 'manipulation', 'object', 'objects', 'paper', 'papers',
  'model', 'network', 'learning', 'data', 'training', 'system',
  'results', 'performance', 'different', 'proposed',
  'latest', 'recent', 'best', 'most', 'first', 'last', 'next',
  'paper', 'papers', 'which', 'where', 'there',
]);

function extractQueryKeywords(query) {
  if (!query) return [];
  const words = query.toLowerCase()
    .replace(/[?!.,;:'"()]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const parts = query.toLowerCase().replace(/[?!.,;:'"()]/g, '').split(/\s+/);
  const phrases = [];
  for (let i = 0; i < parts.length - 1; i++) {
    if (!STOP_WORDS.has(parts[i]) && !STOP_WORDS.has(parts[i + 1])) {
      phrases.push(parts[i] + ' ' + parts[i + 1]);
    }
  }
  return [...phrases, ...words];
}

// ─── FALLBACK ENTITY DICTIONARIES (used when API dictionary not available) ───
const FALLBACK_ENTITIES = {};
// Architecture
['PointNet++', 'PointNet', 'ResNet', 'VGG', 'U-Net'].forEach(t => {
  FALLBACK_ENTITIES[t.toLowerCase()] = { type: 'architecture', tooltip: '' };
});
// Technique
['UMAP', 'HDBSCAN', 'TF-IDF', 'cosine similarity', '6-DoF', '7-DoF', 'sim-to-real',
 'point cloud', 'TSDF', 'RGBD', 'ablation'].forEach(t => {
  FALLBACK_ENTITIES[t.toLowerCase()] = { type: 'technique', tooltip: '' };
});
// Gripper
['parallel-jaw', 'two-finger', 'multi-finger', 'dexterous', 'suction'].forEach(t => {
  FALLBACK_ENTITIES[t.toLowerCase()] = { type: 'gripper', tooltip: '' };
});
// Acronyms from static dictionary
Object.entries(ACRONYMS).forEach(([acr, { full, definition }]) => {
  FALLBACK_ENTITIES[acr.toLowerCase()] = { type: 'technique', tooltip: `${full}: ${definition}` };
});

const TYPE_CLASSES = {
  architecture: 'entity-architecture',
  technique: 'entity-technique',
  gripper: 'entity-gripper',
  sensor: 'entity-technique',
  acronym: 'entity-technique',
  domain: 'entity-technique',
  scene: 'entity-technique',
};

// ─── BUILD ENTITY LOOKUP FROM TERM DICTIONARY ───
function buildEntityLookup(termDictionary) {
  const lookup = { ...FALLBACK_ENTITIES };

  if (termDictionary && termDictionary.terms) {
    // Only include terms with IDF above threshold (distinctive enough to highlight)
    const IDF_THRESHOLD = 2.0;
    termDictionary.terms.forEach(t => {
      if (t.idf >= IDF_THRESHOLD) {
        const key = t.term.toLowerCase();
        const tooltip = t.definition || '';
        lookup[key] = {
          type: t.type || 'domain',
          tooltip: tooltip,
          idf: t.idf,
        };
      }
    });
  }

  if (termDictionary && termDictionary.acronyms) {
    termDictionary.acronyms.forEach(a => {
      const key = a.acronym.toLowerCase();
      if (!lookup[key]) {
        lookup[key] = {
          type: 'acronym',
          tooltip: a.full_form,
        };
      }
    });
  }

  return lookup;
}

function buildTermRegexes(entityLookup) {
  const allTerms = Object.keys(entityLookup);

  // Long terms (5+ chars): case-insensitive word boundary
  const longTerms = allTerms.filter(t => t.length >= 5).sort((a, b) => b.length - a.length);
  // Short terms (2-4 chars): case-sensitive, standalone only
  const shortTerms = allTerms.filter(t => t.length < 5 && t.length >= 2).sort((a, b) => b.length - a.length);

  const longRegex = longTerms.length > 0
    ? new RegExp(`\\b(${longTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
    : null;

  // Short: require non-letter boundaries to avoid matching inside words
  const shortRegex = shortTerms.length > 0
    ? new RegExp(`(?<=\\s|^|[^a-zA-Z])(${shortTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=\\s|$|[^a-zA-Z])`, 'g')
    : null;

  return { longRegex, shortRegex, shortTerms };
}

// ─── RENDERING HELPERS ───

function highlightQueryTerms(text, queryKeywords) {
  if (!queryKeywords || queryKeywords.length === 0) return text;
  // Only highlight keywords 3+ chars to avoid matching inside words
  const filtered = queryKeywords.filter(k => k.length >= 3);
  if (filtered.length === 0) return text;
  const sorted = [...filtered].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Use word boundaries to prevent matching "cant" inside "significant"
  const regex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) => {
    if (filtered.some(k => part.toLowerCase() === k.toLowerCase())) {
      return <span key={i} className="query-term-highlight">{part}</span>;
    }
    return part;
  });
}

function renderEntitySpan(text, entityLookup, typeClasses) {
  const lookup = entityLookup[text.toLowerCase()];
  if (!lookup) return null;
  const className = `entity-tag ${typeClasses[lookup.type] || 'entity-technique'}`;
  if (lookup.tooltip) {
    return (
      <Tooltip text={lookup.tooltip}>
        <span className={className}>{text}</span>
      </Tooltip>
    );
  }
  return <span className={className}>{text}</span>;
}

function renderWithEntities(text, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms) {
  const parts = longRegex ? text.split(longRegex) : [text];

  return parts.map((part, i) => {
    const entityMatch = renderEntitySpan(part, entityLookup, TYPE_CLASSES);
    if (entityMatch) return <span key={i}>{entityMatch}</span>;

    // Short term pass
    if (shortRegex) {
      const subParts = part.split(shortRegex);
      return (
        <span key={i}>
          {subParts.map((sub, j) => {
            const shortLookup = entityLookup[sub.toLowerCase()];
            const isValid = shortLookup && shortTerms.includes(sub);
            if (isValid) {
              return <span key={j}>{renderEntitySpan(sub, entityLookup, TYPE_CLASSES) || sub}</span>;
            }
            return <span key={j}>{highlightQueryTerms(sub, queryKeywords)}</span>;
          })}
        </span>
      );
    }
    return <span key={i}>{highlightQueryTerms(part, queryKeywords)}</span>;
  });
}

// ─── FORMAT BULLET ───

function resolveColor(idOrColor, useDirectColors) {
  if (useDirectColors) return idOrColor; // already a color string
  return CLUSTER_COLORS[idOrColor % CLUSTER_COLORS.length];
}

function formatBullet(text, methodClusterMap, clusterLabelMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors) {
  // First pass: split out citation patterns and wrap them
  // Matches: (Author et al., 2024), (Author and Author, 2023), (Author et al., 2023; Author et al., 2021)
  const citationRegex = /(\([A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?\.?,?\s*\d{4}(?:\s*;\s*[A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?\.?,?\s*\d{4})*\))/g;
  const citeSplit = text.split(citationRegex);
  const citeCheck = /^\([A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?\.?,?\s*\d{4}/;
  const withCitations = citeSplit.map((part, ci) => {
    if (part && citeCheck.test(part)) {
      return <span key={`cite-${ci}`} className="citation-ref">{part}</span>;
    }
    return part;
  });
  // Rejoin non-citation parts for further processing, keeping citation spans
  // We process each non-citation text segment through the rest of the pipeline
  const processedParts = withCitations.map((part, ci) => {
    if (typeof part !== 'string') return part; // already a React element (citation)
    return <span key={`seg-${ci}`}>{formatBulletInner(part, methodClusterMap, clusterLabelMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors)}</span>;
  });
  return processedParts;
}

function formatBulletInner(text, methodClusterMap, clusterLabelMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors) {
  const quoteRegex = /("[^"]{3,}")/g;
  const segments = text.split(quoteRegex);

  return segments.map((seg, i) => {
    // Quoted text
    if (seg.startsWith('"') && seg.endsWith('"')) {
      const name = seg.slice(1, -1);

      // Check cluster labels
      if (clusterLabelMap) {
        const clusterKey = Object.keys(clusterLabelMap).find(label =>
          name.toLowerCase().includes(label.toLowerCase()) ||
          label.toLowerCase().includes(name.toLowerCase())
        );
        if (clusterKey !== undefined) {
          const cId = clusterLabelMap[clusterKey];
          const color = resolveColor(cId, useDirectColors);
          return (
            <span key={i} className="entity-cluster-label"
              style={{ color, backgroundColor: color + '18', borderColor: color }}>
              {name}
            </span>
          );
        }
      }

      // Check method names (case-insensitive, emoji-stripped, partial match)
      let clusterId, matchedMethodName;
      if (methodClusterMap) {
        clusterId = methodClusterMap[name];
        if (clusterId !== undefined) matchedMethodName = name;
        if (clusterId === undefined) {
          const nameLower = name.toLowerCase();
          for (const [mName, cId] of Object.entries(methodClusterMap)) {
            const clean = mName.replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '').trim();
            if (clean.toLowerCase() === nameLower || mName.toLowerCase() === nameLower
                || nameLower.startsWith(clean.toLowerCase()) || nameLower.includes(clean.toLowerCase())) {
              clusterId = cId;
              matchedMethodName = mName;
              break;
            }
          }
        }
      }
      const clusterColor = clusterId !== undefined ? resolveColor(clusterId, useDirectColors) : null;
      if (clusterColor && onMethodClick) {
        return (
          <span key={i} className="entity-method-clickable"
            style={{ color: clusterColor, borderBottomColor: clusterColor }}
            onClick={() => onMethodClick(matchedMethodName || name)}
            title={`Click to highlight ${matchedMethodName || name}`}>
            {name}
          </span>
        );
      }
      return <strong key={i} className="entity-paper">{name}</strong>;
    }

    // Unquoted: check cluster labels first
    if (clusterLabelMap) {
      const labels = Object.keys(clusterLabelMap).sort((a, b) => b.length - a.length);
      const escaped = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const clusterRegex = new RegExp(`(${escaped.join('|')})`, 'gi');
      const clusterParts = seg.split(clusterRegex);
      const hasMatch = clusterParts.some(p =>
        Object.keys(clusterLabelMap).find(l => l.toLowerCase() === p.toLowerCase())
      );
      if (hasMatch) {
        return (
          <span key={i}>
            {clusterParts.map((part, j) => {
              const key = Object.keys(clusterLabelMap).find(l => l.toLowerCase() === part.toLowerCase());
              if (key) {
                const cId = clusterLabelMap[key];
                const color = resolveColor(cId, useDirectColors);
                return (
                  <span key={j} className="entity-cluster-label"
                    style={{ color, backgroundColor: color + '18', borderColor: color }}>
                    {part}
                  </span>
                );
              }
              // Remaining text: check methods then entities
              return <span key={j}>{renderMethodsAndEntities(part, methodClusterMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors)}</span>;
            })}
          </span>
        );
      }
    }

    // Unquoted: check method names then entities
    return <span key={i}>{renderMethodsAndEntities(seg, methodClusterMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors)}</span>;
  });
}

function renderMethodsAndEntities(text, methodClusterMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors) {
  if (!methodClusterMap || !onMethodClick) {
    return renderWithEntities(text, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms);
  }

  // Build method name variants
  const nameVariants = {};
  Object.entries(methodClusterMap).forEach(([name, cId]) => {
    const clean = name.replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '').trim();
    nameVariants[clean.toLowerCase()] = { original: name, clusterId: cId };
    if (clean !== name) nameVariants[name.toLowerCase()] = { original: name, clusterId: cId };
  });

  const cleanNames = Object.keys(nameVariants)
    .map(k => nameVariants[k].original.replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '').trim())
    .filter(n => n.length > 2);
  const uniqueNames = [...new Set(cleanNames)].sort((a, b) => b.length - a.length);

  if (uniqueNames.length === 0) {
    return renderWithEntities(text, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms);
  }

  const escaped = uniqueNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const methodRegex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(methodRegex);

  return parts.map((part, j) => {
    const variant = nameVariants[part.toLowerCase()];
    if (variant) {
      const color = resolveColor(variant.clusterId, useDirectColors);
      return (
        <span key={j} className="entity-method-clickable"
          style={{ color, borderBottomColor: color }}
          onClick={() => onMethodClick(variant.original)}
          title={`Click to highlight ${variant.original}`}>
          {part}
        </span>
      );
    }
    return <span key={j}>{renderWithEntities(part, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms)}</span>;
  });
}

// ─── MAIN COMPONENT ───

export default function InsightBullets({ text, methodClusterMap, clusterLabelMap, onMethodClick, query, termDictionary, useDirectColors, grounding }) {
  const queryKeywords = useMemo(() => {
    const raw = extractQueryKeywords(query);
    return expandKeywordsWithAcronyms(raw);
  }, [query]);

  // Build entity lookup from API dictionary + fallbacks
  const entityLookup = useMemo(() => buildEntityLookup(termDictionary), [termDictionary]);
  const { longRegex, shortRegex, shortTerms } = useMemo(() => buildTermRegexes(entityLookup), [entityLookup]);

  const ungrounded = useMemo(() => new Set((grounding?.ungrounded || []).map(u => u.toLowerCase())), [grounding]);

  if (!text) return null;
  const bullets = text.split('\n').filter(l => l.trim().startsWith('- '));

  // Check if a bullet contains any ungrounded entity
  const bulletHasUngrounded = (bulletText) => {
    if (ungrounded.size === 0) return false;
    const lower = bulletText.toLowerCase();
    return [...ungrounded].some(u => lower.includes(u.toLowerCase()));
  };

  const groundingBar = grounding && (grounding.grounded?.length > 0 || ungrounded.size > 0) ? (
    <div className="grounding-bar">
      <span className="grounding-label">Grounding:</span>
      <span className="grounding-stat grounded">{grounding.grounded?.length || 0} verified in KG</span>
      {ungrounded.size > 0 && (
        <span className="grounding-stat ungrounded" title={`Not in knowledge graph: ${[...ungrounded].join(', ')}`}>
          {ungrounded.size} unverified
        </span>
      )}
    </div>
  ) : null;

  if (bullets.length > 0) {
    return (
      <>
        <ul className="insight-bullets">
          {bullets.map((line, i) => {
            const content = line.replace(/^-\s*/, '');
            const isUngrounded = bulletHasUngrounded(content);
            return (
              <li key={i} className={isUngrounded ? 'bullet-ungrounded' : ''}>
                {formatBullet(content, methodClusterMap, clusterLabelMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors)}
                {isUngrounded && (
                  <span className="ungrounded-marker" title={`Contains entities not found in knowledge graph: ${[...ungrounded].filter(u => content.toLowerCase().includes(u.toLowerCase())).join(', ')}`}>
                    unverified
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {groundingBar}
      </>
    );
  }
  return (
    <>
      <p>{formatBullet(text, methodClusterMap, clusterLabelMap, onMethodClick, queryKeywords, entityLookup, longRegex, shortRegex, shortTerms, useDirectColors)}</p>
      {groundingBar}
    </>
  );
}
