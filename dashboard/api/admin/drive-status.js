import { repoInfo } from '../../lib/admin-github.js';
import {
  driveFolderId, matchPdfs, checkDriveFolder,
  readStoredStatus, writeStoredStatus,
  findNewestCsvEntry, downloadDriveCsv,
} from '../../lib/admin-drive.js';

const MAX_STORED_FILES = 300; // keep the repo variable well under the 48 KB limit

// Read a top-level `key: value` line, stripping surrounding quotes and a
// trailing `# comment` (same regex style as api/admin/domains.js's yamlValue).
function yamlValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!m) return null;
  let value = m[1].trim().replace(/^['"]|['"]$/g, '');
  value = value.replace(/\s+#.*$/, '').trim();
  return value || null;
}

// Minimal RFC-4180 parse (quoted fields may contain commas/newlines) — just
// enough to pull the "Name" column out of a domain's methods CSV.
function parseCsvRecords(text) {
  const t = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"' && t[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  return records.filter(r => r.some(v => v !== ''));
}

function csvNameColumn(text) {
  const records = parseCsvRecords(text);
  if (records.length < 2) return [];
  const headers = records[0];
  const idx = headers.findIndex(h => h.trim().toLowerCase() === 'name');
  if (idx === -1) return [];
  return records.slice(1).map(r => (r[idx] || '').trim()).filter(Boolean);
}

async function pinnedRef(base, headers) {
  try {
    const refRes = await fetch(`${base}/git/ref/heads/main`, { headers });
    if (refRes.ok) return (await refRes.json()).object.sha;
  } catch (_) { /* fall back to the branch name */ }
  return 'main';
}

async function listDomainYamls(base, headers, ref) {
  const domainsRes = await fetch(`${base}/contents/domains?ref=${ref}`, { headers });
  if (!domainsRes.ok) {
    const err = new Error(`GitHub returned ${domainsRes.status} while listing domains — check the GitHub token under Settings.`);
    err.status = 502;
    throw err;
  }
  const files = await domainsRes.json();
  const yamlFiles = files.filter(f => f.name.endsWith('.yaml') || f.name.endsWith('.yml'));
  const out = [];
  for (const f of yamlFiles) {
    const slug = f.name.replace(/\.(yaml|yml)$/, '');
    const contentRes = await fetch(f.download_url);
    out.push({ slug, text: await contentRes.text() });
  }
  return out;
}

async function fetchCsvNames(base, headers, ref, csvPath) {
  if (!csvPath) return null;
  try {
    const csvRes = await fetch(`${base}/contents/${csvPath}?ref=${ref}`, { headers });
    if (!csvRes.ok) return null;
    const data = await csvRes.json();
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    return csvNameColumn(text);
  } catch (_) {
    return null;
  }
}

function capFiles(files) {
  return (files || []).slice(0, MAX_STORED_FILES);
}

export default async function handler(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { owner, repo, headers } = repoInfo();
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  try {
    if (req.method === 'GET') {
      const ref = await pinnedRef(base, headers);
      const yamls = await listDomainYamls(base, headers, ref);

      const domains = [];
      for (const { slug, text } of yamls) {
        const displayName = yamlValue(text, 'display_name') || slug;
        const folderUrl = yamlValue(text, 'drive_folder');
        const pdfUrl = yamlValue(text, 'pdf_url');
        const pdfSource = pdfUrl || folderUrl || null;
        const csvPath = yamlValue(text, 'csv_path');

        const storedInfo = await readStoredStatus(slug);
        const stored = storedInfo ? storedInfo.value : null;
        const storedAt = storedInfo ? storedInfo.updatedAt : null;

        let matching = null;
        if (stored && stored.pdf && Array.isArray(stored.pdf.files) && stored.pdf.files.length > 0) {
          const names = await fetchCsvNames(base, headers, ref, csvPath);
          if (names) matching = matchPdfs(stored.pdf.files.map(f => f.name), names);
        }

        domains.push({ domain: slug, displayName, folderUrl, pdfUrl, pdfSource, stored, storedAt, matching });
      }

      return res.status(200).json({ domains });
    }

    if (req.method === 'POST') {
      const { domain, url, markSynced } = req.body || {};

      if (domain) {
        const ref = await pinnedRef(base, headers);
        const contentsRes = await fetch(`${base}/contents/domains/${domain}.yaml?ref=${ref}`, { headers });
        if (contentsRes.status === 404) return res.status(404).json({ error: `Domain ${domain} not found` });
        if (!contentsRes.ok) throw new Error(`Failed to fetch domain YAML: ${contentsRes.status}`);
        const contentsData = await contentsRes.json();
        const yamlText = Buffer.from(contentsData.content, 'base64').toString('utf8');

        const driveFolder = yamlValue(yamlText, 'drive_folder');
        const pdfUrlVal = yamlValue(yamlText, 'pdf_url');
        const pdfUrlFolderId = pdfUrlVal ? driveFolderId(pdfUrlVal) : null;

        if (!driveFolder && !pdfUrlFolderId) {
          return res.status(400).json({ error: `${domain} has no Google Drive folder connected yet.` });
        }

        const folderUrl = driveFolder || pdfUrlVal;
        // A separate Drive-folder pdf_url overrides where PDFs come from; a
        // non-folder pdf_url (zip/pdf) keeps the "link" behavior (no counting).
        const separatePdfFolder = (driveFolder && pdfUrlFolderId) ? pdfUrlVal : null;
        const pdfIsLinkOnly = !!(driveFolder && pdfUrlVal && !pdfUrlFolderId);

        let stored;
        if (pdfIsLinkOnly) {
          const folderCheck = await checkDriveFolder(driveFolder);
          stored = {
            checked_at: new Date().toISOString(),
            checked_by: 'admin',
            folder: { url: driveFolder, id: folderCheck.folderId, status: folderCheck.status, title: folderCheck.title, message: folderCheck.message || null },
            csv: folderCheck.csv,
            pdf: { source_url: pdfUrlVal, status: 'link', count: null, files: [], subfolders: [], fingerprint: null },
          };
        } else {
          const check = await checkDriveFolder(folderUrl, { pdfUrl: separatePdfFolder });
          stored = {
            checked_at: new Date().toISOString(),
            checked_by: 'admin',
            folder: { url: folderUrl, id: check.folderId, status: check.status, title: check.title, message: check.message || null },
            csv: check.csv,
            pdf: {
              source_url: separatePdfFolder || folderUrl,
              status: check.status,
              count: check.pdf.count,
              files: capFiles(check.pdf.files),
              subfolders: check.pdf.subfolders,
              fingerprint: check.pdf.fingerprint,
            },
          };
        }

        // pdf.fingerprint is the latest listing (whoever counted last); pdf.synced_fingerprint
        // is the PDF set a build was last STARTED for. A "Check now" re-count must not move
        // it — only markSynced:true (the admin just dispatched a build) advances it — so the
        // nightly job can still tell a freshly-counted PDF apart from one already being built.
        const prevStored = await readStoredStatus(domain);
        const prevPdf = (prevStored && prevStored.value && prevStored.value.pdf) || {};
        const prevSynced = Object.prototype.hasOwnProperty.call(prevPdf, 'synced_fingerprint')
          ? prevPdf.synced_fingerprint : null;
        stored.pdf.synced_fingerprint = markSynced ? stored.pdf.fingerprint : prevSynced;

        const csvPath = yamlValue(yamlText, 'csv_path');
        let matching = null;
        if (stored.pdf.files && stored.pdf.files.length > 0) {
          const names = await fetchCsvNames(base, headers, ref, csvPath);
          if (names) matching = matchPdfs(stored.pdf.files.map(f => f.name), names);
        }

        const write = await writeStoredStatus(domain, stored);
        const response = { domain, stored, matching };
        if (!write.ok) response.warning = write.error;
        return res.status(200).json(response);
      }

      if (url) {
        const { includeCsv } = req.body || {};
        if (!driveFolderId(url)) {
          return res.status(400).json({ error: 'Only Google Drive folder links can be tested here.' });
        }
        const result = await checkDriveFolder(url);
        const response = { result };

        if (includeCsv) {
          if (result.status !== 'ok' || !result.csv || !result.csv.count) {
            response.csvFile = null;
            response.csvError = result.message || 'No CSV export found in this folder.';
          } else {
            const entry = await findNewestCsvEntry(url);
            if (!entry) {
              response.csvFile = null;
              response.csvError = 'No CSV export found in this folder.';
            } else {
              const dl = await downloadDriveCsv(entry.id);
              if (dl.error) {
                response.csvFile = null;
                response.csvError = dl.error;
              } else {
                response.csvFile = { name: entry.name, content: dl.content, strippedRows: dl.strippedRows };
              }
            }
          }
        }

        return res.status(200).json(response);
      }

      return res.status(400).json({ error: 'Provide a domain or a url.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
