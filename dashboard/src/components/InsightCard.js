import React, { useState, useMemo, useEffect, useRef } from 'react';
import InsightBullets from './InsightBullets';
import PdfViewer from './PdfViewer';
import { useDomainConfig } from '../DomainContext';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { expandKeywordsWithAcronyms } from '../acronyms';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'each', 'all', 'any', 'few',
  'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very', 'just',
  'about', 'up', 'out', 'if', 'then', 'also', 'how', 'what', 'which',
  'who', 'when', 'where', 'why', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'i', 'me',
  'my', 'you', 'your', 'he', 'she', 'him', 'her', 'his', 'used', 'using',
  'across', 'methods', 'method', 'approach', 'based', 'use',
  // Domain stop words
  'grasp', 'grasping', 'robot', 'robotic', 'robotics',
  'planning', 'manipulation', 'object', 'objects', 'paper', 'papers',
  'model', 'network', 'learning', 'data', 'training', 'system',
  'results', 'performance', 'different', 'proposed',
  'latest', 'recent', 'best', 'most', 'first', 'last', 'next',
]);

function extractKeywords(query) {
  if (!query) return [];
  const words = query.toLowerCase()
    .replace(/[?!.,;:'"()]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const parts = query.toLowerCase().replace(/[?!.,;:'"()]/g, '').split(/\s+/);
  const phrases = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const bigram = parts[i] + ' ' + parts[i + 1];
    if (!STOP_WORDS.has(parts[i]) && !STOP_WORDS.has(parts[i + 1])) {
      phrases.push(bigram);
    }
  }
  return [...phrases, ...words];
}

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

function PaperEvidencePanel({ citations, query, kgContext }) {
  const [showAll, setShowAll] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(null);
  const baseKeywords = useMemo(() => expandKeywordsWithAcronyms(extractKeywords(query)), [query]);

  // Build KG-powered keywords: extract technique names, claim terms, section names from KG context
  const keywords = useMemo(() => {
    const kgTerms = new Set(baseKeywords.map(k => k.toLowerCase()));
    if (kgContext) {
      // Extract technique/method names from the KG context text
      const lines = kgContext.split('\n');
      lines.forEach(line => {
        // Pull out capitalized multi-word names (PointNet++, Contact-GraspNet, Binary CE, etc.)
        const matches = line.match(/\b([A-Z][a-zA-Z]+(?:[-+]?\s*[A-Z][a-zA-Z]*)*(?:\+\+)?)\b/g);
        if (matches) matches.forEach(m => { if (m.length >= 3 && m.length <= 30) kgTerms.add(m.toLowerCase()); });
      });
    }
    // Also add technique/claim terms from citations for this specific paper
    if (citations) {
      citations.forEach(cit => {
        if (cit.domain_topics) {
          cit.domain_topics.split(', ').forEach(t => { if (t.trim().length >= 3) kgTerms.add(t.trim().toLowerCase()); });
        }
      });
    }
    return [...kgTerms].filter(k => k.length >= 3);
  }, [baseKeywords, kgContext, citations]);

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
              <span className="evidence-paper-score">{(paper.score * 100).toFixed(0)}% relevant</span>
            </div>
            <div className="evidence-paper-meta">
              {paper.section && <span className="evidence-tag">{paper.section}</span>}
              {paper.rhetorical_role && <span className="evidence-tag role">{paper.rhetorical_role}</span>}
              {paper.content_type && <span className="evidence-tag content">{paper.content_type}</span>}
            </div>
            {paper.snippet && (
              <div className="evidence-paper-snippet">{paper.snippet.substring(0, 150)}...</div>
            )}
            <button
              className="view-pdf-btn"
              onClick={() => {
                // Build per-paper keywords: global KG keywords + this paper's specific topics
                const paperKeywords = [...keywords];
                if (paper.section) paperKeywords.push(paper.section.toLowerCase());
                if (paper.domain_topics) {
                  paper.domain_topics.split(', ').forEach(t => {
                    if (t.trim().length >= 3) paperKeywords.push(t.trim().toLowerCase());
                  });
                }
                // Deduplicate
                const unique = [...new Set(paperKeywords)];
                setPdfOpen({
                  paperId: paper.paper_id,
                  page: Math.max(1, paper.page || 1),
                  keywords: unique,
                });
              }}
            >
              View PDF
            </button>
          </div>
        ))}
        {papers.length > 5 && !showAll && (
          <button className="evidence-show-more" onClick={() => setShowAll(true)}>
            +{papers.length - 5} more papers
          </button>
        )}
      </div>

      {pdfOpen && (
        <PdfViewer
          paperId={pdfOpen.paperId}
          page={pdfOpen.page}
          keywords={pdfOpen.keywords}
          onClose={() => setPdfOpen(null)}
        />
      )}
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

      <PaperEvidencePanel citations={suggestion.ragCitations} query={query} kgContext={suggestion.kgContext} />

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
