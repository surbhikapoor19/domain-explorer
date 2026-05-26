/**
 * Shared text highlighting utility.
 *
 * Extracts the entity highlighting logic from InsightBullets so it can be
 * used in ANY text component across all pages. Same colors, same tooltips,
 * same click behaviors everywhere.
 *
 * Usage:
 *   import { HighlightedText } from '../highlighter';
 *   <HighlightedText text="..." termDictionary={dict} query="..." />
 */

import React, { useMemo } from 'react';
import Tooltip from './components/Tooltip';
import ACRONYMS from './acronyms';

// ─── Entity type CSS classes (must match App.css) ───
const TYPE_CLASSES = {
  architecture: 'entity-architecture',
  technique: 'entity-technique',
  gripper: 'entity-gripper',
  sensor: 'entity-technique',
  acronym: 'entity-technique',
  domain: 'entity-technique',
  scene: 'entity-technique',
};

// ─── Fallback entities (always available) ───
const FALLBACK = {};
['PointNet++', 'PointNet', 'ResNet', 'VGG', 'U-Net', 'Transformer', 'CNN', 'GNN'].forEach(t =>
  FALLBACK[t.toLowerCase()] = { type: 'architecture', tooltip: '' }
);
['UMAP', 'HDBSCAN', 'TF-IDF', 'cosine similarity', '6-DoF', '7-DoF', 'sim-to-real',
 'point cloud', 'TSDF', 'RGBD', 'ablation'].forEach(t =>
  FALLBACK[t.toLowerCase()] = { type: 'technique', tooltip: '' }
);
['parallel-jaw', 'two-finger', 'multi-finger', 'dexterous', 'suction'].forEach(t =>
  FALLBACK[t.toLowerCase()] = { type: 'gripper', tooltip: '' }
);
Object.entries(ACRONYMS).forEach(([acr, { full, definition }]) => {
  FALLBACK[acr.toLowerCase()] = { type: 'technique', tooltip: `${full}: ${definition}` };
});

// ─── Build lookup from term dictionary ───
export function buildEntityLookup(termDictionary) {
  const lookup = { ...FALLBACK };
  if (termDictionary?.terms) {
    termDictionary.terms.forEach(t => {
      if (t.idf >= 2.0) {
        lookup[t.term.toLowerCase()] = { type: t.type || 'domain', tooltip: t.definition || '' };
      }
    });
  }
  if (termDictionary?.acronyms) {
    termDictionary.acronyms.forEach(a => {
      if (!lookup[a.acronym.toLowerCase()]) {
        lookup[a.acronym.toLowerCase()] = { type: 'acronym', tooltip: a.full_form };
      }
    });
  }
  return lookup;
}

// ─── Build regex for matching ───
function buildRegex(lookup) {
  const terms = Object.keys(lookup).filter(t => t.length >= 4).sort((a, b) => b.length - a.length);
  if (!terms.length) return null;
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
}

// ─── Citation regex ───
const CITATION_RE = /(\([A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?\.?,?\s*\d{4}(?:\s*;\s*[A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?\.?,?\s*\d{4})*\))/g;
const CITE_CHECK = /^\([A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?\.?,?\s*\d{4}/;

/**
 * HighlightedText — Renders text with entity highlighting, citation styling,
 * and query keyword emphasis. Drop-in replacement for plain text spans.
 *
 * Props:
 *   text            - The text to highlight
 *   termDictionary  - API term dictionary (optional, falls back to builtins)
 *   query           - Current query string (optional, for keyword emphasis)
 *   className       - Additional CSS class
 */
export function HighlightedText({ text, termDictionary, query, className }) {
  const lookup = useMemo(() => buildEntityLookup(termDictionary), [termDictionary]);
  const regex = useMemo(() => buildRegex(lookup), [lookup]);

  const queryKeywords = useMemo(() => {
    if (!query) return [];
    const STOPS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','to','of','in','for','on','with','at','by','from','as','and','but','or','not','so','yet','both','all','any','more','most','other','some','such','than','too','very','about','how','what','which','who','when','where','why','this','that','these','those','it','its','they','them','their','we','us','our','used','using','methods','method','approach','based','use']);
    return query.toLowerCase().replace(/[?!.,;:'"()]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOPS.has(w));
  }, [query]);

  if (!text) return null;

  // Strip markdown bold/italic that LLMs sometimes add despite instructions
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');

  // Step 1: split on citations
  const citeParts = text.split(CITATION_RE);

  const rendered = citeParts.map((part, ci) => {
    if (CITE_CHECK.test(part)) {
      return <span key={`c${ci}`} className="citation-ref">{part}</span>;
    }

    // Step 2: split on entity matches
    if (!regex) return <span key={`t${ci}`}>{part}</span>;

    const entityParts = part.split(regex);
    return entityParts.map((ep, ei) => {
      const entityMatch = lookup[ep.toLowerCase()];
      if (entityMatch) {
        const cls = `entity-tag ${TYPE_CLASSES[entityMatch.type] || 'entity-technique'}`;
        if (entityMatch.tooltip) {
          return <Tooltip key={`e${ci}-${ei}`} text={entityMatch.tooltip}><span className={cls}>{ep}</span></Tooltip>;
        }
        return <span key={`e${ci}-${ei}`} className={cls}>{ep}</span>;
      }

      // Step 3: highlight query keywords with word boundaries
      if (queryKeywords.length > 0) {
        const kwSorted = [...queryKeywords].sort((a, b) => b.length - a.length);
        const kwEscaped = kwSorted.filter(k => k.length >= 3).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (kwEscaped.length > 0) {
          const kwRegex = new RegExp(`\\b(${kwEscaped.join('|')})\\b`, 'gi');
          const kwParts = ep.split(kwRegex);
          return kwParts.map((kp, ki) => {
            if (queryKeywords.some(k => kp.toLowerCase() === k.toLowerCase())) {
              return <span key={`k${ci}-${ei}-${ki}`} className="query-term-highlight">{kp}</span>;
            }
            return kp;
          });
        }
      }

      return ep;
    });
  });

  return <span className={className}>{rendered}</span>;
}

export default HighlightedText;
