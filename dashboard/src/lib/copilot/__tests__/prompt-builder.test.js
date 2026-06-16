/* Copilot prompt-builder — AUTHORED BY ORCHESTRATOR (TEST AUTHOR). Implementers must NOT modify.
 *
 * Encodes the CONTRACT for buildInsightPrompt(query, highlightMethods, ragText,
 * kgContext, methodSummaries, branding = {}, benchmarkText = ''):
 *
 *   1) New output structure: (a) ONE-sentence direct answer FIRST; (b) 3-6
 *      evidence points where EACH names a source paper and quotes a number or a
 *      specific technique, using inline [paper] citation markers; (c) a one-line
 *      caveat. The rigid "exactly 3-5 bullets / respond-with-ONLY-bullets"
 *      straitjacket is DROPPED. The plain-text / no-markdown rule is KEPT (the UI
 *      highlighter needs plain text). Rule 0 (benchmark-first, never invent a
 *      number) is KEPT.
 *   2) De-grasp: the literal word "robotic" and the few-shot exemplar method
 *      names must come from `branding` (productSubject + any exemplar field) or be
 *      derived from `highlightMethods`. For a motion branding NO grasp method
 *      names (Contact-GraspNet / VGN / GPD) may appear.
 *
 * These tests are EXPECTED TO FAIL until the implementation lands (TDD).
 */
import { buildInsightPrompt } from '../prompt-builder';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const GRASP_BRANDING = { productSubject: 'grasp planning' };
const MOTION_BRANDING = { productSubject: 'motion planning' };

const RAG_TEXT = '[Contact-GraspNet] reports 90.2% success on the YCB benchmark.';
const KG_CONTEXT = 'Contact-GraspNet -> outperforms -> GPD';
const METHOD_SUMMARIES =
  '- Contact-GraspNet: Plan=Learning; Input=Point cloud\n- GPD: Plan=Sampling';
const BENCHMARK_TEXT =
  'Rank 1: Contact-GraspNet 90.2% (grade A, [Sundermeyer 2021])\n' +
  'Rank 2: VGN 81.0% (grade B, [Breyer 2020])';

// A performance/ranking-flavoured question to exercise rule 0.
const PERF_QUERY = 'Which method has the highest grasp success rate?';

function buildPerfPrompt(branding = GRASP_BRANDING) {
  return buildInsightPrompt(
    PERF_QUERY,
    ['Contact-GraspNet', 'VGN', 'GPD'],
    RAG_TEXT,
    KG_CONTEXT,
    METHOD_SUMMARIES,
    branding,
    BENCHMARK_TEXT
  );
}

// ---------------------------------------------------------------------------
// (1) Output-structure contract
// ---------------------------------------------------------------------------
describe('buildInsightPrompt — output structure', () => {
  test('returns a non-empty string and echoes the researcher question', () => {
    const prompt = buildPerfPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain(PERF_QUERY);
  });

  test('demands a one-sentence direct answer FIRST', () => {
    const prompt = buildPerfPrompt();
    // The instruction must call for a single-sentence direct answer up front.
    expect(prompt).toMatch(/one[- ]sentence/i);
    expect(prompt).toMatch(/\b(direct )?answer\b/i);
    // The ordering cue ("first" / "begin"/ "open with") must be present.
    expect(prompt).toMatch(/\b(first|begin|open with|start)\b/i);
  });

  test('asks for 3-6 evidence points (not a rigid 3-5)', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).toMatch(/3[\s-]*(?:to|–|-)?\s*6/);
    expect(prompt).toMatch(/evidence/i);
  });

  test('each evidence point must name a source paper and quote a number or specific technique', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).toMatch(/source paper|paper/i);
    expect(prompt).toMatch(/number|quote|technique/i);
  });

  test('requires a one-line caveat', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).toMatch(/caveat/i);
  });

  test('drops the rigid "exactly 3-5 bullets" straitjacket', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).not.toMatch(/exactly 3-5 bullet/i);
    expect(prompt).not.toMatch(/exactly 3-5/i);
  });

  test('drops the "respond with ONLY the bullet points" straitjacket', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).not.toMatch(/only the bullet points/i);
    expect(prompt).not.toMatch(/ONLY bullet/i);
  });

  test('KEEPS the plain-text / no-markdown rule (UI highlighter needs plain text)', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).toMatch(/plain text/i);
    expect(prompt).toMatch(/markdown/i);
  });
});

// ---------------------------------------------------------------------------
// (1) Rule 0 — benchmark-first + never-invent-a-number guard
// ---------------------------------------------------------------------------
describe('buildInsightPrompt — rule 0 (benchmark-first)', () => {
  test('a performance query prompt still contains rule 0 (benchmark-first)', () => {
    const prompt = buildPerfPrompt();
    // Rule 0 leads with the verified benchmark evidence on quantitative questions.
    expect(prompt).toMatch(/benchmark/i);
    expect(prompt).toMatch(/best|highest|fastest|ranking|performance|quantitative/i);
    // The verified benchmark block content must be embedded in the prompt.
    expect(prompt).toContain(BENCHMARK_TEXT);
  });

  test('keeps the never-invent-a-number guard', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).toMatch(/never invent a number|do not invent a number/i);
  });

  test('keeps the evidence-grade (A/B/C) provenance language', () => {
    const prompt = buildPerfPrompt();
    expect(prompt).toMatch(/grade/i);
    expect(prompt).toMatch(/\bA\b/);
    expect(prompt).toMatch(/\bC\b/);
  });
});

// ---------------------------------------------------------------------------
// (1)(b) Inline [paper] citation markers
// ---------------------------------------------------------------------------
describe('buildInsightPrompt — inline citations', () => {
  test('the prompt requires inline [paper] citation markers', () => {
    const prompt = buildPerfPrompt();
    // It must instruct the model to use inline citation markers in [paper] form.
    expect(prompt).toMatch(/inline/i);
    expect(prompt).toMatch(/citation/i);
    // The bracketed-marker convention itself must be shown (e.g. "[paper]").
    expect(prompt).toMatch(/\[paper\]/i);
  });
});

// ---------------------------------------------------------------------------
// (2) De-grasp — exemplars + subject come from branding / highlightMethods
// ---------------------------------------------------------------------------
describe('buildInsightPrompt — de-grasp / domain framing', () => {
  test('grasp branding behaviour stays sensible (productSubject surfaces)', () => {
    const prompt = buildPerfPrompt(GRASP_BRANDING);
    expect(prompt).toContain('grasp planning');
  });

  test('does NOT hardcode the literal word "robotic"', () => {
    const prompt = buildPerfPrompt(MOTION_BRANDING);
    expect(prompt).not.toMatch(/\brobotic\b/i);
  });

  test('motion branding + highlightMethods [RRT-Connect, PRM] surfaces the motion subject and exemplars', () => {
    const prompt = buildInsightPrompt(
      'Which planner expands the search tree fastest?',
      ['RRT-Connect', 'PRM'],
      '[Kuffner 2000] introduces RRT-Connect, a bidirectional tree planner.',
      'RRT-Connect -> related -> PRM',
      '- RRT-Connect: Plan=Sampling-based\n- PRM: Plan=Roadmap',
      MOTION_BRANDING,
      '(No benchmark leaderboard matched this query)'
    );
    expect(prompt).toContain('motion planning');
    // Exemplars are derived from the passed highlightMethods (not grasp names).
    expect(prompt).toContain('RRT-Connect');
  });

  test('motion branding prompt contains NO grasp method names (Contact-GraspNet / VGN / GPD)', () => {
    const prompt = buildInsightPrompt(
      'Which planner expands the search tree fastest?',
      ['RRT-Connect', 'PRM'],
      '[Kuffner 2000] introduces RRT-Connect, a bidirectional tree planner.',
      'RRT-Connect -> related -> PRM',
      '- RRT-Connect: Plan=Sampling-based\n- PRM: Plan=Roadmap',
      MOTION_BRANDING,
      '(No benchmark leaderboard matched this query)'
    );
    expect(prompt).not.toMatch(/Contact-GraspNet/);
    expect(prompt).not.toMatch(/\bVGN\b/);
    expect(prompt).not.toMatch(/\bGPD\b/);
    expect(prompt).not.toMatch(/Volumetric Grasping Network/);
    expect(prompt).not.toMatch(/Grasp Pose Detection/);
  });
});
