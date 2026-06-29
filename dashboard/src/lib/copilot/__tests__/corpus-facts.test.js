/* corpus-facts — AUTHORED BY ORCHESTRATOR. Pins the derived-superlatives contract
 * the copilot uses to resolve references like "the top-cited method". */
import { computeCorpusFacts, formatCorpusFacts } from '../corpus-facts';

const KG = {
  nodes: [
    { id: 'paper:a', paper_id: 'a', type: 'paper', methods: ['Alpha'], pagerank: 0.5, n_comparisons: 2 },
    { id: 'paper:b', paper_id: 'b', type: 'paper', methods: ['Beta'], pagerank: 0.1, n_comparisons: 9 },
    { id: 'paper:c', paper_id: 'c', type: 'paper', methods: ['Gamma'], pagerank: 0.2, n_comparisons: 1 },
    { id: 'tech:x', type: 'technique', label: 'Sampling' },
  ],
  links: [
    { type: 'cites', source: 'paper:b', target: 'paper:a' },
    { type: 'cites', source: 'paper:c', target: 'paper:a' },
    { type: 'cites', source: 'paper:a', target: 'paper:b' },
    { type: 'authored_by', source: 'paper:a', target: 'auth:1' },
  ],
};
const METHODS = [
  { name: 'Alpha', metadata: { 'Year (Initial Release)': '2018' } },
  { name: 'Beta', metadata: { 'Year (Initial Release)': '2024' } },
  { name: 'Gamma', metadata: { 'Year (Initial Release)': '2021' } },
];
const BENCH = {
  leaderboards: {
    'm1||c1': { entries: [{ method: 'Alpha' }, { method: 'Beta' }] },
    'm1||c2': { entries: [{ method: 'Alpha' }] },
  },
};

test('top-cited = most incoming `cites` edges', () => {
  const { facts } = computeCorpusFacts({ methods: METHODS, kg: KG, benchmarks: BENCH });
  expect(facts.mostCited).toEqual({ name: 'Alpha', count: 2 });
});

test('most influential = highest pagerank; most-compared = highest n_comparisons', () => {
  const { facts } = computeCorpusFacts({ methods: METHODS, kg: KG });
  expect(facts.mostInfluential.name).toBe('Alpha');
  expect(facts.mostCompared).toEqual({ name: 'Beta', count: 9 });
});

test('newest / oldest by release year', () => {
  const { facts } = computeCorpusFacts({ methods: METHODS, kg: null });
  expect(facts.newest).toEqual({ name: 'Beta', year: 2024 });
  expect(facts.oldest).toEqual({ name: 'Alpha', year: 2018 });
});

test('most-benchmarked = most leaderboard entries', () => {
  const { facts } = computeCorpusFacts({ methods: METHODS, benchmarks: BENCH });
  expect(facts.mostBenchmarked).toEqual({ name: 'Alpha', count: 2 });
});

test('factsText is a non-empty block naming the top-cited method', () => {
  const { factsText } = computeCorpusFacts({ methods: METHODS, kg: KG, benchmarks: BENCH });
  expect(factsText).toMatch(/Top-cited within this corpus: Alpha/);
});

test('defensive on empty / partial input', () => {
  expect(computeCorpusFacts({}).facts).toEqual({});
  expect(computeCorpusFacts({}).factsText).toBe('');
  expect(formatCorpusFacts({})).toBe('');
});
