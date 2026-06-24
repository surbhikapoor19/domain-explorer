/* AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Task 8 — page wiring: Agreement ⇄ Coverage toggle, cell-click opens the
 * PaperTrail drawer, and the copilot↔page handshake is DRAFT-BEFORE-APPLY: a new
 * incomingPageRef stages an editable "Copilot applied: …" banner but does NOT
 * move the view until the user clicks Apply. An unresolvable cell shows a
 * "no matched comparison" state and never opens a wrong cell (the gap is the answer).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';
import { pageRef } from '../../lib/benchmark-cells';

jest.mock('react-plotly.js', () => () => null);

const FIXTURE = {
  stats: { n_comparisons: 1, n_leaderboards: 2, n_methods_indexed: 2, n_cross_validations: 1, n_quarantined: 0 },
  quarantine: {},
  leaderboards: {
    'success_rate||packed': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed', higher_is_better: true,
      entries: [
        { method: 'VGN', value: 78, grade: 'A', n_reports: 2, cv: 0.04, source_papers: ['vgn', 'edge'],
          sources: [{ paper: 'vgn', value_str: '78', condition: 'packed:gsr', table_caption: 'T1', page: 5, crop_image: '/c/vgn.png' }] },
        { method: 'GIGA', value: 70, grade: 'B', n_reports: 1, cv: 0.03, source_papers: ['giga'],
          sources: [{ paper: 'giga', value_str: '70', condition: 'packed:gsr', table_caption: 'T2', page: 6, crop_image: '/c/giga.png' }] },
      ],
    },
    'declutter_rate||real': {
      metric_id: 'declutter_rate', metric_label: 'Declutter Rate (%)', condition: 'real', higher_is_better: true,
      entries: [
        { method: 'Edge', value: 80, grade: 'B', n_reports: 1, cv: 0.02, source_papers: ['edge'],
          sources: [{ paper: 'edge', value_str: '80', condition: 'real' }] },
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
      margin: 8, grade: 'B', confidence: 0.9, paper: 'vgn', table_caption: 'T1', winner_value_str: '78',
      loser_value_str: '70', page: 5, crop_image: '/c/vgn.png' },
  ],
};

function renderPage(extraProps = {}) {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(FIXTURE);
  jest.spyOn(loader, 'loadMethods').mockResolvedValue([]);
  return render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} {...extraProps} />);
}

// Hard gate: cross it by composing the metric facet (reveals all cells for that metric).
async function compose(container) {
  await waitFor(() => expect(container.querySelector('.benchmarks-composer')).toBeTruthy());
  fireEvent.click(container.querySelector('.benchmarks-composer-chip[data-facet="metric"][data-value="Success Rate (%)"]'));
  fireEvent.click(container.querySelector('.benchmarks-composer-apply'));
}

const validRef = () => pageRef('comparisons', { cellKey: 'success_rate||packed', facets: { scene: 'packed' } });
const badRef = () => pageRef('comparisons', { cellKey: 'success_rate||nonexistent', facets: { scene: 'nonexistent' } });

describe('BenchmarksPage — view toggle + copilot draft-apply', () => {
  test('after composing, toggles between the Agreement view and the Coverage matrix', async () => {
    const { container } = renderPage();
    await compose(container);
    await waitFor(() => expect(container.querySelector('.benchmarks-agreement-row')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /coverage/i }));
    expect(container.querySelector('.benchmarks-coverage-col-head')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /agreement/i }));
    expect(container.querySelector('.benchmarks-agreement-row')).toBeTruthy();
  });

  test('a copilot pageRef stages a draft banner WITHOUT moving the view', async () => {
    const { container } = renderPage({ incomingPageRef: validRef() });
    await waitFor(() => expect(container.querySelector('.benchmarks-copilot-banner')).toBeTruthy());
    expect(container.querySelector('.benchmarks-copilot-banner')).toBeTruthy();
    // draft only: no drawer open, filter NOT yet applied
    expect(container.querySelector('.benchmarks-papertrail-drawer')).toBeNull();
    const activeChips = [...container.querySelectorAll('.benchmarks-spine-chip.active')].map((c) => c.textContent);
    expect(activeChips).not.toContain('packed');
  });

  test('Apply commits the filter and opens the referenced cell drawer', async () => {
    const { container } = renderPage({ incomingPageRef: validRef() });
    await waitFor(() => expect(container.querySelector('.benchmarks-copilot-banner')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^apply/i }));
    await waitFor(() => expect(container.querySelector('.benchmarks-papertrail-drawer')).toBeTruthy());
    const activeChips = [...container.querySelectorAll('.benchmarks-spine-chip.active')].map((c) => c.textContent);
    expect(activeChips.join(' ')).toMatch(/packed/i); // humanized label is "Packed"
  });

  test('Dismiss clears the banner and leaves the view unchanged', async () => {
    const { container } = renderPage({ incomingPageRef: validRef() });
    await waitFor(() => expect(container.querySelector('.benchmarks-copilot-banner')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(container.querySelector('.benchmarks-copilot-banner')).toBeNull();
    expect(container.querySelector('.benchmarks-papertrail-drawer')).toBeNull();
  });

  test('an unresolvable pageRef shows a no-match state and never opens a cell', async () => {
    const { container } = renderPage({ incomingPageRef: badRef() });
    await waitFor(() => expect(container.querySelector('.benchmarks-copilot-banner')).toBeTruthy());
    expect(container.querySelector('.benchmarks-copilot-nomatch')).toBeTruthy();
    const applyBtn = screen.queryByRole('button', { name: /^apply/i });
    if (applyBtn) fireEvent.click(applyBtn);
    expect(container.querySelector('.benchmarks-papertrail-drawer')).toBeNull();
  });
});
