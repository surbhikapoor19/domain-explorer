/* BenchmarksPage (redesigned) — AUTHORED BY ORCHESTRATOR. The page is a flat,
 * tag-filtered view of the extracted data: result cards + a collapsible/searchable
 * tag rail (AND across categories / OR within), a Method facet listing every
 * method, and a full-screen lightbox for the source-table crop. No ranking, no
 * charts. Method names appear BOTH in the rail (Method facet) and on cards, so
 * card assertions are scoped to the results region via the bmr-results testid. */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';

jest.mock('../../lib/data-loader', () => ({ loadBenchmarkComparisons: jest.fn() }));
// eslint-disable-next-line import/first
import { loadBenchmarkComparisons } from '../../lib/data-loader';

const BENCH = {
  leaderboards: {
    'success_rate||packed:randomview:gsr': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed:randomview:gsr', higher_is_better: true,
      entries: [
        { method: 'VGN', value: 80, grade: 'B', n_reports: 1, source_papers: ['vgn'] },
        { method: 'GIGA', value: 85, grade: 'A', n_reports: 2, source_papers: ['giga', 'x'] },
      ],
    },
    'success_rate||pile': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'pile', higher_is_better: true,
      entries: [{
        method: 'AnyGrasp', value: 70, grade: 'B', n_reports: 1, source_papers: ['any'],
        sources: [{ crop_image: 'data:image/png;base64,iVBORw0KGgo=', table_caption: 'Table 2: results' }],
      }],
    },
  },
};

beforeEach(() => { loadBenchmarkComparisons.mockResolvedValue(BENCH); });

test('renders a result card per extracted record (no chart), alphabetical', async () => {
  render(<BenchmarksPage />);
  const results = await screen.findByTestId('bmr-results');
  // method names + value + protocol chip show inside the results region
  expect(within(results).getByText('GIGA')).toBeInTheDocument();
  expect(within(results).getByText('AnyGrasp')).toBeInTheDocument();
  expect(screen.getByText(/3 of 3 results/)).toBeInTheDocument();
  expect(within(results).getByText('85')).toBeInTheDocument();
  expect(within(results).getAllByText('Packed').length).toBeGreaterThan(0);
});

test('selecting a tag filters the results (AND across categories)', async () => {
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: /^Pile/ })); // Scene: pile (facet open by default)
  await waitFor(() => expect(screen.getByText(/1 of 3 results/)).toBeInTheDocument());
  const results = screen.getByTestId('bmr-results');
  expect(within(results).getByText('AnyGrasp')).toBeInTheDocument();
  expect(within(results).queryByText('GIGA')).not.toBeInTheDocument();
});

test('Method facet filters to a single method', async () => {
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  // Method facet (3 options) is open by default; click the GIGA option
  fireEvent.click(screen.getByRole('button', { name: /^GIGA/ }));
  await waitFor(() => expect(screen.getByText(/1 of 3 results/)).toBeInTheDocument());
  const results = screen.getByTestId('bmr-results');
  expect(within(results).getByText('GIGA')).toBeInTheDocument();
  expect(within(results).queryByText('AnyGrasp')).not.toBeInTheDocument();
});

test('Clear resets the selection', async () => {
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: /^Pile/ }));
  await screen.findByText(/1 of 3 results/);
  fireEvent.click(screen.getByRole('button', { name: /^Clear/ }));
  await waitFor(() => expect(screen.getByText(/3 of 3 results/)).toBeInTheDocument());
});

test('paginates results at 30 per page', async () => {
  const many = { leaderboards: { 'success_rate||packed': {
    metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed', higher_is_better: true,
    entries: Array.from({ length: 35 }, (_, i) => ({ method: `M${String(i).padStart(2, '0')}`, value: i, grade: 'B', n_reports: 1, source_papers: ['p'] })),
  } } };
  loadBenchmarkComparisons.mockResolvedValue(many);
  render(<BenchmarksPage />);
  const results = await screen.findByTestId('bmr-results');
  expect(within(results).getAllByText(/^M\d\d$/).length).toBe(30);       // page 1 = 30 cards
  expect(screen.getByText(/Showing 1.30 of 35 results/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));        // → page 2
  await waitFor(() => expect(screen.getByText(/Showing 31.35 of 35 results/)).toBeInTheDocument());
  expect(within(screen.getByTestId('bmr-results')).getAllByText(/^M\d\d$/).length).toBe(5);
});

test('source crop opens a full-screen lightbox, closable', async () => {
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: /^Source$/ }));      // expand provenance
  fireEvent.click(screen.getByRole('button', { name: /Click to enlarge/i })); // open lightbox
  const dialog = screen.getByRole('dialog');
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: /Actual size/ })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: /Close/ }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
