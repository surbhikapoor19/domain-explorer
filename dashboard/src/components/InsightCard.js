import React, { useState, useMemo, useEffect, useRef } from 'react';
import InsightBullets from './InsightBullets';
import { useDomainConfig } from '../DomainContext';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { relativePct, maxScore } from '../lib/relevance';

function cleanPdfText(text) {
  if (!text) return '';
  let cleaned = text
    // Add space before uppercase letter following lowercase (e.g., "graspNetwork" -> "grasp Network")
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Add space before uppercase following a digit (e.g., "3DPoint" -> "3D Point")
    .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
    // Add space before opening parens/brackets that follow word chars
    .replace(/([a-zA-Z0-9])\(/g, '$1 (')
    .replace(/([a-zA-Z0-9])\[/g, '$1 [')
    // Add space after closing parens/brackets before word chars
    .replace(/\)([a-zA-Z])/g, ') $1')
    .replace(/\]([a-zA-Z])/g, '] $1')
    // Add space after period followed by uppercase (sentence boundary)
    .replace(/\.([A-Z])/g, '. $1')
    // Add space after comma followed by letter
    .replace(/,([a-zA-Z])/g, ', $1')
    // Fix concatenated common English words (lowercase to lowercase)
    .replace(/([a-z])(the|and|for|with|from|that|this|which|our|we|are|is|in|of|to|on|at|by|as|an|or|it|be|do|no|so|if|up|can|has|had|was|not|but|its|may|all|any|use|how|one|two|new|set|see|per|via|get|let|put|run|own|out|off|top|low|few|key|big|old|raw|due|end|aim|way|pre|sub|non)(?=[a-z])/gi, '$1 $2')
    // Fix lowercase-to-lowercase concatenation with common word patterns
    .replace(/([a-z]{3,})(using|based|given|shown|each|over|than|into|also|then|only|such|much|well|very|most|some|both|like|many|more|other|after|about|under|along|above|below|since|while|until|where|there|these|those|their|being|could|would|should|which|every|first|second|third)/gi, '$1 $2')
    // Fix "wordword" where second word starts with common prefixes
    .replace(/([a-z])(approach|method|network|model|object|grasp|robot|point|cloud|image|depth|scene|train|learn|predict|generate|sample|evaluate|compute|estimate|detect|process)/gi, (match, p1, p2) => {
      // Only add space if the first part is 3+ chars
      if (p1.length >= 3) return p1 + ' ' + p2;
      return match;
    })
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Fix double spaces around punctuation
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return cleaned;
}

function renderLatex(text) {
  // Find LaTeX patterns: $...$ or \(...\) or common equation patterns
  const latexPattern = /(\$[^$]+\$|\\[\(\[][^\\]+\\[\)\]])/g;
  const parts = text.split(latexPattern);

  return parts.map((part, i) => {
    if (part.match(/^\$[^$]+\$$/)) {
      const latex = part.slice(1, -1);
      try {
        const html = katex.renderToString(latex, { throwOnError: false, displayMode: false });
        return <span key={i} className="latex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
      } catch { return <span key={i} className="latex-fallback">{part}</span>; }
    }
    if (part.match(/^\\[\(\[][^\\]+\\[\)\]]$/)) {
      const latex = part.slice(2, -2);
      try {
        const html = katex.renderToString(latex, { throwOnError: false, displayMode: true });
        return <span key={i} className="latex-block" dangerouslySetInnerHTML={{ __html: html }} />;
      } catch { return <span key={i} className="latex-fallback">{part}</span>; }
    }
    return part;
  });
}

function HighlightedText({ text, keywords }) {
  const cleanedText = cleanPdfText(text);

  // First pass: split by keywords for highlighting
  if (!keywords || keywords.length === 0) {
    return <span className="evidence-text-body">{renderLatex(cleanedText)}</span>;
  }
  const sorted = [...keywords].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = cleanedText.split(regex);
  return (
    <span className="evidence-text-body">
      {parts.map((part, i) => {
        const isMatch = keywords.some(k => part.toLowerCase() === k.toLowerCase());
        if (isMatch) {
          return <mark key={i} className="rag-highlight">{part}</mark>;
        }
        return <span key={i}>{renderLatex(part)}</span>;
      })}
    </span>
  );
}

function formatPaperId(id) {
  if (!id) return '';
  const s = String(id);
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function PaperEvidencePanel({ citations }) {
  const [showAll, setShowAll] = useState(false);

  if (!citations || citations.length === 0) return null;

  // Deduplicate by paper_id, keep best score and earliest page
  const paperMap = {};
  citations.forEach(cit => {
    const key = cit.paper_id;
    if (!paperMap[key] || cit.score > paperMap[key].score) {
      paperMap[key] = { ...cit };
    }
  });
  const papers = Object.values(paperMap).sort((a, b) => b.score - a.score);
  const shown = showAll ? papers : papers.slice(0, 5);
  // Relative relevance: the top passage reads 100%, others scale against it — so a raw
  // cosine of ~0.03 shows as "most relevant", not a misleading "3% relevant".
  const topPaperScore = maxScore(papers);

  return (
    <div className="paper-evidence-panel">
      <div className="evidence-header">
        <span className="evidence-title">Paper Evidence</span>
        <span className="evidence-count">
          {citations.length} passages from {papers.length} papers
        </span>
      </div>

      <div className="evidence-paper-list">
        {shown.map((paper, i) => (
          <div key={i} className="evidence-paper-row">
            <div className="evidence-paper-info">
              <span className="evidence-paper-name">{paper.paper_title || formatPaperId(paper.paper_id)}</span>
              <span className="evidence-paper-score">{relativePct(paper.score, topPaperScore)}% relevant</span>
            </div>
            <div className="evidence-paper-meta">
              {paper.section && <span className="evidence-tag">{paper.section}</span>}
              {paper.rhetorical_role && <span className="evidence-tag role">{paper.rhetorical_role}</span>}
              {paper.content_type && <span className="evidence-tag content">{paper.content_type}</span>}
            </div>
            {paper.snippet && (
              <div className="evidence-paper-snippet">{paper.snippet.substring(0, 150)}...</div>
            )}
          </div>
        ))}
        {papers.length > 5 && !showAll && (
          <button className="evidence-show-more" onClick={() => setShowAll(true)}>
            +{papers.length - 5} more papers
          </button>
        )}
      </div>
    </div>
  );
}

export default function InsightCard({ suggestion, weights, query, data, termDictionary, onClose, onMethodClick }) {
  const { shortNames } = useDomainConfig();
  const weightDiffs = Object.entries(suggestion.weights)
    .filter(([col, val]) => val !== (weights[col] ?? 0))
    .map(([col, val]) => ({
      col,
      short: shortNames[col] || col,
      from: weights[col] ?? 0,
      to: val
    }));

  // Build method name -> cluster ID lookup
  const methodClusterMap = useMemo(() => {
    const map = {};
    if (data) {
      data.forEach(d => { map[d.name] = d.cluster; });
    }
    return map;
  }, [data]);

  // Build cluster label -> cluster ID lookup from clusterStats
  const clusterLabelMap = useMemo(() => {
    const map = {};
    if (suggestion.clusterStats) {
      suggestion.clusterStats.forEach(cs => {
        if (cs.label) map[cs.label] = cs.id;
      });
    }
    return map;
  }, [suggestion.clusterStats]);

  return (
    <div className="insight-card">
      <div className="insight-card-header">
        <span className="insight-icon">AI</span>
        <span className="insight-title">Copilot Insight</span>
        <button className="insight-close" onClick={onClose}>&times;</button>
      </div>
      <div className="insight-body">
        <InsightBullets
          text={suggestion.insight}
          methodClusterMap={methodClusterMap}
          clusterLabelMap={clusterLabelMap}
          onMethodClick={onMethodClick}
          query={query}
          termDictionary={termDictionary}
          grounding={suggestion.grounding}
        />
      </div>

      <PaperEvidencePanel citations={suggestion.ragCitations} />

      <div className="insight-actions-summary">
        {suggestion.filterMethods && (
          <span className="action-chip filter-chip">
            Filtered to {suggestion.filterMethods.length} methods
          </span>
        )}
        {(suggestion.highlightMethods || []).length > 0 && (
          <span className="action-chip highlight-chip">
            {suggestion.highlightMethods.length} best matches
          </span>
        )}
        {weightDiffs.length > 0 && (
          <span className="action-chip weight-change-chip">
            {weightDiffs.length} weight{weightDiffs.length > 1 ? 's' : ''} adjusted
          </span>
        )}
      </div>
      {(suggestion.highlightMethods || []).length > 0 && (
        <div className="insight-matches">
          <span className="matches-label">Best matches:</span>
          {suggestion.highlightMethods.join(', ')}
        </div>
      )}
    </div>
  );
}
