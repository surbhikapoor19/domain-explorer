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

test('renders a TABLE row per extracted record by default (no chart, no ranking)', async () => {
  render(<BenchmarksPage />);
  const results = await screen.findByTestId('bmr-results');
  // table view is the default: column headers + one row per record
  expect(within(results).getByRole('columnheader', { name: 'Method' })).toBeInTheDocument();
  expect(within(results).getByRole('columnheader', { name: 'Protocol' })).toBeInTheDocument();
  expect(within(results).getByText('GIGA')).toBeInTheDocument();
  expect(within(results).getByText('AnyGrasp')).toBeInTheDocument();
  expect(screen.getByText(/3 of 3 results/)).toBeInTheDocument();
  expect(within(results).getByText('85')).toBeInTheDocument();
  expect(within(results).getAllByText(/Packed/).length).toBeGreaterThan(0); // protocol column
});

test('view toggle switches to cards and back', async () => {
  render(<BenchmarksPage />);
  const results = await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
  expect(results.querySelector('.bmr-card')).toBeTruthy();
  expect(results.querySelector('.bmr-table')).toBeFalsy();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  expect(results.querySelector('.bmr-table')).toBeTruthy();
});

test('clicking a method opens its evidence dossier (all results, grouped by metric)', async () => {
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: /All evidence for GIGA/i }));
  const dossier = screen.getByRole('dialog', { name: /Evidence dossier for GIGA/i });
  expect(within(dossier).getByText(/1 extracted result/)).toBeInTheDocument();
  expect(within(dossier).getByRole('heading', { name: /Success Rate/ })).toBeInTheDocument();
  fireEvent.click(within(dossier).getByRole('button', { name: /Close/ }));
  expect(screen.queryByRole('dialog', { name: /Evidence dossier/i })).not.toBeInTheDocument();
});

test('Group by protocol clusters rows under a shared-protocol heading', async () => {
  render(<BenchmarksPage />);
  const results = await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: /Group by protocol/i }));
  const heads = within(results).getAllByRole('heading', { level: 3 });
  // VGN + GIGA share success_rate||packed:randomview:gsr -> one heading says 2 results share it
  const shared = heads.find(h => /2 results share this protocol/.test(h.textContent));
  expect(shared).toBeTruthy();
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

test('syncs with a copilot query: pre-filters to the queried methods + shows a banner', async () => {
  render(<BenchmarksPage queryMethods={['GIGA', 'NonexistentMethod']} />);
  const results = await screen.findByTestId('bmr-results');
  await waitFor(() => expect(screen.getByText(/1 of 3 results/)).toBeInTheDocument());
  expect(within(results).getByText('GIGA')).toBeInTheDocument();
  expect(within(results).queryByText('AnyGrasp')).not.toBeInTheDocument();
  expect(screen.getByText(/Synced to your copilot query/)).toBeInTheDocument();
  expect(screen.getByText(/1 had no benchmark data/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Show all results/ }));
  await waitFor(() => expect(screen.getByText(/3 of 3 results/)).toBeInTheDocument());
});

test('shows the copilot answer on the Benchmarks page (no need to go back to Graph)', async () => {
  const suggestion = {
    insight: 'For piled scenes, **Dex-Net 4.0** uses a suction gripper [P1].',
    citations: [{ marker: 'P1', paper_id: 'dex4', paper_title: 'Dex-Net 4.0' }],
    methodRelevance: [{ name: 'Dex-Net 4.0' }],
  };
  const { container } = render(<BenchmarksPage suggestion={suggestion} query="suction piled" />);
  await screen.findByTestId('bmr-results');
  expect(screen.getByText(/Copilot answer/i)).toBeInTheDocument();
  const answer = container.querySelector('.bmr-answer');
  expect(answer).toBeInTheDocument();
  expect(answer.textContent).toMatch(/piled scenes/);
});

test('copilot query whose methods have NO benchmark rows shows a clear message (not silent all-231)', async () => {
  render(<BenchmarksPage queryMethods={['🤖 GraspQP', '🤖 GraspVLA']} />);
  await screen.findByTestId('bmr-results');
  // neither method is in BENCH -> explicit no-data message, names cleaned of the emoji
  expect(await screen.findByText(/No extracted benchmark results/i)).toBeInTheDocument();
  expect(screen.getByText(/GraspQP or GraspVLA/)).toBeInTheDocument();
  // and it did NOT falsely claim to sync/filter
  expect(screen.queryByText(/Synced to your copilot query/)).not.toBeInTheDocument();
  expect(screen.getByText(/3 of 3 results/)).toBeInTheDocument(); // all still shown
});

test('clicking a citation in the answer opens the source modal (was dead on Benchmarks)', async () => {
  const suggestion = {
    insight: 'GIGA uses a contact-point loss [P1].',
    citations: [{ marker: 'P1', paper_id: 'giga', paper_title: 'GIGA Source Paper', index: 1,
      chunks: [{ text: 'A contact-point loss trains the network.', section: 'Method', page: 3, score: 0.6 }] }],
    methodRelevance: [{ name: 'GIGA' }],
  };
  render(<BenchmarksPage suggestion={suggestion} query="loss" />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: '[1]' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('GIGA Source Paper')).toBeInTheDocument();
});

test('global search narrows results across method/metric/paper text', async () => {
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.change(screen.getByRole('searchbox', { name: /Search results/i }), { target: { value: 'anygrasp' } });
  await waitFor(() => expect(screen.getByText(/1 of 3 results/)).toBeInTheDocument());
  const results = screen.getByTestId('bmr-results');
  expect(within(results).getByText('AnyGrasp')).toBeInTheDocument();
  expect(within(results).queryByText('GIGA')).not.toBeInTheDocument();
});

test('Group by method inserts one heading per method with its result count', async () => {
  const twoForVgn = { leaderboards: {
    'success_rate||packed': { metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'packed', higher_is_better: true,
      entries: [
        { method: 'VGN', value: 80, grade: 'B', n_reports: 1, source_papers: ['vgn'] },
        { method: 'GIGA', value: 85, grade: 'A', n_reports: 2, source_papers: ['giga'] },
      ] },
    'latency||inference-time': { metric_id: 'latency', metric_label: 'Latency (ms)', condition: 'inference-time', higher_is_better: false,
      entries: [{ method: 'VGN', value: 10, grade: 'B', n_reports: 1, source_papers: ['vgn'] }] },
  } };
  loadBenchmarkComparisons.mockResolvedValue(twoForVgn);
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: /Group by method/i }));
  const results = screen.getByTestId('bmr-results');
  const heads = within(results).getAllByRole('heading', { level: 3 });
  expect(heads).toHaveLength(2);                                   // one per method, not per record
  const vgnHead = heads.find(h => h.textContent.includes('VGN'));
  expect(vgnHead.textContent).toMatch(/2 results/);                // VGN's block spans both its records
  const gigaHead = heads.find(h => h.textContent.includes('GIGA'));
  expect(gigaHead.textContent).toMatch(/1 result/);
});

test('a pooled median is labeled honestly (median of N values, per-source values listed)', async () => {
  const pooled = { leaderboards: { 'success_rate||real': {
    metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'real', higher_is_better: true,
    entries: [{ method: 'X-Grasp', value: 89, grade: 'B', n_reports: 1, source_papers: ['xg'],
      sources: [
        { paper: 'xg', value_str: '90', metric_raw: 'SR (%)', page: 5 },
        { paper: 'xg', value_str: '88', metric_raw: 'SR (%)', page: 5 },
      ] }],
  } } };
  loadBenchmarkComparisons.mockResolvedValue(pooled);
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: 'Cards' }));       // card face carries the badge
  expect(screen.getByText(/median of 2 values/)).toBeInTheDocument();   // NOT presented as extracted
  fireEvent.click(screen.getByRole('button', { name: /^Source$/ }));
  expect(screen.getByText('90')).toBeInTheDocument();                    // each reported value visible
  expect(screen.getByText('88')).toBeInTheDocument();
});

test('the no-benchmark-data banner is dismissable', async () => {
  render(<BenchmarksPage queryMethods={['🤖 NoSuchMethod']} />);
  await screen.findByTestId('bmr-results');
  await screen.findByText(/No extracted benchmark results/i);
  fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
  expect(screen.queryByText(/No extracted benchmark results/i)).not.toBeInTheDocument();
});

test('source crop opens a full-screen lightbox, closable', async () => {
  render(<BenchmarksPage />);
  await screen.findByTestId('bmr-results');
  fireEvent.click(screen.getByRole('button', { name: 'Cards' }));         // card view: one Source per card-with-source
  fireEvent.click(screen.getByRole('button', { name: /^Source$/ }));      // expand provenance
  fireEvent.click(screen.getByRole('button', { name: /Click to enlarge/i })); // open lightbox
  const dialog = screen.getByRole('dialog');
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: /Actual size/ })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: /Close/ }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
