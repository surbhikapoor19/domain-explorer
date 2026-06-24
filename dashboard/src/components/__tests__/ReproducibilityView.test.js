/* AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Agreement row — NUMBERS-FORWARD (decided 2026-06-24, supersedes the dumbbell
 * chart). Each row shows the verdict glyph (✓ agree / ⚠ contested / ○ single),
 * the per-paper values INLINE as text, a headline value, and a plain-language
 * spread. NO chart: the dumbbell SVG is gone (it was a lone dot for the common
 * single-source rows). The Wilson/trust PURE helpers remain unit-tested in
 * benchmark-cells.test.js; only the chart rendering is removed here.
 */
import React from 'react';
import { render } from '@testing-library/react';
import ReproducibilityView from '../ReproducibilityView';

const cv = {
  method: 'VGN', metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed',
  mean: 78, cv: 0.03, status: 'consistent', grade: 'A', n_papers: 2,
  reports: [
    { paper: 'vgn', value: 76, value_str: '76', condition: 'packed' },
    { paper: 'edge', value: 80, value_str: '80', condition: 'packed' },
  ],
};

function baseProps(crossValidations, unreproducedCells = []) {
  return {
    crossValidations,
    totalCrossValidations: crossValidations.length,
    minConfidence: 0,
    unreproducedCells,
    onOpenCell: () => {},
    showMetric: true,
  };
}

describe('ReproducibilityView — numbers-forward Agreement row', () => {
  test('renders each paper value INLINE as text (not a chart)', () => {
    const { container } = render(<ReproducibilityView {...baseProps([cv])} />);
    const vals = [...container.querySelectorAll('.benchmarks-agreement-value')].map((e) => e.textContent).join(' ');
    expect(vals).toMatch(/76/);
    expect(vals).toMatch(/80/);
  });

  test('keeps the verdict glyph and the plain-language spread', () => {
    const { container } = render(<ReproducibilityView {...baseProps([cv])} />);
    expect(container.querySelector('.benchmarks-agreement-verdict')).toBeTruthy();
    expect(container.querySelector('.benchmarks-agreement-spread')).toBeTruthy();
  });

  test('does NOT render the dumbbell chart anymore', () => {
    const { container } = render(<ReproducibilityView {...baseProps([cv])} />);
    expect(container.querySelector('.benchmarks-dumbbell-svg')).toBeNull();
    expect(container.querySelector('.benchmarks-dumbbell-dot')).toBeNull();
    expect(container.querySelector('.benchmarks-dumbbell-wilson')).toBeNull();
  });

  test('a single-source row reads cleanly — one value, no chart', () => {
    const cell = {
      key: 'declutter_rate||real', metric_id: 'declutter_rate', metric_label: 'Declutter Rate (%)', condition: 'real',
      facets: { scene: 'real' },
      entries: [{ method: 'Edge', value: 70, value_str: '70', grade: 'B', source_papers: ['edge'] }],
    };
    const { container } = render(<ReproducibilityView {...baseProps([], [cell])} />);
    const vals = [...container.querySelectorAll('.benchmarks-agreement-value')].map((e) => e.textContent).join(' ');
    expect(vals).toMatch(/70/);
    expect(container.querySelector('.benchmarks-dumbbell-svg')).toBeNull();
  });
});
