/**
 * KGEdgeDetail — side panel for a clicked edge in the predictions view.
 *
 * Renders the deep-detail layer that the edge tooltip deliberately does
 * not duplicate:
 *   - The two endpoints' labels (with the directed/undirected arrow)
 *   - HGT scores (pattern + content)
 *   - Comparability table over the eight priority dimensions (paper↔paper
 *     predictions only — `comparability` is precomputed)
 *   - Shared-context list (KG topic/technique/dataset/hardware nodes
 *     both endpoints touch)
 *   - Quoted contexts for observed `cites` edges (TEI sentiment + quote)
 *
 * Per the no-redundancy rule, the visual signal layer (edge color, width,
 * arrow shape) and the orientation tooltip already convey edge type,
 * confidence, and direction-ness; this panel adds the things they cannot
 * — the full per-dim breakdown and the actual quoted text.
 */
import React from 'react';
import { HighlightedText } from '../highlighter';

const VERDICT_LABEL = {
  shared: 'agree',
  differs: 'differ',
  gaps: 'gap',
};

function pct(x) { return `${Math.round((x || 0) * 100)}%`; }

export default function KGEdgeDetail({ selection, onClose, query, termDictionary }) {
  if (!selection) return null;
  const { edge, src, tgt } = selection;
  const isPredicted = !!edge.inferred;
  const arrow = edge.bidirectional ? '↔' : '→';
  const cmp = edge.comparability;

  return (
    <div className="kgnd-panel">
      <div className="detail-panel-header">
        <h3>
          {src.label}
          {' '}<span className="kged-arrow">{arrow}</span>{' '}
          {tgt.label}
        </h3>
        <button onClick={onClose}>&times;</button>
      </div>

      <div className="detail-panel-body">
        {/* Edge-type chip + scores */}
        <div className="kged-meta">
          <span className={`kged-type ${isPredicted ? 'predicted' : 'observed'}`}>
            {isPredicted ? 'Predicted: ' : ''}{edge.type}
          </span>
          {isPredicted && (
            <span className="kged-scores">
              Pattern <strong>{pct(edge.confidence)}</strong>
              {edge.semantic_relevance > 0 && (
                <> · Content <strong>{pct(edge.semantic_relevance)}</strong></>
              )}
            </span>
          )}
          {edge.sentiment && !isPredicted && (
            <span className={`kged-stance stance-${edge.sentiment}`}>
              {edge.sentiment === 'builds_on' ? 'builds on'
                : edge.sentiment === 'differs_from' ? 'differs'
                : 'neutral'}
            </span>
          )}
        </div>

        {isPredicted && edge.bidirectional && (
          <p className="kged-note">
            Direction is ambiguous — the model scored both directions
            identically. Treat as a comparison candidate, not a directional
            claim.
          </p>
        )}

        {/* Paper↔paper comparability (only present for predicted
            paper-paper edges; precompute leaves it null otherwise). */}
        {cmp && (
          <div className="kged-section">
            <div className="kged-section-title">
              Comparability across the 8 priority dimensions
            </div>
            <div className="kged-cmp-summary">
              <span className="kged-tally shared">{cmp.shared.length} agree</span>
              <span className="kged-tally differs">{cmp.differs.length} differ</span>
              <span className="kged-tally gaps">{cmp.gaps.length} gap{cmp.gaps.length === 1 ? '' : 's'}</span>
            </div>
            <table className="kged-cmp-table">
              <thead>
                <tr>
                  <th></th>
                  <th>{src.label}</th>
                  <th>{tgt.label}</th>
                </tr>
              </thead>
              <tbody>
                {['shared', 'differs', 'gaps'].flatMap(bucket =>
                  (cmp[bucket] || []).map((row, i) => (
                    <tr key={`${bucket}-${i}`} className={`kged-cmp-row kged-cmp-${bucket}`}>
                      <td className="kged-cmp-dim">
                        <span className="kged-cmp-dim-label">{row.label}</span>
                        <span className={`kged-cmp-verdict kged-cmp-verdict-${bucket}`}>
                          {VERDICT_LABEL[bucket]}
                        </span>
                      </td>
                      <td>
                        {row.value_a
                          ? <HighlightedText text={row.value_a} termDictionary={termDictionary} query={query} />
                          : <span className="kged-cmp-empty">—</span>}
                      </td>
                      <td>
                        {row.value_b
                          ? <HighlightedText text={row.value_b} termDictionary={termDictionary} query={query} />
                          : <span className="kged-cmp-empty">—</span>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Shared structural neighbors — what KG context both endpoints
            touch. The HGT model leveraged these when scoring the edge. */}
        {edge.shared_context && edge.shared_context.length > 0 && (
          <div className="kged-section">
            <div className="kged-section-title">
              Shared neighbors in the KG
            </div>
            <div className="kged-shared-context">
              {edge.shared_context.map((c, i) => (
                <span key={i} className={`kged-ctx-chip kged-ctx-${c.type}`}>
                  <span className="kged-ctx-type">{c.type}</span>
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Quoted in-text contexts — observed cites edges only.
            Predicted edges do not carry quoted text; their evidence is
            the structural pattern summarized above. */}
        {!isPredicted && edge.contexts && edge.contexts.length > 0 && (
          <div className="kged-section">
            <div className="kged-section-title">
              In-text context ({edge.contexts.length} quote{edge.contexts.length === 1 ? '' : 's'})
            </div>
            {edge.contexts.map((q, i) => (
              <blockquote key={i} className="kged-quote">
                <HighlightedText text={q} termDictionary={termDictionary} query={query} />
              </blockquote>
            ))}
          </div>
        )}

        {/* Why the model flagged it (predicted edges only) — short copy
            that doesn't repeat what's already visible in the comparability
            table. Calls out the inherent limitation of structural-only
            scoring when the user might over-trust the verdict. */}
        {isPredicted && (
          <div className="kged-section kged-why">
            <div className="kged-section-title">Why the model flagged this</div>
            <p className="kged-why-text">
              Both nodes' KG neighborhoods match the structural pattern of
              other observed <code>{edge.type}</code> pairs. Pattern strength
              is {pct(edge.confidence)}; content similarity (text-only,
              independent of the graph) is {pct(edge.semantic_relevance)}.
              {edge.bidirectional
                ? ' The model has no signal to prefer one direction over the other.'
                : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
