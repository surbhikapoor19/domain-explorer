/* AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Task 5 — Coverage gap-finder. The SAME cells the Agreement view renders, re-laid
 * as a condition × metric matrix so the EMPTY intersections (untested) read as
 * whitespace/opportunity, and a robvis-style traffic-light surfaces *reporting*
 * gaps (which confound axes a paper did/didn't disclose). You only ever read DOWN
 * one matched column — cross-cell comparison is structurally impossible here.
 *
 * Honesty: an empty intersection is a GAP, never a zero; the traffic-light marks a
 * confound axis "missing" when the source didn't report it (from reproducibilityCard).
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import CoverageMatrix from '../CoverageMatrix';

// 2 metrics (success_rate, declutter_rate) × 2 conditions (packed, pile), but
// declutter_rate||pile is INTENTIONALLY ABSENT -> exactly one coverage gap.
const BENCH = {
  leaderboards: {
    'success_rate||packed': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed', higher_is_better: true,
      entries: [
        { method: 'VGN', value: 76, grade: 'A', n_reports: 2, cv: 0.04, source_papers: ['vgn', 'edge'],
          sources: [{ paper: 'vgn', value_str: '76', condition: 'packed:gsr', page: 5, crop_image: '/c/vgn.png' }] },
      ],
    },
    'success_rate||pile': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'pile', higher_is_better: true,
      entries: [
        { method: 'GIGA', value: 60, grade: 'B', n_reports: 1, cv: 0.03, source_papers: ['giga'],
          sources: [{ paper: 'giga', value_str: '60', condition: 'pile', page: 3 }] },
      ],
    },
    'declutter_rate||packed': {
      metric_id: 'declutter_rate', metric_label: 'Declutter Rate (%)', condition: 'packed', higher_is_better: true,
      entries: [
        { method: 'Edge', value: 80, grade: 'B', n_reports: 1, cv: 0.02, source_papers: ['edge'],
          sources: [{ paper: 'edge', value_str: '80', condition: 'packed' }] },
      ],
    },
  },
  cross_validations: [],
  comparisons: [],
};

function props(overrides = {}) {
  return { benchmarkData: BENCH, conditionFilter: {}, onOpenCell: () => {}, ...overrides };
}

describe('CoverageMatrix', () => {
  test('renders one column per metric and one row per condition', () => {
    const { container } = render(<CoverageMatrix {...props()} />);
    expect(container.querySelectorAll('.benchmarks-coverage-col-head').length).toBe(2); // 2 metrics
    expect(container.querySelectorAll('.benchmarks-coverage-row-head').length).toBe(2); // 2 conditions
  });

  test('the untested intersection is rendered as a gap, not a zero', () => {
    const { container } = render(<CoverageMatrix {...props()} />);
    // exactly one (metric × condition) has no cell: declutter_rate || pile
    expect(container.querySelectorAll('.benchmarks-coverage-gap').length).toBe(1);
  });

  test('clicking a filled intersection opens that exact cell by CELL_KEY', () => {
    const onOpenCell = jest.fn();
    const { container } = render(<CoverageMatrix {...props({ onOpenCell })} />);
    const cell = container.querySelector('[data-cell-key="success_rate||packed"]');
    expect(cell).toBeTruthy();
    fireEvent.click(cell);
    expect(onOpenCell).toHaveBeenCalledWith('success_rate||packed');
  });

  test('the robvis traffic-light marks reported vs missing confound axes', () => {
    const { container } = render(<CoverageMatrix {...props()} />);
    const reported = container.querySelectorAll('.benchmarks-robvis-tile.reported');
    const missing = container.querySelectorAll('.benchmarks-robvis-tile.missing');
    // scene is reported (from the condition); gripper/arm/sensor/etc are not -> both present
    expect(reported.length).toBeGreaterThan(0);
    expect(missing.length).toBeGreaterThan(0);
  });
});
