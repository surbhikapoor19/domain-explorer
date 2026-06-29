/* AnswerMarkdown — AUTHORED BY ORCHESTRATOR. The copilot answer renders as
 * formatted markdown: bold/bullets/table/citations, [m_id] markers consumed,
 * and discussed-method names become clickable (the prose->everywhere join). */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AnswerMarkdown from '../AnswerMarkdown';

describe('AnswerMarkdown', () => {
  test('renders a bulleted list', () => {
    const { container } = render(<AnswerMarkdown text={'Lead sentence.\n\n- first point\n- second point'} />);
    const items = container.querySelectorAll('.answer-list li');
    expect(items.length).toBe(2);
    expect(container.querySelector('.answer-p').textContent).toMatch(/Lead sentence/);
  });

  test('renders a markdown table for comparison answers', () => {
    const md = '**A** vs **B**.\n\n| Dimension | A | B |\n|---|---|---|\n| Hand | jaw | multi |';
    const { container } = render(<AnswerMarkdown text={md} />);
    const ths = [...container.querySelectorAll('.answer-table th')].map(t => t.textContent);
    expect(ths).toEqual(['Dimension', 'A', 'B']);
    expect(container.querySelectorAll('.answer-table tbody td').length).toBe(3);
  });

  test('renders [P#] as a citation chip showing the paper title, and CONSUMES [m_*] markers', () => {
    const { container } = render(
      <AnswerMarkdown
        text={'**VGN** [m_vgn] is solid [P1].'}
        citations={[{ marker: 'P1', paper_id: 'vgn', paper_title: 'Volumetric Grasping Network', index: 1 }]}
      />,
    );
    const cite = container.querySelector('.answer-cite');
    expect(cite.textContent).toBe('[1]');
    expect(cite.getAttribute('title')).toMatch(/Volumetric Grasping Network/);
    // the [m_vgn] parsing marker must NOT appear as literal text
    expect(container.textContent).not.toMatch(/\[m_vgn\]/);
  });

  test('a RESOLVED citation [P#] is a clickable chip that fires onCiteClick(paper_id)', () => {
    const onCiteClick = jest.fn();
    render(
      <AnswerMarkdown
        text={'Strong result [P1].'}
        citations={[{ marker: 'P1', paper_id: 'vgn', paper_title: 'VGN', index: 1 }]}
        onCiteClick={onCiteClick}
      />,
    );
    const btn = screen.getByRole('button', { name: '[1]' });
    fireEvent.click(btn);
    expect(onCiteClick).toHaveBeenCalledWith('vgn');
  });

  test('an UNRESOLVED citation marker is dropped (no dead chip, no raw text)', () => {
    const { container } = render(
      <AnswerMarkdown
        text={'Claimed [P9].'}
        citations={[{ marker: 'P1', paper_id: 'vgn', paper_title: 'VGN', index: 1 }]}
        onCiteClick={() => {}}
      />,
    );
    expect(container.querySelector('.answer-cite')).toBeNull();
    expect(container.textContent).not.toMatch(/\[P9\]/);
  });

  test('a multi-tag bracket [P1, P2] renders one chip per resolved tag', () => {
    render(
      <AnswerMarkdown
        text={'Both agree [P1, P2].'}
        citations={[
          { marker: 'P1', paper_id: 'a', paper_title: 'A', index: 1 },
          { marker: 'P2', paper_id: 'b', paper_title: 'B', index: 2 },
        ]}
        onCiteClick={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '[1]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[2]' })).toBeInTheDocument();
  });

  test('a bold name that matches a discussed method becomes clickable and fires onMethodClick', () => {
    const onMethodClick = jest.fn();
    render(
      <AnswerMarkdown
        text={'For clutter, **Contact-GraspNet** works well.'}
        methods={['Contact-GraspNet']}
        onMethodClick={onMethodClick}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Contact-GraspNet' });
    fireEvent.click(btn);
    expect(onMethodClick).toHaveBeenCalledWith('Contact-GraspNet');
  });

  test('resolves a method even when the [m_id] marker is INSIDE the bold', () => {
    const onMethodClick = jest.fn();
    render(
      <AnswerMarkdown
        text={'For clutter, **[m_dexgraspnet] DexGraspNet** is best.'}
        methods={['DexGraspNet']}
        onMethodClick={onMethodClick}
      />,
    );
    const btn = screen.getByRole('button', { name: 'DexGraspNet' }); // marker stripped from label
    fireEvent.click(btn);
    expect(onMethodClick).toHaveBeenCalledWith('DexGraspNet');
  });

  test('a bold name NOT in the method set renders as plain bold (not a button)', () => {
    render(<AnswerMarkdown text={'It uses a **binary cross-entropy** loss.'} methods={['VGN']} onMethodClick={() => {}} />);
    expect(screen.queryByRole('button', { name: /binary cross-entropy/i })).toBeNull();
  });

  test('is defensive on empty input', () => {
    const { container } = render(<AnswerMarkdown text={''} />);
    expect(container.querySelector('.answer-markdown')).toBeNull();
  });
});
