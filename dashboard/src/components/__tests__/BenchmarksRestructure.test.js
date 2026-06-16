/* Benchmarks PAGE restructure (Phase 2a) — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * The Benchmarks page is being restructured per round-3 research from three co-equal tabs
 * (Agreement / Leaderboards / Head-to-Head) into:
 *
 *   1) A default "Reproducibility" view (the renamed Agreement view): one method across
 *      papers, split consistent vs contested.
 *   2) A persistent CONDITION SPINE — a facet filter bar (metric / scene / success_criterion)
 *      whose values are derived from the actual cells (buildCells + parseConditionFacets) and
 *      which FILTERS the visible cells/results via findCells().
 *   3) A cell-scoped COMPARISONS drill-down: clicking a result (a method in a metric × condition
 *      cell) opens a comparison scoped to that ONE cell — head-to-head with a delta when the cell
 *      has 2 methods, a within-cell ranking when it has N — each row badged with the cell facets,
 *      under a caption that the ranking is valid ONLY within this cell.
 *   4) An incomingPageRef prop { view, cellKey, conditionFilter } that deep-links the page.
 *
 * The old standalone Leaderboards and Head-to-Head TABS are REMOVED (their data is reachable
 * via spine -> cell -> Comparisons).
 *
 * These assertions intentionally FAIL against the current implementation (which renders three
 * tabs, defaults to "Agreement", has no condition spine, no cell-scoped Comparisons view, and
 * ignores incomingPageRef) — correct TDD red. */
import { render, screen, fireEvent, within } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';
import { CELL_KEY } from '../../lib/benchmark-cells';

// Plotly cannot run in jsdom — replace with a no-op so component tests focus on logic.
jest.mock('react-plotly.js', () => () => null);

/* ── Fixture ─────────────────────────────────────────────────────────────────
 * Three metric × condition cells across two scenes:
 *   - success_rate || pile:gsr   -> 2 methods (head-to-head cell, has a comparison row)
 *   - success_rate || packed:dr  -> 3 methods (within-cell ranking cell)
 *   - success_rate || real:sr    -> 1 method  (single-method / coverage-gap cell)
 * cross_validations: one consistent (pile:gsr) + one high_variance (packed:dr).
 * One comparison row scoped to the pile:gsr cell with winner/loser/margin/crop_image. */
const PILE_KEY   = CELL_KEY('success_rate', 'pile:gsr');    // success_rate||pile:gsr
const PACKED_KEY = CELL_KEY('success_rate', 'packed:dr');   // success_rate||packed:dr

const DATA = {
  leaderboards: {
    [PILE_KEY]: {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null,
      condition: 'pile:gsr', higher_is_better: true,
      entries: [
        { method: 'NeuGraspNet', value: 86.51, median: 86.51, n_reports: 2, cv: 0.02, grade: 'A',
          confidence: 0.9, source_papers: ['neugraspnet', 'graspnet-eval'] },
        { method: 'PointNetGPD', value: 79.79, median: 79.79, n_reports: 1, cv: 0.03, grade: 'B',
          confidence: 0.85, source_papers: ['pointnetgpd'] },
      ],
    },
    [PACKED_KEY]: {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null,
      condition: 'packed:dr', higher_is_better: true,
      entries: [
        { method: 'GIGA',     value: 88.4, median: 88.4, n_reports: 2, cv: 0.05, grade: 'A',
          confidence: 0.9, source_papers: ['giga', 'vgn-followup'] },
        { method: 'AnyGrasp', value: 84.2, median: 84.2, n_reports: 1, cv: 0.04, grade: 'B',
          confidence: 0.88, source_papers: ['anygrasp'] },
        { method: 'GPD',      value: 71.2, median: 71.2, n_reports: 1, cv: 0.41, grade: 'C',
          confidence: 0.8, source_papers: ['gpd'] },
      ],
    },
    'success_rate||real:sr': {
      metric_id: 'success_rate', metric_label: 'Success Rate (%)', dataset_id: null,
      condition: 'real:sr', higher_is_better: true,
      entries: [
        { method: 'LonelyMethod', value: 64.0, median: 64.0, n_reports: 1, cv: 0, grade: 'B',
          confidence: 0.82, source_papers: ['solo-paper'] },
      ],
    },
  },
  cross_validations: [
    {
      method: 'NeuGraspNet', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
      dataset_id: null, condition: 'pile:gsr', n_papers: 2, mean: 86.2, cv: 0.02,
      status: 'consistent', grade: 'A',
      reports: [
        { paper: 'neugraspnet',   value: 86.51, value_str: '86.51', condition: 'pile:gsr' },
        { paper: 'graspnet-eval', value: 85.9,  value_str: '85.9',  condition: 'pile:gsr' },
      ],
    },
    {
      method: 'GPD', metric_id: 'success_rate', metric_label: 'Success Rate (%)',
      dataset_id: null, condition: 'packed:dr', n_papers: 3, mean: 71.2, cv: 0.41,
      status: 'high_variance', grade: 'C',
      reports: [
        { paper: 'gpd',            value: 89.0, value_str: '89.0', condition: 'packed:dr' },
        { paper: 'benchmark-2021', value: 62.5, value_str: '62.5', condition: 'packed:dr' },
        { paper: 'survey-2022',    value: 62.1, value_str: '62.1', condition: 'packed:dr' },
      ],
    },
  ],
  comparisons: [
    {
      winner: 'NeuGraspNet', loser: 'PointNetGPD', metric_id: 'success_rate',
      condition: 'pile:gsr', winner_value: 86.51, loser_value: 79.79, margin: 6.72,
      grade: 'B', confidence: 0.78, paper: 'neugraspnet',
      table_caption: 'TABLE I: NeuGraspNet vs. baselines on Pile and Packed',
      extractor: 'tei_table',
      winner_value_str: '86.51 ± 1.42', loser_value_str: '79.79 ± 2.28',
      page: 6, crop_image: '/data-grasp-planning/crops/neugraspnet_t0.png',
    },
  ],
  method_index: {},
  quarantine: { n_records: 42, reasons: { unresolved_header: 42 } },
  stats: {
    n_comparisons: 1, n_leaderboards: 3, n_methods_indexed: 6,
    n_cross_validations: 2, n_grade_a: 2, n_quarantined: 42,
  },
};

beforeEach(() => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(DATA);
});

// Wait for the page to finish loading (data resolved).
async function renderPage(props = {}) {
  const utils = render(
    <BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} {...props} />
  );
  await screen.findByText(/reproducib/i);
  return utils;
}

// ── (a) Reproducibility view is the DEFAULT landing ──────────────────────────
test('(a) the Reproducibility view is the default landing (renamed from Agreement)', async () => {
  await renderPage();

  // The view's label/heading uses "Reproducibility" wording, visible without interaction.
  expect(screen.getByText(/reproducib/i)).toBeInTheDocument();

  // The active tab is the reproducibility view (NOT something called only "agreement").
  const activeTab = document.querySelector('.benchmarks-tab.active');
  expect(activeTab).toBeTruthy();
  expect(activeTab.textContent).toMatch(/reproducib/i);

  // Its consistent/contested split survives the rename: both buckets render.
  expect(screen.getByText(/^consistent$/i)).toBeInTheDocument();
  expect(screen.getByText(/^contested$/i)).toBeInTheDocument();

  // The consistent method is on screen straight away, and the subtitle frames the view
  // as "one method across papers".
  expect(screen.getByText('NeuGraspNet')).toBeInTheDocument();
  expect(
    screen.getByText(/one method across papers|consistent vs contested/i)
  ).toBeInTheDocument();
});

// ── (b) Condition spine renders facet controls for metric and scene ──────────
test('(b) a condition spine renders facet controls for metric and scene (data-derived)', async () => {
  const { container } = await renderPage();

  // A persistent facet bar exists.
  const spine = container.querySelector('.benchmarks-condition-spine');
  expect(spine).toBeTruthy();

  // It surfaces a metric facet control and a scene facet control.
  expect(within(spine).getByText(/metric/i)).toBeInTheDocument();
  expect(within(spine).getByText(/scene/i)).toBeInTheDocument();

  // The scene facet values are DERIVED from the actual cells (pile / packed / real),
  // not hardcoded — every parsed scene in the data is offered as a selectable facet.
  expect(within(spine).getByText(/\bpile\b/i)).toBeInTheDocument();
  expect(within(spine).getByText(/\bpacked\b/i)).toBeInTheDocument();
  expect(within(spine).getByText(/\breal\b/i)).toBeInTheDocument();

  // A coverage hint surfaces the single-method gap (1 of 3 cells has only one method).
  expect(screen.getByText(/gap/i)).toBeInTheDocument();
});

// ── (c) Selecting a scene facet narrows the visible cells (findCells-driven) ──
test('(c) selecting a scene facet narrows the visible cells via findCells', async () => {
  const { container } = await renderPage();

  // Before filtering, methods from multiple scenes are reachable in the reproducibility view.
  expect(screen.getByText('NeuGraspNet')).toBeInTheDocument(); // pile cell (consistent)
  expect(screen.getByText('GPD')).toBeInTheDocument();         // packed cell (contested)

  // Select the "packed" scene facet in the spine.
  const spine = container.querySelector('.benchmarks-condition-spine');
  const packedControl = within(spine).getByText(/\bpacked\b/i);
  fireEvent.click(packedControl);

  // Now only packed-scene results remain — the pile cell's consistent entry is gone,
  // while the packed cell's contested entry stays.
  expect(screen.queryByText('NeuGraspNet')).not.toBeInTheDocument();
  expect(screen.getByText('GPD')).toBeInTheDocument();
});

// ── (d) Clicking a result opens a cell-scoped Comparisons view ───────────────
test('(d) clicking a result opens the cell-scoped Comparisons view with caption + facet badge', async () => {
  await renderPage();

  // Click a reproducibility result to drill into its (metric × condition) cell.
  fireEvent.click(screen.getByText('NeuGraspNet'));

  // The cell-scoped caption appears verbatim — the ranking is valid ONLY within this cell.
  expect(
    await screen.findByText(/valid only within this cell/i)
  ).toBeInTheDocument();

  // Both methods of the pile:gsr cell are shown in the comparison.
  expect(screen.getByText('NeuGraspNet')).toBeInTheDocument();
  expect(screen.getByText('PointNetGPD')).toBeInTheDocument();

  // The cell facets are badged so it can never read as a global rank — the scene (pile)
  // and success criterion (gsr) of this cell are surfaced.
  expect(screen.getByText(/\bpile\b/i)).toBeInTheDocument();
  expect(screen.getByText(/\bgsr\b/i)).toBeInTheDocument();

  // A 2-method cell renders a head-to-head with the delta/margin from the comparison row.
  expect(screen.getByText(/6\.72/)).toBeInTheDocument();
});

// ── (e) The old standalone Leaderboards and Head-to-Head TABS are gone ───────
test('(e) the old standalone Leaderboards and Head-to-Head tabs are removed', async () => {
  await renderPage();

  const tabBar = document.querySelector('.benchmarks-tabs');
  expect(tabBar).toBeTruthy();
  const tabLabels = Array.from(tabBar.querySelectorAll('.benchmarks-tab'))
    .map(t => (t.textContent || '').trim());

  // No tab is labelled "Leaderboards" or "Head-to-Head" any more.
  expect(tabLabels.some(l => /leaderboard/i.test(l))).toBe(false);
  expect(tabLabels.some(l => /head[\s-]*to[\s-]*head/i.test(l))).toBe(false);

  // There is no tab BUTTON for them either (they merged into the cell-scoped Comparisons surface).
  expect(
    within(tabBar).queryByRole('button', { name: /^leaderboards$/i })
  ).not.toBeInTheDocument();
  expect(
    within(tabBar).queryByRole('button', { name: /head[\s-]*to[\s-]*head/i })
  ).not.toBeInTheDocument();
});

// ── (f) incomingPageRef opens the named cell directly ────────────────────────
test('(f) incomingPageRef { view:"comparisons", cellKey } opens that cell directly', async () => {
  await renderPage({ incomingPageRef: { view: 'comparisons', cellKey: PILE_KEY, conditionFilter: null } });

  // The page opens straight into the cell-scoped Comparisons view for the pile:gsr cell,
  // without any user interaction — the caption and both methods are present.
  expect(
    await screen.findByText(/valid only within this cell/i)
  ).toBeInTheDocument();
  expect(screen.getByText('NeuGraspNet')).toBeInTheDocument();
  expect(screen.getByText('PointNetGPD')).toBeInTheDocument();

  // And it scoped to the RIGHT cell: the unrelated packed-cell-only method is not shown.
  expect(screen.queryByText('AnyGrasp')).not.toBeInTheDocument();
});
