/* AnswerBlock ordering contract — AUTHORED BY ORCHESTRATOR.
 *
 * Product direction: the copilot answer must lead. The synthesis ANSWER renders
 * BEFORE the comparison table inside AnswerBlock (and the page renders the
 * interactive plots/charts after AnswerBlock). This test pins answer-before-table
 * DOM order so a future refactor can't silently bury the answer under the table.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import AnswerBlock from '../AnswerBlock';
import DomainContext, { GRASP_DEFAULTS } from '../../DomainContext';

const ANCHORS = [
  { name: 'Contact-GraspNet', score: 0.91, cluster: 0,
    meta: { 'Object Configuration': 'Cluttered', 'Planning Method': 'Learning-based' } },
  { name: 'AnyGrasp', score: 0.82, cluster: 1,
    meta: { 'Object Configuration': 'Cluttered', 'Planning Method': 'Geometric' } },
];
const SUGGESTION = {
  intent: 'comparison',   // table renders EXPANDED only for a comparison ask
  paperRelevance: [
    { name: 'Contact-GraspNet', score: 0.91 },
    { name: 'AnyGrasp', score: 0.82 },
  ],
  insight: 'Both methods target cluttered scenes via different planning strategies.',
};

function renderBlock() {
  return render(
    <DomainContext.Provider value={GRASP_DEFAULTS}>
      <AnswerBlock
        suggestion={SUGGESTION}
        query="compare grasp planners for cluttered scenes"
        anchorMethods={ANCHORS}
        termDictionary={{}}
        methodClusterMap={{}}
        clusterLabelMap={{}}
        onMethodClick={() => {}}
      />
    </DomainContext.Provider>,
  );
}

describe('AnswerBlock answer-first ordering', () => {
  test('renders an "Answer" synthesis section carrying the insight text', () => {
    renderBlock();
    const label = screen.getByText(/^Answer$/);
    expect(label).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/different planning strategies/i);
    // The old "Graph Analysis" label for the buried synthesis is gone.
    expect(screen.queryByText(/^Graph Analysis$/)).not.toBeInTheDocument();
  });

  test('the Answer synthesis appears BEFORE the comparison table in DOM order', () => {
    const { container } = renderBlock();
    const answer = container.querySelector('.gr-answer-synthesis');
    const table = container.querySelector('.gr-comparison-table');
    expect(answer).not.toBeNull();
    expect(table).not.toBeNull();
    // Node.DOCUMENT_POSITION_FOLLOWING (4) => table follows answer.
    // eslint-disable-next-line no-bitwise
    expect(answer.compareDocumentPosition(table) & 4).toBeTruthy();
  });
});
