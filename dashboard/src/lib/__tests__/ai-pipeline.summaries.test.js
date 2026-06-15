/* Copilot method summaries — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * The "RELEVANT METHODS" block fed to the LLM must summarize each method over the
 * ACTIVE DOMAIN's columns (priorityDims) + short names — not hardcoded grasp
 * columns — so a non-grasp domain's copilot context is populated, not blank. */
import { buildMethodSummaries } from '../ai-pipeline';

test('summarizes methods over the domain-provided columns + short names', () => {
  const methods = [
    { name: 'RRT-Connect', metadata: { 'Planning Type': 'Sampling-based', 'Middleware': 'OMPL', 'IK/Controller': 'KDL' } },
    { name: 'CHOMP', metadata: { 'Planning Type': 'Optimization-based', 'Middleware': 'MoveIt' } },
  ];
  const out = buildMethodSummaries(methods, {
    summaryColumns: ['Planning Type', 'Middleware'],
    shortNames: { 'Planning Type': 'Plan', 'Middleware': 'MW' },
  });
  expect(out).toBe(
    '- RRT-Connect: Plan=Sampling-based; MW=OMPL\n' +
    '- CHOMP: Plan=Optimization-based; MW=MoveIt'
  );
  // The grasp default columns are NOT used: 'Planning Method' is absent here, so a
  // grasp-hardcoded summarizer would have produced empty bodies.
  expect(out).not.toContain('Planning Method');
});

test('falls back to grasp default columns when the domain provides none', () => {
  const methods = [{ name: 'GPD', metadata: { 'Planning Method': 'Sampling', 'Input Data': 'Point cloud' } }];
  const out = buildMethodSummaries(methods);
  expect(out).toContain('GPD:');
  expect(out).toContain('Plan=Sampling');       // DEFAULT_SHORT_NAMES['Planning Method'] = 'Plan'
  expect(out).toContain('Input=Point cloud');
});

test('omits empty columns and missing metadata gracefully', () => {
  const methods = [{ name: 'PRM', metadata: { 'Planning Type': 'Sampling-based' } }];
  const out = buildMethodSummaries(methods, { summaryColumns: ['Planning Type', 'Middleware'], shortNames: {} });
  expect(out).toBe('- PRM: Planning Type=Sampling-based');   // no short name → raw column; Middleware skipped
});
