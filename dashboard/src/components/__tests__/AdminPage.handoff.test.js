/* Admin handoff flows — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * Delete-with-typed-confirmation (protected core domains have no Delete), AI-key save,
 * and the "View logs" failure diagnosis in the Activity feed. */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AdminPage from '../AdminPage';

const DOMAINS = [
  { slug: 'grasp_planning', displayName: 'Grasp Planning', methodCount: 60, methodNoun: 'method',
    hasData: true, hasKG: true, protected: true },
  { slug: 'test_domain', displayName: 'Test Domain', methodCount: 3, methodNoun: 'method',
    hasData: true, hasKG: true, protected: false },
];
const RUNS = [{
  id: 42, title: 'Build test_domain (all)', name: 'Domain Build Pipeline', kind: 'build',
  domain: 'test_domain', scope: 'all', forced: false, event: 'repository_dispatch',
  status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/42',
  created_at: '2026-09-10T09:59:00Z', run_started_at: '2026-09-10T09:59:10Z',
  updated_at: '2026-09-10T10:00:10Z', duration_s: 60,
}];
const KEYS = {
  providers: [
    { name: 'GEMINI_API_KEY', label: 'Google Gemini', usedFor: 'Build pipeline + chat copilot',
      inGitHub: true, githubUpdatedAt: '2026-02-01T00:00:00Z', inVercel: true },
    { name: 'GEMINI_API_KEY_2', label: 'Google Gemini (backup)', usedFor: 'Build pipeline fallback',
      inGitHub: false, githubUpdatedAt: null, inVercel: false },
    { name: 'GROQ_API_KEY', label: 'Groq', usedFor: 'Build pipeline + chat fallback',
      inGitHub: false, githubUpdatedAt: null, inVercel: false },
    { name: 'HF_TOKEN', label: 'Hugging Face', usedFor: 'Setup assistant + vision',
      inGitHub: true, githubUpdatedAt: '2026-02-01T00:00:00Z', inVercel: true },
  ],
  ghPat: { present: true, scopes: ['repo', 'workflow'], expiresAt: '2027-04-27 00:00:00 UTC' },
};
const LOGS = {
  run: { id: 42, title: 'Build test_domain (all)', status: 'completed', conclusion: 'failure',
         html_url: 'https://github.com/o/r/actions/runs/42' },
  jobs: [{ name: 'build', status: 'completed', conclusion: 'failure',
           steps: [{ name: 'Run ingestion pipeline', status: 'completed', conclusion: 'failure', number: 14 }] }],
  failure: {
    job: 'build', step: 'Run ingestion pipeline',
    excerpt: 'ERROR: No LLM API key configured (set GROQ_API_KEY or GEMINI_API_KEY)',
    errorLines: ['ERROR: No LLM API key configured (set GROQ_API_KEY or GEMINI_API_KEY)'],
    hints: [{ title: 'No AI key configured', fix: 'Add a Gemini or Groq key under AI keys, then re-run the build.' }],
  },
};

function mockFetch(cap) {
  global.fetch = jest.fn((url, opts = {}) => {
    const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/api/admin/domains')) return ok({ domains: DOMAINS });
    if (url.includes('/api/admin/build-status')) return ok({ runs: RUNS, deployments: [] });
    if (url.includes('/api/admin/build-logs')) { cap.logsUrl = url; return ok(LOGS); }
    if (url.includes('/api/admin/keys')) {
      if ((opts.method || 'GET').toUpperCase() === 'POST') {
        cap.keysBody = JSON.parse(opts.body);
        return ok({ success: true, name: cap.keysBody.name, validated: true });
      }
      return ok(KEYS);
    }
    if (url.includes('/api/admin/delete-domain')) {
      cap.deleteBody = JSON.parse(opts.body);
      return ok({ success: true, commitSha: 'abc1234def', removed: ['domains/test_domain.yaml'] });
    }
    return ok({});
  });
}

async function login() {
  render(<AdminPage explorerEnabled={false} onToggleExplorer={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/admin token/i), { target: { value: 'tok' } });
  fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));
  await screen.findByRole('heading', { name: 'Test Domain' });
}

test('protected core domains have no Delete; others need the slug typed to confirm', async () => {
  const cap = {};
  mockFetch(cap);
  await login();

  const deletes = screen.getAllByRole('button', { name: /^delete/i });
  expect(deletes).toHaveLength(1); // only Test Domain — Grasp Planning is protected
  fireEvent.click(deletes[0]);

  const dialog = await screen.findByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: /delete domain/i });
  expect(confirm).toBeDisabled();
  const input = within(dialog).getByRole('textbox');
  fireEvent.change(input, { target: { value: 'test' } });
  expect(confirm).toBeDisabled();
  fireEvent.change(input, { target: { value: 'test_domain' } });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);

  await waitFor(() => expect(cap.deleteBody).toEqual({ domain: 'test_domain', confirm: 'test_domain' }));
});

test('AI keys: adding a Groq key posts name + value to /api/admin/keys from a password field', async () => {
  const cap = {};
  mockFetch(cap);
  await login();

  await screen.findByRole('heading', { name: /ai keys/i });
  fireEvent.click(await screen.findByRole('button', { name: /(add|replace).*groq/i }));
  const input = await screen.findByLabelText(/groq api key/i);
  expect(input).toHaveAttribute('type', 'password');
  fireEvent.change(input, { target: { value: 'gsk_test_123' } });
  fireEvent.click(screen.getByRole('button', { name: /save key/i }));

  await waitFor(() => expect(cap.keysBody).toEqual(
    expect.objectContaining({ name: 'GROQ_API_KEY', value: 'gsk_test_123' })));
});

test('Activity: "View logs" on a failed build shows the diagnosis from /api/admin/build-logs', async () => {
  const cap = {};
  mockFetch(cap);
  await login();

  const btn = await screen.findByRole('button', { name: /view logs/i });
  expect(cap.logsUrl).toBeUndefined(); // logs are fetched on demand, not on page load
  fireEvent.click(btn);

  await waitFor(() => expect(cap.logsUrl).toMatch(/run_id=42/));
  expect((await screen.findAllByText(/no ai key configured/i)).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/add a gemini or groq key/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/run ingestion pipeline/i).length).toBeGreaterThan(0);
});
