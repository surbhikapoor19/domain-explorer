/* AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Task 9 — hard-gate navigation + KG-enriched drawer wiring. The page opens as a
 * query builder: NO metrics until ≥1 facet is composed. Composing reveals the
 * scoped metrics; opening a cell shows the drawer's "Why they differ"
 * (cell_context), and a "Change query" control returns to the composer.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';

jest.mock('react-plotly.js', () => () => null);

const FIXTURE = {
  stats: { n_comparisons: 1, n_leaderboards: 1, n_methods_indexed: 2, n_cross_validations: 1, n_quarantined: 0 },
  quarantine: {},
  leaderboards: {
    'success_rate||packed': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed', higher_is_better: true,
      entries: [
        { method: 'VGN', value: 78, grade: 'A', n_reports: 2, cv: 0.04, source_papers: ['vgn'],
          sources: [{ paper: 'vgn', value_str: '78', condition: 'packed:gsr', page: 5, crop_image: '/c/vgn.png' }] },
        { method: 'GIGA', value: 70, grade: 'B', n_reports: 1, cv: 0.03, source_papers: ['giga'],
          sources: [{ paper: 'giga', value_str: '70', condition: 'packed:gsr', page: 6, crop_image: '/c/giga.png' }] },
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
      margin: 8, grade: 'B', confidence: 0.8, paper: 'vgn', winner_value_str: '78', loser_value_str: '70', page: 5, crop_image: '/c/vgn.png' },
  ],
  cell_context: {
    'success_rate||packed': {
      differences: [{ axis: 'gripper', values: { VGN: 'Parallel-jaw', GIGA: 'Multi-finger' }, differ: true, source: 'method-typical (KG/CSV)' }],
      relations: { citations: [{ from_paper: 'giga', to_paper: 'vgn', stance: 'differs_from' }], technique_lineage: { per_paper_backbones: {}, shared_backbones: [], builds_on_pairs: [] }, outperforms: [{ winner_paper: 'vgn', loser_paper: 'giga', kind: 'stated', evidence: 'VGN edges GIGA on packed' }] },
    },
  },
};

const METHODS = [
  { Name: 'VGN', 'Gripper Type': 'Parallel-jaw', 'Input Data': 'TSDF' },
  { Name: 'GIGA', 'Gripper Type': 'Multi-finger', 'Input Data': 'Point cloud' },
];

function renderPage() {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(FIXTURE);
  jest.spyOn(loader, 'loadMethods').mockResolvedValue(METHODS);
  return render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} />);
}

// Show-all-by-default: agreement rows render on load — just wait for them.
async function compose(container) {
  await waitFor(() => expect(container.querySelector('.benchmarks-agreement-row')).toBeTruthy());
}

describe('BenchmarksPage — show-all + KG drawer', () => {
  test('shows all comparisons on load — agreement rows + the Agreement/Coverage toggle are present', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.benchmarks-agreement-row')).toBeTruthy());
    expect(container.querySelector('.benchmarks-tabs')).toBeTruthy(); // Agreement/Coverage toggle present
  });

  test('opening a cell shows "Why they differ" (KG context in the drawer)', async () => {
    const { container } = renderPage();
    await compose(container);
    fireEvent.click(container.querySelector('.benchmarks-agreement-row'));
    await waitFor(() => expect(container.querySelector('.benchmarks-papertrail-drawer')).toBeTruthy());
    expect(container.querySelector('.benchmarks-celldiff')).toBeTruthy(); // KG context wired into the drawer
  });

  test('a "?" above the table opens the in-app walkthrough help', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.benchmarks-condition-spine')).toBeTruthy());
    const help = container.querySelector('.benchmarks-help-btn');
    expect(help).toBeTruthy(); // the "?" is present from the start (above the table)
    fireEvent.click(help);
    expect(container.querySelector('.benchmarks-help-modal')).toBeTruthy();
    expect(container.querySelector('.benchmarks-help-modal iframe')).toBeTruthy(); // surfaces the walkthrough in-app
  });
});
