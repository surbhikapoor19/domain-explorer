/* Benchmarks PAGE structure — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Updated 2026-06-17 for the redesign (see docs/superpowers/specs/2026-06-17-
 * benchmarks-page-redesign-design.md). The page now offers:
 *
 *   1) A default "Agreement" view (dumbbell rows: one method across papers, split
 *      consistent vs contested) with an Agreement ⇄ Coverage toggle.
 *   2) A persistent CONDITION SPINE — a facet filter bar (metric / scene /
 *      success_criterion) whose values are DERIVED from the actual cells and which
 *      FILTERS the visible cells/results via findCells().
 *   3) A cell-scoped PaperTrail DRAWER: clicking a result opens a drawer scoped to
 *      that ONE (metric × condition) cell — head-to-head with a delta for 2 methods,
 *      a within-cell ranking for N — each row badged with the cell facets, under a
 *      caption that the ranking is valid ONLY within this cell.
 *   4) An incomingPageRef { view, cellKey, conditionFilter } that the copilot emits.
 *      The page stages it as a DRAFT (a "Copilot applied: …" banner) and only moves
 *      the view when the user clicks Apply (draft-before-apply).
 *
 * The old standalone Leaderboards and Head-to-Head TABS are REMOVED. */
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
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
 * cross_validations: one consistent (pile:gsr) + one high_variance (packed:dr). */
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
  jest.spyOn(loader, 'loadMethods').mockResolvedValue([]);
});

// Show-all-by-default: the page renders every comparison on load (no gate).
async function renderPage(props = {}) {
  const utils = render(
    <BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} {...props} />
  );
  await waitFor(() => expect(utils.container.querySelector('.benchmarks-condition-spine')).toBeTruthy());
  return utils;
}

// Show-all-by-default: agreement rows render on load — just wait for them.
async function compose(container) {
  await waitFor(() => expect(container.querySelector('.benchmarks-agreement-row')).toBeTruthy());
}

// ── (a) Show-all: the consistent/contested split is visible on load ──────────
test('(a) shows all comparisons on load — the consistent/contested split appears without composing', async () => {
  const { container } = await renderPage();

  await compose(container);

  // The consistent/contested split + the consistent method appear immediately.
  expect(screen.getByText(/^consistent$/i)).toBeInTheDocument();
  expect(screen.getByText(/^contested$/i)).toBeInTheDocument();
  expect(screen.getByText('NeuGraspNet')).toBeInTheDocument();
});

// ── (g) Method-attribute facets (gripper) come from the KG/CSV join ──────────
test('(g) the spine offers a gripper facet from the join; selecting one narrows the cells', async () => {
  // Methods carry a gripper attribute so the join produces a real facet axis.
  loader.loadMethods.mockResolvedValue([
    { Name: 'NeuGraspNet', 'Gripper Type': 'Parallel-jaw' },
    { Name: 'PointNetGPD', 'Gripper Type': 'Parallel-jaw' },
    { Name: 'GPD', 'Gripper Type': 'Suction' },
  ]);
  const { container } = await renderPage();
  await compose(container);

  const spine = container.querySelector('.benchmarks-condition-spine');
  // The gripper facet + its DERIVED values appear once the join resolves (never hardcoded).
  expect(await within(spine).findByText(/^gripper$/i)).toBeInTheDocument();
  expect(within(spine).getByText(/parallel-jaw/i)).toBeInTheDocument();
  expect(within(spine).getByText(/suction/i)).toBeInTheDocument();

  // Filtering by the suction gripper keeps only the cell whose method uses it.
  fireEvent.click(within(spine).getByText(/suction/i));
  expect(screen.getByText('GPD')).toBeInTheDocument();
  expect(screen.queryByText('NeuGraspNet')).not.toBeInTheDocument();
});

// ── (b) Condition spine renders facet controls for metric and scene ──────────
test('(b) a condition spine renders facet controls for metric and scene (data-derived)', async () => {
  const { container } = await renderPage();
  await compose(container);

  const spine = container.querySelector('.benchmarks-condition-spine');
  expect(spine).toBeTruthy();

  expect(within(spine).getByText(/metric/i)).toBeInTheDocument();
  expect(within(spine).getByText(/scene/i)).toBeInTheDocument();

  // The scene facet values are DERIVED from the actual cells (pile / packed / real).
  expect(within(spine).getByText(/\bpile\b/i)).toBeInTheDocument();
  expect(within(spine).getByText(/\bpacked\b/i)).toBeInTheDocument();
  expect(within(spine).getByText(/\breal\b/i)).toBeInTheDocument();

  // A coverage hint surfaces the single-method gap (1 of 3 cells has only one method).
  expect(screen.getByText(/gap/i)).toBeInTheDocument();
});

// ── (c) Selecting a scene facet narrows the visible cells (findCells-driven) ──
test('(c) selecting a scene facet narrows the visible cells via findCells', async () => {
  const { container } = await renderPage();
  await compose(container);

  expect(screen.getByText('NeuGraspNet')).toBeInTheDocument(); // pile cell (consistent)
  expect(screen.getByText('GPD')).toBeInTheDocument();         // packed cell (contested)

  const spine = container.querySelector('.benchmarks-condition-spine');
  fireEvent.click(within(spine).getByText(/\bpacked\b/i));

  // Now only packed-scene results remain.
  expect(screen.queryByText('NeuGraspNet')).not.toBeInTheDocument();
  expect(screen.getByText('GPD')).toBeInTheDocument();
});

// ── (d) Clicking a result opens the cell-scoped PaperTrail DRAWER ─────────────
test('(d) clicking a result opens the cell-scoped drawer with caption + facet badge + delta', async () => {
  const { container } = await renderPage();
  await compose(container);

  fireEvent.click(screen.getByText('NeuGraspNet'));

  const drawer = await waitFor(() => {
    const d = container.querySelector('.benchmarks-papertrail-drawer');
    expect(d).toBeTruthy();
    return d;
  });

  // Scope to the comparison subsection (the drawer also stacks per-method
  // Reproducibility Cards, which repeat the method names + facet values).
  const cmp = drawer.querySelector('.benchmarks-comparisons-section');
  expect(within(cmp).getByText(/valid only within this cell/i)).toBeInTheDocument();
  expect(within(cmp).getByText('NeuGraspNet')).toBeInTheDocument();
  expect(within(cmp).getByText('PointNetGPD')).toBeInTheDocument();
  // The cell facets are badged so it can never read as a global rank.
  expect(within(cmp).getByText(/\bpile\b/i)).toBeInTheDocument();
  expect(within(cmp).getByText(/\bgsr\b/i)).toBeInTheDocument();
  // A 2-method cell renders the delta/margin from the comparison row.
  expect(within(cmp).getByText(/6\.72/)).toBeInTheDocument();
});

// ── (e) The old standalone Leaderboards and Head-to-Head TABS are gone ───────
test('(e) the old standalone Leaderboards and Head-to-Head tabs are removed', async () => {
  const { container } = await renderPage();
  await compose(container);

  const tabBar = document.querySelector('.benchmarks-tabs');
  expect(tabBar).toBeTruthy();
  const tabLabels = Array.from(tabBar.querySelectorAll('.benchmarks-tab'))
    .map(t => (t.textContent || '').trim());

  expect(tabLabels.some(l => /leaderboard/i.test(l))).toBe(false);
  expect(tabLabels.some(l => /head[\s-]*to[\s-]*head/i.test(l))).toBe(false);

  expect(
    within(tabBar).queryByRole('button', { name: /^leaderboards$/i })
  ).not.toBeInTheDocument();
  expect(
    within(tabBar).queryByRole('button', { name: /head[\s-]*to[\s-]*head/i })
  ).not.toBeInTheDocument();
});

// ── (f) incomingPageRef DRAFTS a banner; Apply opens that exact cell ──────────
test('(f) incomingPageRef stages a draft banner; Apply opens the named cell', async () => {
  const { container } = await renderPage({
    incomingPageRef: { view: 'comparisons', cellKey: PILE_KEY, conditionFilter: null },
  });

  // Draft-before-apply: the banner is staged, the drawer is NOT open yet.
  expect(container.querySelector('.benchmarks-copilot-banner')).toBeTruthy();
  expect(container.querySelector('.benchmarks-papertrail-drawer')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /^apply/i }));

  const drawer = await waitFor(() => {
    const d = container.querySelector('.benchmarks-papertrail-drawer');
    expect(d).toBeTruthy();
    return d;
  });

  const cmp = drawer.querySelector('.benchmarks-comparisons-section');
  expect(within(cmp).getByText(/valid only within this cell/i)).toBeInTheDocument();
  expect(within(cmp).getByText('NeuGraspNet')).toBeInTheDocument();
  expect(within(cmp).getByText('PointNetGPD')).toBeInTheDocument();
  // Scoped to the RIGHT cell: the packed-only method is absent everywhere.
  expect(screen.queryByText('AnyGrasp')).not.toBeInTheDocument();
});
