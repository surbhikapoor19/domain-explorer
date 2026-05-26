/**
 * DebuggerModal — Visual debugger for a specific insight bullet.
 *
 * Shows the subgraph that generated the bullet, lets the user
 * exclude nodes/papers and re-run the LLM with modified context.
 */

import React, { useState, useCallback } from 'react';
import KGSubgraph from './KGSubgraph';

export default function DebuggerModal({ bullet, paperIds, kgContext, onClose, onRerun }) {
  const [excludedNodes, setExcludedNodes] = useState(new Set());
  const [rerunning, setRerunning] = useState(false);
  const [modifiedInsight, setModifiedInsight] = useState(null);

  const handleNodeClick = useCallback(node => {
    if (node.type === 'paper' || node.type === 'method') {
      setExcludedNodes(prev => {
        const next = new Set(prev);
        if (next.has(node.id)) {
          next.delete(node.id);
        } else {
          next.add(node.id);
        }
        return next;
      });
    }
  }, []);

  const handleRerun = async () => {
    if (!onRerun) return;
    setRerunning(true);
    try {
      // Filter out excluded paper IDs from the context
      const filteredPaperIds = paperIds.filter(pid => !excludedNodes.has(`paper:${pid}`));
      const result = await onRerun(filteredPaperIds, excludedNodes);
      setModifiedInsight(result);
    } catch (e) {
      setModifiedInsight('Re-run failed — please try again.');
    }
    setRerunning(false);
  };

  const activePaperIds = paperIds.filter(pid => !excludedNodes.has(`paper:${pid}`));

  return (
    <div className="debugger-overlay" onClick={onClose}>
      <div className="debugger-modal" onClick={e => e.stopPropagation()}>
        <div className="debugger-header">
          <h3>Debug Insight</h3>
          <button className="debugger-close" onClick={onClose}>&times;</button>
        </div>

        <div className="debugger-body">
          {/* Original bullet */}
          <div className="debugger-section">
            <div className="debugger-section-label">Original Insight</div>
            <div className="debugger-bullet">{bullet}</div>
          </div>

          {/* Interactive subgraph */}
          <div className="debugger-section">
            <div className="debugger-section-label">
              Supporting Subgraph
              <span className="debugger-hint">Click a paper/method node to exclude it</span>
            </div>
            <KGSubgraph paperIds={activePaperIds} onNodeClick={handleNodeClick} height={300} />
          </div>

          {/* Excluded nodes */}
          {excludedNodes.size > 0 && (
            <div className="debugger-section">
              <div className="debugger-section-label">Excluded ({excludedNodes.size})</div>
              <div className="debugger-excluded">
                {[...excludedNodes].map(nid => (
                  <span key={nid} className="debugger-excluded-chip" onClick={() => {
                    setExcludedNodes(prev => { const n = new Set(prev); n.delete(nid); return n; });
                  }}>
                    {nid.split(':').pop().replace(/-/g, ' ')} &times;
                  </span>
                ))}
              </div>
              <button
                className="debugger-rerun-btn"
                onClick={handleRerun}
                disabled={rerunning}
              >
                {rerunning ? 'Re-running...' : 'Re-run without excluded'}
              </button>
            </div>
          )}

          {/* Modified insight */}
          {modifiedInsight && (
            <div className="debugger-section">
              <div className="debugger-section-label">Modified Insight</div>
              <div className="debugger-bullet modified">{modifiedInsight}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
