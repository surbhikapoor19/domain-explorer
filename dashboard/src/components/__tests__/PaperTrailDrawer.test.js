/* AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Task 6 — PaperTrail drawer. Clicking a cell opens a side drawer with three
 * stacked parts: (1) the cell comparison (reuses ComparisonsView — head-to-head
 * for 2 methods / within-cell rank for N, NEVER a pooled mean), (2) a
 * Reproducibility Card per method (the record schema + replication tier +
 * do-not-compare list), and (3) a provenance crop viewer (every source's table
 * image, caption, page).
 *
 * Honesty guards pinned here: a card shows "not reported" for fields we never
 * extracted (never invented), and the drawer NEVER renders a pooled mean across
 * the cell's different methods.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import PaperTrailDrawer from '../PaperTrailDrawer';
import { buildCells, buildMethodsIndex } from '../../lib/benchmark-cells';

const BENCH = {
  leaderboards: {
    'success_rate||packed': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed', higher_is_better: true,
      entries: [
        { method: 'VGN', value: 78, grade: 'A', n_reports: 2, cv: 0.04, source_papers: ['vgn', 'edge'],
          sources: [{ paper: 'vgn', value_str: '78', condition: 'packed:gsr', table_caption: 'TABLE I', page: 5, crop_image: '/c/vgn.png' }] },
        { method: 'GIGA', value: 70, grade: 'B', n_reports: 1, cv: 0.03, source_papers: ['giga'],
          sources: [{ paper: 'giga', value_str: '70', condition: 'packed:gsr', table_caption: 'TABLE II', page: 6, crop_image: '/c/giga.png' }] },
      ],
    },
  },
  cross_validations: [
    { method: 'VGN', metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed',
      mean: 78, cv: 0.04, status: 'consistent', grade: 'A', n_papers: 2,
      reports: [{ paper: 'vgn', value: 78, value_str: '78', condition: 'packed:gsr', page: 5, crop_image: '/c/vgn.png' }] },
  ],
  comparisons: [
    { winner: 'VGN', loser: 'GIGA', metric_id: 'success_rate', condition: 'packed', winner_value: 78, loser_value: 70,
      margin: 8, grade: 'B', confidence: 0.8, paper: 'vgn', table_caption: 'TABLE I', winner_value_str: '78',
      loser_value_str: '70', page: 5, crop_image: '/c/vgn.png' },
  ],
};

const CELL = buildCells(BENCH).find((c) => c.key === 'success_rate||packed');

function props(overrides = {}) {
  return { cell: CELL, data: [], selectedPoint: null, onSelect: () => {}, onClose: () => {}, ...overrides };
}

describe('PaperTrailDrawer', () => {
  test('shows the cell metric + condition header', () => {
    const { container } = render(<PaperTrailDrawer {...props()} />);
    const title = container.querySelector('.benchmarks-cell-title');
    expect(title).toBeTruthy();
    expect(title.textContent).toMatch(/Success Rate/);
  });

  test('renders one Reproducibility Card per method, each with a tier + do-not-compare list', () => {
    const { container } = render(<PaperTrailDrawer {...props()} />);
    expect(container.querySelectorAll('.benchmarks-card-tier').length).toBe(CELL.entries.length); // 2
    expect(container.querySelectorAll('.benchmarks-card-dnc-item').length).toBeGreaterThan(0);
  });

  test('the provenance viewer renders an image for each source crop', () => {
    const { container } = render(<PaperTrailDrawer {...props()} />);
    // 2 entries × 1 source each = 2 crops in the dedicated provenance viewer
    expect(container.querySelectorAll('.benchmarks-papertrail-crops img').length).toBe(2);
  });

  test('"not reported" fields are visible (never invented)', () => {
    const { container } = render(<PaperTrailDrawer {...props()} />);
    const vals = [...container.querySelectorAll('.benchmarks-card-factor-val')];
    expect(vals.length).toBeGreaterThanOrEqual(8);
    expect(vals.some((el) => el.textContent === 'not reported')).toBe(true);
  });

  test('the close control and backdrop both fire onClose', () => {
    const onClose = jest.fn();
    const { container } = render(<PaperTrailDrawer {...props({ onClose })} />);
    fireEvent.click(container.querySelector('.benchmarks-drawer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.benchmarks-drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('honesty guard: NEVER renders a pooled mean across the cell\'s methods', () => {
    const { container } = render(<PaperTrailDrawer {...props()} />);
    expect(container.querySelector('.benchmarks-pooled-mean')).toBeNull();
  });
});

// ── Task 7: KG enrichment wired into the drawer ──────────────────────────────
const METHODS_IDX = buildMethodsIndex([
  { Name: 'VGN', 'Gripper Type': 'Parallel-jaw', 'Input Data': 'TSDF', 'Backbone': 'UNet', 'Learning Paradigm': 'Classical', 'End-effector Hardware': 'Two-finger' },
]);

const CTX = {
  'success_rate||packed': {
    differences: [{ axis: 'gripper', values: { VGN: 'Parallel-jaw', GIGA: 'Multi-finger' }, differ: true, source: 'method-typical (KG/CSV)' }],
    relations: { citations: [{ from_paper: 'giga', to_paper: 'vgn', stance: 'differs_from' }], technique_lineage: { per_paper_backbones: {}, shared_backbones: [], builds_on_pairs: [] }, outperforms: [] },
  },
};

describe('PaperTrailDrawer — KG enrichment', () => {
  test('mounts the "Why they differ" section when cell_context is provided', () => {
    const { container } = render(<PaperTrailDrawer {...props({ cellContext: CTX, methodsIndex: METHODS_IDX })} />);
    expect(container.querySelector('.benchmarks-celldiff')).toBeTruthy();
  });

  test('fills a Reproducibility Card "not reported" gripper slot from the attribute join (source-tagged)', () => {
    // cellContext WITHOUT differences -> "Parallel-jaw" can only come from the CARD fill.
    const { container } = render(<PaperTrailDrawer {...props({ cellContext: {}, methodsIndex: METHODS_IDX })} />);
    expect(container.textContent).toMatch(/Parallel-jaw/);   // VGN gripper filled from methods.json
    expect(container.textContent).toMatch(/method-typical/i); // carries its source tag
  });

  test('back-compat: no cell_context / no methodsIndex renders no "Why they differ" and does not crash', () => {
    const { container } = render(<PaperTrailDrawer {...props()} />);
    expect(container.querySelector('.benchmarks-celldiff')).toBeNull();
    expect(container.querySelector('.benchmarks-papertrail-drawer')).toBeTruthy();
  });
});
