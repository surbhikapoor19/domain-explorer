import { render, screen } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';

// Plotly cannot run in jsdom — replace with a no-op so component tests can focus on logic.
jest.mock('react-plotly.js', () => () => null);

const V2 = {
  leaderboards: { 'success_rate||pile': {
    metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null, condition: 'pile',
    higher_is_better: true,
    entries: [
      {method: 'AnyGrasp', value: 86.9, median: 86.9, n_reports: 3, cv: 0.03, grade: 'A', source_papers: ['anygrasp']},
      {method: 'GPD', value: 70.1, median: 70.1, n_reports: 1, cv: 0, grade: 'B', source_papers: ['gpd']}]}},
  cross_validations: [{method: 'GIGA', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
    dataset_id: null, n_papers: 5, mean: 74.9, cv: 0.16, status: 'different_setup', grade: 'C', reports: []}],
  comparisons: [], method_index: {},
  quarantine: {n_records: 156, reasons: {}},
  stats: {n_comparisons: 394, n_leaderboards: 1, n_methods_indexed: 2,
          n_cross_validations: 1, n_grade_a: 1, n_quarantined: 156},
};

test('renders v2 leaderboard with grade badge and quarantine count', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(V2);
  render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} />);
  expect(await screen.findByText(/Success Rate/)).toBeInTheDocument();
  expect(screen.getByText('AnyGrasp')).toBeInTheDocument();
  expect(screen.getByText(/156/)).toBeInTheDocument();   // quarantine count
});
