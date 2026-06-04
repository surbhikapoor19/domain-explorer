import React, { useState, useEffect, useCallback, useRef } from 'react';

const POLL_SLOW = 15000;
const POLL_FAST = 5000;

const ROLE_OPTIONS = [
  'identity.name', 'identity.description', 'identity.citation', 'identity.year', 'identity.code',
  'method.family', 'method.backbone', 'method.middleware', 'method.ik_controller',
  'train.regime', 'train.simulator',
  'input.modality', 'input.sensor',
  'output.shape',
  'hardware.platform',
  'env.context',
  'eval.benchmark', 'eval.metric',
  'meta.language', 'meta.license', 'meta.maintainer',
];

const FACET_OPTIONS = ['categorical', 'numeric', 'text', 'url', 'identifier'];

function ConfigEditor({ config, onChange, csvHeaders }) {
  const update = (key, value) => onChange({ ...config, [key]: value });

  const updateColumn = (colName, field, value) => {
    const cols = { ...config.columns };
    cols[colName] = { ...cols[colName], [field]: value };
    update('columns', cols);
  };

  const updateLlm = (key, value) => {
    update('llm', { ...config.llm, [key]: value });
  };

  const updateListItem = (listKey, idx, value) => {
    const arr = [...(config.llm?.[listKey] || [])];
    arr[idx] = value;
    updateLlm(listKey, arr);
  };

  return (
    <div className="config-editor">
      <div className="config-section">
        <h4>Identity</h4>
        <div className="config-row">
          <label>Display Name</label>
          <input type="text" value={config.display_name || ''} onChange={e => update('display_name', e.target.value)} />
        </div>
        <div className="config-row">
          <label>Subject (plural)</label>
          <input type="text" value={config.display_subject || ''} onChange={e => update('display_subject', e.target.value)} placeholder="e.g., motion planning algorithms" />
        </div>
        <div className="config-row">
          <label>Short Name</label>
          <input type="text" value={config.display_short || ''} onChange={e => update('display_short', e.target.value)} placeholder="e.g., motion planning" />
        </div>
        <div className="config-row">
          <label>Method Noun</label>
          <input type="text" value={config.method_noun || ''} onChange={e => update('method_noun', e.target.value)} placeholder="method, algorithm, technique" />
        </div>
        <div className="config-row">
          <label>Search Hint</label>
          <input type="text" value={config.query_hint || ''} onChange={e => update('query_hint', e.target.value)} />
        </div>
      </div>

      <div className="config-section">
        <h4>Column Mappings</h4>
        <p className="config-hint">Map each CSV column to a semantic role and facet type.</p>
        <div className="column-map-grid">
          <div className="column-map-header">
            <span>CSV Column</span><span>Role</span><span>Facet</span>
          </div>
          {csvHeaders.map(col => {
            const mapping = config.columns?.[col] || {};
            return (
              <div key={col} className="column-map-row">
                <span className="column-map-name" title={col}>{col}</span>
                <select value={mapping.role || ''} onChange={e => updateColumn(col, 'role', e.target.value)}>
                  <option value="">— select role —</option>
                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <select value={mapping.facet || ''} onChange={e => updateColumn(col, 'facet', e.target.value)}>
                  <option value="">— select facet —</option>
                  {FACET_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      <div className="config-section">
        <h4>LLM Prompts</h4>
        <div className="config-row">
          <label>Domain Subject</label>
          <input type="text" value={config.llm?.domain_subject || ''} onChange={e => updateLlm('domain_subject', e.target.value)} placeholder="e.g., robotic motion planning" />
        </div>
        <div className="config-list-section">
          <label>Claim Extraction Focus (what to look for in papers)</label>
          {(config.llm?.claim_extraction_focus || ['', '', '', '']).map((item, i) => (
            <input key={i} type="text" value={item} onChange={e => updateListItem('claim_extraction_focus', i, e.target.value)} placeholder={`Focus area ${i + 1}`} />
          ))}
        </div>
        <div className="config-list-section">
          <label>Example Queries</label>
          {(config.llm?.query_rewrite_examples || ['', '', '']).map((item, i) => (
            <input key={i} type="text" value={item} onChange={e => updateListItem('query_rewrite_examples', i, e.target.value)} placeholder={`Example query ${i + 1}`} />
          ))}
        </div>
      </div>

      <div className="config-section">
        <h4>Domain Context</h4>
        <div className="config-row">
          <label>Color-By Roles (comma-separated)</label>
          <input
            type="text"
            value={(config.default_color_by_roles || []).join(', ')}
            onChange={e => update('default_color_by_roles', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
        <div className="config-row">
          <label>Extra Datasets (comma-separated — domain-specific benchmarks to recognize in papers)</label>
          <input
            type="text"
            value={(config.extra_datasets || []).join(', ')}
            onChange={e => update('extra_datasets', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
        <div className="config-row">
          <label>Extra Keywords (comma-separated — domain-specific terms)</label>
          <input
            type="text"
            value={(config.extra_keywords || []).join(', ')}
            onChange={e => update('extra_keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
      </div>
    </div>
  );
}

function generateYamlPreview(domainSlug, config, csvFilename, pdfUrl) {
  const slug = (domainSlug || '').trim().replace(/\s+/g, '_').toLowerCase();
  const dashed = slug.replace(/_/g, '-');
  const lines = [];
  lines.push(`domain: ${slug}`);
  lines.push(`display_name: "${config.display_name || ''}"`);
  lines.push(`display_subject: "${config.display_subject || ''}"`);
  lines.push(`display_short: "${config.display_short || ''}"`);
  lines.push(`ecosystem: "COMPARE Ecosystem"`);
  lines.push(`tagline: "AI-in-the-Loop"`);
  lines.push(`query_hint: '${config.query_hint || ''}'`);
  lines.push(`method_noun: "${config.method_noun || 'method'}"`);
  lines.push('');
  lines.push(`csv_path: datasets/${dashed}/${csvFilename || `${slug}.csv`}`);
  lines.push(`papers_dir: datasets/${dashed}/papers/`);
  if (pdfUrl) lines.push(`pdf_url: "${pdfUrl}"`);
  lines.push('');
  lines.push('columns:');
  for (const [col, mapping] of Object.entries(config.columns || {})) {
    if (mapping.role) {
      const parts = [`role: ${mapping.role}`];
      if (mapping.facet) parts.push(`facet: ${mapping.facet}`);
      lines.push(`  "${col}": { ${parts.join(', ')} }`);
    }
  }
  lines.push('');
  lines.push('llm:');
  lines.push(`  domain_subject: "${config.llm?.domain_subject || ''}"`);
  lines.push('  claim_extraction_focus:');
  for (const item of (config.llm?.claim_extraction_focus || [])) {
    if (item) lines.push(`    - "${item}"`);
  }
  lines.push('  query_rewrite_examples:');
  for (const item of (config.llm?.query_rewrite_examples || [])) {
    if (item) lines.push(`    - "${item}"`);
  }
  lines.push('');
  lines.push('default_color_by_roles:');
  for (const r of (config.default_color_by_roles || [])) {
    lines.push(`  - ${r}`);
  }
  if (config.extra_datasets?.length) {
    lines.push('');
    lines.push('extra_datasets:');
    for (const d of config.extra_datasets) lines.push(`  - "${d}"`);
  }
  if (config.extra_keywords?.length) {
    lines.push('');
    lines.push('extra_keywords:');
    for (const k of config.extra_keywords) lines.push(`  - "${k}"`);
  }
  return lines.join('\n');
}

function AdminPage({ explorerEnabled, onToggleExplorer }) {
  const [token, setToken] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [domains, setDomains] = useState([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [error, setError] = useState(null);
  const [buildStatus, setBuildStatus] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [building, setBuilding] = useState(null);
  const [editingDomain, setEditingDomain] = useState(null);
  const [editPdfZip, setEditPdfZip] = useState(null);
  const [updating, setUpdating] = useState(false);

  const [uploadMode, setUploadMode] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [newDomain, setNewDomain] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [methodNoun, setMethodNoun] = useState('method');
  const [domainDescription, setDomainDescription] = useState('');
  const [csvFile, setCsvFile] = useState(null);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvSampleRows, setCsvSampleRows] = useState([]);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfZipFile, setPdfZipFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposedConfig, setProposedConfig] = useState(null);
  const [editedConfig, setEditedConfig] = useState(null);

  const pollRef = useRef(null);
  const pollIntervalRef = useRef(POLL_SLOW);
  const storedToken = useRef('');

  const authHeaders = useCallback(() => ({
    'x-admin-token': storedToken.current,
  }), []);

  const hasActiveRun = useCallback((runs) => {
    return runs.some(r => r.status === 'in_progress' || r.status === 'queued');
  }, []);

  const fetchDomains = useCallback(async () => {
    setLoadingDomains(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/domains', { headers: authHeaders() });
      if (!res.ok) throw new Error(res.status === 401 ? 'Invalid token' : 'Failed to load domains');
      const data = await res.json();
      setDomains(data.domains || []);
      setAuthenticated(true);
    } catch (err) {
      setError(err.message);
      if (err.message === 'Invalid token') setAuthenticated(false);
    }
    setLoadingDomains(false);
  }, [authHeaders]);

  const startPolling = useCallback((interval) => {
    clearInterval(pollRef.current);
    pollIntervalRef.current = interval;
    pollRef.current = setInterval(() => {
      fetch('/api/admin/build-status', { headers: { 'x-admin-token': storedToken.current } })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data) return;
          const runs = data.runs || [];
          setBuildStatus(runs);
          setDeployments(data.deployments || []);
          const activeBuild = runs.some(r => r.status === 'in_progress' || r.status === 'queued');
          const activeDeploy = (data.deployments || []).some(d => d.state === 'pending' || d.state === 'in_progress');
          if (!activeBuild && !activeDeploy && pollIntervalRef.current === POLL_FAST) {
            startPolling(POLL_SLOW);
          }
        })
        .catch(() => {});
    }, interval);
  }, []);

  const fetchBuildStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/build-status', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const runs = data.runs || [];
        setBuildStatus(runs);
        setDeployments(data.deployments || []);
        return runs;
      }
    } catch (_) {}
    return [];
  }, [authHeaders]);

  useEffect(() => {
    if (authenticated) {
      fetchBuildStatus().then(runs => {
        startPolling(hasActiveRun(runs) ? POLL_FAST : POLL_SLOW);
      });
      return () => clearInterval(pollRef.current);
    }
  }, [authenticated, fetchBuildStatus, startPolling, hasActiveRun]);

  const handleLogin = async (e) => {
    e.preventDefault();
    storedToken.current = token;
    await fetchDomains();
  };

  const parseCSV = (text) => {
    const splitCsvLine = (line) => {
      const fields = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQuotes = !inQuotes; continue; }
        if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue; }
        current += ch;
      }
      fields.push(current.trim());
      return fields;
    };
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const headers = splitCsvLine(lines[0]);
    const rows = [];
    for (let i = 1; i < Math.min(lines.length, 4); i++) {
      const values = splitCsvLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
      rows.push(row);
    }
    return { headers, rows };
  };

  const handleCsvChange = async (file) => {
    setCsvFile(file);
    if (!file) { setCsvHeaders([]); setCsvSampleRows([]); return; }
    const text = await file.text();
    const { headers, rows } = parseCSV(text);
    setCsvHeaders(headers);
    setCsvSampleRows(rows);
  };

  const handlePropose = async () => {
    if (!csvHeaders.length) { setError('Upload a CSV first'); return; }
    setProposing(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/propose-yaml', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domainSlug: newDomain.trim().replace(/\s+/g, '_').toLowerCase(),
          description: domainDescription,
          csvHeaders,
          csvSampleRows,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Proposal failed');
      if (data.yaml) {
        setProposedConfig(data.yaml);
        setEditedConfig(JSON.parse(JSON.stringify(data.yaml)));
        setWizardStep(2);
      } else {
        throw new Error(data.parseError || 'LLM returned unparseable response');
      }
    } catch (err) {
      setError(err.message);
    }
    setProposing(false);
  };

  const handleTriggerBuild = async (domain) => {
    setBuilding(domain);
    setError(null);
    try {
      const res = await fetch('/api/admin/trigger-build', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Build trigger failed');
      setTimeout(async () => {
        await fetchBuildStatus();
        startPolling(POLL_FAST);
      }, 3000);
    } catch (err) {
      setError(err.message);
    }
    setBuilding(null);
  };

  const handleUpdateDomain = async (domain) => {
    if (!editPdfZip) {
      setError('Select a .zip file of PDFs');
      return;
    }
    setUpdating(true);
    setError(null);
    try {
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(editPdfZip);
      });
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain,
          updateOnly: true,
          pdfZipBase64: base64,
          pdfZipFilename: editPdfZip.name,
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error(text.slice(0, 200)); }
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setEditingDomain(null);
      setEditPdfZip(null);
      await fetchDomains();
    } catch (err) {
      setError(err.message);
    }
    setUpdating(false);
  };

  const handleUpload = async () => {
    if (!csvFile || !newDomain.trim()) {
      setError('Domain name and CSV file are required');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const csvContent = await csvFile.text();
      const cfg = editedConfig || {};
      let pdfZipBase64 = undefined;
      let pdfZipFilename = undefined;
      if (pdfZipFile) {
        pdfZipBase64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(pdfZipFile);
        });
        pdfZipFilename = pdfZipFile.name;
      }
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: newDomain.trim().replace(/\s+/g, '_').toLowerCase(),
          csvContent,
          csvFilename: csvFile.name,
          pdfUrl: pdfUrl.trim() || undefined,
          pdfZipBase64,
          pdfZipFilename,
          displayName: cfg.display_name || displayName.trim() || undefined,
          methodNoun: cfg.method_noun || methodNoun.trim() || undefined,
          yamlConfig: cfg,
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error(text.slice(0, 200)); }
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      resetWizard();
      await fetchDomains();
    } catch (err) {
      setError(err.message);
    }
    setUploading(false);
  };

  const resetWizard = () => {
    setUploadMode(false);
    setWizardStep(1);
    setNewDomain('');
    setDisplayName('');
    setMethodNoun('method');
    setDomainDescription('');
    setCsvFile(null);
    setCsvHeaders([]);
    setCsvSampleRows([]);
    setPdfUrl('');
    setPdfZipFile(null);
    setProposedConfig(null);
    setEditedConfig(null);
  };

  if (!authenticated) {
    return (
      <div className="admin-page">
        <div className="admin-login">
          <h2>Admin Access</h2>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Enter admin token"
              autoFocus
            />
            <button type="submit" disabled={!token.trim()}>
              Authenticate
            </button>
          </form>
          {error && <div className="admin-error">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <div className="admin-container">
        <div className="admin-header">
          <h2>Domain Management</h2>
          <button
            className="admin-btn admin-btn-primary"
            onClick={() => { if (uploadMode) { resetWizard(); } else { setUploadMode(true); setWizardStep(1); } }}
          >
            {uploadMode ? 'Cancel' : '+ New Domain'}
          </button>
        </div>

        <div className="admin-setting-row">
          <label className="admin-toggle-label">
            <input type="checkbox" checked={!!explorerEnabled} onChange={e => onToggleExplorer(e.target.checked)} />
            <span>Show Explorer tab</span>
          </label>
          <span className="admin-setting-hint">When off, Graph Reasoning is the landing page</span>
        </div>

        {error && <div className="admin-error">{error}</div>}

        {uploadMode && (
          <div className="admin-upload-form">
            <div className="wizard-steps">
              <span className={`wizard-step ${wizardStep >= 1 ? 'active' : ''}`}>1. Describe</span>
              <span className="wizard-arrow">&rarr;</span>
              <span className={`wizard-step ${wizardStep >= 2 ? 'active' : ''}`}>2. Configure</span>
              <span className="wizard-arrow">&rarr;</span>
              <span className={`wizard-step ${wizardStep >= 3 ? 'active' : ''}`}>3. Review</span>
            </div>

            {wizardStep === 1 && (
              <div className="wizard-panel">
                <h3>Describe Your Domain</h3>
                <p className="wizard-hint">Upload your CSV and describe the domain. An LLM will propose a full configuration that you can review and edit.</p>
                <div className="admin-field">
                  <label>Domain ID *</label>
                  <input type="text" value={newDomain} onChange={e => setNewDomain(e.target.value)} placeholder="e.g., motion_planning" pattern="[a-z_]+" />
                </div>
                <div className="admin-field">
                  <label>CSV File *</label>
                  <input type="file" accept=".csv" onChange={e => handleCsvChange(e.target.files[0])} />
                  {csvHeaders.length > 0 && (
                    <div className="csv-preview">
                      <span className="csv-preview-label">{csvHeaders.length} columns detected:</span>
                      <div className="csv-preview-chips">
                        {csvHeaders.map(h => <span key={h} className="csv-chip">{h}</span>)}
                      </div>
                    </div>
                  )}
                </div>
                <div className="admin-field">
                  <label>Describe this domain</label>
                  <textarea
                    value={domainDescription}
                    onChange={e => setDomainDescription(e.target.value)}
                    placeholder="e.g., This dataset catalogs robotic motion planning algorithms. Each row is an algorithm with its planning type, middleware, and IK/controller approach. The domain focuses on sampling-based and optimization-based planners for manipulation tasks."
                    rows={4}
                  />
                </div>
                <div className="admin-field">
                  <label>PDF Papers (optional — upload a .zip or paste a URL)</label>
                  <input type="file" accept=".zip" onChange={e => setPdfZipFile(e.target.files[0])} />
                  {pdfZipFile && <span className="csv-preview-label">{pdfZipFile.name} ({(pdfZipFile.size / 1024 / 1024).toFixed(1)} MB)</span>}
                  <div className="pdf-or-divider"><span>or</span></div>
                  <input type="url" value={pdfUrl} onChange={e => setPdfUrl(e.target.value)} placeholder="https://drive.google.com/..." />
                </div>
                <div className="wizard-actions">
                  <button className="admin-btn" onClick={resetWizard}>Cancel</button>
                  <button
                    className="admin-btn admin-btn-primary"
                    onClick={handlePropose}
                    disabled={proposing || !csvFile || !newDomain.trim()}
                  >
                    {proposing ? 'Analyzing CSV...' : 'Generate Configuration'}
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 2 && editedConfig && (
              <div className="wizard-panel">
                <h3>Review & Edit Configuration</h3>
                <p className="wizard-hint">The LLM proposed this configuration based on your CSV. Edit any field below.</p>
                <ConfigEditor config={editedConfig} onChange={setEditedConfig} csvHeaders={csvHeaders} />
                <div className="wizard-actions">
                  <button className="admin-btn" onClick={() => setWizardStep(1)}>Back</button>
                  <button className="admin-btn" onClick={() => { setEditedConfig(JSON.parse(JSON.stringify(proposedConfig))); }}>Reset to Proposed</button>
                  <button className="admin-btn admin-btn-primary" onClick={() => setWizardStep(3)}>Review Final</button>
                </div>
              </div>
            )}

            {wizardStep === 3 && editedConfig && (
              <div className="wizard-panel">
                <h3>Confirm & Create Domain</h3>
                <div className="yaml-preview">
                  <pre>{generateYamlPreview(newDomain, editedConfig, csvFile?.name, pdfUrl)}</pre>
                </div>
                <div className="wizard-actions">
                  <button className="admin-btn" onClick={() => setWizardStep(2)}>Back to Edit</button>
                  <button
                    className="admin-btn admin-btn-primary"
                    onClick={handleUpload}
                    disabled={uploading}
                  >
                    {uploading ? 'Creating Domain...' : 'Create Domain'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="admin-domains">
          <h3>Existing Domains</h3>
          {loadingDomains && <div className="admin-loading">Loading domains...</div>}
          {domains.length === 0 && !loadingDomains && (
            <div className="admin-empty">No domains configured yet.</div>
          )}
          {domains.map(d => {
            const domainPath = `/${d.slug.replace(/_/g, '-')}`;
            return (
              <div key={d.slug} className="admin-domain-card">
                <div className="admin-domain-info">
                  <h4>{d.displayName}</h4>
                  <div className="admin-domain-meta">
                    <span>{d.slug}</span>
                    {d.methodCount > 0 && <span>{d.methodCount} {d.methodNoun}s</span>}
                    {d.hasData && <span className="admin-badge admin-badge-ok">Data</span>}
                    {d.hasKG ? (
                      <span className="admin-badge admin-badge-ok">KG</span>
                    ) : (
                      <span className="admin-badge admin-badge-warn">No KG</span>
                    )}
                  </div>
                  <div className="admin-domain-url">
                    <a href={domainPath} target="_blank" rel="noopener noreferrer">{window.location.origin}{domainPath}</a>
                  </div>
                </div>
                <div className="admin-domain-actions">
                  <button
                    className="admin-btn"
                    onClick={() => {
                      if (editingDomain === d.slug) {
                        setEditingDomain(null);
                        setEditPdfZip(null);
                      } else {
                        setEditingDomain(d.slug);
                        setEditPdfZip(null);
                      }
                    }}
                  >
                    {editingDomain === d.slug ? 'Cancel' : 'Update'}
                  </button>
                  <button
                    className="admin-btn"
                    onClick={() => handleTriggerBuild(d.slug)}
                    disabled={building === d.slug}
                  >
                    {building === d.slug ? 'Building...' : 'Build'}
                  </button>
                  <a
                    className="admin-btn admin-btn-visit"
                    href={domainPath}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Visit
                  </a>
                </div>
                {editingDomain === d.slug && (
                  <div className="admin-update-form">
                    <div className="admin-field">
                      <label>Upload PDFs (.zip of PDF files)</label>
                      <input
                        type="file"
                        accept=".zip"
                        onChange={e => setEditPdfZip(e.target.files[0])}
                      />
                    </div>
                    <button
                      className="admin-btn admin-btn-primary"
                      onClick={() => handleUpdateDomain(d.slug)}
                      disabled={updating || !editPdfZip}
                    >
                      {updating ? 'Uploading...' : 'Upload PDFs & Build'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {buildStatus.length > 0 && (
          <div className="admin-builds">
            <h3>Pipeline Status</h3>
            {buildStatus.map(run => {
              const isActive = run.status === 'in_progress' || run.status === 'queued';
              const isFailed = run.conclusion === 'failure';
              const isSuccess = run.conclusion === 'success';
              const activeJob = (run.jobs || []).find(j => j.status === 'in_progress') || (run.jobs || [])[0];
              const steps = activeJob ? activeJob.steps : [];
              const completedSteps = steps.filter(s => s.status === 'completed').length;
              const activeStep = steps.find(s => s.status === 'in_progress');
              const totalSteps = steps.length || 1;
              const pct = isActive && totalSteps > 1 ? Math.round((completedSteps / totalSteps) * 100) : 0;
              const elapsed = isActive ? Math.round((Date.now() - new Date(run.created_at).getTime()) / 1000) : null;
              const elapsedStr = elapsed ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : '';

              return (
                <div key={run.id} className={`admin-build-card ${isActive ? 'active' : ''} ${isFailed ? 'failed' : ''} ${isSuccess ? 'success' : ''}`}>
                  <div className="admin-build-header">
                    <span className={`admin-build-pill ${isActive ? 'pill-active' : isFailed ? 'pill-failed' : isSuccess ? 'pill-success' : ''}`}>
                      {isActive ? (run.status === 'queued' ? 'Queued' : 'Running') : isFailed ? 'Failed' : isSuccess ? 'Done' : run.status}
                    </span>
                    <span className="admin-build-name">{run.name}</span>
                    <span className="admin-build-time">
                      {isActive ? elapsedStr : new Date(run.created_at).toLocaleString()}
                    </span>
                    {run.html_url && (
                      <a href={run.html_url} target="_blank" rel="noopener noreferrer" className="admin-build-link">View logs</a>
                    )}
                  </div>

                  {isActive && steps.length > 0 && (
                    <div className="admin-progress-section">
                      <div className="admin-progress-bar-track">
                        <div className="admin-progress-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="admin-progress-detail">
                        <span className="admin-progress-step">
                          {activeStep ? activeStep.name : `Step ${completedSteps}/${totalSteps}`}
                        </span>
                        <span className="admin-progress-pct">{pct}%</span>
                      </div>
                      <div className="admin-step-list">
                        {steps.map(step => (
                          <div key={step.number} className={`admin-step ${step.status === 'completed' ? 'step-done' : step.status === 'in_progress' ? 'step-active' : 'step-pending'}`}>
                            <span className="step-icon">
                              {step.status === 'completed' ? (step.conclusion === 'success' ? '✓' : '✗') : step.status === 'in_progress' ? '●' : '○'}
                            </span>
                            <span className="step-name">{step.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {isFailed && (
                    <div className="admin-build-fail-msg">
                      Build failed — <a href={run.html_url} target="_blank" rel="noopener noreferrer">check logs</a> for details.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {deployments.length > 0 && (
          <div className="admin-deploys">
            <h3>Vercel Deployments</h3>
            {deployments.map(d => {
              const isPending = d.state === 'pending' || d.state === 'in_progress';
              const isReady = d.state === 'success';
              const isError = d.state === 'error' || d.state === 'failure';
              return (
                <div key={d.id} className={`admin-deploy-card ${isPending ? 'deploying' : ''} ${isReady ? 'live' : ''} ${isError ? 'failed' : ''}`}>
                  <span className={`admin-deploy-pill ${isPending ? 'pill-deploying' : isReady ? 'pill-live' : isError ? 'pill-failed' : ''}`}>
                    {isPending ? 'Deploying' : isReady ? 'Live' : isError ? 'Failed' : d.state || 'Unknown'}
                  </span>
                  <span className="admin-deploy-sha">{d.sha}</span>
                  <span className="admin-deploy-env">{d.environment}</span>
                  <span className="admin-deploy-time">
                    {new Date(d.updated_at || d.created_at).toLocaleString()}
                  </span>
                  {d.target_url && (
                    <a href={d.target_url} target="_blank" rel="noopener noreferrer" className="admin-build-link">
                      {isReady ? 'Visit' : 'View'}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminPage;
