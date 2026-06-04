/* Proof / view-source UI test — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * Every published number must be traceable to its source: the exact printed cell text,
 * the table caption, and the rendered table-crop image. */
import { render, screen, fireEvent, within } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';

jest.mock('react-plotly.js', () => () => null);

const V2 = {
  leaderboards: {
    'success_rate||pile': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null,
      condition: 'pile', higher_is_better: true,
      entries: [{
        method: 'AnyGrasp', value: 86.9, median: 86.9, n_reports: 1, cv: 0, grade: 'B',
        source_papers: ['anygrasp'],
        sources: [{
          paper: 'anygrasp', value_str: '86.9 ± 1.2', table_caption: 'Table 2: SR on pile (%)',
          page: 4, extractor: 'tei_table', crop_image: '/data-grasp-planning/crops/anygrasp_t1.png',
        }],
      }],
    },
  },
  cross_validations: [], comparisons: [], method_index: {},
  quarantine: { n_records: 0, reasons: {} },
  stats: {
    n_comparisons: 1, n_leaderboards: 1, n_methods_indexed: 1,
    n_cross_validations: 0, n_grade_a: 0, n_quarantined: 0,
  },
};

beforeEach(() => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(V2);
});

test('every number exposes a view-source control', async () => {
  render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} />);
  await screen.findByText('AnyGrasp');
  expect(screen.getByRole('button', { name: /source|proof/i })).toBeInTheDocument();
});

test('view-source reveals raw cell text, caption, and the table crop image', async () => {
  render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} />);
  await screen.findByText('AnyGrasp');
  fireEvent.click(screen.getByRole('button', { name: /source|proof/i }));

  // exact printed cell text (not just the parsed float)
  expect(screen.getByText(/86\.9\s*±\s*1\.2/)).toBeInTheDocument();
  // the table caption it was extracted from
  expect(screen.getByText(/Table 2: SR on pile/)).toBeInTheDocument();
  // the rendered table-crop image, sourced from the saved crop path
  const img = screen.getByRole('img', { name: /source|crop|proof|table/i });
  expect(img).toHaveAttribute('src', '/data-grasp-planning/crops/anygrasp_t1.png');
});
