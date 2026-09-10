import React, { useState } from 'react';
import { StatusTag, IconLock } from './icons';
import { relativeTime, absoluteTime } from './utils';
import DriveFolderBlock from './DriveFolder';

function domainStatus(domain, latestRun, latestDeploy) {
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
  // A build that just passed is committed but not yet on the site until Vercel redeploys
  // (~2-3 min); "Live" there would send the user to the "isn't available yet" page. Bounded to
  // 10 min so a no-op build (nothing committed, so no new deploy) can't stick here.
  if (latestRun && latestRun.conclusion === 'success' && latestDeploy && latestRun.updated_at) {
    const finished = new Date(latestRun.updated_at).getTime();
    const deployedAfter = new Date(latestDeploy.created_at).getTime() >= finished - 60 * 1000;
    const deployReady = ['success', 'ready'].includes((latestDeploy.state || '').toLowerCase());
    if (Date.now() - finished < 10 * 60 * 1000 && !(deployedAfter && deployReady)) {
      return { tone: 'running', text: 'Publishing to the website (~3 min)' };
    }
  }
  if (domain.hasData) return { tone: 'success', text: 'Live' };
  return { tone: 'muted', text: 'Not built yet' };
}

function UpdateDataPanel({ domain, busy, error, onSubmitCsv, onSubmitPdfUrl }) {
  const [mode, setMode] = useState('csv');
  const [csvFile, setCsvFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');

  return (
    <div className="admin-update-panel">
      <div className="admin-update-tabs">
        <button type="button" className={`admin-update-tab ${mode === 'csv' ? 'active' : ''}`} onClick={() => setMode('csv')}>Replace CSV</button>
        <button type="button" className={`admin-update-tab ${mode === 'url' ? 'active' : ''}`} onClick={() => setMode('url')}>Set PDF link</button>
      </div>
      <p className="admin-hint">
        To add papers, put the PDFs in this domain&rsquo;s Google Drive folder &mdash; existing papers are kept; new ones
        are pulled in at the next build (tonight, or press Build).
      </p>

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
          <label htmlFor={`pdfurl-${domain.slug}`}>Link to a zip or PDF hosted elsewhere</label>
          <input id={`pdfurl-${domain.slug}`} type="url" value={pdfUrl} onChange={e => setPdfUrl(e.target.value)} placeholder="https://..." />
          <p className="admin-hint">Downloaded at build time, never committed. Still auto-fetches anything missing from arXiv / OpenAlex / Semantic Scholar.</p>
          <button type="button" className="admin-btn admin-btn-primary" disabled={!pdfUrl.trim() || busy}
            onClick={() => onSubmitPdfUrl(pdfUrl.trim())}>
            {busy ? 'Saving…' : 'Save link'}
          </button>
        </div>
      )}
      {error && <div className="admin-inline-error">{error}</div>}
    </div>
  );
}

export default function DomainCard({
  domain, latestRun, latestDeploy, hasActiveRun, buildingAction, updating, updateError,
  updateOpen, onToggleUpdate, onSubmitCsv, onSubmitPdfUrl,
  onBuild, onBuildBenchmarks, onDelete,
  driveEntry, driveChecking, driveCheckError, onDriveCheckNow, onDriveTestLink, onDriveSaveFolder,
}) {
  const status = domainStatus(domain, latestRun, latestDeploy);
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

      <DriveFolderBlock
        domainSlug={domain.slug}
        entry={driveEntry}
        checking={driveChecking}
        checkError={driveCheckError}
        hasActiveRun={hasActiveRun}
        onCheckNow={onDriveCheckNow}
        onTestLink={onDriveTestLink}
        onSaveFolder={onDriveSaveFolder}
      />

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
