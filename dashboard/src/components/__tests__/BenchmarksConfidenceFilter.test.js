/* Min-confidence filter — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * Extracted metrics below the threshold (grade C / weak / disputed) must be hidden,
 * and reappear when the threshold is lowered. */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';

jest.mock('react-plotly.js', () => () => null);

const DATA = {
  leaderboards: { 'success_rate||pile': {
    metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null, condition: 'pile',
    higher_is_better: true,
    entries: [
      { method: 'StrongMethod', value: 90, median: 90, n_reports: 3, cv: 0.03, grade: 'A', confidence: 0.9, source_papers: ['a'] },
      { method: 'WeakMethod', value: 50, median: 50, n_reports: 1, cv: 0.5, grade: 'C', confidence: 0.4, source_papers: ['b'] },
    ] } },
  cross_validations: [], comparisons: [], method_index: {},
  quarantine: { n_records: 0, reasons: {} },
  stats: { n_comparisons: 0, n_leaderboards: 1, n_methods_indexed: 0, n_cross_validations: 0, n_grade_a: 1, n_quarantined: 0 },
};

beforeEach(() => {
  jest.spyOn(loader, 'loadMethods').mockResolvedValue([]);
});

// Show-all-by-default: data renders on load; just wait for it (no gate to cross).
async function composed(props = {}) {
  const utils = render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} {...props} />);
  await waitFor(() => expect(utils.container.querySelector('.benchmarks-condition-spine')).toBeTruthy());
  return utils;
}

test('hides entries below the min-confidence threshold', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA);
  await composed({ minConfidence: 0.70 });
  expect(await screen.findByText('StrongMethod')).toBeInTheDocument();
  expect(screen.queryByText('WeakMethod')).not.toBeInTheDocument();   // 0.40 < 0.70 -> hidden
});

test('low-confidence entries reappear when the threshold is lowered', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA);
  await composed({ minConfidence: 0.30 });
  expect(await screen.findByText('WeakMethod')).toBeInTheDocument();   // 0.40 >= 0.30 -> shown
});

// The confidence gate must announce what it withholds — a researcher should never
// silently see a thinner list with no indication results were hidden.
const DATA_CV = {
  leaderboards: { 'success_rate||pile': {
    metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null, condition: 'pile',
    higher_is_better: true,
    entries: [
      { method: 'StrongMethod', value: 90, median: 90, n_reports: 3, cv: 0.03, grade: 'A', confidence: 0.9, source_papers: ['a'] },
    ] } },
  cross_validations: [
    { method: 'StrongMethod', metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'pile',
      mean: 90, cv: 0.03, status: 'consistent', grade: 'A', confidence: 0.9, n_papers: 3, reports: [] },
    { method: 'WeakCV', metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'pile',
      mean: 50, cv: 0.5, status: 'high_variance', grade: 'C', confidence: 0.4, n_papers: 2, reports: [] },
  ],
  comparisons: [], method_index: {},
  quarantine: { n_records: 0, reasons: {} },
  stats: { n_comparisons: 0, n_leaderboards: 1, n_methods_indexed: 1, n_cross_validations: 2, n_grade_a: 1, n_quarantined: 0 },
};

test('the confidence gate is not silent — it announces how many cross-paper results are hidden', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA_CV);
  const { container } = await composed({ minConfidence: 0.70 });
  const hidden = container.querySelector('.benchmarks-confidence-hidden');
  expect(hidden).toBeTruthy();                                          // 0.40 < 0.70 -> 1 hidden
  expect(hidden.textContent).toMatch(/1 cross-paper result hidden below 70% confidence/i);
});

test('lowering the threshold clears the hidden-count indicator', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA_CV);
  const { container } = await composed({ minConfidence: 0.30 });
  expect(container.querySelector('.benchmarks-confidence-hidden')).toBeNull(); // 0.40 >= 0.30 -> none hidden
});
