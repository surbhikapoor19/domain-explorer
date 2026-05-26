import React, { useState, useEffect } from 'react';

const CONFLICT_LABELS = {
  limitation_vs_claim: 'Limitation vs Claim',
  mutual_superiority: 'Mutual Superiority',
};

export default function ContradictionPanel() {
  const [contradictions, setContradictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState(null);

  useEffect(() => {
    import('../lib/data-loader').then(({ loadKgContradictions }) => {
      loadKgContradictions()
        .then(data => {
          setContradictions(Array.isArray(data) ? data : (data.contradictions || []));
          setLoading(false);
        })
        .catch(() => { setContradictions([]); setLoading(false); });
    });
  }, []);

  if (loading) return <div className="gr-card"><div className="gr-card-body">Loading contradictions...</div></div>;
  if (contradictions.length === 0) return null;

  return (
    <div className="gr-card contradiction-panel">
      <div className="gr-card-header">
        <h3 className="gr-card-title">Disputed Claims</h3>
        <span className="gr-count-badge contradiction-badge">{contradictions.length} disputes</span>
      </div>
      <div className="gr-card-body">
        {contradictions.slice(0, 10).map((c, i) => (
          <div
            key={i}
            className={`contradiction-item ${expandedIdx === i ? 'expanded' : ''}`}
            onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
          >
            <div className="contradiction-header">
              <span className="contradiction-type">{CONFLICT_LABELS[c.conflict_type] || c.conflict_type}</span>
              {c.technique && <span className="contradiction-technique">re: {c.technique}</span>}
            </div>
            <div className="contradiction-sides">
              <div className="contradiction-side side-a">
                <div className="contradiction-paper">{c.paper_a}</div>
                <div className="contradiction-claim-type">{c.claim_a_type}</div>
                <div className="contradiction-claim">{expandedIdx === i ? c.claim_a : c.claim_a.substring(0, 80) + '...'}</div>
              </div>
              <div className="contradiction-vs">vs</div>
              <div className="contradiction-side side-b">
                <div className="contradiction-paper">{c.paper_b}</div>
                <div className="contradiction-claim-type">{c.claim_b_type}</div>
                <div className="contradiction-claim">{expandedIdx === i ? c.claim_b : c.claim_b.substring(0, 80) + '...'}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
