// Shared formatting + parsing helpers for the admin page. Pure functions only —
// no React here — so they're easy to unit-reason-about and reuse across sections.

export const ZIP_HARD_LIMIT_MB = 3;
export const PAYLOAD_HARD_LIMIT_MB = 4.5;
export const BASE64_EXPANSION = 1.37; // base64 inflates raw bytes by ~4/3

export function relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  return `${month}mo ago`;
}

export function absoluteTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

export function formatDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

export function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / (1000 * 60 * 60 * 24));
}

// Known GitHub Actions step names -> a plain-language phrase (+ typical duration).
// Anything not in this table falls back to the raw step name unchanged.
const STEP_PHRASES = {
  'Install Python dependencies': ['Installing tools', '~3 min'],
  'Set up GROBID': ['Starting PDF parser', '~2 min'],
  'Fetch missing PDFs (public OA sources)': ['Fetching papers', ''],
  'Run ingestion pipeline': ['Reading papers & building the knowledge graph', 'longest step'],
  'Commit results': ['Saving results', ''],
};

export function friendlyStepName(rawName) {
  const entry = STEP_PHRASES[rawName];
  if (!entry) return rawName;
  const [label, hint] = entry;
  return hint ? `${label} (${hint})` : label;
}

// Vercel's raw deployment state -> the plain phrase for the Website health chip.
export function websiteStatus(deployment) {
  if (!deployment) return { text: 'No deployments yet', tone: 'muted' };
  const s = (deployment.state || '').toLowerCase();
  if (s === 'ready' || s === 'success') return { text: 'Up to date', tone: 'success' };
  if (s === 'building' || s === 'pending' || s === 'in_progress' || s === 'queued') return { text: 'Updating…', tone: 'running' };
  if (s === 'error' || s === 'failure' || s === 'canceled' || s === 'cancelled') return { text: 'Update failed', tone: 'failed' };
  return { text: deployment.state || 'Unknown', tone: 'muted' };
}

export function slugifyDomain(name) {
  let s = (name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return '';
  if (!/^[a-z]/.test(s)) s = `d_${s}`;
  return s;
}

export function isValidSlug(s) {
  return /^[a-z][a-z0-9_]*$/.test(s || '');
}

// Strip a UTF-8 BOM and normalize CRLF/CR line endings before parsing.
export function cleanCsvText(text) {
  return (text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// RFC-4180-style parse: quoted fields may contain commas, "" escapes and NEWLINES
// (sheet exports put line breaks inside Description / Link(s) cells), so records are
// split on unquoted newlines only — a naive line split over-counts rows.
function parseCsvRecords(text) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field.trim()); field = ''; }
    else if (ch === '\n') { row.push(field.trim()); records.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field.trim()); records.push(row); }
  return records.filter(r => r.some(v => v !== ''));
}

export function parseCSV(text) {
  const records = parseCsvRecords(cleanCsvText(text));
  if (records.length < 2) return { headers: [], rows: [], rowCount: 0 };
  const headers = records[0];
  const rows = records.slice(1, 4).map((values) => {
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    return row;
  });
  return { headers, rows, rowCount: records.length - 1 };
}

// Wizard step 1 validation: a "Name" column (exact case) is required.
export function nameColumnStatus(headers) {
  if (headers.includes('Name')) return { ok: true };
  const variant = headers.find(h => h.trim().toLowerCase() === 'name');
  if (variant) {
    return { ok: false, message: `Found a column called "${variant}" — rename it to exactly "Name" (capital N) so the pipeline can find it.` };
  }
  return { ok: false, message: 'No "Name" column found. Add a column named exactly "Name" with one row per method.' };
}

export function hasCitationColumn(headers) {
  return headers.some(h => h.trim().toLowerCase() === 'citation');
}

// Step 3 "Use default mapping" — a sane role/facet guess with no AI call.
export function defaultColumnMapping(headers) {
  const columns = {};
  for (const h of headers) {
    const lower = h.trim().toLowerCase();
    if (lower === 'name') columns[h] = { role: 'identity.name', facet: 'identifier' };
    else if (lower === 'description') columns[h] = { role: 'identity.description', facet: 'text' };
    else if (lower === 'citation') columns[h] = { role: 'identity.citation', facet: 'text' };
    else if (/^links?(\(s\))?$/.test(lower)) columns[h] = { role: 'identity.code', facet: 'url' };
    else if (/^year/.test(lower)) columns[h] = { role: 'identity.year', facet: 'numeric' };
    else columns[h] = { facet: 'categorical' };
  }
  return columns;
}

// Client-side estimate of the JSON request body size for the "Create domain" /
// "Update data" upload, BEFORE base64-encoding a zip (base64 inflates bytes ~37%).
export function estimatePayloadMB(csvText, zipFile) {
  const csvBytes = csvText ? new Blob([csvText]).size : 0;
  const zipBytes = zipFile ? zipFile.size : 0;
  return (csvBytes + zipBytes * BASE64_EXPANSION) / (1024 * 1024);
}
