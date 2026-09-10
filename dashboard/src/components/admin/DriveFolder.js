import React, { useState } from 'react';
import { StatusTag } from './icons';
import { relativeTime, absoluteTime, formatDriveTestResult } from './utils';

// Folder health status (from the API's `folder.status`) -> tone + a plain-language
// fallback label when the API doesn't send its own `message`.
const FOLDER_STATUS_TONE = {
  ok: 'success',
  empty: 'warning',
  not_public: 'failed',
  not_found: 'failed',
  unreachable: 'warning',
  invalid: 'warning',
  link: 'warning',
};
const FOLDER_STATUS_LABEL = {
  ok: 'Connected',
  empty: 'Connected · empty',
};

function folderStatusInfo(folder) {
  const status = folder?.status;
  return {
    tone: FOLDER_STATUS_TONE[status] || 'warning',
    label: FOLDER_STATUS_LABEL[status] || folder?.message || 'Needs attention',
  };
}

function pdfFact(pdf) {
  if (!pdf) return null;
  const count = pdf.count ?? 0;
  const sub = pdf.subfolders && pdf.subfolders.length ? ` in ${pdf.subfolders[0]}/` : '';
  return <><strong>{count} PDF{count === 1 ? '' : 's'}</strong>{sub}</>;
}

function matchFact(matching) {
  if (!matching) return null;
  const total = matching.matchedMethods + (matching.missingMethods?.length || 0);
  return `${matching.matchedMethods} of ${total} methods have a PDF`;
}

// csv.newest is a sheet-export filename like "Test Sheet_2026-09-03_22-41-54.csv" —
// pull the embedded date out of it when there's no separate newest_modified.
function csvFact(csv) {
  if (!csv) return null;
  const count = csv.count ?? 0;
  const dateSource = csv.newest_modified || csv.newest || '';
  const m = dateSource.match(/(\d{4})-(\d{2})-(\d{2})/);
  const dateText = m ? ` · newest ${new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '';
  return `${count} sheet export${count === 1 ? '' : 's'}${dateText}`;
}

function countedFact(stored) {
  if (!stored?.checked_at) return null;
  const who = stored.checked_by === 'admin' ? 'by you' : 'nightly';
  return { text: `Counted ${relativeTime(stored.checked_at)} (${who})`, title: absoluteTime(stored.checked_at) };
}

// `synced_fingerprint` is the PDF set a build was last started for. Absent entirely
// (an older record from before this field existed) means "unknown" — say nothing.
// Present but different from the current `fingerprint` (including still null, i.e.
// never synced) means the folder has PDFs a build hasn't picked up yet.
function pdfChangedSinceBuild(pdf) {
  if (!pdf || !Object.prototype.hasOwnProperty.call(pdf, 'synced_fingerprint')) return false;
  if (!(pdf.count > 0)) return false;
  return pdf.synced_fingerprint !== pdf.fingerprint;
}

function capList(arr) {
  if (arr.length <= 10) return arr.join(', ');
  return `${arr.slice(0, 10).join(', ')}, +${arr.length - 10} more`;
}

function MatchDetails({ matching }) {
  const missing = matching?.missingMethods || [];
  const unmatched = matching?.unmatchedPdfs || [];
  if (!missing.length && !unmatched.length) return null;
  return (
    <details className="admin-drive-details">
      <summary>Details</summary>
      {missing.length > 0 && <div className="admin-hint">Missing a PDF: {capList(missing)}</div>}
      {unmatched.length > 0 && <div className="admin-hint">Unmatched files: {capList(unmatched)}</div>}
    </details>
  );
}

function ConnectForm({ initialUrl, onTest, onSave, onCancel }) {
  const [url, setUrl] = useState(initialUrl || '');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const handleTest = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const data = await onTest(trimmed);
      setTestResult(formatDriveTestResult(data));
    } catch (err) {
      setTestResult({ ok: false, text: err.message });
    }
    setTestBusy(false);
  };

  const handleSave = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setSaveError(err.message);
      setSaveBusy(false);
    }
  };

  return (
    <div className="admin-drive-form">
      <label htmlFor="admin-drive-url">Google Drive folder link</label>
      <input
        id="admin-drive-url" type="url" value={url}
        onChange={e => { setUrl(e.target.value); setTestResult(null); }}
        placeholder={'Paste the folder link — shared "Anyone with the link"'}
      />
      <div className="admin-drive-form-actions">
        <button type="button" className="admin-btn" disabled={!url.trim() || testBusy} onClick={handleTest}>
          {testBusy ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="admin-btn admin-btn-primary" disabled={!url.trim() || saveBusy} onClick={handleSave}>
          {saveBusy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="admin-btn" onClick={onCancel} disabled={saveBusy}>Cancel</button>
      </div>
      {testResult && <div className={testResult.ok ? 'admin-hint' : 'admin-inline-error'}>{testResult.text}</div>}
      {saveError && <div className="admin-inline-error">{saveError}</div>}
    </div>
  );
}

// Google Drive folder block for a domain card — sits under the status line, above
// the build/update actions. `entry` is this domain's item from GET drive-status
// (undefined while that request is still in flight).
export default function DriveFolderBlock({ domainSlug, entry, checking, checkError, hasActiveRun, onCheckNow, onTestLink, onSaveFolder }) {
  const [formOpen, setFormOpen] = useState(false);
  if (!entry) return null;

  const connected = !!entry.folderUrl;
  const folder = entry.stored?.folder;
  const statusInfo = folder ? folderStatusInfo(folder) : null;
  const counted = countedFact(entry.stored);

  const handleSave = async (url) => {
    await onSaveFolder(url);
    setFormOpen(false);
  };

  return (
    <div className="admin-drive-block">
      {connected ? (
        <>
          <div className="admin-drive-status-row">
            {statusInfo && <StatusTag tone={statusInfo.tone}>{statusInfo.label}</StatusTag>}
            {folder?.title && <span className="admin-drive-title">{folder.title}</span>}
            {folder?.url && (
              <a className="admin-drive-open-link" href={folder.url} target="_blank" rel="noopener noreferrer">Open in Drive &#8599;</a>
            )}
          </div>
          {entry.stored && (
            <div className="admin-drive-facts">
              {pdfFact(entry.stored.pdf) && <span>{pdfFact(entry.stored.pdf)}</span>}
              {matchFact(entry.matching) && <span>{matchFact(entry.matching)}</span>}
              {csvFact(entry.stored.csv) && <span>{csvFact(entry.stored.csv)}</span>}
            </div>
          )}
          <MatchDetails matching={entry.matching} />
          {pdfChangedSinceBuild(entry.stored?.pdf) && (
            <div className="admin-inline-warning">
              PDFs changed since the last build &mdash; they&rsquo;re pulled in at tonight&rsquo;s sync, or press Build now.
            </div>
          )}
          {counted && <div className="admin-hint admin-drive-counted" title={counted.title}>{counted.text}</div>}
          {checkError && <div className="admin-inline-error">{checkError}</div>}
          <div className="admin-drive-actions">
            <button type="button" className="admin-btn" disabled={checking || hasActiveRun} onClick={() => onCheckNow(domainSlug)}>
              {checking ? 'Counting…' : 'Check now'}
            </button>
            <button type="button" className="admin-btn" onClick={() => setFormOpen(o => !o)}>
              {formOpen ? 'Cancel' : 'Change folder'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="admin-hint admin-drive-empty">No Google Drive folder connected</p>
          <button type="button" className="admin-btn" onClick={() => setFormOpen(o => !o)}>
            {formOpen ? 'Cancel' : 'Connect Drive folder'}
          </button>
        </>
      )}

      {formOpen && (
        <ConnectForm
          initialUrl={connected ? entry.folderUrl : ''}
          onTest={onTestLink}
          onSave={handleSave}
          onCancel={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}
