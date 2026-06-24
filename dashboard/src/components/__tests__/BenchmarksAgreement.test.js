/* Cross-Paper AGREEMENT view (UNIT B1) — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * The Benchmarks page must DEFAULT to a reproducibility/agreement view built entirely on
 * benchmarkData.cross_validations. The view answers "what replicates vs what is contested":
 *   - it lands by default (no tab click),
 *   - it leads with a hero count of independently-reproduced (consistent) results,
 *   - it splits entries into a CONSISTENT section and a CONTESTED section
 *     (high_variance / different_setup are contested, never consistent),
 *   - it renders the per-paper spread (each report's value) for every entry.
 *
 * This intentionally FAILS against the current implementation, which defaults to the
 * "leaderboards" tab — correct TDD red. */
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';

// Plotly cannot run in jsdom — replace with a no-op so component tests can focus on logic.
jest.mock('react-plotly.js', () => () => null);

// Fixture: 2 consistent (reproduced) + 1 high_variance (contested) cross-validations.
// Each carries the full v2 cross_validation shape the Agreement view renders from.
const DATA = {
  leaderboards: {
    'success_rate||pile': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null, condition: 'pile',
      higher_is_better: true,
      entries: [
        { method: 'AnyGrasp', value: 86.9, median: 86.9, n_reports: 2, cv: 0.03, grade: 'A', source_papers: ['anygrasp'] },
      ],
    },
  },
  cross_validations: [
    {
      method: 'AnyGrasp', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
      dataset_id: null, condition: 'pile', n_papers: 2, mean: 86.4, cv: 0.04,
      status: 'consistent', grade: 'A',
      reports: [
        { paper: 'anygrasp', value: 86.9, value_str: '86.9', condition: 'pile' },
        { paper: 'graspnet-eval', value: 85.9, value_str: '85.9', condition: 'pile' },
      ],
    },
    {
      method: 'GIGA', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
      dataset_id: null, condition: 'packed', n_papers: 2, mean: 88.1, cv: 0.02,
      status: 'consistent', grade: 'A',
      reports: [
        { paper: 'giga', value: 88.4, value_str: '88.4', condition: 'packed' },
        { paper: 'vgn-followup', value: 87.8, value_str: '87.8', condition: 'packed' },
      ],
    },
    {
      method: 'GPD', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
      dataset_id: null, condition: 'clutter', n_papers: 3, mean: 71.2, cv: 0.41,
      status: 'high_variance', grade: 'C',
      reports: [
        { paper: 'gpd', value: 89.0, value_str: '89.0', condition: 'clutter' },
        { paper: 'benchmark-2021', value: 62.5, value_str: '62.5', condition: 'clutter' },
        { paper: 'survey-2022', value: 62.1, value_str: '62.1', condition: 'clutter' },
      ],
    },
  ],
  comparisons: [], method_index: {},
  quarantine: { n_records: 0, reasons: {} },
  stats: {
    n_comparisons: 0, n_leaderboards: 1, n_methods_indexed: 1,
    n_cross_validations: 3, n_grade_a: 2, n_quarantined: 0,
  },
};

const N_CONSISTENT = DATA.cross_validations.filter(v => v.status === 'consistent').length;       // 2
const CONTESTED = DATA.cross_validations.filter(v => v.status !== 'consistent');                  // [GPD]

beforeEach(() => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA);
  jest.spyOn(loader, 'loadMethods').mockResolvedValue([]);
});

// Hard gate: render + compose the (single) metric facet to reveal the metrics.
async function composed(props = {}) {
  const utils = render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} {...props} />);
  await waitFor(() => expect(utils.container.querySelector('.benchmarks-composer')).toBeTruthy());
  fireEvent.click(utils.container.querySelector('.benchmarks-composer-chip[data-facet="metric"][data-value="Success Rate (%)"]'));
  fireEvent.click(utils.container.querySelector('.benchmarks-composer-apply'));
  return utils;
}

// (a) The Agreement / Reproducibility view renders by DEFAULT — no tab click needed.
test('lands on the agreement/reproducibility view by default', async () => {
  await composed();
  // The view's framing words must be visible without any interaction.
  expect(await screen.findByText('AnyGrasp')).toBeInTheDocument();
  // The active tab is the agreement view, not the leaderboards tab.
  const activeTab = document.querySelector('.benchmarks-tab.active');
  expect(activeTab).toBeTruthy();
  expect(activeTab.textContent).toMatch(/agreement|reproducibility/i);
  // The consistent entries are on screen straight away (no click to reach them).
  expect(screen.getByText('AnyGrasp')).toBeInTheDocument();
  expect(screen.getByText('GIGA')).toBeInTheDocument();
});

// (b) The hero reproduced-count equals the number of consistent entries.
test('hero count equals the number of consistent (reproduced) entries', async () => {
  await composed();
  await screen.findByText('AnyGrasp');

  // The hero leads with "N results independently reproduced under matched conditions".
  const hero = screen.getByText(
    (_, node) =>
      /independently reproduced under matched conditions/i.test(node?.textContent || '') &&
      // restrict to the element that actually owns the phrase (not ancestors)
      Array.from(node?.children || []).every(
        c => !/independently reproduced under matched conditions/i.test(c.textContent || '')
      )
  );
  expect(hero).toBeInTheDocument();
  expect(hero.textContent).toMatch(new RegExp(`\\b${N_CONSISTENT}\\b`));   // hero shows "2"
});

// (c) Both a CONSISTENT section and a CONTESTED section render with their entries.
test('renders both a consistent section and a contested section with their entries', async () => {
  await composed();
  await screen.findByText('AnyGrasp');

  // Section headings for each bucket.
  const consistentHeading = screen.getByText(/^consistent$/i);
  const contestedHeading  = screen.getByText(/^contested$/i);
  expect(consistentHeading).toBeInTheDocument();
  expect(contestedHeading).toBeInTheDocument();

  // The two consistent methods are present; the contested method is present.
  expect(screen.getByText('AnyGrasp')).toBeInTheDocument();
  expect(screen.getByText('GIGA')).toBeInTheDocument();
  expect(screen.getByText('GPD')).toBeInTheDocument();
});

// (d) A high_variance entry is presented as CONTESTED, not consistent.
test('a high_variance entry is grouped under contested, not consistent', async () => {
  const { container } = await composed();
  await screen.findByText('AnyGrasp');

  // Locate the contested section by its heading and assert GPD lives inside it.
  const contestedHeading = screen.getByText(/^contested$/i);
  const contestedSection = contestedHeading.closest('section, div');
  expect(contestedSection).toBeTruthy();
  expect(within(contestedSection).getByText('GPD')).toBeInTheDocument();

  // And GPD must NOT appear inside the consistent section.
  const consistentHeading = screen.getByText(/^consistent$/i);
  const consistentSection = consistentHeading.closest('section, div');
  expect(consistentSection).toBeTruthy();
  expect(within(consistentSection).queryByText('GPD')).not.toBeInTheDocument();

  // The contested count (= number of non-consistent entries) is surfaced somewhere.
  expect(container.textContent).toMatch(new RegExp(`\\b${CONTESTED.length}\\b`));
});

// (e) The per-paper report values appear (the spread, not just the mean).
test('shows the per-paper report values for each entry', async () => {
  await composed();
  await screen.findByText('AnyGrasp');

  // Consistent entry: both papers' values are printed (a value may also appear in
  // the min..mean..max spread strip, so allow >=1 occurrence).
  expect(screen.getAllByText(/86\.9/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/85\.9/).length).toBeGreaterThan(0);

  // Contested entry: the disagreeing per-paper values are printed.
  expect(screen.getAllByText(/89\.0/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/62\.5/).length).toBeGreaterThan(0);
});
