/* Admin API acceptance tests — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * Run: node --test dashboard/tests/admin-api/
 * GitHub + provider HTTP calls are served by an in-process fetch router (no network). */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';

process.env.ADMIN_TOKEN = 'admintok';
process.env.GH_PAT = 'ghp_TESTSECRET123';
process.env.GITHUB_OWNER = 'o';
process.env.GITHUB_REPO = 'r';

const GH = 'https://api.github.com/repos/o/r';

function mockRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
  res.end = () => res;
  return res;
}
function mkReq(method, { body, query, token = 'admintok' } = {}) {
  return { method, body, query: query || {}, headers: token ? { 'x-admin-token': token } : {} };
}
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

let calls = [];
function installFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    const headers = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    calls.push({ url: u, method, body, headers, redirect: opts.redirect });
    for (const [re, fn] of routes) {
      if (re.test(`${method} ${u}`)) return fn(u, opts, body);
    }
    return json({ message: 'Not Found' }, 404);
  };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// Standard git-data write chain: ref -> commit -> (blobs) -> tree -> commit -> ref PATCH.
function gitChain({ patchStatuses = [200], tree = [], captured = {} } = {}) {
  let patchN = 0; let blobN = 0;
  captured.blobs = []; captured.trees = []; captured.commits = []; captured.patches = [];
  return [
    [/^GET .*\/git\/ref\/heads\/main$/, () => json({ object: { sha: 'base-sha' } })],
    [/^GET .*\/git\/commits\/base-sha$/, () => json({ sha: 'base-sha', tree: { sha: 'base-tree' } })],
    [/^GET .*\/git\/trees\/base-tree\?recursive=1$/, () => json({ sha: 'base-tree', truncated: false, tree })],
    [/^POST .*\/git\/blobs$/, (u, o, body) => { captured.blobs.push(body); return json({ sha: `blob-${++blobN}` }, 201); }],
    [/^POST .*\/git\/trees$/, (u, o, body) => { captured.trees.push(body); return json({ sha: 'new-tree' }, 201); }],
    [/^POST .*\/git\/commits$/, (u, o, body) => { captured.commits.push(body); return json({ sha: 'new-commit-sha' }, 201); }],
    [/^PATCH .*\/git\/refs\/heads\/main$/, (u, o, body) => {
      captured.patches.push(body);
      const st = patchStatuses[Math.min(patchN++, patchStatuses.length - 1)];
      return st === 200 ? json({ object: { sha: body.sha } }) : json({ message: 'Update is not a fast forward' }, st);
    }],
  ];
}

/* ------------------------------------------------------------------ */
/* delete-domain                                                        */
/* ------------------------------------------------------------------ */
describe('delete-domain', async () => {
  const { default: handler } = await import('../../api/admin/delete-domain.js');

  const TREE = [
    { path: 'domains', type: 'tree', sha: 't1' },
    { path: 'domains/test_domain.yaml', type: 'blob', sha: 'a1' },
    { path: 'domains/grasp_planning.yaml', type: 'blob', sha: 'a2' },
    { path: 'datasets/test-domain', type: 'tree', sha: 't2' },
    { path: 'datasets/test-domain/test.csv', type: 'blob', sha: 'a3' },
    { path: 'datasets/test-domain/papers.zip', type: 'blob', sha: 'a4' },
    { path: 'datasets/test-domain/tei/graspgen.tei.xml', type: 'blob', sha: 'a5' },
    { path: 'datasets/test-domain-2/x.csv', type: 'blob', sha: 'a6' },
    { path: 'dashboard/public/data-test-domain/methods.json', type: 'blob', sha: 'a7' },
    { path: 'dashboard/public/data-test-domain/kg-full.json', type: 'blob', sha: 'a8' },
    { path: 'dashboard/public/data-test-domain-2/methods.json', type: 'blob', sha: 'a9' },
    { path: 'dashboard/scripts/precompute/benchmarks/config/test_domain.json', type: 'blob', sha: 'b1' },
    { path: 'dashboard/scripts/precompute/benchmarks/config/grasp_planning.json', type: 'blob', sha: 'b2' },
  ];
  const EXPECTED = [
    'domains/test_domain.yaml',
    'datasets/test-domain/test.csv',
    'datasets/test-domain/papers.zip',
    'datasets/test-domain/tei/graspgen.tei.xml',
    'dashboard/public/data-test-domain/methods.json',
    'dashboard/public/data-test-domain/kg-full.json',
    'dashboard/scripts/precompute/benchmarks/config/test_domain.json',
  ].sort();

  test('rejects missing token (401) and non-POST (405)', async () => {
    installFetch([]);
    let res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', confirm: 'test_domain' }, token: null }), res);
    assert.equal(res.statusCode, 401);
    res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 405);
  });

  test('requires typed confirmation equal to the domain (400)', async () => {
    installFetch(gitChain({ tree: TREE }));
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', confirm: 'test' } }), res);
    assert.equal(res.statusCode, 400);
    assert.ok(!calls.some(c => c.method === 'PATCH'), 'must not write anything');
  });

  test('rejects unsafe domain names (400)', async () => {
    installFetch(gitChain({ tree: TREE }));
    for (const bad of ['../etc', 'a/b', '', 'Test Domain']) {
      const res = mockRes();
      await handler(mkReq('POST', { body: { domain: bad, confirm: bad } }), res);
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });

  test('refuses protected core domains in either spelling (403)', async () => {
    installFetch(gitChain({ tree: TREE }));
    for (const d of ['grasp_planning', 'grasp-planning', 'motion_planning']) {
      const res = mockRes();
      await handler(mkReq('POST', { body: { domain: d, confirm: d } }), res);
      assert.equal(res.statusCode, 403, `expected 403 for ${d}`);
    }
    assert.ok(!calls.some(c => c.method === 'PATCH'));
  });

  test('404 when the domain YAML is not in the repo tree', async () => {
    installFetch(gitChain({ tree: TREE.filter(t => t.path !== 'domains/test_domain.yaml') }));
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', confirm: 'test_domain' } }), res);
    assert.equal(res.statusCode, 404);
  });

  test('removes exactly the domain files in ONE commit (prefix-boundary safe)', async () => {
    const cap = {};
    installFetch([
      ...gitChain({ tree: TREE, captured: cap }),
      [/^GET .*\/actions\/caches/, () => json({ total_count: 0, actions_caches: [] })],
    ]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', confirm: 'test_domain' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.commitSha, 'new-commit-sha');
    assert.equal(cap.trees.length, 1);
    const t = cap.trees[0];
    assert.equal(t.base_tree, 'base-tree');
    const paths = t.tree.map(i => i.path).sort();
    assert.deepEqual(paths, EXPECTED);
    for (const i of t.tree) assert.equal(i.sha, null, `${i.path} must be a deletion (sha:null)`);
    assert.deepEqual([...res.body.removed].sort(), EXPECTED);
    assert.equal(cap.commits.length, 1);
    assert.deepEqual(cap.commits[0].parents, ['base-sha']);
    assert.match(cap.commits[0].message, /test_domain/);
    assert.doesNotMatch(cap.commits[0].message, /claude|anthropic|co-authored/i);
  });

  test('retries when a concurrent push moves main (422 then 200)', async () => {
    const cap = {};
    installFetch([
      ...gitChain({ tree: TREE, captured: cap, patchStatuses: [422, 200] }),
      [/^GET .*\/actions\/caches/, () => json({ total_count: 0, actions_caches: [] })],
    ]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', confirm: 'test_domain' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(cap.patches.length, 2);
    assert.ok(cap.patches.every(p => p.force !== true), 'must never force-push main');
  });

  test('best-effort clears this domain\'s pipeline caches; cache errors never fail the delete', async () => {
    const cap = {};
    installFetch([
      ...gitChain({ tree: TREE, captured: cap }),
      [/^GET .*\/actions\/caches\?.*key=pipeline-cache-test-domain-/, () => json({
        total_count: 2,
        actions_caches: [
          { id: 11, key: 'pipeline-cache-test-domain-111' },
          { id: 12, key: 'pipeline-cache-test-domain-2-999' }, // different domain: keep
        ],
      })],
      [/^DELETE .*\/actions\/caches\/11$/, () => new Response(null, { status: 204 })],
      [/^DELETE .*\/actions\/caches\/12$/, () => new Response(null, { status: 204 })],
    ]);
    let res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', confirm: 'test_domain' } }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(calls.some(c => c.method === 'DELETE' && /\/actions\/caches\/11$/.test(c.url)));
    assert.ok(!calls.some(c => c.method === 'DELETE' && /\/actions\/caches\/12$/.test(c.url)),
      'must not delete another domain\'s cache (prefix boundary)');

    installFetch([
      ...gitChain({ tree: TREE }),
      [/^GET .*\/actions\/caches/, () => json({ message: 'boom' }, 500)],
    ]);
    res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', confirm: 'test_domain' } }), res);
    assert.equal(res.statusCode, 200);
  });
});

/* ------------------------------------------------------------------ */
/* build-logs                                                           */
/* ------------------------------------------------------------------ */
describe('build-logs', async () => {
  const mod = await import('../../api/admin/build-logs.js');
  const handler = mod.default;

  const LOG = [
    '2026-09-10T10:00:00.0000000Z ##[group]Run python scripts/ingest_domain.py --domain test_domain',
    '2026-09-10T10:00:01.0000000Z Loading domain config domains/test_domain.yaml',
    '2026-09-10T10:00:02.0000000Z step_kg: building knowledge graph',
    '2026-09-10T10:00:03.0000000Z ERROR: No LLM API key configured (set GROQ_API_KEY or GEMINI_API_KEY)',
    '2026-09-10T10:00:04.0000000Z Traceback (most recent call last):',
    '2026-09-10T10:00:04.1000000Z   File "scripts/ingest_domain.py", line 88, in main',
    '2026-09-10T10:00:04.2000000Z RuntimeError: extraction failed',
    '2026-09-10T10:00:05.0000000Z ##[error]Process completed with exit code 1.',
    '2026-09-10T10:00:06.0000000Z ##[group]Run docker stop grobid 2>/dev/null || true',
    '2026-09-10T10:00:07.0000000Z grobid',
    '2026-09-10T10:00:08.0000000Z Post job cleanup.',
  ].join('\n');

  const RUN_FAILED = {
    id: 42, display_title: 'Build test_domain (all)', name: 'Domain Build Pipeline', event: 'repository_dispatch',
    status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/42',
    created_at: '2026-09-10T09:59:00Z', run_started_at: '2026-09-10T09:59:10Z', updated_at: '2026-09-10T10:00:09Z',
  };
  const JOBS_FAILED = { jobs: [{
    id: 7, name: 'build', status: 'completed', conclusion: 'failure',
    html_url: 'https://github.com/o/r/actions/runs/42/job/7',
    steps: [
      { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 },
      { name: 'Run ingestion pipeline', status: 'completed', conclusion: 'failure', number: 14 },
      { name: 'Commit results', status: 'completed', conclusion: 'skipped', number: 15 },
      { name: 'Stop GROBID', status: 'completed', conclusion: 'success', number: 16 },
    ],
  }] };

  test('400 without run_id, 401 without token', async () => {
    installFetch([]);
    let res = mockRes();
    await handler(mkReq('GET', { query: {} }), res);
    assert.equal(res.statusCode, 400);
    res = mockRes();
    await handler(mkReq('GET', { query: { run_id: '42' }, token: null }), res);
    assert.equal(res.statusCode, 401);
  });

  test('failed run -> failing step, de-timestamped excerpt around ##[error], actionable hint', async () => {
    installFetch([
      [/^GET .*\/actions\/runs\/42$/, () => json(RUN_FAILED)],
      [/^GET .*\/actions\/runs\/42\/jobs/, () => json(JOBS_FAILED)],
      [/^GET .*\/actions\/jobs\/7\/logs$/, () => new Response(null, { status: 302, headers: { location: 'https://logs.example.net/job7.txt?sig=abc' } })],
      [/^GET https:\/\/logs\.example\.net\/job7\.txt/, () => new Response(LOG, { status: 200, headers: { 'content-type': 'text/plain' } })],
    ]);
    const res = mockRes();
    await handler(mkReq('GET', { query: { run_id: '42' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const { run, jobs, failure } = res.body;
    assert.equal(run.id, 42);
    assert.equal(run.title, 'Build test_domain (all)');
    assert.equal(jobs[0].steps.length, 4);
    assert.ok(failure, 'failure block expected');
    assert.equal(failure.job, 'build');
    assert.equal(failure.step, 'Run ingestion pipeline');
    assert.match(failure.excerpt, /No LLM API key configured/);
    assert.match(failure.excerpt, /RuntimeError: extraction failed/);
    assert.doesNotMatch(failure.excerpt, /^\d{4}-\d{2}-\d{2}T/m, 'timestamps must be stripped');
    assert.ok(failure.excerpt.length <= 12000);
    assert.ok(Array.isArray(failure.hints) && failure.hints.length >= 1);
    assert.match(failure.hints[0].title, /key/i);
    assert.ok(failure.hints[0].fix && failure.hints[0].fix.length > 10, 'hint must carry a concrete fix');
    // the pre-signed log URL is a third-party host: never send the PAT there
    const logCall = calls.find(c => c.url.startsWith('https://logs.example.net/'));
    assert.ok(logCall, 'must follow the log redirect');
    assert.ok(!logCall.headers.authorization, 'must NOT forward Authorization to the log host');
    assert.ok(!JSON.stringify(res.body).includes('ghp_TESTSECRET123'));
  });

  test('in-progress run -> steps only, no log download', async () => {
    installFetch([
      [/^GET .*\/actions\/runs\/43$/, () => json({ ...RUN_FAILED, id: 43, status: 'in_progress', conclusion: null })],
      [/^GET .*\/actions\/runs\/43\/jobs/, () => json({ jobs: [{ ...JOBS_FAILED.jobs[0], status: 'in_progress', conclusion: null }] })],
    ]);
    const res = mockRes();
    await handler(mkReq('GET', { query: { run_id: '43' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.failure, null);
    assert.ok(!calls.some(c => /\/logs$/.test(c.url)));
  });

  test('successful run -> failure null, no log download', async () => {
    installFetch([
      [/^GET .*\/actions\/runs\/44$/, () => json({ ...RUN_FAILED, id: 44, conclusion: 'success' })],
      [/^GET .*\/actions\/runs\/44\/jobs/, () => json({ jobs: [{ ...JOBS_FAILED.jobs[0], conclusion: 'success', steps: [] }] })],
    ]);
    const res = mockRes();
    await handler(mkReq('GET', { query: { run_id: '44' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.failure, null);
    assert.ok(!calls.some(c => /\/logs$/.test(c.url)));
  });

  test('hint rules: named export hintsFor(text) -> [{title, fix}] in rule order', () => {
    const { hintsFor } = mod;
    assert.equal(typeof hintsFor, 'function');
    const cases = [
      ['API key not valid. Please pass a valid API key.', /invalid|rejected/i],
      ['groq.APIStatusError: Error code: 401 - Invalid API Key', /invalid|rejected/i],
      ['429 Too Many Requests: RESOURCE_EXHAUSTED', /rate|quota/i],
      ['batch response: This repository is over its data quota. Account responsible for LFS bandwidth should purchase more data packs', /LFS/i],
      ['ERROR: papers dir not found: datasets/x/papers', /PDF/i],
      ["KeyError: 'Name'", /CSV/i],
      ['GROBID never responded', /GROBID/i],
      ['::error::push failed after 5 attempts', /push|conflict|race|concurrent/i],
      ['ERROR: Could not find a version that satisfies the requirement torch==9.9', /depend|install|package/i],
      ['yaml.scanner.ScannerError: mapping values are not allowed here', /YAML|config/i],
      ["[32da80e1] Object does not exist on the server: [404] Object does not exist on the server\nFailed to fetch some objects from 'https://github.com/o/r.git/info/lfs'", /zip|LFS|storage/i],
    ];
    for (const [text, re] of cases) {
      const h = hintsFor(text);
      assert.ok(Array.isArray(h) && h.length >= 1, `no hint for: ${text}`);
      assert.match(h[0].title, re, `wrong first hint for: ${text} -> ${h[0].title}`);
      assert.ok(typeof h[0].fix === 'string' && h[0].fix.length > 10);
    }
    assert.deepEqual(hintsFor('everything is fine, completed successfully'), []);
  });
});

/* ------------------------------------------------------------------ */
/* build-status                                                         */
/* ------------------------------------------------------------------ */
describe('build-status', async () => {
  const { default: handler } = await import('../../api/admin/build-status.js');

  const base = { name: 'Domain Build Pipeline', html_url: 'https://github.com/o/r/actions/runs/x' };
  const DISPATCH_RUNS = { workflow_runs: [
    { ...base, id: 1, display_title: 'Build test_domain (all)', event: 'repository_dispatch', status: 'in_progress', conclusion: null,
      created_at: '2026-08-10T10:00:00Z', run_started_at: '2026-08-10T10:00:05Z', updated_at: '2026-08-10T10:05:00Z',
      jobs_url: `${GH}/actions/runs/1/jobs` },
    { ...base, id: 2, display_title: 'Build grasp_planning (precompute, forced)', event: 'repository_dispatch', status: 'completed', conclusion: 'success',
      created_at: '2026-08-09T06:10:00Z', run_started_at: '2026-08-09T06:10:10Z', updated_at: '2026-08-09T06:15:10Z',
      jobs_url: `${GH}/actions/runs/2/jobs` },
    { ...base, id: 3, display_title: 'Domain Build Pipeline', event: 'repository_dispatch', status: 'completed', conclusion: 'failure',
      created_at: '2026-08-01T06:10:00Z', run_started_at: '2026-08-01T06:10:00Z', updated_at: '2026-08-01T06:40:00Z',
      jobs_url: `${GH}/actions/runs/3/jobs` },
    { ...base, id: 5, display_title: 'Switch domain: motion_planning', event: 'repository_dispatch', status: 'completed', conclusion: 'success',
      created_at: '2026-07-30T06:10:00Z', run_started_at: '2026-07-30T06:10:00Z', updated_at: '2026-07-30T06:11:00Z',
      jobs_url: `${GH}/actions/runs/5/jobs` },
  ] };
  const POLL_RUNS = { workflow_runs: [
    { id: 4, name: 'Poll Google Drive CSV folders', display_title: 'Poll Google Drive CSV folders', event: 'schedule',
      status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/4',
      created_at: '2026-08-10T06:00:00Z', run_started_at: '2026-08-10T06:00:03Z', updated_at: '2026-08-10T06:01:03Z' },
  ] };

  test('merges build + nightly runs, parses domain/scope/forced, computes durations, newest first', async () => {
    installFetch([
      [/^GET .*\/actions\/runs\?.*event=repository_dispatch/, () => json(DISPATCH_RUNS)],
      [/^GET .*\/actions\/workflows\/sheet-poll\.yml\/runs/, () => json(POLL_RUNS)],
      [/^GET .*\/actions\/runs\/1\/jobs/, () => json({ jobs: [{ name: 'build', status: 'in_progress', conclusion: null,
        steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 },
                { name: 'Run ingestion pipeline', status: 'in_progress', conclusion: null, number: 14 }] }] })],
      [/^GET .*\/deployments/, () => json([])],
    ]);
    const res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const runs = res.body.runs;
    assert.deepEqual(runs.map(r => r.id), [1, 4, 2, 3, 5], 'sorted by created_at desc');
    const byId = Object.fromEntries(runs.map(r => [r.id, r]));
    assert.equal(byId[1].kind, 'build');
    assert.equal(byId[1].domain, 'test_domain');
    assert.equal(byId[1].scope, 'all');
    assert.equal(byId[1].forced, false);
    assert.equal(byId[1].title, 'Build test_domain (all)');
    assert.ok(Array.isArray(byId[1].jobs) && byId[1].jobs[0].steps.length === 2, 'in-progress run keeps jobs/steps');
    assert.ok(typeof byId[1].duration_s === 'number' && byId[1].duration_s > 0, 'in-progress duration = now - started');
    assert.equal(byId[2].domain, 'grasp_planning');
    assert.equal(byId[2].scope, 'precompute');
    assert.equal(byId[2].forced, true);
    assert.equal(byId[2].duration_s, 300);
    assert.equal(byId[3].kind, 'build');
    assert.equal(byId[3].domain, null, 'legacy run without run-name -> domain null');
    assert.equal(byId[3].scope, null);
    assert.equal(byId[4].kind, 'nightly');
    assert.equal(byId[4].duration_s, 60);
    assert.equal(byId[5].kind, 'switch');
    assert.ok(Array.isArray(res.body.deployments));
  });

  test('nightly-poll fetch failure does not break the endpoint', async () => {
    installFetch([
      [/^GET .*\/actions\/runs\?.*event=repository_dispatch/, () => json({ workflow_runs: [] })],
      [/^GET .*\/actions\/workflows\/sheet-poll\.yml\/runs/, () => json({ message: 'boom' }, 500)],
      [/^GET .*\/deployments/, () => json([])],
    ]);
    const res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.runs, []);
  });
});

/* ------------------------------------------------------------------ */
/* keys                                                                 */
/* ------------------------------------------------------------------ */
describe('keys', async () => {
  const { default: handler } = await import('../../api/admin/keys.js');
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const PUBKEY_B64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'AIza-VERCEL-SECRET-VALUE';
    delete process.env.GROQ_API_KEY;
    delete process.env.HF_TOKEN;
  });

  test('GET reports presence + metadata only (never values), incl. GH_PAT scopes/expiry', async () => {
    installFetch([
      [/^GET .*\/actions\/secrets\?|^GET .*\/actions\/secrets$/, () => json({ total_count: 2, secrets: [
        { name: 'GEMINI_API_KEY', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' },
        { name: 'GH_PAT', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ] })],
      [/^GET https:\/\/api\.github\.com\/user$/, () => json({ login: 'o' }, 200, {
        'x-oauth-scopes': 'repo, workflow',
        'github-authentication-token-expiration': '2027-04-27 00:00:00 UTC',
      })],
    ]);
    const res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const { providers, ghPat } = res.body;
    const by = Object.fromEntries(providers.map(p => [p.name, p]));
    for (const n of ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GROQ_API_KEY', 'HF_TOKEN']) assert.ok(by[n], `missing provider ${n}`);
    assert.equal(by.GEMINI_API_KEY.inGitHub, true);
    assert.equal(by.GEMINI_API_KEY.githubUpdatedAt, '2026-02-01T00:00:00Z');
    assert.equal(by.GEMINI_API_KEY.inVercel, true);
    assert.equal(by.GROQ_API_KEY.inGitHub, false);
    assert.equal(by.GROQ_API_KEY.inVercel, false);
    assert.ok(by.GROQ_API_KEY.label && by.GROQ_API_KEY.usedFor, 'label + usedFor text for the UI');
    assert.equal(ghPat.present, true);
    assert.deepEqual(ghPat.scopes, ['repo', 'workflow']);
    assert.match(String(ghPat.expiresAt), /2027-04-27/);
    const dump = JSON.stringify(res.body);
    assert.ok(!dump.includes('AIza-VERCEL-SECRET-VALUE'), 'must never echo a key value');
    assert.ok(!dump.includes('ghp_TESTSECRET123'), 'must never echo the PAT');
  });

  test('POST rejects names outside the allowlist and empty values (400)', async () => {
    installFetch([]);
    for (const body of [{ name: 'GH_PAT', value: 'x1234567890' }, { name: 'ADMIN_TOKEN', value: 'x1234567890' },
                        { name: 'FOO', value: 'x1234567890' }, { name: 'GROQ_API_KEY', value: '   ' }]) {
      const res = mockRes();
      await handler(mkReq('POST', { body }), res);
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    assert.ok(!calls.some(c => c.method === 'PUT'));
  });

  test('POST: provider rejects the key -> 422, nothing saved', async () => {
    installFetch([
      [/^GET https:\/\/generativelanguage\.googleapis\.com\//, () => json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }, 400)],
    ]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { name: 'GEMINI_API_KEY', value: 'AIza-bad' } }), res);
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.match(res.body.error, /reject|invalid|not valid/i);
    assert.ok(!calls.some(c => c.method === 'PUT'));
    const v = calls.find(c => c.url.startsWith('https://generativelanguage.googleapis.com/'));
    assert.ok(!v.url.includes('AIza-bad'), 'Gemini key goes in the x-goog-api-key header, not the URL');
    assert.equal(v.headers['x-goog-api-key'], 'AIza-bad');
  });

  test('POST: valid Groq key -> verified, sealed with the repo public key, saved as a GitHub secret', async () => {
    installFetch([
      [/^GET https:\/\/api\.groq\.com\/openai\/v1\/models$/, () => json({ data: [] })],
      [/^GET .*\/actions\/secrets\/public-key$/, () => json({ key_id: 'kid-1', key: PUBKEY_B64 })],
      [/^PUT .*\/actions\/secrets\/GROQ_API_KEY$/, () => new Response(null, { status: 201 })],
    ]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { name: 'GROQ_API_KEY', value: '  gsk_live_value_123  ' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.name, 'GROQ_API_KEY');
    assert.equal(res.body.validated, true);
    const verify = calls.find(c => c.url === 'https://api.groq.com/openai/v1/models');
    assert.equal(verify.headers.authorization, 'Bearer gsk_live_value_123', 'value is trimmed');
    const put = calls.find(c => c.method === 'PUT');
    assert.equal(put.body.key_id, 'kid-1');
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(put.body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey);
    assert.equal(sodium.to_string(opened), 'gsk_live_value_123');
    assert.ok(!JSON.stringify(res.body).includes('gsk_live_value_123'));
  });

  test('POST: provider rate-limits (429) -> key recognised, saved with a warning', async () => {
    installFetch([
      [/^GET https:\/\/huggingface\.co\/api\/whoami-v2$/, () => json({ error: 'rate limited' }, 429)],
      [/^GET .*\/actions\/secrets\/public-key$/, () => json({ key_id: 'kid-1', key: PUBKEY_B64 })],
      [/^PUT .*\/actions\/secrets\/HF_TOKEN$/, () => new Response(null, { status: 204 })],
    ]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { name: 'HF_TOKEN', value: 'hf_abc123456' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.ok(res.body.warning, 'rate-limit should surface a warning');
  });

  test('POST: provider unreachable -> 502 unless skipValidation, then saved unverified', async () => {
    const routes = [
      [/^GET https:\/\/api\.groq\.com\//, () => { throw new TypeError('fetch failed'); }],
      [/^GET .*\/actions\/secrets\/public-key$/, () => json({ key_id: 'kid-1', key: PUBKEY_B64 })],
      [/^PUT .*\/actions\/secrets\/GROQ_API_KEY$/, () => new Response(null, { status: 201 })],
    ];
    installFetch(routes);
    let res = mockRes();
    await handler(mkReq('POST', { body: { name: 'GROQ_API_KEY', value: 'gsk_x1234567' } }), res);
    assert.equal(res.statusCode, 502, JSON.stringify(res.body));
    assert.ok(!calls.some(c => c.method === 'PUT'));
    installFetch(routes);
    res = mockRes();
    await handler(mkReq('POST', { body: { name: 'GROQ_API_KEY', value: 'gsk_x1234567', skipValidation: true } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.validated, false);
  });
});

/* ------------------------------------------------------------------ */
/* upload (additions for the handoff)                                   */
/* ------------------------------------------------------------------ */
describe('upload', async () => {
  const { default: handler } = await import('../../api/admin/upload.js');
  const YAML = [
    'domain: test_domain',
    'display_name: "Test Domain"',
    'csv_path: datasets/test-domain/test.csv',
    'papers_dir: datasets/test-domain/papers/',
    'columns: {}',
    '',
  ].join('\n');
  const contentsRoute = (yaml) => [/^GET .*\/contents\/domains\/test_domain\.yaml/, () => json({
    type: 'file', path: 'domains/test_domain.yaml', sha: 'yaml-sha', encoding: 'base64', content: b64(yaml),
  })];
  const committed = (cap) => {
    // map path -> decoded content, joining tree items with the blob bodies (in order)
    const items = cap.trees[0].tree;
    const out = {};
    items.forEach((it) => {
      const n = Number(String(it.sha).replace('blob-', '')) - 1;
      out[it.path] = cap.blobs[n] ? unb64(cap.blobs[n].content) : null;
    });
    return out;
  };

  test('new domain YAML enables the Explorer page', async () => {
    const cap = {};
    installFetch(gitChain({ captured: cap }));
    const res = mockRes();
    await handler(mkReq('POST', { body: {
      domain: 'test_domain', csvContent: 'Name,Citation\nA,"X. A. Title. 2024."\n', csvFilename: 'test.csv',
      displayName: 'Test Domain', methodNoun: 'method',
    } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const files = committed(cap);
    assert.match(files['domains/test_domain.yaml'], /^explorer_enabled: true$/m);
    assert.equal(files['datasets/test-domain/test.csv'], 'Name,Citation\nA,"X. A. Title. 2024."\n');
  });

  test('updateOnly + csvContent replaces the CSV at the YAML csv_path', async () => {
    const cap = {};
    installFetch([contentsRoute(YAML), ...gitChain({ captured: cap })]);
    const res = mockRes();
    const csv = 'Name,Citation\nA,x\nB,y\n';
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, csvContent: csv, csvFilename: 'new-export.csv' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const files = committed(cap);
    assert.equal(files['datasets/test-domain/test.csv'], csv);
    assert.ok(!('datasets/test-domain/new-export.csv' in files), 'replace in place, do not fork a second CSV');
  });

  test('updateOnly + pdfUrl sets (then replaces) pdf_url in the YAML', async () => {
    let cap = {};
    installFetch([contentsRoute(YAML), ...gitChain({ captured: cap })]);
    let res = mockRes();
    const url1 = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv';
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, pdfUrl: url1 } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    let yaml = committed(cap)['domains/test_domain.yaml'];
    assert.match(yaml, new RegExp(`^pdf_url: "${url1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
    assert.match(yaml, /^csv_path: datasets\/test-domain\/test\.csv$/m, 'rest of YAML preserved');

    cap = {};
    installFetch([contentsRoute(yaml), ...gitChain({ captured: cap })]);
    res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, pdfUrl: 'https://example.org/p.zip' } }), res);
    yaml = committed(cap)['domains/test_domain.yaml'];
    assert.equal((yaml.match(/^pdf_url:/gm) || []).length, 1, 'exactly one pdf_url line');
    assert.match(yaml, /^pdf_url: "https:\/\/example\.org\/p\.zip"$/m);
  });

  test('PDF zip: uploads to LFS, then VERIFIES (object is only downloadable after verify)', async () => {
    const cap = {};
    const lfs = [];
    installFetch([
      [/^POST https:\/\/github\.com\/o\/r\.git\/info\/lfs\/objects\/batch$/, (u, o, body) => json({ objects: [{
        oid: body.objects[0].oid, size: body.objects[0].size,
        actions: { upload: { href: 'https://lfs.example/put', header: { 'X-Sig': '1' } },
                   verify: { href: 'https://lfs.example/verify', header: { Authorization: 'RemoteAuth v' } } },
      }] })],
      [/^PUT https:\/\/lfs\.example\/put$/, () => { lfs.push('put'); return new Response(null, { status: 200 }); }],
      [/^POST https:\/\/lfs\.example\/verify$/, (u, o, body) => { lfs.push(['verify', body]); return new Response(null, { status: 200 }); }],
      contentsRoute(YAML), ...gitChain({ captured: cap }),
    ]);
    const res = mockRes();
    const zip = Buffer.from('PK\u0003\u0004fake-zip-bytes');
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, pdfZipBase64: zip.toString('base64') } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(lfs[0], 'put');
    assert.equal(lfs[1][0], 'verify', 'verify must follow the PUT');
    assert.equal(lfs[1][1].size, zip.length);
    assert.match(lfs[1][1].oid, /^[0-9a-f]{64}$/);
    assert.match(committed(cap)['datasets/test-domain/papers.zip'], /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize \d+\n$/);
  });

  test('PDF zip: a per-object LFS error fails the upload instead of committing a dangling pointer', async () => {
    const cap = {};
    installFetch([
      [/^POST https:\/\/github\.com\/o\/r\.git\/info\/lfs\/objects\/batch$/, () => json({ objects: [{
        oid: 'x', size: 1, error: { code: 507, message: 'Insufficient storage' } }] })],
      contentsRoute(YAML), ...gitChain({ captured: cap }),
    ]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, pdfZipBase64: Buffer.from('PK').toString('base64') } }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /Insufficient storage/);
    assert.equal(cap.patches.length, 0, 'nothing committed');
  });

  test('updateOnly + driveFolder connects a Google Drive folder (sets drive_folder; rejects non-folder links)', async () => {
    let cap = {};
    installFetch([contentsRoute(YAML), ...gitChain({ captured: cap })]);
    let res = mockRes();
    const folder = 'https://drive.google.com/drive/folders/1TOPFOLDERXXXXXXXXXXXXXXX?usp=sharing';
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, driveFolder: folder } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const yaml = committed(cap)['domains/test_domain.yaml'];
    assert.equal((yaml.match(/^drive_folder:/gm) || []).length, 1);
    assert.match(yaml, /^drive_folder: "https:\/\/drive\.google\.com\/drive\/folders\/1TOPFOLDERXXXXXXXXXXXXXXX\?usp=sharing"$/m);
    assert.match(yaml, /^csv_path: datasets\/test-domain\/test\.csv$/m);

    cap = {};
    installFetch([contentsRoute(YAML), ...gitChain({ captured: cap })]);
    res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, driveFolder: 'https://example.org/papers.zip' } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(cap.patches.length, 0);
  });

  test('upload survives a concurrent push (ref 422 then 200)', async () => {
    const cap = {};
    installFetch([contentsRoute(YAML), ...gitChain({ captured: cap, patchStatuses: [422, 200] })]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', updateOnly: true, csvContent: 'Name\nA\n' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(cap.patches.every(p => p.force !== true));
  });
});

/* ------------------------------------------------------------------ */
/* domains                                                              */
/* ------------------------------------------------------------------ */
describe('domains', async () => {
  const { default: handler } = await import('../../api/admin/domains.js');
  test('flags protected core domains and surfaces pdf_url / drive_folder', async () => {
    installFetch([
      [/^GET .*\/git\/ref\/heads\/main$/, () => json({ object: { sha: 'abc123sha' } })],
      [/^GET .*\/contents\/domains\?ref=abc123sha$/, () => json([
        { name: 'grasp_planning.yaml', download_url: 'https://raw.example/grasp.yaml' },
        { name: 'test_domain.yaml', download_url: 'https://raw.example/test.yaml' },
      ])],
      [/^GET https:\/\/raw\.example\/grasp\.yaml$/, () => new Response('display_name: "Grasp Planning"\ncsv_path: datasets/csv-gp-combined.csv\ndrive_folder: "https://drive.google.com/drive/folders/abc"\n')],
      [/^GET https:\/\/raw\.example\/test\.yaml$/, () => new Response('display_name: "Test Domain"\ncsv_path: datasets/test-domain/test.csv\npdf_url: "https://example.org/p.zip"\n')],
      [/^GET .*\/contents\/dashboard\/public\/data-/, () => json([], 404)],
    ]);
    const res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const by = Object.fromEntries(res.body.domains.map(d => [d.slug, d]));
    assert.equal(by.grasp_planning.protected, true);
    assert.equal(by.test_domain.protected, false);
    assert.equal(by.test_domain.pdfUrl, 'https://example.org/p.zip');
    assert.equal(by.grasp_planning.driveFolder, 'https://drive.google.com/drive/folders/abc');
  });

  test('reads are pinned to main\'s commit (fresh right after an admin commit) and GitHub errors surface', async () => {
    installFetch([
      [/^GET .*\/git\/ref\/heads\/main$/, () => json({ object: { sha: 'abc123sha' } })],
      [/^GET .*\/contents\/domains\?ref=abc123sha$/, () => json([{ name: 'test_domain.yaml', download_url: 'https://raw.example/abc123sha/test.yaml' }])],
      [/^GET https:\/\/raw\.example\/abc123sha\/test\.yaml$/, () => new Response('display_name: "Test Domain"\n')],
      [/^GET .*\/contents\/dashboard\/public\/data-test-domain\?ref=abc123sha$/, () => json([])],
    ]);
    let res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.domains.length, 1);
    assert.ok(calls.some(c => /data-test-domain\?ref=abc123sha$/.test(c.url)), 'data listing pinned to the same commit');

    installFetch([[/^GET .*\/contents\/domains/, () => json({ message: 'Bad credentials' }, 401)]]);
    res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /token/i);
  });
});
