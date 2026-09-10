/* Google Drive folder status on domain cards — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify. */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AdminPage from '../AdminPage';

const FOLDER = 'https://drive.google.com/drive/folders/1TOPFOLDERXXXXXXXXXXXXXXX';
const DOMAINS = [
  { slug: 'grasp_planning', displayName: 'Grasp Explorer', methodCount: 60, methodNoun: 'method', hasData: true, hasKG: true, protected: true },
  { slug: 'test_domain', displayName: 'Test Domain', methodCount: 3, methodNoun: 'method', hasData: true, hasKG: true, protected: false, driveFolder: FOLDER },
];
const DRIVE = { domains: [
  { domain: 'grasp_planning', displayName: 'Grasp Explorer', folderUrl: null, pdfUrl: null, pdfSource: null, stored: null, storedAt: null, matching: null },
  { domain: 'test_domain', displayName: 'Test Domain', folderUrl: FOLDER, pdfUrl: null, pdfSource: FOLDER,
    stored: { checked_at: '2026-09-10T06:00:00Z', checked_by: 'nightly',
      folder: { url: FOLDER, id: '1TOPFOLDERXXXXXXXXXXXXXXX', status: 'ok', title: 'Test Domain PDFs' },
      csv: { count: 3, newest: 'Test Sheet_2026-09-03_22-41-54.csv' },
      pdf: { status: 'ok', count: 12, files: [], subfolders: ['PDFs'], fingerprint: 'x', synced_fingerprint: 'older' } },
    storedAt: '2026-09-10T06:00:05Z',
    matching: { matchedMethods: 10, missingMethods: ['AnyGrasp'], unmatchedPdfs: ['survey.pdf', 'notes.pdf'] } },
] };

function mockFetch(cap) {
  global.fetch = jest.fn((url, opts = {}) => {
    const ok = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
    const method = (opts.method || 'GET').toUpperCase();
    if (url.includes('/api/admin/domains')) return ok({ domains: DOMAINS });
    if (url.includes('/api/admin/build-status')) return ok({ runs: [], deployments: [] });
    if (url.includes('/api/admin/trigger-build')) { cap.builds = [...(cap.builds || []), JSON.parse(opts.body)]; return ok({ success: true }); }
    if (url.includes('/api/admin/drive-status')) {
      if (method === 'POST') {
        cap.posts = [...(cap.posts || []), JSON.parse(opts.body)];
        return ok({ domain: 'test_domain', stored: { ...DRIVE.domains[1].stored, checked_by: 'admin', checked_at: new Date().toISOString() }, matching: DRIVE.domains[1].matching });
      }
      return ok(DRIVE);
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
const cardOf = (name) => screen.getByRole('heading', { name }).closest('.admin-domain-card');

test('a connected Drive folder shows its status, PDF count, matching and when it was last counted', async () => {
  const cap = {};
  mockFetch(cap);
  await login();
  const card = cardOf('Test Domain');
  await within(card).findByText(/12 PDFs/);
  expect(within(card).getAllByText(/10 of 11 methods have a PDF|10 match/i).length).toBeGreaterThan(0);
  expect(within(card).getAllByText(/nightly/i).length).toBeGreaterThan(0);
  expect(within(card).getAllByText(/3 sheet exports?/i).length).toBeGreaterThan(0);
  expect(cap.posts).toBeUndefined(); // a stored count exists -> no automatic live check on load
});

test('"Check now" re-counts the folder via POST /api/admin/drive-status {domain}', async () => {
  const cap = {};
  mockFetch(cap);
  await login();
  const card = cardOf('Test Domain');
  fireEvent.click(await within(card).findByRole('button', { name: /check now/i }));
  await waitFor(() => expect(cap.posts).toEqual([{ domain: 'test_domain' }]));
});

test('a domain without a folder offers "Connect Drive folder"', async () => {
  mockFetch({});
  await login();
  const card = cardOf('Grasp Explorer');
  expect(await within(card).findByRole('button', { name: /connect drive folder/i })).toBeInTheDocument();
});

test('PDFs changed since the last build are flagged, and starting a Build marks the folder as synced', async () => {
  const cap = {};
  mockFetch(cap);
  await login();
  const card = cardOf('Test Domain');
  expect((await within(card).findAllByText(/since the last build/i)).length).toBeGreaterThan(0);
  fireEvent.click(within(card).getByRole('button', { name: /^build$/i }));
  await waitFor(() => expect(cap.builds && cap.builds[0].domain).toBe('test_domain'));
  expect(cap.builds[0].pages).not.toBe('benchmark');
  await waitFor(() => expect(cap.posts).toEqual([{ domain: 'test_domain', markSynced: true }]));
});
