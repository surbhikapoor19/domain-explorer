/**
 * ProofBlock — collapsible "how we got that answer" panel.
 *
 * Sits beneath AnswerBlock. Folded by default; opens to show:
 *   ① Anchor papers found (top of paperRelevance + KG-degree)
 *   ② Property extraction summary (X/8 dims, gaps, disagreements)
 *   ③ Evidence collected (top ragCitations with quoted snippets)
 *   ④ Synthesis metadata (model + citations resolved)
 *
 * Quotes use the same highlighter as the Copilot Insight so methods + domain
 * terms stay visually consistent with everything else on the page.
 */
import React, { useMemo, useState } from 'react';
import { HighlightedText } from '../highlighter';
import { CLUSTER_COLORS } from '../constants';
import { useDomainConfig } from '../DomainContext';
import { GRASP_PRIORITY_DIMS } from './AnswerBlock';

const MAX_QUOTES = 4;

function clusterColor(clusterId) {
  if (clusterId == null) return 'var(--primary, #185A7C)';
  return CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];
}

function normalize(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan' || s === '-') return '';
  return s;
}

function pct(score) {
  return `${Math.round((score || 0) * 100)}%`;
}

export default function ProofBlock({
  suggestion, anchorMethods, query, termDictionary, onMethodClick,
}) {
  const domainCfg = useDomainConfig();
  const PRIORITY_DIMS = (domainCfg.priorityDims && domainCfg.priorityDims.length > 0)
    ? domainCfg.priorityDims
    : GRASP_PRIORITY_DIMS;
  const [open, setOpen] = useState(false);

  // Edge counts per anchor — sums edges in any traversal step where this
  // method/paper appears as source or target. Gives a quick "depth of evidence"
  // signal without rendering the whole traversal tree.
  const edgesPerAnchor = useMemo(() => {
    const counts = {};
    anchorMethods.forEach(m => { counts[m.name] = 0; });
    (suggestion?.kgTraversal || []).forEach(step => {
      (step.edges || []).forEach(e => {
        const sLabel = e.source_label;
        const tLabel = e.target_label;
        anchorMethods.forEach(m => {
          if (sLabel === m.name || tLabel === m.name) counts[m.name] += 1;
        });
      });
    });
    return counts;
  }, [suggestion, anchorMethods]);

  // Property extraction summary — counts of shared / differs / partial / gap
  // across the eight priority dims for the anchor methods.
  const extractionSummary = useMemo(() => {
    const tally = { shared: 0, differs: 0, partial: 0, gap: 0 };
    PRIORITY_DIMS.forEach(d => {
      const vals = anchorMethods.map(m => normalize(m.meta[d.key]));
      const filled = vals.filter(Boolean);
      if (filled.length === 0) tally.gap += 1;
      else if (filled.length < anchorMethods.length) tally.partial += 1;
      else if (new Set(filled.map(v => v.toLowerCase())).size === 1) tally.shared += 1;
      else tally.differs += 1;
    });
    return tally;
  }, [anchorMethods]);

  // Pick the strongest 4 citations, restricted to anchor papers when possible.
  const topQuotes = useMemo(() => {
    const all = suggestion?.ragCitations || [];
    if (!all.length) return [];
    const anchorIds = new Set(
      anchorMethods.map(m => m.name.toLowerCase().replace(/\s+/g, '-'))
    );
    const fromAnchors = all.filter(c =>
      anchorIds.has((c.paper_id || '').toLowerCase())
    );
    const pool = fromAnchors.length >= 2 ? fromAnchors : all;
    return [...pool]
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, MAX_QUOTES);
  }, [suggestion, anchorMethods]);

  if (anchorMethods.length === 0) return null;

  const summaryLine = `${anchorMethods.length} anchor${anchorMethods.length === 1 ? '' : 's'} · ${topQuotes.length} quote${topQuotes.length === 1 ? '' : 's'} · ${extractionSummary.gap} gaps · ${extractionSummary.differs} disagreements`;

  return (
    <div className={`gr-proof-block ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="gr-proof-header"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="gr-proof-toggle">{open ? '▾' : '▸'}</span>
        <span className="gr-proof-title">Proof</span>
        <span className="gr-proof-summary">{summaryLine}</span>
      </button>

      {open && (
        <div className="gr-proof-body">

          <section className="gr-proof-section">
            <div className="gr-proof-step">
              <span className="gr-proof-step-num">1</span>
              <span className="gr-proof-step-label">Anchor papers</span>
            </div>
            <ul className="gr-proof-anchors">
              {anchorMethods.map(m => (
                <li key={m.name}>
                  <button
                    type="button"
                    className="gr-proof-anchor-name"
                    style={{ color: clusterColor(m.cluster) }}
                    onClick={() => onMethodClick && onMethodClick(m.name)}
                    title={`Highlight ${m.name} everywhere`}
                  >
                    {m.name}
                  </button>
                  <span className="gr-proof-anchor-meta">
                    {m.meta['Year (Initial Release)'] && (
                      <>· {String(m.meta['Year (Initial Release)']).split('.')[0]}</>
                    )}
                    {edgesPerAnchor[m.name] > 0 && (
                      <> · {edgesPerAnchor[m.name]} edge{edgesPerAnchor[m.name] === 1 ? '' : 's'}</>
                    )}
                    {m.score > 0 && <> · relevance {pct(m.score)}</>}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="gr-proof-section">
            <div className="gr-proof-step">
              <span className="gr-proof-step-num">2</span>
              <span className="gr-proof-step-label">Evidence collected</span>
            </div>
            {topQuotes.length === 0 && (
              <div className="gr-proof-empty">No retrieved passages.</div>
            )}
            <ol className="gr-proof-quotes">
              {topQuotes.map((c, i) => (
                <li key={i} className="gr-proof-quote">
                  <div className="gr-proof-quote-head">
                    <span className="gr-proof-quote-num">[{i + 1}]</span>
                    <span className="gr-proof-quote-src">
                      {c.paper_title || c.paper_id}
                      {c.section && <span className="gr-proof-quote-section"> · {c.section}</span>}
                    </span>
                    {c.score != null && (
                      <span className="gr-proof-quote-score">{pct(c.score)}</span>
                    )}
                  </div>
                  <blockquote className="gr-proof-quote-text">
                    <HighlightedText
                      text={(c.snippet || c.full_text || '').slice(0, 280) +
                            ((c.snippet || c.full_text || '').length > 280 ? '…' : '')}
                      termDictionary={termDictionary}
                      query={query}
                    />
                  </blockquote>
                </li>
              ))}
            </ol>
          </section>

          <section className="gr-proof-section">
            <div className="gr-proof-step">
              <span className="gr-proof-step-num">3</span>
              <span className="gr-proof-step-label">Synthesis</span>
            </div>
            <div className="gr-proof-meta">
              LLM synthesis · {topQuotes.length} citation{topQuotes.length === 1 ? '' : 's'} resolved
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
