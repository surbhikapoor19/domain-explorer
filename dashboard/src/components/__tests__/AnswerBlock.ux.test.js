/* comparison-table UX test — AUTHORED BY ORCHESTRATOR (TDD). Implementers must NOT modify.
 *
 * Encodes the comparison-table-ux CONTRACT:
 *   1) AnswerBlock: one-line caption under the table title explaining the four
 *      states; title + status pills wrapped in the Tooltip component; badge
 *      reworded "X of Y dimensions documented" (not "dims with evidence").
 *   2) App.css: .gr-cmp-status-differs / .gr-proof-tally-differs recolored away
 *      from alarm-red (#b03029) to a neutral slate / blue-grey.
 *   3) ProofBlock: the duplicate Property-extraction pill tally (gr-proof-tally
 *      spans) removed; the single summary count line in the header kept.
 *
 * These assertions are EXPECTED TO FAIL until the implementation lands — that
 * is correct TDD. They must not be weakened to pass against current source.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import AnswerBlock from '../AnswerBlock';
import ProofBlock from '../ProofBlock';
import DomainContext, { GRASP_DEFAULTS } from '../../DomainContext';

const CSS_PATH = path.resolve(__dirname, '../../App.css');
const PROOF_PATH = path.resolve(__dirname, '../ProofBlock.js');

// Two anchor methods, hydrated the way computeAnchorMethods would hand them to
// AnswerBlock (name + score + cluster + meta). They agree on "Object
// Configuration" (=> shared) but disagree on "Planning Method" (two distinct
// valid choices => differs), guaranteeing a 'differs' status pill renders.
const ANCHORS = [
  {
    name: 'Contact-GraspNet',
    score: 0.91,
    cluster: 0,
    meta: {
      'Object Configuration': 'Cluttered',
      'Planning Method': 'Learning-based',
      'Training Data': 'Synthetic',
    },
  },
  {
    name: 'AnyGrasp',
    score: 0.82,
    cluster: 1,
    meta: {
      'Object Configuration': 'Cluttered',
      'Planning Method': 'Geometric',
      'Training Data': 'Synthetic',
    },
  },
];

// Minimal suggestion: paperRelevance listing 2+ methods (per contract) plus a
// synthesis string so the block renders its full shell.
const SUGGESTION = {
  intent: 'comparison',   // table renders EXPANDED only for a comparison ask
  paperRelevance: [
    { name: 'Contact-GraspNet', score: 0.91 },
    { name: 'AnyGrasp', score: 0.82 },
  ],
  insight: 'Both methods target cluttered scenes via different planning strategies.',
};

function renderAnswerBlock() {
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

describe('AnswerBlock comparison-table UX', () => {
  // CONTRACT 1a — one-line caption directly under the title explaining the four
  // states. Assert each state's meaning is spelled out (shared = all agree,
  // differs = different valid choices, partial = some documented, gap = no data).
  test('renders a caption explaining the visible states (gap rows fold behind a toggle instead)', () => {
    renderAnswerBlock();
    const caption = screen.getByText(
      /shared[^]*all agree[^]*differs[^]*different valid[^]*partial[^]*documented/i,
    );
    expect(caption).toBeInTheDocument();
    // It is one caption element, not the table rows: it names all four states.
    const txt = caption.textContent.toLowerCase();
    ['shared', 'differs', 'partial'].forEach(state => {   // 'gap' rows are folded, not captioned
      expect(txt).toContain(state);
    });
  });

  // CONTRACT 1b — badge reworded. The old jargon "dims with evidence" must be
  // gone; the new copy reads "X of Y dimensions documented".
  test('badge reads "X of Y dimensions documented", not "dims with evidence"', () => {
    renderAnswerBlock();
    // New wording present: "<covered> of <total> dimensions documented".
    const badge = screen.getByText(/\bof\b[^]*dimensions documented/i);
    expect(badge).toBeInTheDocument();
    // Old jargon gone everywhere in the rendered block.
    expect(screen.queryByText(/dims with evidence/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/dims with evidence/i);
  });

  // CONTRACT 1c — the table title is wrapped in the Tooltip component. Tooltip
  // renders its children inside <span class="tooltip-wrapper">, so the title
  // text must live within a .tooltip-wrapper after the change.
  test('wraps the comparison-table title in the Tooltip component', () => {
    renderAnswerBlock();
    // The comparison title text (2 anchors => "How 2 methods compare ...").
    const title = screen.getByText(/how 2 methods compare/i);
    expect(title.closest('.tooltip-wrapper')).not.toBeNull();
  });

  // CONTRACT 1c (pills) — each status pill is also wrapped in a Tooltip.
  test('wraps each status pill in the Tooltip component', () => {
    const { container } = renderAnswerBlock();
    const pills = container.querySelectorAll('.gr-cmp-status');
    expect(pills.length).toBeGreaterThan(0);
    pills.forEach(pill => {
      expect(pill.closest('.tooltip-wrapper')).not.toBeNull();
    });
  });

  // Sanity: the 'differs' pill actually renders for our fixture (so the colour
  // assertion below is meaningful), and the old alarm-red hex is not inlined
  // onto the differs pill element.
  test('renders a differs status pill that does not carry the old alarm-red hex inline', () => {
    const { container } = renderAnswerBlock();
    const differsPill = container.querySelector('.gr-cmp-status-differs');
    expect(differsPill).not.toBeNull();
    const inlineColor = (differsPill.getAttribute('style') || '').toLowerCase();
    expect(inlineColor).not.toContain('#b03029');
    expect(inlineColor).not.toContain('b03029');
  });
});

// CONTRACT 2 — App.css recolor. The differs pill + proof tally must no longer
// use the alarm-red #b03029; red stays reserved for real problems. Parse the
// specific rule blocks so an unrelated #b03029 elsewhere doesn't mask the bug.
describe('App.css neutral recolor of "differs"', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  function ruleBody(selector) {
    const re = new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
    );
    const m = css.match(re);
    expect(m).not.toBeNull(); // selector must still exist
    return m[1].toLowerCase();
  }

  test('.gr-cmp-status-differs is no longer alarm-red #b03029', () => {
    expect(ruleBody('.gr-cmp-status-differs')).not.toContain('#b03029');
  });

  test('.gr-proof-tally-differs is no longer alarm-red #b03029', () => {
    // This rule may be removed entirely (CONTRACT 3 drops the proof tally); if
    // it still exists, it must not be alarm-red.
    if (/\.gr-proof-tally-differs\s*\{/.test(css)) {
      expect(ruleBody('.gr-proof-tally-differs')).not.toContain('#b03029');
    }
  });
});

// CONTRACT 3 — ProofBlock no longer re-renders the shared/differs/partial/gap
// pill tally. The gr-proof-tally spans must be gone; the single summary count
// line in the header (anchors · quotes · gaps · disagreements) stays.
describe('ProofBlock no longer duplicates the property-extraction tally', () => {
  const ANCHOR_META = ANCHORS;
  const PROOF_SUGGESTION = {
    ...SUGGESTION,
    kgTraversal: [],
    ragCitations: [],
  };

  function renderProofBlock() {
    return render(
      <DomainContext.Provider value={GRASP_DEFAULTS}>
        <ProofBlock
          suggestion={PROOF_SUGGESTION}
          anchorMethods={ANCHOR_META}
          query="compare grasp planners"
          termDictionary={{}}
        />
      </DomainContext.Provider>,
    );
  }

  test('source no longer contains the gr-proof-tally pill spans', () => {
    const src = fs.readFileSync(PROOF_PATH, 'utf8');
    expect(src).not.toMatch(/gr-proof-tally/);
  });

  test('rendered ProofBlock exposes no gr-proof-tally elements', () => {
    const { container } = renderProofBlock();
    expect(container.querySelector('[class*="gr-proof-tally"]')).toBeNull();
  });

  test('keeps the single summary count line in the ProofBlock header', () => {
    renderProofBlock();
    // The header summary survives: "2 anchors · 0 quotes · N gaps · N disagreements".
    const summary = screen.getByText(/anchors?[^]*quotes?[^]*gaps?[^]*disagreements?/i);
    expect(summary).toBeInTheDocument();
    expect(summary.textContent).toMatch(/2 anchors/i);
  });
});
