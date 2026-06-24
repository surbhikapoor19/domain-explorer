/* AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Task 8 — the hard-gate query builder. Idea 5: the researcher defines the setup
 * (scene + method attributes) BEFORE any metric appears. Facets are data-derived
 * with live counts (so a query is never empty); Apply is disabled until ≥1 facet
 * is chosen; method-attribute facets (gripper/sensor) come from the KG/CSV join.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import QueryComposer from '../QueryComposer';
import { buildMethodsIndex } from '../../lib/benchmark-cells';

const BENCH = {
  leaderboards: {
    'success_rate||packed': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed', higher_is_better: true,
      entries: [{ method: 'VGN', value: 78, source_papers: ['vgn'] }],
    },
    'success_rate||pile': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'pile', higher_is_better: true,
      entries: [{ method: 'GIGA', value: 70, source_papers: ['giga'] }],
    },
  },
  cross_validations: [], comparisons: [],
};

const METHODS_IDX = buildMethodsIndex([
  { Name: 'VGN', 'Gripper Type': 'Parallel-jaw', 'Input Data': 'TSDF' },
  { Name: 'GIGA', 'Gripper Type': 'Multi-finger', 'Input Data': 'Point cloud' },
]);

function renderComposer(onApply = () => {}) {
  return render(<QueryComposer benchmarkData={BENCH} methodsIndex={METHODS_IDX} onApply={onApply} />);
}

describe('QueryComposer', () => {
  test('renders data-derived facet chips with live counts (incl. method-attribute facets)', () => {
    const { container } = renderComposer();
    const packed = container.querySelector('.benchmarks-composer-chip[data-facet="scene"][data-value="packed"]');
    expect(packed).toBeTruthy();
    expect(packed.textContent).toMatch(/\(1\)/); // live count
    // method-attribute facets come from the KG/CSV join
    expect(container.querySelector('.benchmarks-composer-chip[data-facet="gripper"][data-value="Multi-finger"]')).toBeTruthy();
    expect(container.querySelector('.benchmarks-composer-chip[data-facet="gripper"][data-value="Parallel-jaw"]')).toBeTruthy();
  });

  test('Apply is disabled until at least one facet is chosen', () => {
    const { container } = renderComposer();
    const apply = container.querySelector('.benchmarks-composer-apply');
    expect(apply).toBeTruthy();
    expect(apply).toBeDisabled();
    fireEvent.click(container.querySelector('.benchmarks-composer-chip[data-facet="gripper"][data-value="Multi-finger"]'));
    expect(apply).not.toBeDisabled();
  });

  test('Apply emits the selected facets (gripper) and maps the metric label to its id', () => {
    const onApply = jest.fn();
    const { container } = renderComposer(onApply);
    fireEvent.click(container.querySelector('.benchmarks-composer-chip[data-facet="gripper"][data-value="Multi-finger"]'));
    fireEvent.click(container.querySelector('.benchmarks-composer-chip[data-facet="metric"][data-value="Success Rate (%)"]'));
    fireEvent.click(container.querySelector('.benchmarks-composer-apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const facets = onApply.mock.calls[0][0];
    expect(facets.gripper).toBe('Multi-finger');
    expect(facets.metricId).toBe('success_rate'); // label -> id mapping
  });

  test('toggling a selected chip clears it (Apply disabled again)', () => {
    const { container } = renderComposer();
    const chip = container.querySelector('.benchmarks-composer-chip[data-facet="gripper"][data-value="Multi-finger"]');
    const apply = container.querySelector('.benchmarks-composer-apply');
    fireEvent.click(chip);
    expect(apply).not.toBeDisabled();
    fireEvent.click(chip);
    expect(apply).toBeDisabled();
  });
});
