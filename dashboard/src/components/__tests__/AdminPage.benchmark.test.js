/* Admin "Build benchmarks" trigger — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * Clicking "Build benchmarks" must POST to /api/admin/trigger-build with pages='benchmark'
 * (a benchmark-only opt-in build), distinct from the existing full "Build". */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminPage from '../AdminPage';

const DOMAIN = {
  slug: 'motion-planning', displayName: 'Motion Planning',
  methodCount: 13, methodNoun: 'algorithm', hasData: true, hasKG: true,
};

function mockFetch(captured) {
  global.fetch = jest.fn((url, opts = {}) => {
    if (url.includes('/api/admin/domains')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ domains: [DOMAIN] }) });
    }
    if (url.includes('/api/admin/build-status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ runs: [], deployments: [] }) });
    }
    if (url.includes('/api/admin/trigger-build')) {
      captured.body = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

test('Build benchmarks triggers a benchmark-only build (pages=benchmark)', async () => {
  const captured = {};
  mockFetch(captured);
  render(<AdminPage explorerEnabled={false} onToggleExplorer={() => {}} />);

  // authenticate
  fireEvent.change(screen.getByPlaceholderText(/admin token/i), { target: { value: 'tok' } });
  fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));

  // domain card appears
  await screen.findByText('Motion Planning');

  // the new control
  const btn = screen.getByRole('button', { name: /build benchmarks/i });
  fireEvent.click(btn);

  await waitFor(() => expect(captured.body).toBeTruthy());
  expect(captured.body.domain).toBe('motion-planning');
  expect(captured.body.pages).toBe('benchmark');
});

test('the plain Build button still triggers a full build (no pages=benchmark)', async () => {
  const captured = {};
  mockFetch(captured);
  render(<AdminPage explorerEnabled={false} onToggleExplorer={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/admin token/i), { target: { value: 'tok' } });
  fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));
  await screen.findByText('Motion Planning');

  // the existing full "Build" button (exact match, not "Build benchmarks")
  fireEvent.click(screen.getByRole('button', { name: /^build$/i }));
  await waitFor(() => expect(captured.body).toBeTruthy());
  expect(captured.body.domain).toBe('motion-planning');
  expect(captured.body.pages).not.toBe('benchmark');
});
