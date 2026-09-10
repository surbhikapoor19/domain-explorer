// Google Drive folder connection — pure helpers + live folder check, shared by
// api/admin/drive-status.js (admin "Check now") and the nightly scripts/drive_sync.py
// equivalent. Lives outside api/ so Vercel doesn't turn it into a route.
import crypto from 'crypto';
import { repoInfo } from './admin-github.js';

const DRIVE_TIMEOUT_MS = 30000;

const MESSAGES = {
  not_found: "Folder not found — check the link and that it's shared 'Anyone with the link'.",
  not_public: "The folder isn't public — in Drive: Share → General access → Anyone with the link (Viewer).",
  unreachable: "Couldn't reach Google Drive — try again.",
  invalid: 'Only Google Drive folder links can be tested here.',
};

// Accepts drive.google.com/drive/folders/<id> and .../drive/u/<n>/folders/<id>;
// rejects file links and any other host.
export function driveFolderId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/i);
  return m ? m[1] : null;
}

// Parse the `embeddedfolderview` listing HTML into {public, title, entries}.
// PER-ENTRY (split on the flip-entry opener), never a single window that could
// pair one entry's id with another entry's title.
export function parseDriveListing(html) {
  const text = html || '';
  const isPublic = /class="flip-entries"/.test(text);
  const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  const starts = [];
  const openRe = /<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = openRe.exec(text))) starts.push({ index: m.index, id: m[1] });

  const entries = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const block = text.slice(start, end);
    const kind = /drive\/folders\//.test(block) ? 'folder' : 'file';
    const nameMatch = block.match(/flip-entry-title[^>]*>([^<]*)</);
    const name = nameMatch ? nameMatch[1].trim() : '';
    if (!name) continue;
    const modMatch = block.match(/flip-entry-last-modified"[^>]*>\s*<div>([^<]*)<\/div>/);
    entries.push({ id: starts[i].id, name, kind, modified: modMatch ? modMatch[1].trim() : null });
  }

  return { public: isPublic, title, entries };
}

// Method name -> PDF slug. Verbatim port of backend/rag/method_paper_map.py::_slugify.
export function slugifyMethodName(name) {
  const stripped = String(name || '').replace('🤖 ', '').trim();
  let slug = stripped.toLowerCase();
  slug = slug.replace(/[^a-z0-9]+/g, '-');
  slug = slug.replace(/^-+|-+$/g, '');
  return slug;
}

function letters(s) {
  return s.match(/[a-z]+/g) || [];
}

// Exact port of backend/rag/method_paper_map.py::build_method_paper_map, minus
// MANUAL_MAP: paper ids = file names sorted, minus .pdf, '_'->'-', lower-cased;
// per method: exact slug match, else the FIRST paper id (sorted order) sharing
// >=2 words or any word > 3 letters with the method's slug.
export function matchPdfs(pdfNames, methodNames) {
  const sortedNames = [...(pdfNames || [])].sort();
  const paperIds = sortedNames.map(n => n.replace(/\.pdf$/i, '').replace(/_/g, '-').toLowerCase());
  const idToName = {};
  paperIds.forEach((pid, i) => { if (!(pid in idToName)) idToName[pid] = sortedNames[i]; });
  const paperToMethods = {};
  paperIds.forEach(pid => { paperToMethods[pid] = []; });

  let matchedMethods = 0;
  const missingMethods = [];

  for (const rawName of methodNames || []) {
    const name = String(rawName || '').replace('🤖 ', '').trim();
    const slug = slugifyMethodName(name);

    if (Object.prototype.hasOwnProperty.call(paperToMethods, slug)) {
      paperToMethods[slug].push(name);
      matchedMethods++;
      continue;
    }

    const nameWords = new Set(letters(slug));
    let matched = false;
    for (const pid of paperIds) {
      const pidWords = new Set(letters(pid));
      const common = [...nameWords].filter(w => pidWords.has(w));
      const longCommon = common.some(w => w.length > 3);
      if (common.length >= 2 || longCommon) {
        paperToMethods[pid].push(name);
        matchedMethods++;
        matched = true;
        break;
      }
    }
    if (!matched) missingMethods.push(name);
  }

  const unmatchedPdfs = Object.keys(paperToMethods)
    .filter(pid => paperToMethods[pid].length === 0)
    .map(pid => idToName[pid]);

  return { matchedMethods, missingMethods, unmatchedPdfs };
}

// sha1 hex of sorted "id:name" lines — identical to scripts/drive_sync.py's
// pdf_fingerprint so the nightly job and the admin agree on "did the PDF set change".
export function pdfFingerprint(files) {
  const lines = (files || []).map(f => `${f.id}:${f.name}`).sort();
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

async function fetchListing(folderId, timeoutMs = DRIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    const html = await res.text();
    return { httpStatus: res.status, html };
  } finally {
    clearTimeout(timer);
  }
}

function csvSortKey(name) {
  const m = String(name || '').match(/(\d{4}-\d{2}-\d{2}[ _]\d{2}-\d{2}-\d{2})/);
  return m ? m[1].replace(' ', '_') : null;
}

function pickNewestCsv(entries) {
  let newest = null;
  for (const e of entries) {
    if (!newest) { newest = e; continue; }
    const a = csvSortKey(e.name);
    const b = csvSortKey(newest.name);
    if (a && b) { if (a > b) newest = e; }
    else if (a && !b) { newest = e; }
    else if (!a && !b) { if (e.name > newest.name) newest = e; }
  }
  return newest;
}

// Top level + one subfolder level (<=10 subfolders), deduped by file id.
async function gatherPdfs(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (e.kind === 'file' && /\.pdf$/i.test(e.name)) byId.set(e.id, e.name);
  }
  const subfolderEntries = entries.filter(e => e.kind === 'folder').slice(0, 10);
  const subfolders = subfolderEntries.map(e => e.name);
  for (const sub of subfolderEntries) {
    try {
      const { html } = await fetchListing(sub.id);
      const parsed = parseDriveListing(html);
      for (const e of parsed.entries) {
        if (e.kind === 'file' && /\.pdf$/i.test(e.name)) byId.set(e.id, e.name);
      }
    } catch (_) { /* an unreachable subfolder just contributes nothing */ }
  }
  const files = [...byId.entries()].map(([id, name]) => ({ id, name }));
  return { files, subfolders };
}

function errorResult(status, folderId, title, checkedAt) {
  return {
    status,
    message: MESSAGES[status],
    folderId: folderId || null,
    title: title || null,
    csv: { count: 0, newest: null, newestModified: null },
    pdf: { count: 0, files: [], subfolders: [], fingerprint: pdfFingerprint([]) },
    checkedAt,
  };
}

// Live check of a Drive folder: CSVs (top level only) + PDFs (top level + one
// subfolder level, or from `pdfUrl` when it is itself a separate Drive folder).
export async function checkDriveFolder(url, { pdfUrl } = {}) {
  const checkedAt = new Date().toISOString();
  const folderId = driveFolderId(url);
  if (!folderId) return errorResult('invalid', null, null, checkedAt);

  let listing;
  try {
    listing = await fetchListing(folderId);
  } catch (_) {
    return errorResult('unreachable', folderId, null, checkedAt);
  }
  if (listing.httpStatus === 404) return errorResult('not_found', folderId, null, checkedAt);

  const parsed = parseDriveListing(listing.html);
  if (!parsed.public) return errorResult('not_public', folderId, parsed.title, checkedAt);

  const csvEntries = parsed.entries.filter(e => e.kind === 'file' && /\.csv$/i.test(e.name));
  const newest = pickNewestCsv(csvEntries);

  const pdfFolderId = pdfUrl ? driveFolderId(pdfUrl) : null;
  let pdfResult;
  if (pdfFolderId && pdfFolderId !== folderId) {
    try {
      const pdfListing = await fetchListing(pdfFolderId);
      pdfResult = await gatherPdfs(parseDriveListing(pdfListing.html).entries);
    } catch (_) {
      pdfResult = { files: [], subfolders: [] };
    }
  } else {
    pdfResult = await gatherPdfs(parsed.entries);
  }

  const status = (csvEntries.length > 0 || pdfResult.files.length > 0) ? 'ok' : 'empty';

  return {
    status,
    folderId,
    title: parsed.title || null,
    csv: {
      count: csvEntries.length,
      newest: newest ? newest.name : null,
      newestModified: newest ? newest.modified : null,
    },
    pdf: {
      count: pdfResult.files.length,
      files: pdfResult.files,
      subfolders: pdfResult.subfolders,
      fingerprint: pdfFingerprint(pdfResult.files),
    },
    checkedAt,
  };
}

// The newest top-level .csv entry (with its file id, needed to download it) —
// same "newest" rule as checkDriveFolder's csv.newest. Returns null when the
// folder link is invalid/unreachable/not public/empty.
export async function findNewestCsvEntry(url) {
  const folderId = driveFolderId(url);
  if (!folderId) return null;
  let listing;
  try {
    listing = await fetchListing(folderId);
  } catch (_) {
    return null;
  }
  if (listing.httpStatus !== 200) return null;
  const parsed = parseDriveListing(listing.html);
  if (!parsed.public) return null;
  const csvEntries = parsed.entries.filter(e => e.kind === 'file' && /\.csv$/i.test(e.name));
  return pickNewestCsv(csvEntries);
}

const CSV_BANNER_SCAN_ROWS = 25; // only look this many rows deep for the header
const CSV_MAX_BYTES = 4 * 1024 * 1024; // ~4 MB cap on a CSV export download

// Google Sheet CSV exports often carry banner/preamble rows above the real
// header (e.g. "Latest update: ..."). Quote-aware parse to find the header —
// the first row (within the first 25) with a cell equal to "Name" (case-
// insensitive, trimmed) — then slice the ORIGINAL text from there onward
// (never re-serialised, so quoting/newlines in the data rows are untouched).
export function stripCsvBanner(text) {
  const t = String(text || '');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let recordStart = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"' && t[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') {
      row.push(field);
      records.push({ fields: row, start: recordStart });
      row = []; field = ''; recordStart = i + 1;
      if (records.length >= CSV_BANNER_SCAN_ROWS) break;
    } else field += ch;
  }
  if (records.length < CSV_BANNER_SCAN_ROWS && (field !== '' || row.length)) {
    row.push(field);
    records.push({ fields: row, start: recordStart });
  }
  for (let idx = 0; idx < records.length; idx++) {
    if (records[idx].fields.some(v => v.trim().toLowerCase() === 'name')) {
      return { content: t.slice(records[idx].start), strippedRows: idx };
    }
  }
  return null;
}

// Download one Drive file (a CSV export) and strip its banner rows. Returns
// {content, strippedRows} or {error: '<plain message>'} — never throws.
export async function downloadDriveCsv(fileId) {
  let text;
  try {
    const res = await fetch(`https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    text = await res.text();
  } catch (_) {
    return { error: "Couldn't reach Google Drive — try again." };
  }
  if (Buffer.byteLength(text, 'utf8') > CSV_MAX_BYTES) {
    return { error: 'CSV export is larger than the 4 MB limit.' };
  }
  if (/^\s*<(!doctype|html)/i.test(text)) {
    return { error: "Could not download the CSV — make sure the folder is shared publicly ('Anyone with the link')." };
  }
  const stripped = stripCsvBanner(text);
  if (!stripped) {
    return { error: 'No "Name" header row found in the CSV export.' };
  }
  return stripped;
}

// GitHub Actions repo variable DRIVE_STATUS_<DOMAIN> — domain id upper-cased,
// non-alphanumerics collapsed to a single '_'.
export function driveStatusVariableName(domain) {
  return `DRIVE_STATUS_${String(domain || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export async function readStoredStatus(domain) {
  const { owner, repo, headers } = repoInfo();
  const name = driveStatusVariableName(domain);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/variables/${name}`, { headers });
  if (res.status === 404 || !res.ok) return null;
  const data = await res.json();
  let value = null;
  try { value = JSON.parse(data.value); } catch (_) { value = null; }
  return { value, updatedAt: data.updated_at || null };
}

export async function writeStoredStatus(domain, status) {
  const { owner, repo, headers } = repoInfo();
  const name = driveStatusVariableName(domain);
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/variables`;
  const value = JSON.stringify(status);
  try {
    const getRes = await fetch(`${base}/${name}`, { headers });
    if (getRes.status === 404) {
      const createRes = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ name, value }) });
      if (!createRes.ok) return { ok: false, error: `Failed to create ${name}: ${createRes.status}` };
      return { ok: true };
    }
    const patchRes = await fetch(`${base}/${name}`, { method: 'PATCH', headers, body: JSON.stringify({ name, value }) });
    if (!patchRes.ok) return { ok: false, error: `Failed to update ${name}: ${patchRes.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
