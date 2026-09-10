/* "Ask for help" on failed builds, maintainer contact, and loading the CSV from a Drive folder in the
 * wizard — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify. */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AdminPage from '../AdminPage';

const FOLDER = 'https://drive.google.com/drive/folders/1TOPFOLDERXXXXXXXXXXXXXXX';
const DOMAINS = [
  { slug: 'test_domain', displayName: 'Test Domain', methodCount: 3, methodNoun: 'method', hasData: true, hasKG: true, protected: false },
];
const RUNS = [{
  id: 42, title: 'Build test_domain (all)', kind: 'build', domain: 'test_domain', scope: 'all', forced: false,
  status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/42',
  created_at: '2026-09-10T09:59:00Z', run_started_at: '2026-09-10T09:59:10Z', updated_at: '2026-09-10T10:00:10Z', duration_s: 60,
}];
const LOGS = {
  run: { id: 42, title: 'Build test_domain (all)', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/42' },
  jobs: [{ name: 'build', status: 'completed', conclusion: 'failure', steps: [] }],
  failure: { job: 'build', step: 'Run ingestion pipeline', excerpt: 'ERROR: No LLM API key configured',
    errorLines: ['ERROR: No LLM API key configured'], logUrl: 'https://github.com/o/r/actions/runs/42/job/7',
    hints: [{ title: 'No AI key configured', fix: 'Add a Gemini or Groq key under AI keys, then re-run the build.' }] },
};
const CSV = 'Name,Citation\nGraspGen,"x"\nAffordGen,"y"\nContact-GraspNet,"z"\nDex-Net 2.0,"w"\n';

function mockFetch(cap, { email = 'student@wpi.edu' } = {}) {
  global.fetch = jest.fn((url, opts = {}) => {
    const ok = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
    const method = (opts.method || 'GET').toUpperCase();
    if (url.includes('/api/admin/domains')) return ok({ domains: DOMAINS });
    if (url.includes('/api/admin/build-status')) return ok({ runs: RUNS, deployments: [] });
    if (url.includes('/api/admin/build-logs')) return ok(LOGS);
    if (url.includes('/api/admin/settings')) {
      if (method === 'POST') { cap.settings = JSON.parse(opts.body); return ok({ success: true, maintainerEmail: cap.settings.maintainerEmail }); }
      return ok({ maintainerEmail: email });
    }
    if (url.includes('/api/admin/drive-status')) {
      if (method === 'POST') {
        const body = JSON.parse(opts.body); cap.drivePosts = [...(cap.drivePosts || []), body];
        if (body.includeCsv) {
          return ok({ result: { status: 'ok', title: 'Test Domain', csv: { count: 1, newest: 'Test Domain_2026-09-10_12-00-00.csv' }, pdf: { count: 4, subfolders: ['PDFs'] } },
            csvFile: { name: 'Test Domain_2026-09-10_12-00-00.csv', content: CSV, strippedRows: 2 } });
        }
        return ok({ result: { status: 'ok', title: 'Test Domain', csv: { count: 1 }, pdf: { count: 4 } } });
      }
      return ok({ domains: [] });
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

test('a failed build offers Ask for help: prefilled email to the maintainer, a GitHub issue, and a copyable report', async () => {
  const cap = {};
  mockFetch(cap);
  await login();
  fireEvent.click(await screen.findByRole('button', { name: /view logs/i }));
  const email = await screen.findByRole('link', { name: /email the maintainer/i });
  const href = email.getAttribute('href');
  expect(href.startsWith('mailto:student@wpi.edu?')).toBe(true);
  const body = decodeURIComponent(href);
  expect(body).toMatch(/Run ingestion pipeline/);
  expect(body).toMatch(/No AI key configured/);
  expect(body).toMatch(/actions\/runs\/42/);
  const issue = screen.getByRole('link', { name: /open a github issue/i });
  expect(issue.getAttribute('href')).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/new\?/);
  expect(screen.getByRole('button', { name: /copy report/i })).toBeInTheDocument();
});

test('Settings stores the maintainer email used by Ask for help', async () => {
  const cap = {};
  mockFetch(cap, { email: null });
  await login();
  const input = await screen.findByLabelText(/maintainer email/i);
  fireEvent.change(input, { target: { value: 'student@wpi.edu' } });
  fireEvent.click(screen.getByRole('button', { name: /save email/i }));
  await waitFor(() => expect(cap.settings).toEqual({ maintainerEmail: 'student@wpi.edu' }));
});

test('the wizard can load the CSV from a Google Drive folder (newest export) instead of an upload', async () => {
  const cap = {};
  mockFetch(cap);
  await login();
  fireEvent.click(screen.getByRole('button', { name: /new domain/i }));
  fireEvent.change(await screen.findByLabelText('Display name'), { target: { value: 'Drive Demo' } });
  fireEvent.click(screen.getByLabelText(/newest export in a google drive folder/i));
  fireEvent.change(screen.getByLabelText(/drive folder link/i), { target: { value: FOLDER } });
  fireEvent.click(screen.getByRole('button', { name: /load newest csv/i }));
  await waitFor(() => expect(cap.drivePosts).toEqual([{ url: FOLDER, includeCsv: true }]));
  expect((await screen.findAllByText(/Test Domain_2026-09-10_12-00-00\.csv/)).length).toBeGreaterThan(0);
  expect(screen.getByText(/4 rows detected/)).toBeInTheDocument();
});
