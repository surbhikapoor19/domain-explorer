/* CitationModal — AUTHORED BY ORCHESTRATOR. Clicking a citation must open the
 * passage that supports THAT claim (not the paper's top query chunk), highlight
 * the shared terms, and be honest when the source doesn't actually back the claim. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CitationModal from '../CitationModal';

const cite = {
  index: 2, paper_id: 'giga', paper_title: 'GIGA',
  chunks: [
    { text: 'GIGA is evaluated on packed and pile scenes.', section: 'Experiments', page: 5, score: 0.7 },
    { text: 'A contact-point loss with binary cross-entropy trains the network.', section: 'Method', page: 3, score: 0.6 },
  ],
};

test('opens the passage best matching the claim, terms highlighted', () => {
  const { container } = render(
    <CitationModal data={{ cite, claimText: 'It uses a contact-point loss with binary cross-entropy [P2].' }} onClose={() => {}} />);
  expect(screen.getByText('GIGA')).toBeInTheDocument();
  const passage = container.querySelector('.cite-modal-passage');
  expect(passage.textContent).toMatch(/contact-point loss/i);       // the METHOD chunk, not Experiments
  expect(container.querySelectorAll('.cite-modal-passage mark').length).toBeGreaterThan(0);
  expect(screen.getByText(/supporting passage/i)).toBeInTheDocument();
});

test('flags a weak match when no chunk supports the claim', () => {
  render(<CitationModal data={{ cite, claimText: 'It achieves 99% success on real suction hardware [P2].' }} onClose={() => {}} />);
  expect(screen.getByText(/weak match/i)).toBeInTheDocument();
  expect(screen.getByText(/clearly state the cited claim/i)).toBeInTheDocument();
});

test('Esc closes; null data renders nothing', () => {
  const onClose = jest.fn();
  const { container, rerender } = render(<CitationModal data={{ cite, claimText: 'x' }} onClose={onClose} />);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
  rerender(<CitationModal data={null} onClose={onClose} />);
  expect(container.querySelector('.cite-modal')).toBeNull();
});
