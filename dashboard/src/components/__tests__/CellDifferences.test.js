/* AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 *
 * Task 6 — the drawer's "Why they differ" section. Reads the precomputed
 * cell_context to explain a disagreement: source-tagged attribute differences,
 * citation stance, technique-lineage, and STATED outperforms claims.
 *
 * Honesty guard pinned here: HGT *predicted* outperforms are GATED — the
 * component must NEVER render a predicted entry (the user does not yet trust the
 * 0.51–0.70 metrics). Only `kind === 'stated'` claims appear.
 */
import React from 'react';
import { render } from '@testing-library/react';
import CellDifferences from '../CellDifferences';

const CELL = { key: 'success_rate||packed', entries: [{ method: 'GIGA' }, { method: 'ContactGN' }] };

const CELL_CONTEXT = {
  'success_rate||packed': {
    differences: [
      { axis: 'gripper', values: { GIGA: 'Parallel-jaw', ContactGN: 'Multi-finger' }, differ: true, source: 'method-typical (KG/CSV)' },
    ],
    relations: {
      citations: [{ from_paper: 'contact-graspnet', to_paper: 'giga', stance: 'differs_from' }],
      technique_lineage: { per_paper_backbones: { giga: ['PointNet'], 'contact-graspnet': ['PointNet'] }, shared_backbones: ['PointNet'], builds_on_pairs: [['vgn', 'giga']] },
      outperforms: [
        { winner_paper: 'giga', loser_paper: 'contact-graspnet', kind: 'stated', evidence: 'GIGA cuts failures on packed clutter vs ContactGN' },
        { winner_paper: 'giga', loser_paper: 'contact-graspnet', kind: 'predicted', confidence: 0.58, semantic_relevance: 0.92 },
      ],
    },
  },
};

describe('CellDifferences', () => {
  test('renders source-tagged attribute differences', () => {
    const { container } = render(<CellDifferences cell={CELL} cellContext={CELL_CONTEXT} />);
    const axis = container.querySelector('.benchmarks-celldiff-axis');
    expect(axis).toBeTruthy();
    const chips = [...container.querySelectorAll('.benchmarks-celldiff-chip[data-source]')];
    expect(chips.length).toBeGreaterThan(0);
    const text = chips.map((c) => c.textContent).join(' | ');
    expect(text).toMatch(/Parallel-jaw/);
    expect(text).toMatch(/Multi-finger/);
    // every chip is tagged with its provenance
    expect(chips.every((c) => c.getAttribute('data-source'))).toBe(true);
  });

  test('renders the citation stance and the technique-lineage', () => {
    const { container } = render(<CellDifferences cell={CELL} cellContext={CELL_CONTEXT} />);
    expect(container.querySelector('.benchmarks-celldiff-stance')).toBeTruthy();
    expect(container.textContent).toMatch(/differs.?from/i);
    expect(container.querySelector('.benchmarks-celldiff-lineage')).toBeTruthy();
    expect(container.textContent).toMatch(/PointNet/);
  });

  test('renders STATED outperforms evidence text', () => {
    const { container } = render(<CellDifferences cell={CELL} cellContext={CELL_CONTEXT} />);
    expect(container.querySelector('.benchmarks-celldiff-outperforms')).toBeTruthy();
    expect(container.textContent).toMatch(/cuts failures on packed clutter/);
  });

  test('GUARD: never renders a PREDICTED outperforms (gated off)', () => {
    const { container } = render(<CellDifferences cell={CELL} cellContext={CELL_CONTEXT} />);
    expect(container.querySelector('.benchmarks-celldiff-predicted')).toBeNull();
    // the predicted confidence value must not leak into the DOM anywhere
    expect(container.textContent).not.toMatch(/0\.58/);
    expect(container.textContent.toLowerCase()).not.toContain('predicted');
  });

  test('is defensive when the cell has no context', () => {
    const { container } = render(<CellDifferences cell={CELL} cellContext={{}} />);
    // no crash; nothing (or a muted note) rendered — but never a difference axis
    expect(container.querySelector('.benchmarks-celldiff-axis')).toBeNull();
  });
});
