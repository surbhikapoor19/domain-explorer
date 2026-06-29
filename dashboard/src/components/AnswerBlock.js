/**
 * AnswerBlock — answer-first response for the Graph Reasoning page.
 *
 * Order (per product direction): the LLM synthesis ANSWER to the question comes
 * first, then the comparison table (the eight method-comparability dimensions
 * across the methods most relevant to the query, with extracted CSV values per
 * cell). The synthesis runs through the same highlighter the Copilot Insight
 * uses so method names and domain terms get the cluster-colored /
 * glossary-annotated treatment. The interactive plots/charts (subgraph, proof,
 * evidence, equations) follow this block on the page.
 */
import React, { useMemo } from 'react';
import AnswerMarkdown from './AnswerMarkdown';
import Tooltip from './Tooltip';
import { HighlightedText } from '../highlighter';
import { CLUSTER_COLORS } from '../constants';
import { useDomainConfig } from '../DomainContext';

// Per-status copy: a short pill tooltip plus the plain-English meaning used in
// the table caption. Keeps the two surfaces describing the four states from one
// source of truth.
const STATUS_TOOLTIPS = {
  shared: 'All compared methods report the same value for this dimension.',
  differs: 'Methods make different but equally valid choices for this dimension.',
  partial: 'Only some of the compared methods document this dimension.',
  gap: 'None of the compared methods document this dimension.',
};

const COMPARISON_TITLE_TOOLTIP =
  'Each row is one priority dimension. The pill flags whether the compared methods agree (shared), make different valid choices (differs), are partly documented (partial), or have no data (gap).';

const GRASP_PRIORITY_DIMS = [
  { key: 'Object Configuration',                                      label: 'Scene / Object Config' },
  { key: 'Planning Method',                                           label: 'Planning Method' },
  { key: 'Training Data',                                             label: 'Training Data' },
  { key: 'End-effector Hardware',                                     label: 'End-effector Hardware' },
  { key: 'Input Data',                                                label: 'Input / Sensor' },
  { key: 'Corresponding Dataset (see repository linked above)',       label: 'Dataset' },
  { key: 'Simulator (see repository linked above)',                   label: 'Simulator' },
  { key: 'Metric(s) Used ',                                           label: 'Metrics' },
];

const MAX_ANCHORS = 4;
const SCORE_THRESHOLD = 0.5;

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

/**
 * Pick anchor methods from `suggestion.paperRelevance`, hydrating each with
 * its cluster + CSV metadata from `data`. Top MAX_ANCHORS by score, but if
 * fewer than 2 clear SCORE_THRESHOLD we fall back to the raw top-N so even a
 * single-method query renders a useful overview.
 */
export function computeAnchorMethods(suggestion, data) {
  const rel = suggestion?.paperRelevance || [];
  if (!rel.length || !data?.length) return [];
  const sorted = [...rel].sort((a, b) => (b.score || 0) - (a.score || 0));
  const aboveThreshold = sorted.filter(p => (p.score || 0) >= SCORE_THRESHOLD);
  const picks = aboveThreshold.length >= 2
    ? aboveThreshold.slice(0, MAX_ANCHORS)
    : sorted.slice(0, Math.min(MAX_ANCHORS, sorted.length));
  return picks.map(p => {
    const row = data.find(d => d.name === p.name);
    return {
      name: p.name,
      score: p.score || 0,
      cluster: row?.cluster,
      meta: row?.metadata || {},
    };
  });
}

export default function AnswerBlock({
  suggestion, query, anchorMethods, termDictionary,
  methodClusterMap, clusterLabelMap, onMethodClick, onCiteClick,
}) {
  const domainCfg = useDomainConfig();
  const PRIORITY_DIMS = (domainCfg.priorityDims && domainCfg.priorityDims.length > 0)
    ? domainCfg.priorityDims
    : GRASP_PRIORITY_DIMS;

  // For each priority dim: 'shared' | 'differs' | 'partial' | 'gap'.
  const dimStatus = useMemo(() => {
    const out = {};
    PRIORITY_DIMS.forEach(d => {
      const vals = anchorMethods.map(m => normalize(m.meta[d.key]));
      const filled = vals.filter(Boolean);
      if (filled.length === 0) out[d.key] = 'gap';
      else if (filled.length < anchorMethods.length) out[d.key] = 'partial';
      else if (new Set(filled.map(v => v.toLowerCase())).size === 1) out[d.key] = 'shared';
      else out[d.key] = 'differs';
    });
    return out;
  }, [anchorMethods]);

  const coverage = useMemo(() => {
    const covered = PRIORITY_DIMS.filter(d => dimStatus[d.key] !== 'gap').length;
    return { covered, total: PRIORITY_DIMS.length };
  }, [dimStatus]);

  if (anchorMethods.length === 0) return null;

  const isComparison = anchorMethods.length >= 2;
  // The grounded synthesis answer (RAG+KG). The graph-traversal narrative is gone
  // — the answer is now the model's structured `insight` rendered as markdown.
  const answer = suggestion?.insight || '';
  const titleNames = anchorMethods.map(m => m.name).join(' · ');
  const title = isComparison
    ? `How ${anchorMethods.length} methods compare on the priority dimensions`
    : `Profile: ${anchorMethods[0].name}`;

  return (
    <div className="gr-answer-block">
      {/* ANSWER first — the grounded, formatted synthesis answer (markdown). The
          methods named here are the SAME set shown in the comparison table below
          (both come from the model's `discussed` selection -> paperRelevance). */}
      {answer && (
        <div className="gr-answer-synthesis">
          <div className="gr-synthesis-label">Answer</div>
          <AnswerMarkdown
            text={answer}
            termDictionary={termDictionary}
            query={query}
            citations={suggestion?.citations}
            methods={anchorMethods.map(m => m.name)}
            onMethodClick={onMethodClick}
            onCiteClick={onCiteClick}
          />
        </div>
      )}

      {/* COMPARISON next — the priority-dimension comparison table. */}
      <div className="gr-card-header">
        <Tooltip text={COMPARISON_TITLE_TOOLTIP} wide>
          <h3 className="gr-card-title">{title}</h3>
        </Tooltip>
        <span className="gr-count-badge">
          {coverage.covered} of {coverage.total} dimensions documented
        </span>
      </div>

      <p className="gr-comparison-caption">
        shared = all agree · differs = different valid choices · partial = some
        documented · gap = no data
      </p>

      <div className="gr-answer-methods">
        {anchorMethods.map(m => (
          <span
            key={m.name}
            className="gr-answer-chip"
            style={{ borderColor: clusterColor(m.cluster), color: clusterColor(m.cluster) }}
            onClick={() => onMethodClick && onMethodClick(m.name)}
          >
            {m.name}
          </span>
        ))}
      </div>

      <div className="gr-comparison-scroll">
        <table className="gr-comparison-table">
          <thead>
            <tr>
              <th className="gr-cmp-dim-h">Priority Dimension</th>
              {anchorMethods.map(m => (
                <th
                  key={m.name}
                  className="gr-cmp-method-h"
                  style={{ borderTopColor: clusterColor(m.cluster) }}
                >
                  <span style={{ color: clusterColor(m.cluster) }}>{m.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PRIORITY_DIMS.map(d => {
              const status = dimStatus[d.key];
              return (
                <tr key={d.key} className={`gr-cmp-row gr-cmp-${status}`}>
                  <td className="gr-cmp-dim">
                    <span className="gr-cmp-dim-label">{d.label}</span>
                    <Tooltip text={STATUS_TOOLTIPS[status]}>
                      <span className={`gr-cmp-status gr-cmp-status-${status}`}>
                        {status}
                      </span>
                    </Tooltip>
                  </td>
                  {anchorMethods.map(m => {
                    const v = normalize(m.meta[d.key]);
                    return (
                      <td
                        key={m.name}
                        className="gr-cmp-cell"
                        style={{ borderLeftColor: clusterColor(m.cluster) }}
                      >
                        {v ? (
                          <HighlightedText text={v} termDictionary={termDictionary} query={query} />
                        ) : (
                          <span className="gr-cmp-gap-mark">not specified</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { GRASP_PRIORITY_DIMS };
