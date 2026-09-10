import React, { useState } from 'react';
import { StatusTag, IconLock } from './icons';
import { relativeTime, absoluteTime, ZIP_HARD_LIMIT_MB } from './utils';

function domainStatus(domain, latestRun) {
  if (latestRun && (latestRun.status === 'in_progress' || latestRun.status === 'queued')) {
    const job = (latestRun.jobs || [])[0];
    const steps = job?.steps || [];
    const done = steps.filter(s => s.status === 'completed').length;
    const stepText = steps.length ? ` — step ${Math.min(done + 1, steps.length)}/${steps.length}` : '';
    return { tone: 'running', text: `Building…${stepText}` };
  }
  if (latestRun && latestRun.conclusion === 'failure') {
    return { tone: 'failed', text: 'Last build failed', link: latestRun.html_url };
  }
  if (domain.hasData) return { tone: 'success', text: 'Live' };
  return { tone: 'muted', text: 'Not built yet' };
}

function UpdateDataPanel({ domain, busy, error, onSubmitCsv, onSubmitPdfUrl, onSubmitZip }) {
  const [mode, setMode] = useState('csv');
  const [csvFile, setCsvFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [zipFile, setZipFile] = useState(null);
  const zipTooBig = zipFile && zipFile.size > ZIP_HARD_LIMIT_MB * 1024 * 1024;

  return (
    <div className="admin-update-panel">
      <div className="admin-update-tabs">
        <button type="button" className={`admin-update-tab ${mode === 'csv' ? 'active' : ''}`} onClick={() => setMode('csv')}>Replace CSV</button>
        <button type="button" className={`admin-update-tab ${mode === 'url' ? 'active' : ''}`} onClick={() => setMode('url')}>Set PDF link</button>
        <button type="button" className={`admin-update-tab ${mode === 'zip' ? 'active' : ''}`} onClick={() => setMode('zip')}>Upload small PDF zip</button>
      </div>

      {mode === 'csv' && (
        <div className="admin-update-body">
          <label htmlFor={`csv-${domain.slug}`}>New CSV (replaces the current one)</label>
          <input id={`csv-${domain.slug}`} type="file" accept=".csv" onChange={e => setCsvFile(e.target.files[0] || null)} />
          <button type="button" className="admin-btn admin-btn-primary" disabled={!csvFile || busy}
            onClick={() => onSubmitCsv(csvFile)}>
            {busy ? 'Saving…' : 'Save CSV'}
          </button>
        </div>
      )}
      {mode === 'url' && (
        <div className="admin-update-body">
          <label htmlFor={`pdfurl-${domain.slug}`}>Google Drive folder or zip link (shared &ldquo;Anyone with the link&rdquo;)</label>
          <input id={`pdfurl-${domain.slug}`} type="url" value={pdfUrl} onChange={e => setPdfUrl(e.target.value)} placeholder="https://drive.google.com/..." />
          <p className="admin-hint">Still auto-fetches anything missing from arXiv / OpenAlex / Semantic Scholar.</p>
          <button type="button" className="admin-btn admin-btn-primary" disabled={!pdfUrl.trim() || busy}
            onClick={() => onSubmitPdfUrl(pdfUrl.trim())}>
            {busy ? 'Saving…' : 'Save link'}
          </button>
        </div>
      )}
      {mode === 'zip' && (
        <div className="admin-update-body">
          <label htmlFor={`zip-${domain.slug}`}>Zip of PDF files (&le; {ZIP_HARD_LIMIT_MB} MB — the server rejects bigger ones)</label>
          <input id={`zip-${domain.slug}`} type="file" accept=".zip" onChange={e => setZipFile(e.target.files[0] || null)} />
          {zipFile && <span className="admin-hint">{zipFile.name} ({(zipFile.size / 1024 / 1024).toFixed(1)} MB)</span>}
          {zipTooBig && (
            <div className="admin-inline-error">
              That zip is over {ZIP_HARD_LIMIT_MB} MB. Use &ldquo;Set PDF link&rdquo; with a shared Drive folder instead.
            </div>
          )}
          <button type="button" className="admin-btn admin-btn-primary" disabled={!zipFile || zipTooBig || busy}
            onClick={() => onSubmitZip(zipFile)}>
            {busy ? 'Uploading…' : 'Upload zip'}
          </button>
        </div>
      )}
      {error && <div className="admin-inline-error">{error}</div>}
    </div>
  );
}

export default function DomainCard({
  domain, latestRun, hasActiveRun, buildingAction, updating, updateError,
  updateOpen, onToggleUpdate, onSubmitCsv, onSubmitPdfUrl, onSubmitZip,
  onBuild, onBuildBenchmarks, onDelete,
}) {
  const status = domainStatus(domain, latestRun);
  const domainPath = `/${domain.slug.replace(/_/g, '-')}`;
  const lastBuildIso = latestRun?.updated_at || latestRun?.created_at;
  const waitReason = 'Wait for the current build to finish';

  return (
    <div className="admin-domain-card">
      <div className="admin-domain-card-header">
        <h3>{domain.displayName}</h3>
        <a className="admin-domain-visit" href={domainPath} target="_blank" rel="noopener noreferrer">Visit &#8599;</a>
      </div>
      <div className="admin-domain-meta">
        <span className="admin-domain-slug">{domain.slug}</span>
        {domain.methodCount > 0 && <span>{domain.methodCount} {domain.methodNoun ? `${domain.methodNoun}s` : 'methods'}</span>}
        {domain.hasData && <span className="admin-badge admin-badge-ok">Data</span>}
        {domain.hasKG ? <span className="admin-badge admin-badge-ok">KG</span> : <span className="admin-badge admin-badge-warn">No KG</span>}
      </div>
      <div className="admin-domain-status">
        <StatusTag tone={status.tone}>
          {status.text}
          {status.link && <> — <a href={status.link} target="_blank" rel="noopener noreferrer">view log &#8599;</a></>}
        </StatusTag>
        {lastBuildIso && (
          <span className="admin-domain-last-build" title={absoluteTime(lastBuildIso)}>last build {relativeTime(lastBuildIso)}</span>
        )}
      </div>

      <div className="admin-domain-actions">
        <button type="button" className="admin-btn admin-btn-primary" onClick={onToggleUpdate} disabled={hasActiveRun} title={hasActiveRun ? waitReason : undefined}>
          {updateOpen ? 'Close' : 'Update data'}
        </button>
        <div className="admin-domain-actions-secondary">
          <button type="button" className="admin-btn" onClick={() => onBuild(domain.slug)} disabled={hasActiveRun || !!buildingAction} title={hasActiveRun ? waitReason : 're-runs everything, 15–40 min'}>
            {buildingAction === 'build' ? 'Building…' : 'Build'}
          </button>
          <button type="button" className="admin-btn" onClick={() => onBuildBenchmarks(domain.slug)} disabled={hasActiveRun || !!buildingAction} title={hasActiveRun ? waitReason : 're-extracts result tables'}>
            {buildingAction === 'benchmark' ? 'Building…' : 'Build benchmarks'}
          </button>
        </div>
      </div>

      {updateOpen && (
        <UpdateDataPanel
          domain={domain}
          busy={updating}
          error={updateError}
          onSubmitCsv={onSubmitCsv}
          onSubmitPdfUrl={onSubmitPdfUrl}
          onSubmitZip={onSubmitZip}
        />
      )}

      <div className="admin-domain-footer">
        {domain.protected ? (
          <span className="admin-protected-note" title="Core domain — cannot be deleted from here">
            <IconLock /> Core domain
          </span>
        ) : (
          <button type="button" className="admin-btn-text-danger" onClick={() => onDelete(domain)} disabled={hasActiveRun} title={hasActiveRun ? waitReason : undefined}>
            Delete&hellip;
          </button>
        )}
      </div>
    </div>
  );
}
