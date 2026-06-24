import React, { useState } from 'react';
import { buildCells, facetCounts } from '../lib/benchmark-cells';

export default function QueryComposer({ benchmarkData, methodsIndex, onApply }) {
  const cells = buildCells(benchmarkData);
  const counts = facetCounts(cells, methodsIndex);
  const [sel, setSel] = useState({});
  const metricIdByLabel = {};
  for (const c of cells) if (c.metric_label) metricIdByLabel[c.metric_label] = c.metric_id;
  const toggle = (facet, value) => setSel((s) => ({ ...s, [facet]: s[facet] === value ? undefined : value }));
  const hasAny = Object.values(sel).some((v) => v != null && v !== '');
  const apply = () => {
    const out = {};
    if (sel.metric) out.metricId = metricIdByLabel[sel.metric];
    for (const k of ['scene', 'success_criterion', 'gripper', 'sensor', 'learning_paradigm']) if (sel[k]) out[k] = sel[k];
    onApply(out);
  };
  const GROUPS = [
    { facet: 'metric', label: 'Metric', values: counts.metric },
    { facet: 'scene', label: 'Scene', values: counts.scene },
    { facet: 'success_criterion', label: 'Success criterion', values: counts.success_criterion },
    { facet: 'gripper', label: 'Gripper', values: counts.gripper },
    { facet: 'sensor', label: 'Sensor', values: counts.sensor },
    { facet: 'learning_paradigm', label: 'Learning paradigm', values: counts.learning_paradigm },
  ];
  return (
    <div className="benchmarks-composer">
      <div className="benchmarks-composer-prompt">Define the setup to compare — e.g. multi-finger grippers in piled scenes. Pick at least one facet to see matched results.</div>
      {GROUPS.filter((g) => g.values && g.values.length).map((g) => (
        <div className="benchmarks-composer-group" key={g.facet}>
          <span className="benchmarks-composer-group-label">{g.label}</span>
          <div className="benchmarks-composer-chips">
            {g.values.map((v) => (
              <button key={v.value} type="button"
                className={`benchmarks-composer-chip${sel[g.facet] === v.value ? ' active' : ''}`}
                data-facet={g.facet} data-value={v.value} aria-pressed={sel[g.facet] === v.value}
                onClick={() => toggle(g.facet, v.value)}>{v.value} ({v.count})</button>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="benchmarks-composer-apply" disabled={!hasAny} onClick={apply}>Show matched comparisons</button>
    </div>
  );
}
