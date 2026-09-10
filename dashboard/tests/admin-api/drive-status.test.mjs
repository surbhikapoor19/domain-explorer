/* Google Drive folder connection — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
 * Run: node --test dashboard/tests/admin-api/drive-status.test.mjs
 * Each domain's Drive folder holds the sheet CSV exports and the paper PDFs (top level or one
 * subfolder deep). The admin shows reachability, counts, PDF->method matching and when it was last
 * counted; the last count lives in a GitHub Actions repo variable DRIVE_STATUS_<DOMAIN>. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'admintok';
process.env.GH_PAT = 'ghp_TESTSECRET123';
process.env.GITHUB_OWNER = 'o';
process.env.GITHUB_REPO = 'r';

const lib = await import('../../lib/admin-drive.js');
const { default: handler } = await import('../../api/admin/drive-status.js');

const FP = '4301741e9bfd533b62f3c5738851eb83caf6076b'; // sha1 of sorted "id:name" lines (shared with Python)

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => res; res.end = () => res;
  return res;
}
const mkReq = (method, { body, query, token = 'admintok' } = {}) =>
  ({ method, body, query: query || {}, headers: token ? { 'x-admin-token': token } : {} });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const html = (h, s = 200) => new Response(h, { status: s, headers: { 'content-type': 'text/html' } });

let calls = [];
function installFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    calls.push({ url: u, method, body });
    for (const [re, fn] of routes) if (re.test(`${method} ${u}`)) return fn(u, opts, body);
    return json({ message: 'Not Found' }, 404);
  };
}

const entry = (id, name, { folder = false, modified = 'Sep 3' } = {}) =>
  `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info">` +
  `<a href="https://drive.google.com/${folder ? 'drive/folders' : 'file/d'}/${id}${folder ? '' : '/view?usp=drive_web'}" target="_blank">` +
  `<div class="flip-entry-visual"><div class="flip-entry-thumb"><img src="x" alt=""/></div></div>` +
  `<div class="flip-entry-title">${name}</div></a></div><div class="flip-entry-last-modified"><div>${modified}</div></div></div>`;
const listing = (title, entries) =>
  `<html><head><title>${title}</title></head><body><div class="flip-list-title-header">TITLE</div>` +
  `<div class="flip-entries">${entries.join('')}</div></body></html>`;

const TOP = listing('Test Domain', [
  entry('1CSVAAAAAAAAAAAAAAAAAAAAA', 'Test Sheet_2026-09-01_10-00-00.csv', { modified: 'Sep 1' }),
  entry('1CSVBBBBBBBBBBBBBBBBBBBBB', 'Test Sheet_2026-09-03_22-41-54.csv', { modified: 'Sep 3' }),
  entry('1AAAAAAAAAAAAAAAAAAAAAAAA', 'GraspGen.pdf'),
  entry('1FOLDERPDFSSSSSSSSSSSSSSS', 'PDFs', { folder: true }),
]);
const SUB = listing('PDFs', [
  entry('1CCCCCCCCCCCCCCCCCCCCCCCC', 'AffordGen.pdf'),
  entry('1AAAAAAAAAAAAAAAAAAAAAAAA', 'GraspGen.pdf'), // same file linked twice -> counted once
  entry('1NOTESSSSSSSSSSSSSSSSSSSS', 'notes.txt'),
]);
const FOLDER_URL = 'https://drive.google.com/drive/folders/1TOPFOLDERXXXXXXXXXXXXXXX?usp=sharing';
const driveRoutes = (top = TOP) => [
  [/^GET https:\/\/drive\.google\.com\/embeddedfolderview\?id=1TOPFOLDERXXXXXXXXXXXXXXX/, () => html(top)],
  [/^GET https:\/\/drive\.google\.com\/embeddedfolderview\?id=1FOLDERPDFSSSSSSSSSSSSSSS/, () => html(SUB)],
];

describe('lib/admin-drive.js (pure helpers)', () => {
  test('driveFolderId accepts share links incl. /u/N/, rejects files and other hosts', () => {
    assert.equal(lib.driveFolderId(FOLDER_URL), '1TOPFOLDERXXXXXXXXXXXXXXX');
    assert.equal(lib.driveFolderId('https://drive.google.com/drive/u/0/folders/1TOPFOLDERXXXXXXXXXXXXXXX'), '1TOPFOLDERXXXXXXXXXXXXXXX');
    assert.equal(lib.driveFolderId('https://drive.google.com/file/d/1XyZ_abcdefghijklmnopq/view'), null);
    assert.equal(lib.driveFolderId('https://example.org/drive/folders/1TOPFOLDERXXXXXXXXXXXXXXX'), null);
    assert.equal(lib.driveFolderId(''), null);
  });

  test('parseDriveListing: public flag, title, files vs folders, modified text', () => {
    const p = lib.parseDriveListing(TOP);
    assert.equal(p.public, true);
    assert.equal(p.title, 'Test Domain');
    assert.equal(p.entries.length, 4);
    assert.deepEqual(p.entries.find(e => e.name === 'PDFs'), { id: '1FOLDERPDFSSSSSSSSSSSSSSS', name: 'PDFs', kind: 'folder', modified: 'Sep 3' });
    assert.equal(p.entries.find(e => e.name === 'GraspGen.pdf').kind, 'file');
    assert.equal(lib.parseDriveListing('<html><title>Sign in</title>accounts.google.com</html>').public, false);
  });

  test('slugifyMethodName mirrors the pipeline (_slugify)', () => {
    assert.equal(lib.slugifyMethodName('Dex-Net 2.0 (GQ-CNN)'), 'dex-net-2-0-gq-cnn');
    assert.equal(lib.slugifyMethodName('🤖 AffordGen'), 'affordgen');
    assert.equal(lib.slugifyMethodName('6-DoF GraspNet'), '6-dof-graspnet');
  });

  test('matchPdfs mirrors build_method_paper_map: exact slug, then shared words', () => {
    const r = lib.matchPdfs(
      ['graspgen.pdf', 'Contact_GraspNet.pdf', 'dex-net-2-0-gq-cnn.pdf', 'unrelated-survey.pdf'],
      ['GraspGen', 'Contact-GraspNet', 'Dex-Net 2.0 (GQ-CNN)', 'AnyGrasp']);
    assert.equal(r.matchedMethods, 3);
    assert.deepEqual(r.missingMethods, ['AnyGrasp']);
    assert.deepEqual(r.unmatchedPdfs, ['unrelated-survey.pdf']);
  });

  test('pdfFingerprint = sha1 of sorted "id:name" lines (identical to the Python nightly)', () => {
    assert.equal(lib.pdfFingerprint([
      { id: '1CCCCCCCCCCCCCCCCCCCCCCCC', name: 'AffordGen.pdf' },
      { id: '1AAAAAAAAAAAAAAAAAAAAAAAA', name: 'GraspGen.pdf' },
    ]), FP);
  });

  test('checkDriveFolder: CSVs from the top level, PDFs from top level + one subfolder level, deduped', async () => {
    installFetch(driveRoutes());
    const r = await lib.checkDriveFolder(FOLDER_URL);
    assert.equal(r.status, 'ok');
    assert.equal(r.title, 'Test Domain');
    assert.equal(r.csv.count, 2);
    assert.equal(r.csv.newest, 'Test Sheet_2026-09-03_22-41-54.csv');
    assert.equal(r.pdf.count, 2);
    assert.deepEqual([...r.pdf.files].map(f => f.name).sort(), ['AffordGen.pdf', 'GraspGen.pdf']);
    assert.deepEqual(r.pdf.subfolders, ['PDFs']);
    assert.equal(r.pdf.fingerprint, FP);
    assert.ok(!Number.isNaN(Date.parse(r.checkedAt)));
  });

  test('checkDriveFolder: not found (404), not public (sign-in page), empty, unreachable, invalid', async () => {
    installFetch([[/embeddedfolderview/, () => html('<title>Error 404 (Not Found)!!1</title>', 404)]]);
    assert.equal((await lib.checkDriveFolder(FOLDER_URL)).status, 'not_found');
    installFetch([[/embeddedfolderview/, () => html('<html><title>Sign in - Google Accounts</title></html>')]]);
    const np = await lib.checkDriveFolder(FOLDER_URL);
    assert.equal(np.status, 'not_public');
    assert.match(np.message, /anyone with the link/i);
    installFetch([[/embeddedfolderview/, () => html(listing('Empty', []))]]);
    assert.equal((await lib.checkDriveFolder(FOLDER_URL)).status, 'empty');
    installFetch([[/embeddedfolderview/, () => { throw new TypeError('fetch failed'); }]]);
    assert.equal((await lib.checkDriveFolder(FOLDER_URL)).status, 'unreachable');
    assert.equal((await lib.checkDriveFolder('https://example.org/x')).status, 'invalid');
  });
});

describe('api/admin/drive-status.js', () => {
  const YAML_TEST = `domain: test_domain\ndisplay_name: "Test Domain"\ncsv_path: datasets/test-domain/test.csv\ndrive_folder: "${FOLDER_URL}"\n`;
  const YAML_GRASP = 'domain: grasp_planning\ndisplay_name: "Grasp Explorer"\ncsv_path: datasets/csv-gp-combined.csv\n';
  const repoRoutes = ({ variable } = {}) => [
    [/^GET .*\/git\/ref\/heads\/main$/, () => json({ object: { sha: 'sha1' } })],
    [/^GET .*\/contents\/domains\?ref=sha1$/, () => json([
      { name: 'grasp_planning.yaml', download_url: 'https://raw.example/sha1/grasp.yaml' },
      { name: 'test_domain.yaml', download_url: 'https://raw.example/sha1/test.yaml' },
    ])],
    [/^GET https:\/\/raw\.example\/sha1\/grasp\.yaml$/, () => new Response(YAML_GRASP)],
    [/^GET https:\/\/raw\.example\/sha1\/test\.yaml$/, () => new Response(YAML_TEST)],
    [/^GET .*\/contents\/domains\/grasp_planning\.yaml\?ref=sha1$/, () => json({ content: Buffer.from(YAML_GRASP).toString('base64'), encoding: 'base64' })],
    [/^GET .*\/contents\/domains\/test_domain\.yaml\?ref=sha1$/, () => json({ content: Buffer.from(YAML_TEST).toString('base64'), encoding: 'base64' })],
    [/^GET .*\/contents\/datasets\/test-domain\/test\.csv\?ref=sha1$/, () => json({
      content: Buffer.from('Name,Citation\nGraspGen,"x"\nAffordGen,"y"\n"Dex-Net 2.0 (GQ-CNN)","z"\n').toString('base64'), encoding: 'base64' })],
    [/^GET .*\/actions\/variables\/DRIVE_STATUS_TEST_DOMAIN$/, () => variable
      ? json({ name: 'DRIVE_STATUS_TEST_DOMAIN', value: JSON.stringify(variable), updated_at: '2026-09-10T06:00:05Z' })
      : json({ message: 'Not Found' }, 404)],
    [/^POST .*\/actions\/variables$/, () => new Response(null, { status: 201 })],
    [/^PATCH .*\/actions\/variables\/DRIVE_STATUS_TEST_DOMAIN$/, () => new Response(null, { status: 204 })],
  ];

  test('401 without the admin token', async () => {
    installFetch([]);
    const res = mockRes();
    await handler(mkReq('GET', { token: null }), res);
    assert.equal(res.statusCode, 401);
  });

  test('GET: every domain with its folder, the last stored count, and PDF->method matching', async () => {
    const stored = { checked_at: '2026-09-10T06:00:00Z', checked_by: 'nightly', folder: { url: FOLDER_URL, status: 'ok', title: 'Test Domain' },
      csv: { count: 2, newest: 'Test Sheet_2026-09-03_22-41-54.csv' },
      pdf: { status: 'ok', count: 2, files: [{ id: 'a', name: 'GraspGen.pdf' }, { id: 'c', name: 'AffordGen.pdf' }], fingerprint: FP } };
    installFetch(repoRoutes({ variable: stored }));
    const res = mockRes();
    await handler(mkReq('GET'), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const by = Object.fromEntries(res.body.domains.map(d => [d.domain, d]));
    assert.equal(by.grasp_planning.folderUrl, null);
    assert.equal(by.grasp_planning.stored, null);
    assert.equal(by.test_domain.folderUrl, FOLDER_URL);
    assert.equal(by.test_domain.stored.checked_by, 'nightly');
    assert.equal(by.test_domain.stored.pdf.count, 2);
    assert.equal(by.test_domain.storedAt, '2026-09-10T06:00:05Z');
    assert.equal(by.test_domain.matching.matchedMethods, 2);
    assert.deepEqual(by.test_domain.matching.missingMethods, ['Dex-Net 2.0 (GQ-CNN)']);
    assert.ok(!calls.some(c => c.url.includes('embeddedfolderview')), 'GET is cheap: no live Drive listing');
  });

  test('POST {domain}: live count, stored as DRIVE_STATUS_<DOMAIN> (create on first check)', async () => {
    installFetch([...repoRoutes(), ...driveRoutes()]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.stored.checked_by, 'admin');
    assert.equal(res.body.stored.folder.status, 'ok');
    assert.equal(res.body.stored.pdf.count, 2);
    assert.equal(res.body.stored.pdf.fingerprint, FP);
    assert.equal(res.body.stored.csv.count, 2);
    assert.equal(res.body.matching.matchedMethods, 2);
    const create = calls.find(c => c.method === 'POST' && /\/actions\/variables$/.test(c.url));
    assert.ok(create, 'repo variable created');
    assert.equal(create.body.name, 'DRIVE_STATUS_TEST_DOMAIN');
    const saved = JSON.parse(create.body.value);
    assert.equal(saved.pdf.fingerprint, FP);
    assert.ok(create.body.value.length < 48000, 'fits the 48 KB variable limit');
  });

  test('POST {domain}: updates (PATCH) an existing record', async () => {
    installFetch([...repoRoutes({ variable: { checked_at: 'x', pdf: { count: 1 } } }), ...driveRoutes()]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(calls.some(c => c.method === 'PATCH' && /DRIVE_STATUS_TEST_DOMAIN$/.test(c.url)));
  });

  test('POST {domain}: a re-count keeps pdf.synced_fingerprint; markSynced:true (a build was just started) sets it', async () => {
    installFetch([...repoRoutes({ variable: { checked_at: 'x', pdf: { count: 1, fingerprint: 'old', synced_fingerprint: 'old' } } }), ...driveRoutes()]);
    let res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.stored.pdf.fingerprint, FP);
    assert.equal(res.body.stored.pdf.synced_fingerprint, 'old', 'Check now must not mark new PDFs as built');
    let patch = calls.find(c => c.method === 'PATCH');
    assert.equal(JSON.parse(patch.body.value).pdf.synced_fingerprint, 'old');

    installFetch([...repoRoutes({ variable: { checked_at: 'x', pdf: { count: 1, fingerprint: 'old', synced_fingerprint: 'old' } } }), ...driveRoutes()]);
    res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain', markSynced: true } }), res);
    assert.equal(res.body.stored.pdf.synced_fingerprint, FP);

    installFetch([...repoRoutes(), ...driveRoutes()]);           // first count ever, no build started
    res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'test_domain' } }), res);
    assert.equal(res.body.stored.pdf.synced_fingerprint, null);
  });

  test('POST {url}: tests a link before saving — Drive folders only, nothing stored', async () => {
    installFetch(driveRoutes());
    let res = mockRes();
    await handler(mkReq('POST', { body: { url: FOLDER_URL } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.status, 'ok');
    assert.equal(res.body.result.pdf.count, 2);
    assert.ok(!calls.some(c => /\/actions\/variables/.test(c.url)));
    res = mockRes();
    await handler(mkReq('POST', { body: { url: 'http://169.254.169.254/latest/meta-data' } }), res);
    assert.equal(res.statusCode, 400, 'only Google Drive folder links are fetched');
  });

  test('POST {url, includeCsv}: returns the newest CSV export, banner rows above the Name header stripped', async () => {
    const exportCsv = '"Latest update:  | 🤖 = latest additions","September 3, 2026"\n,,\nName,Citation\nGraspGen,"x"\nAffordGen,"y"\n';
    installFetch([...driveRoutes(),
      [/^GET https:\/\/drive\.usercontent\.google\.com\/download\?id=1CSVBBBBBBBBBBBBBBBBBBBBB/, () => new Response(exportCsv)]]);
    const res = mockRes();
    await handler(mkReq('POST', { body: { url: FOLDER_URL, includeCsv: true } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const f = res.body.csvFile;
    assert.equal(f.name, 'Test Sheet_2026-09-03_22-41-54.csv');
    assert.ok(f.content.startsWith('Name,Citation'), f.content.slice(0, 40));
    assert.equal(f.strippedRows, 2);
    assert.ok(!calls.some(c => c.url.includes('1CSVAAAAAAAAAAAAAAAAAAAAA')), 'only the newest export is downloaded');
  });

  test('POST {domain} for a domain with no folder -> 400 with a helpful message', async () => {
    installFetch(repoRoutes());
    const res = mockRes();
    await handler(mkReq('POST', { body: { domain: 'grasp_planning' } }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /no google drive folder/i);
  });
});
