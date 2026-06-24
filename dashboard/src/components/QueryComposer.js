import React, { useState, useMemo } from 'react';
import { buildCells, facetCounts, filterCells, humanizeFacet } from '../lib/benchmark-cells';

// The hard-gate query builder. Counts are LIVE: each facet value shows how many
// comparisons match (your current selection + that value), recomputed through the
// SAME filterCells the page uses — so a bracket count can never disagree with the
// result. A value that would yield zero is disabled, so you're never led into an
// empty result. Scene / success-criterion tokens are shown in plain English.
export default function QueryComposer({ benchmarkData, methodsIndex, onApply }) {
  const cells = useMemo(() => buildCells(benchmarkData), [benchmarkData]);
  const options = useMemo(() => facetCounts(cells, methodsIndex), [cells, methodsIndex]);
  const [sel, setSel] = useState({}); // { metric?(label), scene?, success_criterion?, gripper?, sensor?, learning_paradigm? }

  const metricIdByLabel = useMemo(() => {
    const m = {};
    for (const c of cells) if (c.metric_label) m[c.metric_label] = c.metric_id;
    return m;
  }, [cells]);

  // Map the composer's selection (metric carried as a label) to the filterCells shape.
  const selToFilter = (s) => {
    const f = {};
    if (s.metric) f.metricId = metricIdByLabel[s.metric];
    for (const k of ['scene', 'success_criterion', 'gripper', 'sensor', 'learning_paradigm']) if (s[k]) f[k] = s[k];
    return f;
  };

  const countFor = (facet, value) => filterCells(cells, selToFilter({ ...sel, [facet]: value }), methodsIndex).length;
  const total = filterCells(cells, selToFilter(sel), methodsIndex).length;
  const hasAny = Object.values(sel).some((v) => v != null && v !== '');

  const toggle = (facet, value) => setSel((s) => ({ ...s, [facet]: s[facet] === value ? undefined : value }));
  const apply = () => onApply(selToFilter(sel));

  const GROUPS = [
    { facet: 'metric', label: 'Metric', humanize: false, values: options.metric },
    { facet: 'scene', label: 'Scene', humanize: true, values: options.scene },
    { facet: 'success_criterion', label: 'Success criterion', humanize: true, values: options.success_criterion },
    { facet: 'gripper', label: 'Gripper', humanize: false, values: options.gripper },
    { facet: 'sensor', label: 'Sensor', humanize: false, values: options.sensor },
    { facet: 'learning_paradigm', label: 'Learning paradigm', humanize: false, values: options.learning_paradigm },
  ];

  return (
    <div className="benchmarks-composer">
      <div className="benchmarks-composer-prompt">
        Define the setup you want to compare under — e.g. <em>multi-finger grippers, piled scenes</em>. Pick one or
        more; the counts show how many matched comparisons remain, and greyed options have none.
      </div>

      {GROUPS.filter((g) => g.values && g.values.length).map((g) => (
        <div className="benchmarks-composer-group" key={g.facet}>
          <span className="benchmarks-composer-group-label">{g.label}</span>
          <div className="benchmarks-composer-chips">
            {g.values.map((v) => {
              const selected = sel[g.facet] === v.value;
              const cnt = countFor(g.facet, v.value);
              const disabled = cnt === 0 && !selected;
              const label = g.humanize ? humanizeFacet(v.value) : v.value;
              return (
                <button
                  key={v.value}
                  type="button"
                  className={`benchmarks-composer-chip${selected ? ' active' : ''}${disabled ? ' is-empty' : ''}`}
                  data-facet={g.facet}
                  data-value={v.value}
                  aria-pressed={selected}
                  disabled={disabled}
                  onClick={() => toggle(g.facet, v.value)}
                >
                  {label} <span className="benchmarks-composer-count">({cnt})</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="benchmarks-composer-footer">
        <span className="benchmarks-composer-total">
          {hasAny
            ? `${total} comparison${total === 1 ? '' : 's'} match`
            : 'Select at least one facet above'}
          {hasAny && total === 0 ? ' — remove a filter' : ''}
        </span>
        <button
          type="button"
          className="benchmarks-composer-apply"
          disabled={!hasAny || total === 0}
          onClick={apply}
        >
          Show matched comparisons
        </button>
      </div>
    </div>
  );
}
