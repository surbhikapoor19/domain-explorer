/* Min-confidence filter — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * Extracted metrics below the threshold (grade C / weak / disputed) must be hidden,
 * and reappear when the threshold is lowered. */
import { render, screen } from '@testing-library/react';
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

test('hides entries below the min-confidence threshold', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA);
  render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} minConfidence={0.70} />);
  expect(await screen.findByText('StrongMethod')).toBeInTheDocument();
  expect(screen.queryByText('WeakMethod')).not.toBeInTheDocument();   // 0.40 < 0.70 -> hidden
});

test('low-confidence entries reappear when the threshold is lowered', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA);
  render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} minConfidence={0.30} />);
  expect(await screen.findByText('WeakMethod')).toBeInTheDocument();   // 0.40 >= 0.30 -> shown
});
