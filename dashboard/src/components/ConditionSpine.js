import React, { useMemo } from 'react';
import { buildCells, coverageGaps, humanizeFacet, facetCounts } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * ConditionSpine (Phase 2a)
 *
 * A persistent facet filter bar that sits near the top of the Benchmarks page.
 * It offers facet selectors for:
 *   - metric             (metric_id, labelled by metric_label)
 *   - scene              (pile / packed / real / isolated / cluttered / sim)
 *   - success_criterion  (gsr / dr / sr)
 *
 * Every facet VALUE offered is DERIVED from the actual cells (buildCells +
 * the facets each cell already parsed via parseConditionFacets) — we never
 * hardcode the option list, so a domain that only has "pile" + "packed" never
 * shows "isolated".
 *
 * Selecting a facet value calls onChange with the next condition filter object
 * (a plain { metricId?, scene?, success_criterion? }). Clicking an already
 * selected value clears it (toggle). "All" / Clear resets everything.
 *
 * A small coverage hint surfaces the single-method cells via coverageGaps()
 * so under-studied conditions read as gaps, not as a clean comparison.
 * ────────────────────────────────────────────────────────────────────────── */

// Friendly labels for the success-criterion tokens.
const CRITERION_LABELS = {
  gsr: 'gsr',
  dr: 'dr',
  sr: 'sr',
};

// Method-attribute axes offered as OPTIONAL filters (the KG/CSV join). Only the
// axes that actually have joined values render — never a hardcoded option list.
const ATTR_AXES = [
  { key: 'gripper', label: 'Gripper' },
  { key: 'sensor', label: 'Sensor' },
  { key: 'learning_paradigm', label: 'Learning' },
];

export default function ConditionSpine({ benchmarkData, value, onChange, methodsIndex = null, attrValue, onAttrChange }) {
  const filter = value || {};
  const attrFilter = attrValue || {};

  // Build the cells once, then derive the offered facet values from them.
  const { cells, gaps } = useMemo(() => {
    const c = buildCells(benchmarkData);
    return { cells: c, gaps: coverageGaps(benchmarkData) };
  }, [benchmarkData]);

  // Method-attribute facet values (gripper / sensor / learning paradigm) come from
  // the methods.json join — empty unless a methodsIndex is provided.
  const attrFacets = useMemo(() => facetCounts(cells, methodsIndex), [cells, methodsIndex]);

  // Distinct metric options (metric_id -> metric_label), preserving first-seen order.
  const metricOptions = useMemo(() => {
    const seen = new Map();
    for (const cell of cells) {
      if (cell.metric_id != null && !seen.has(cell.metric_id)) {
        seen.set(cell.metric_id, cell.metric_label || cell.metric_id);
      }
    }
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
  }, [cells]);

  // Distinct scene values present in the data (in stable order of appearance).
  const sceneOptions = useMemo(() => {
    const seen = [];
    for (const cell of cells) {
      const s = cell.facets?.scene;
      if (s != null && !seen.includes(s)) seen.push(s);
    }
    return seen;
  }, [cells]);

  // Distinct success-criterion values present in the data.
  const criterionOptions = useMemo(() => {
    const seen = [];
    for (const cell of cells) {
      const c = cell.facets?.success_criterion;
      if (c != null && !seen.includes(c)) seen.push(c);
    }
    return seen;
  }, [cells]);

  // Toggle one facet to the next value (clicking the active one clears it).
  const toggle = (facetName, facetValue) => {
    const next = { ...filter };
    if (next[facetName] === facetValue) {
      delete next[facetName];
    } else {
      next[facetName] = facetValue;
    }
    onChange(next);
  };

  // Toggle a method-attribute facet (gripper / sensor / learning_paradigm).
  const toggleAttr = (axis, axisValue) => {
    const next = { ...attrFilter };
    if (next[axis] === axisValue) delete next[axis];
    else next[axis] = axisValue;
    if (onAttrChange) onAttrChange(next);
  };

  const hasCondition =
    (filter.metricId != null && filter.metricId !== '') ||
    (filter.scene != null && filter.scene !== '') ||
    (filter.success_criterion != null && filter.success_criterion !== '');
  const hasAttr = ATTR_AXES.some((a) => attrFilter[a.key] != null && attrFilter[a.key] !== '');
  const hasAny = hasCondition || hasAttr;

  const nGaps = gaps.length;
  const nCells = cells.length;

  return (
    <div className="benchmarks-condition-spine" role="group" aria-label="Condition spine">
      {/* Metric facet */}
      {metricOptions.length > 0 && (
        <div className="benchmarks-spine-facet">
          <span className="benchmarks-spine-facet-label">Metric</span>
          <div className="benchmarks-spine-chips">
            {metricOptions.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`benchmarks-spine-chip${filter.metricId === id ? ' active' : ''}`}
                aria-pressed={filter.metricId === id}
                onClick={() => toggle('metricId', id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scene facet */}
      {sceneOptions.length > 0 && (
        <div className="benchmarks-spine-facet">
          <span className="benchmarks-spine-facet-label">Scene</span>
          <div className="benchmarks-spine-chips">
            {sceneOptions.map((s) => (
              <button
                key={s}
                type="button"
                className={`benchmarks-spine-chip${filter.scene === s ? ' active' : ''}`}
                aria-pressed={filter.scene === s}
                onClick={() => toggle('scene', s)}
              >
                {humanizeFacet(s)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Success-criterion facet */}
      {criterionOptions.length > 0 && (
        <div className="benchmarks-spine-facet">
          <span className="benchmarks-spine-facet-label">Criterion</span>
          <div className="benchmarks-spine-chips">
            {criterionOptions.map((c) => (
              <button
                key={c}
                type="button"
                className={`benchmarks-spine-chip${filter.success_criterion === c ? ' active' : ''}`}
                aria-pressed={filter.success_criterion === c}
                onClick={() => toggle('success_criterion', c)}
                title={c === 'gsr' ? 'grasp success rate' : c === 'dr' ? 'declutter rate' : c === 'sr' ? 'success rate' : c}
              >
                {humanizeFacet(c)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Method-attribute facets (gripper / sensor / learning paradigm) — the
          KG/CSV join. Each axis renders ONLY when the join produced real values. */}
      {ATTR_AXES.map(({ key, label }) => {
        const opts = attrFacets[key] || [];
        if (opts.length === 0) return null;
        return (
          <div className="benchmarks-spine-facet" key={key}>
            <span className="benchmarks-spine-facet-label">{label}</span>
            <div className="benchmarks-spine-chips">
              {opts.map(({ value: v }) => (
                <button
                  key={v}
                  type="button"
                  className={`benchmarks-spine-chip${attrFilter[key] === v ? ' active' : ''}`}
                  aria-pressed={attrFilter[key] === v}
                  onClick={() => toggleAttr(key, v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {/* All / clear */}
      <button
        type="button"
        className={`benchmarks-spine-clear${hasAny ? '' : ' active'}`}
        onClick={() => { onChange({}); if (onAttrChange) onAttrChange({}); }}
        aria-pressed={!hasAny}
      >
        All
      </button>

      {/* Coverage hint — surfaces single-method (under-studied) cells as gaps. */}
      {nGaps > 0 && (
        <div className="benchmarks-spine-coverage" title="Cells where only one method has a reported number — there is nothing to compare against yet.">
          {nGaps} of {nCells} cell{nCells !== 1 ? 's' : ''} {nGaps === 1 ? 'has' : 'have'} only one method — gaps
        </div>
      )}
    </div>
  );
}
