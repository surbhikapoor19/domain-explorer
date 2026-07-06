/* AnswerBlock collapse contract (redesign C) — AUTHORED BY ORCHESTRATOR.
 * The comparison table is an APPENDIX unless the user asked a comparison:
 * collapsed to one line for other intents, no redundant chips row, gap rows
 * folded, CSV quote artifacts stripped, headers are the method affordance. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AnswerBlock from '../AnswerBlock';
import DomainContext, { GRASP_DEFAULTS } from '../../DomainContext';

const ANCHORS = [
  { name: 'DexDiffuser', score: 0.9, cluster: 0,
    meta: { 'Planning Method': 'Generative', 'Training Data': 'Sim',
            'Object Configuration': '"Singulated"' } },       // quote artifact on purpose
  { name: 'GraspGen', score: 0.8, cluster: 1,
    meta: { 'Planning Method': 'Generative', 'Training Data': 'Sim',
            'Object Configuration': 'Singulated' } },
];

function renderWith(intent, extra = {}) {
  const suggestion = {
    intent,
    paperRelevance: ANCHORS.map(a => ({ name: a.name, score: a.score })),
    insight: 'DexDiffuser needs evaluator-guided diffusion; GraspGen has slow sampling.',
  };
  return render(
    <DomainContext.Provider value={GRASP_DEFAULTS}>
      <AnswerBlock suggestion={suggestion} query="limitations of diffusion methods"
        anchorMethods={ANCHORS} termDictionary={{}} methodClusterMap={{}}
        clusterLabelMap={{}} onMethodClick={extra.onMethodClick || (() => {})} />
    </DomainContext.Provider>,
  );
}

test('non-comparison intent: table collapsed to a one-line expand affordance', () => {
  renderWith('default');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  const expand = screen.getByRole('button', { name: /Compare these 2 methods/i });
  fireEvent.click(expand);
  expect(screen.getByRole('table')).toBeInTheDocument();       // expands on demand
});

test('comparison intent: table open by default, collapsible', () => {
  renderWith('comparison');
  expect(screen.getByRole('table')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Collapse/i }));
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('no redundant chips row; the column header IS the method affordance', () => {
  const onMethodClick = jest.fn();
  const { container } = renderWith('comparison', { onMethodClick });
  expect(container.querySelector('.gr-answer-chip')).toBeNull();          // chips row gone
  fireEvent.click(screen.getByRole('button', { name: /Highlight DexDiffuser/i }));
  expect(onMethodClick).toHaveBeenCalledWith('DexDiffuser');
});

test('all-gap dimensions fold behind a reveal toggle', () => {
  renderWith('comparison');
  // GRASP defaults include dims neither anchor documents (e.g. Input / Sensor)
  expect(screen.queryByText('Input / Sensor')).not.toBeInTheDocument();
  const toggle = screen.getByRole('button', { name: /dimensions? with no documented data/i });
  fireEvent.click(toggle);
  expect(screen.getByText('Input / Sensor')).toBeInTheDocument();
});

test('CSV quote artifacts are stripped from cell values', () => {
  renderWith('comparison');
  const cells = screen.getAllByText('Singulated');
  expect(cells.length).toBe(2);                                  // both cells, no `"Singulated"`
  expect(screen.queryByText('"Singulated"')).not.toBeInTheDocument();
});
