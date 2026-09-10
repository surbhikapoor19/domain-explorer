import React, { useState } from 'react';
import { ConfigEditor, generateYamlPreview } from './ConfigEditor';
import {
  slugifyDomain, isValidSlug, nameColumnStatus, hasCitationColumn, formatDriveTestResult,
} from './utils';

const STEPS = ['Data', 'Papers', 'Configure', 'Review & create'];

function StepIndicator({ step }) {
  return (
    <div className="admin-wizard-steps">
      {STEPS.map((label, i) => (
        <React.Fragment key={label}>
          {i > 0 && <span className="admin-wizard-arrow">&rarr;</span>}
          <span className={`admin-wizard-step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}>
            {i + 1}. {label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function filesToCreate(wizard) {
  const dashed = (wizard.newDomain || '').replace(/_/g, '-');
  const files = [
    `domains/${wizard.newDomain}.yaml — configuration`,
    `datasets/${dashed}/${wizard.csvFileName || `${wizard.newDomain}.csv`} — your CSV`,
    `datasets/${dashed}/papers/ — PDFs (auto-fetched + any you provided)`,
  ];
  if (wizard.editedConfig?.benchmarks?.metrics?.length && wizard.includeBenchmarks) {
    files.push(`scripts/precompute/benchmarks/config/${wizard.newDomain}.json — benchmark metrics`);
  }
  return files;
}

export default function DomainWizard({
  wizard, csvFile, domains, keyProviders,
  proposing, uploading, createError,
  patch, setEditedConfig, onCsvSelected,
  onPropose, onUseDefaultMapping, onCreate, onCancel,
  onTestDriveLink, onLoadDriveCsv,
}) {
  const step = wizard.step;
  const [driveTesting, setDriveTesting] = useState(false);
  const [driveTestResult, setDriveTestResult] = useState(null);
  const [csvLoading, setCsvLoading] = useState(false);

  const handleTestDriveLink = async () => {
    const url = wizard.pdfUrl.trim();
    if (!url) return;
    setDriveTesting(true);
    setDriveTestResult(null);
    try {
      const data = await onTestDriveLink(url);
      setDriveTestResult(formatDriveTestResult(data));
    } catch (err) {
      setDriveTestResult({ ok: false, text: err.message });
    }
    setDriveTesting(false);
  };

  // Loads the newest CSV export out of a Drive folder, then feeds it through the
  // SAME path a real file upload takes (onCsvSelected) so headers/preview/checks
  // all work unchanged.
  const handleLoadNewestCsv = async () => {
    const url = (wizard.driveFolder || '').trim();
    if (!url) return;
    setCsvLoading(true);
    patch({ csvError: '' });
    try {
      const data = await onLoadDriveCsv(url);
      if (data.csvFile) {
        const file = new File([data.csvFile.content], data.csvFile.name, { type: 'text/csv' });
        await onCsvSelected(file);
        patch({
          csvDriveMeta: {
            name: data.csvFile.name,
            strippedRows: data.csvFile.strippedRows || 0,
            count: data.result?.csv?.count || 1,
          },
        });
      } else {
        patch({ csvError: data.csvError || 'No CSV export was found in that folder.' });
      }
    } catch (err) {
      patch({ csvError: err.message });
    }
    setCsvLoading(false);
  };

  const dashed = (wizard.newDomain || '').replace(/_/g, '-');
  const slugValid = isValidSlug(wizard.newDomain);
  const slugTaken = domains.some(d => d.slug === wizard.newDomain);
  const nameCol = nameColumnStatus(wizard.csvHeaders);
  const citationOk = hasCitationColumn(wizard.csvHeaders);

  const canLeaveStep1 = !!wizard.displayName.trim() && slugValid && !slugTaken && wizard.csvHeaders.length > 0 && nameCol.ok;

  const canGenerateWithAi = keyProviders.some(p => (p.name === 'HF_TOKEN' || p.name === 'GROQ_API_KEY') && p.inVercel);
  const canLeaveStep3 = !!wizard.editedConfig;

  const roleSummary = Object.entries(wizard.editedConfig?.columns || {})
    .filter(([, m]) => m.role)
    .map(([col, m]) => ({ col, role: m.role }));

  // What the Review step's YAML preview should show for the papers source, mirroring
  // the routing handleCreate uses at submit time.
  const previewDriveFolder = wizard.papersMode === 'same-drive' ? wizard.driveFolder.trim()
    : wizard.papersMode === 'drive' ? wizard.pdfUrl.trim() : '';
  const previewPdfUrl = wizard.papersMode === 'link' ? wizard.pdfUrl.trim() : '';
  const previewConfig = previewDriveFolder ? { ...(wizard.editedConfig || {}), drive_folder: previewDriveFolder } : wizard.editedConfig;

  return (
    <div className="admin-wizard">
      <StepIndicator step={step} />

      {step === 1 && (
        <div className="admin-wizard-panel">
          <h3>Data</h3>
          <p className="admin-wizard-hint">Give the domain a name and upload its CSV — one row per method.</p>
          <div className="admin-field">
            <label htmlFor="wiz-display-name">Display name</label>
            <input
              id="wiz-display-name" type="text" value={wizard.displayName}
              onChange={e => {
                const v = e.target.value;
                patch({ displayName: v, ...(wizard.slugEdited ? {} : { newDomain: slugifyDomain(v) }) });
              }}
              placeholder="e.g., Motion Planning"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="wiz-slug">Domain ID (used in the URL)</label>
            <input
              id="wiz-slug" type="text" value={wizard.newDomain}
              onChange={e => patch({ newDomain: e.target.value.toLowerCase(), slugEdited: true })}
              placeholder="e.g., motion_planning"
            />
            {wizard.newDomain && !slugValid && (
              <div className="admin-inline-error">Use lowercase letters, numbers and underscores only, starting with a letter.</div>
            )}
            {wizard.newDomain && slugValid && slugTaken && (
              <div className="admin-inline-error">A domain with this ID already exists.</div>
            )}
            {wizard.newDomain && slugValid && !slugTaken && (
              <p className="admin-hint">saved as {wizard.newDomain} &middot; /{dashed}</p>
            )}
          </div>
          <div className="admin-field">
            <label htmlFor="wiz-method-noun">What do you call one row? (e.g. method, algorithm)</label>
            <input id="wiz-method-noun" type="text" value={wizard.methodNoun} onChange={e => patch({ methodNoun: e.target.value })} />
          </div>
          <div className="admin-field">
            <label>CSV source</label>
            <div className="admin-radio-cards">
              <div className={`admin-radio-card ${wizard.csvSource !== 'drive' ? 'selected' : ''}`}>
                <label className="admin-radio-card-label">
                  <input type="radio" name="csv-source" checked={wizard.csvSource !== 'drive'} onChange={() => patch({ csvSource: 'upload' })} />
                  <span className="admin-radio-card-title">Upload a CSV file</span>
                </label>
                {wizard.csvSource !== 'drive' && (
                  <div
                    className="admin-radio-card-body admin-dropzone"
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onCsvSelected(f); }}
                  >
                    <input id="wiz-csv" type="file" accept=".csv" onChange={e => onCsvSelected(e.target.files[0])} />
                    <span className="admin-hint">or drag a .csv file here</span>
                  </div>
                )}
              </div>
              <div className={`admin-radio-card ${wizard.csvSource === 'drive' ? 'selected' : ''}`}>
                <label className="admin-radio-card-label">
                  <input type="radio" name="csv-source" checked={wizard.csvSource === 'drive'} onChange={() => patch({ csvSource: 'drive' })} />
                  <span className="admin-radio-card-title">Use the newest export in a Google Drive folder</span>
                </label>
                {wizard.csvSource === 'drive' && (
                  <div className="admin-radio-card-body">
                    <label htmlFor="wiz-csv-drive-url">Drive folder link</label>
                    <input
                      id="wiz-csv-drive-url" type="url" value={wizard.driveFolder}
                      onChange={e => patch({ driveFolder: e.target.value, csvError: '' })}
                      placeholder="https://drive.google.com/..."
                    />
                    <div className="admin-drive-test-row">
                      <button type="button" className="admin-btn" disabled={!wizard.driveFolder.trim() || csvLoading} onClick={handleLoadNewestCsv}>
                        {csvLoading ? 'Loading…' : 'Load newest CSV'}
                      </button>
                    </div>
                    {wizard.csvDriveMeta && (
                      <p className="admin-hint">
                        Loaded &lsquo;{wizard.csvDriveMeta.name}&rsquo; (newest of {wizard.csvDriveMeta.count} export{wizard.csvDriveMeta.count === 1 ? '' : 's'};
                        {' '}skipped {wizard.csvDriveMeta.strippedRows} banner row{wizard.csvDriveMeta.strippedRows === 1 ? '' : 's'})
                      </p>
                    )}
                    {wizard.csvError && <div className="admin-inline-error">{wizard.csvError}</div>}
                  </div>
                )}
              </div>
            </div>
            {wizard.csvHeaders.length > 0 && (
              <div className="admin-csv-preview">
                <p className="admin-hint">{wizard.csvHeaders.length} columns, {wizard.rowCount || wizard.csvSampleRows.length} rows detected</p>
                {!nameCol.ok && <div className="admin-inline-error">{nameCol.message}</div>}
                {nameCol.ok && !citationOk && (
                  <div className="admin-inline-warning">No &ldquo;Citation&rdquo; column — PDFs can&rsquo;t be auto-fetched without it.</div>
                )}
                <div className="admin-csv-table-wrap">
                  <table className="admin-csv-table">
                    <thead><tr>{wizard.csvHeaders.map(h => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {wizard.csvSampleRows.map((row, i) => (
                        <tr key={i}>{wizard.csvHeaders.map(h => <td key={h}>{row[h]}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
          <div className="admin-field">
            <label htmlFor="wiz-desc">Describe this domain in one line (helps the AI propose a configuration)</label>
            <input
              id="wiz-desc" type="text" value={wizard.domainDescription}
              onChange={e => patch({ domainDescription: e.target.value })}
              placeholder="e.g., Robotic motion planning algorithms for manipulation tasks"
            />
          </div>
          <div className="admin-wizard-actions">
            <button type="button" className="admin-btn" onClick={onCancel}>Cancel</button>
            <button
              type="button" className="admin-btn admin-btn-primary" disabled={!canLeaveStep1}
              onClick={() => patch({
                step: 2,
                // Loaded the CSV from a Drive folder? Preselect reusing it for PDFs too.
                ...(wizard.driveFolder.trim() && wizard.papersMode === 'auto' ? { papersMode: 'same-drive' } : {}),
              })}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="admin-wizard-panel">
          <h3>Papers</h3>
          <p className="admin-wizard-hint">How should we get the PDFs for these methods?</p>
          <div className="admin-radio-cards">
            {wizard.driveFolder.trim() && (
              <label className={`admin-radio-card ${wizard.papersMode === 'same-drive' ? 'selected' : ''}`}>
                <input type="radio" name="papers-mode" checked={wizard.papersMode === 'same-drive'} onChange={() => patch({ papersMode: 'same-drive' })} />
                <span className="admin-radio-card-title">Same Google Drive folder (PDFs in it or a subfolder)</span>
                <span className="admin-hint">Reuses the folder the CSV was loaded from in step 1 &mdash; put the PDFs there too, at the top level or in a subfolder.</span>
              </label>
            )}
            <label className={`admin-radio-card ${wizard.papersMode === 'drive' ? 'selected' : ''}`}>
              <input type="radio" name="papers-mode" checked={wizard.papersMode === 'drive'} onChange={() => patch({ papersMode: 'drive' })} />
              <span className="admin-radio-card-title">Google Drive folder (PDFs)</span>
              <span className="admin-hint">Shared &ldquo;Anyone with the link&rdquo;. Name each PDF after its method, e.g. GraspGen &rarr; graspgen.pdf. New PDFs are picked up every night.</span>
              {wizard.papersMode === 'drive' && (
                <>
                  <input
                    type="url" value={wizard.pdfUrl}
                    onChange={e => { patch({ pdfUrl: e.target.value }); setDriveTestResult(null); }}
                    placeholder="https://drive.google.com/..."
                  />
                  <div className="admin-drive-test-row">
                    <button type="button" className="admin-btn" disabled={!wizard.pdfUrl.trim() || driveTesting} onClick={handleTestDriveLink}>
                      {driveTesting ? 'Testing…' : 'Test connection'}
                    </button>
                    {driveTestResult && (
                      <span className={driveTestResult.ok ? 'admin-hint' : 'admin-inline-error'}>{driveTestResult.text}</span>
                    )}
                  </div>
                </>
              )}
            </label>
            <label className={`admin-radio-card ${wizard.papersMode === 'link' ? 'selected' : ''}`}>
              <input type="radio" name="papers-mode" checked={wizard.papersMode === 'link'} onChange={() => patch({ papersMode: 'link' })} />
              <span className="admin-radio-card-title">Link to a zip or PDF hosted elsewhere</span>
              <span className="admin-hint">Downloaded at build time and never committed to the repo. Still auto-fetches anything missing.</span>
              {wizard.papersMode === 'link' && (
                <input type="url" value={wizard.pdfUrl} onChange={e => patch({ pdfUrl: e.target.value })} placeholder="https://..." />
              )}
            </label>
            <label className={`admin-radio-card ${wizard.papersMode === 'auto' ? 'selected' : ''}`}>
              <input type="radio" name="papers-mode" checked={wizard.papersMode === 'auto'} onChange={() => patch({ papersMode: 'auto' })} />
              <span className="admin-radio-card-title">Find them automatically only</span>
              <span className="admin-hint">Searches arXiv, OpenAlex and Semantic Scholar using the Citation column. Closed-access papers won&rsquo;t be found.</span>
            </label>
          </div>
          <div className="admin-wizard-actions">
            <button type="button" className="admin-btn" onClick={() => patch({ step: 1 })}>Back</button>
            <button type="button" className="admin-btn admin-btn-primary" onClick={() => patch({ step: 3 })}>Next</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="admin-wizard-panel">
          <h3>Configure</h3>
          <p className="admin-wizard-hint">Map each CSV column to what it means. AI can propose this for you, or use the default mapping.</p>
          <div className="admin-wizard-configure-actions">
            <button
              type="button" className="admin-btn admin-btn-primary" onClick={onPropose}
              disabled={proposing || !canGenerateWithAi}
              title={!canGenerateWithAi ? 'No AI key is set on the website yet — see Settings' : undefined}
            >
              {proposing ? 'Analyzing CSV…' : 'Generate with AI'}
            </button>
            <button type="button" className="admin-btn" onClick={onUseDefaultMapping}>Use default mapping</button>
            {!canGenerateWithAi && <a className="admin-hint" href="#settings">No AI key is set on the website yet — add one in Settings &rarr;</a>}
          </div>

          {wizard.editedConfig && roleSummary.length > 0 && (
            <div className="admin-mapping-summary">
              <table>
                <thead><tr><th>CSV column</th><th>Mapped to</th></tr></thead>
                <tbody>
                  {roleSummary.map(({ col, role }) => <tr key={col}><td>{col}</td><td><code>{role}</code></td></tr>)}
                </tbody>
              </table>
            </div>
          )}

          {wizard.editedConfig && (
            <details className="admin-advanced-disclosure">
              <summary>Advanced (full configuration editor)</summary>
              <ConfigEditor config={wizard.editedConfig} onChange={setEditedConfig} csvHeaders={wizard.csvHeaders} />
            </details>
          )}

          <div className="admin-wizard-actions">
            <button type="button" className="admin-btn" onClick={() => patch({ step: 2 })}>Back</button>
            <button type="button" className="admin-btn admin-btn-primary" disabled={!canLeaveStep3} onClick={() => patch({ step: 4 })}>Next</button>
          </div>
        </div>
      )}

      {step === 4 && wizard.editedConfig && (
        <div className="admin-wizard-panel">
          <h3>Review &amp; create</h3>
          <p className="admin-wizard-hint">This will create:</p>
          <ul className="admin-dialog-list">
            {filesToCreate(wizard).map(f => <li key={f}><code>{f}</code></li>)}
          </ul>
          <label className="admin-checkbox-row">
            <input type="checkbox" checked={wizard.startBuildNow} onChange={e => patch({ startBuildNow: e.target.checked })} />
            <span>Start the first build now</span>
          </label>
          <label className="admin-checkbox-row">
            <input
              type="checkbox" checked={wizard.includeBenchmarks && !!wizard.editedConfig?.benchmarks?.metrics?.length}
              disabled={!wizard.editedConfig?.benchmarks?.metrics?.length}
              onChange={e => patch({ includeBenchmarks: e.target.checked })}
            />
            <span>Include benchmark tables {!wizard.editedConfig?.benchmarks?.metrics?.length && '(no metrics configured yet)'} {wizard.editedConfig?.benchmarks?.metrics?.length ? '(slower)' : ''}</span>
          </label>
          <details className="admin-advanced-disclosure">
            <summary>YAML preview</summary>
            <div className="admin-yaml-preview">
              <pre>{generateYamlPreview(wizard.newDomain, previewConfig, wizard.csvFileName, previewPdfUrl)}</pre>
            </div>
          </details>
          {createError && <div className="admin-inline-error">{createError}</div>}
          <div className="admin-wizard-actions">
            <button type="button" className="admin-btn" onClick={() => patch({ step: 3 })} disabled={uploading}>Back</button>
            <button type="button" className="admin-btn admin-btn-primary" disabled={uploading || !csvFile} onClick={onCreate}>
              {uploading ? 'Creating domain…' : 'Create domain'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
