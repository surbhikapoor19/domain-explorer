import React, { useEffect, useMemo } from 'react';
import { bestChunkForClaim, splitHighlight } from '../lib/citation-evidence';

// Shown when a citation [P#] is clicked (Graph Reasoning OR Benchmarks). It shows
// the retrieved passage that best SUPPORTS the specific claim the marker sits on
// — not just the paper's top query chunk — with the shared terms highlighted. When
// the best passage only weakly matches, it says so, so a citation whose source
// doesn't actually state the claim is visible as such instead of silently pointing
// at an unrelated paragraph. Self-contained (reads chunks off the citation), so it
// works identically on both pages.
function stripMarkers(s) {
  return String(s || '')
    .replace(/\[[A-Za-z]?\d+(?:\s*[;,]\s*[A-Za-z]?\d+)*\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function CitationModal({ data, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const match = useMemo(
    () => (data && data.cite ? bestChunkForClaim(data.cite.chunks || [], data.claimText || '') : null),
    [data]
  );

  if (!data || !data.cite) return null;
  const { cite, claimText } = data;
  const chunk = match && match.chunk;
  const support = match ? match.support : 0;
  // Weak = the passage shares too little with the claim to plausibly support it:
  // fewer than 2 distinct content words, or under a fifth of the claim's terms.
  // (Real-corpus check: an off-topic claim scored ~0.14 on incidental overlap, so
  // 0.12 alone was too lax — require a real term count too.)
  const weak = !!chunk && ((match.terms || []).length < 2 || support < 0.2);
  const segments = chunk ? splitHighlight(chunk.text, match.terms) : [];
  const claim = stripMarkers(claimText);

  return (
    <div className="cite-modal" role="dialog" aria-modal="true" aria-label={`Source for citation ${cite.index}`} onClick={onClose}>
      <div className="cite-modal-card" onClick={e => e.stopPropagation()}>
        <div className="cite-modal-head">
          <div className="cite-modal-titles">
            <span className="cite-modal-marker">[{cite.index}]</span>
            <span className="cite-modal-paper">{cite.paper_title || cite.paper_id}</span>
          </div>
          <button type="button" className="cite-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {claim && (
          <div className="cite-modal-claim"><span className="cite-modal-claim-label">Cited for</span>{claim}</div>
        )}
        {chunk ? (
          <>
            <div className="cite-modal-meta">
              {chunk.section && <span className="cite-modal-section">{chunk.section}</span>}
              {chunk.page ? <span className="cite-modal-page">p.{chunk.page}</span> : null}
              <span className={`cite-modal-support ${weak ? 'weak' : 'ok'}`}>{weak ? 'weak match' : 'supporting passage'}</span>
            </div>
            <div className="cite-modal-passage">
              {segments.map((s, i) => (s.hit ? <mark key={i}>{s.t}</mark> : <span key={i}>{s.t}</span>))}
            </div>
            {weak && (
              <div className="cite-modal-warn">
                This retrieved passage doesn't clearly state the cited claim — the copilot may have generalized across sources. Treat this citation with caution.
              </div>
            )}
          </>
        ) : (
          <div className="cite-modal-empty">No retrieved passage is attached to this citation.</div>
        )}
      </div>
    </div>
  );
}
