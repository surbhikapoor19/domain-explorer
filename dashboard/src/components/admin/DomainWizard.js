import React from 'react';
import { ConfigEditor, generateYamlPreview } from './ConfigEditor';
import {
  slugifyDomain, isValidSlug, nameColumnStatus, hasCitationColumn,
  estimatePayloadMB, ZIP_HARD_LIMIT_MB, PAYLOAD_HARD_LIMIT_MB,
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
  wizard, csvFile, pdfZipFile, domains, keyProviders,
  proposing, uploading, createError,
  patch, setEditedConfig, onCsvSelected, onZipSelected,
  onPropose, onUseDefaultMapping, onCreate, onCancel,
}) {
  const step = wizard.step;
  const dashed = (wizard.newDomain || '').replace(/_/g, '-');
  const slugValid = isValidSlug(wizard.newDomain);
  const slugTaken = domains.some(d => d.slug === wizard.newDomain);
  const nameCol = nameColumnStatus(wizard.csvHeaders);
  const citationOk = hasCitationColumn(wizard.csvHeaders);

  const canLeaveStep1 = !!wizard.displayName.trim() && slugValid && !slugTaken && wizard.csvHeaders.length > 0 && nameCol.ok;

  const zipMB = pdfZipFile ? pdfZipFile.size / (1024 * 1024) : 0;
  const zipTooBig = pdfZipFile && zipMB > ZIP_HARD_LIMIT_MB;
  const canLeaveStep2 = wizard.papersMode !== 'zip' || (pdfZipFile && !zipTooBig);

  const canGenerateWithAi = keyProviders.some(p => (p.name === 'HF_TOKEN' || p.name === 'GROQ_API_KEY') && p.inVercel);
  const canLeaveStep3 = !!wizard.editedConfig;

  const roleSummary = Object.entries(wizard.editedConfig?.columns || {})
    .filter(([, m]) => m.role)
    .map(([col, m]) => ({ col, role: m.role }));

  const payloadMB = estimatePayloadMB('', pdfZipFile);

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
            <label htmlFor="wiz-csv">CSV file</label>
            <div
              className="admin-dropzone"
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onCsvSelected(f); }}
            >
              <input id="wiz-csv" type="file" accept=".csv" onChange={e => onCsvSelected(e.target.files[0])} />
              <span className="admin-hint">or drag a .csv file here</span>
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
            <button type="button" className="admin-btn admin-btn-primary" disabled={!canLeaveStep1} onClick={() => patch({ step: 2 })}>Next</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="admin-wizard-panel">
          <h3>Papers</h3>
          <p className="admin-wizard-hint">How should we get the PDFs for these methods?</p>
          <div className="admin-radio-cards">
            <label className={`admin-radio-card ${wizard.papersMode === 'auto' ? 'selected' : ''}`}>
              <input type="radio" name="papers-mode" checked={wizard.papersMode === 'auto'} onChange={() => patch({ papersMode: 'auto' })} />
              <span className="admin-radio-card-title">Find them automatically (recommended)</span>
              <span className="admin-hint">Searches arXiv, OpenAlex and Semantic Scholar using the Citation column. Closed-access papers won&rsquo;t be found.</span>
            </label>
            <label className={`admin-radio-card ${wizard.papersMode === 'drive' ? 'selected' : ''}`}>
              <input type="radio" name="papers-mode" checked={wizard.papersMode === 'drive'} onChange={() => patch({ papersMode: 'drive' })} />
              <span className="admin-radio-card-title">Link a Google Drive folder or zip</span>
              <span className="admin-hint">Must be shared &ldquo;Anyone with the link&rdquo;. Name each PDF after its method, e.g. GraspGen &rarr; graspgen.pdf. Still auto-fetches anything missing.</span>
              {wizard.papersMode === 'drive' && (
                <input type="url" value={wizard.pdfUrl} onChange={e => patch({ pdfUrl: e.target.value })} placeholder="https://drive.google.com/..." />
              )}
            </label>
            <label className={`admin-radio-card ${wizard.papersMode === 'zip' ? 'selected' : ''}`}>
              <input type="radio" name="papers-mode" checked={wizard.papersMode === 'zip'} onChange={() => patch({ papersMode: 'zip' })} />
              <span className="admin-radio-card-title">Upload a small zip (&le; {ZIP_HARD_LIMIT_MB} MB)</span>
              <span className="admin-hint">Hard limit — the server rejects anything bigger. For a bigger corpus, use the Drive link option above. Still auto-fetches anything missing.</span>
              {wizard.papersMode === 'zip' && (
                <>
                  <input type="file" accept=".zip" onChange={e => onZipSelected(e.target.files[0])} />
                  {pdfZipFile && <span className="admin-hint">{pdfZipFile.name} ({zipMB.toFixed(1)} MB)</span>}
                  {zipTooBig && <div className="admin-inline-error">Over the {ZIP_HARD_LIMIT_MB} MB limit — use the Drive link option instead.</div>}
                  <div className="admin-payload-meter">
                    <div className="admin-payload-meter-track">
                      <div
                        className={`admin-payload-meter-fill ${payloadMB > PAYLOAD_HARD_LIMIT_MB ? 'over' : ''}`}
                        style={{ width: `${Math.min(100, (payloadMB / PAYLOAD_HARD_LIMIT_MB) * 100)}%` }}
                      />
                    </div>
                    <span className="admin-hint">{payloadMB.toFixed(1)} of {PAYLOAD_HARD_LIMIT_MB} MB request limit</span>
                  </div>
                </>
              )}
            </label>
          </div>
          <div className="admin-wizard-actions">
            <button type="button" className="admin-btn" onClick={() => patch({ step: 1 })}>Back</button>
            <button type="button" className="admin-btn admin-btn-primary" disabled={!canLeaveStep2} onClick={() => patch({ step: 3 })}>Next</button>
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
              <pre>{generateYamlPreview(wizard.newDomain, wizard.editedConfig, wizard.csvFileName, wizard.papersMode === 'drive' ? wizard.pdfUrl : '')}</pre>
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
