// Shared formatting + parsing helpers for the admin page. Pure functions only —
// no React here — so they're easy to unit-reason-about and reuse across sections.

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

export function scopeLabel(scope) {
  if (scope === 'benchmark') return 'benchmark tables';
  if (scope === 'new-paper') return 'new paper';
  if (scope === 'precompute') return 'precompute';
  return 'full';
}

// A plain-text "Ask for help" report for a failed build — shared by the mailto
// link, the GitHub issue link and the "Copy report" button in Activity. Trims
// error lines first so the eventual mailto href stays under ~1800 characters.
export function buildHelpReport({ title, domainLabel, scope, when, failure, runUrl, adminUrl }) {
  const subject = `Build failed: ${title}`;
  const whenText = when ? new Date(when).toISOString() : 'unknown';
  const logUrl = failure?.logUrl || runUrl || '';
  const buildBody = (maxErrorLines) => {
    const lines = [
      `Domain: ${domainLabel}`,
      `Build scope: ${scope}`,
      `When: ${whenText} (UTC)`,
    ];
    if (failure?.step) lines.push(`Failing step: ${failure.step}`);
    lines.push('');
    for (const hint of (failure?.hints || [])) {
      lines.push(hint.title);
      lines.push(`Fix: ${hint.fix}`);
      lines.push('');
    }
    const errorLines = (failure?.errorLines || []).slice(0, maxErrorLines);
    if (errorLines.length) {
      lines.push('Error lines:');
      lines.push(...errorLines);
      lines.push('');
    }
    if (logUrl) lines.push(`Log: ${logUrl}`);
    if (adminUrl) lines.push(`Admin: ${adminUrl}`);
    lines.push('');
    lines.push('Anything else I noticed:');
    return lines.join('\n');
  };
  const OVERHEAD = 60; // "mailto:" + a typical email address + "?subject=&body="
  let maxErrorLines = 10;
  let body = buildBody(maxErrorLines);
  while (maxErrorLines > 0 && encodeURIComponent(subject).length + encodeURIComponent(body).length + OVERHEAD > 1800) {
    maxErrorLines = Math.max(0, maxErrorLines - 2);
    body = buildBody(maxErrorLines);
  }
  return { subject, body };
}

export function mailtoHref(email, subject, body) {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Derives owner/repo from a GitHub Actions run URL (…/github.com/<owner>/<repo>/actions/runs/…).
export function githubIssueHref(runUrl, subject, body) {
  const m = (runUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\//);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/issues/new?title=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

// A Google Drive FOLDER link (as opposed to a file/zip share link) — the only
// kind that can be saved as `drive_folder` / the nightly sync source.
export function isDriveFolderUrl(url) {
  return /drive\.google\.com\/.*\/folders\//i.test(url || '');
}

// Shared "Test connection" result line for a Drive folder link — used by both
// the domain card's Connect/Change form and the new-domain wizard's Papers step.
export function formatDriveTestResult(data) {
  const r = data?.result;
  if (!r || (r.status && r.status !== 'ok')) {
    return { ok: false, text: r?.message || 'That link could not be reached.' };
  }
  const pdfCount = r.pdf?.count ?? 0;
  const csvCount = r.csv?.count ?? 0;
  return {
    ok: true,
    text: `Connected to ‘${r.title || 'folder'}’ · ${pdfCount} PDF${pdfCount === 1 ? '' : 's'} · ${csvCount} sheet export${csvCount === 1 ? '' : 's'}`,
  };
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
