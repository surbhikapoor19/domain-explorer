import React, { useState, useEffect, useCallback, useRef } from 'react';
import HealthStrip from './admin/HealthStrip';
import DomainsSection from './admin/DomainsSection';
import DomainWizard from './admin/DomainWizard';
import ActivitySection from './admin/ActivitySection';
import SettingsSection from './admin/SettingsSection';
import DeleteDialog from './admin/DeleteDialog';
import { parseCSV, defaultColumnMapping, ZIP_HARD_LIMIT_MB } from './admin/utils';

const POLL_SLOW = 15000;
const POLL_FAST = 5000;
const WIZARD_STORAGE_KEY = 'admin-wizard-v1';

const anyRunActive = (runs) => runs.some(r => r.status === 'in_progress' || r.status === 'queued');

const emptyWizard = () => ({
  step: 1,
  newDomain: '', slugEdited: false,
  displayName: '', methodNoun: 'method', domainDescription: '',
  csvFileName: '', csvHeaders: [], csvSampleRows: [], rowCount: 0,
  papersMode: 'auto', pdfUrl: '', driveFolder: '',
  proposedConfig: null, editedConfig: null,
  startBuildNow: true, includeBenchmarks: true,
});

function loadPersistedWizard() {
  try {
    const raw = sessionStorage.getItem(WIZARD_STORAGE_KEY);
    if (raw) return { ...emptyWizard(), ...JSON.parse(raw) };
  } catch (_) { /* ignore */ }
  return emptyWizard();
}

function AdminPage({ explorerEnabled, onToggleExplorer }) {
  const [token, setToken] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState(null);

  const [domains, setDomains] = useState([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [buildStatus, setBuildStatus] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [keyProviders, setKeyProviders] = useState([]);
  const [ghPat, setGhPat] = useState(null);

  const pollRef = useRef(null);
  const pollIntervalRef = useRef(POLL_SLOW);
  const storedToken = useRef('');
  const domainsHeadingRef = useRef(null);

  const authHeaders = useCallback(() => ({
    'x-admin-token': storedToken.current,
  }), []);

  const fetchDomains = useCallback(async () => {
    setLoadingDomains(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/domains', { headers: authHeaders() });
      if (res.status === 401) throw new Error('Invalid token');
      const data = await res.json().catch(() => ({}));
      // Only a 401 means a wrong admin token. Anything else (e.g. an expired GitHub token)
      // still logs in, so Settings can show what's wrong instead of locking the user out.
      setAuthenticated(true);
      if (!res.ok) throw new Error(data.error || 'Failed to load domains');
      setDomains(data.domains || []);
    } catch (err) {
      setError(err.message);
      if (err.message === 'Invalid token') setAuthenticated(false);
    }
    setLoadingDomains(false);
  }, [authHeaders]);

  const fetchBuildStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/build-status', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const runs = data.runs || [];
        setBuildStatus(runs);
        setDeployments(data.deployments || []);
        setLastRefreshedAt(new Date().toISOString());
        return runs;
      }
    } catch (_) { /* ignore — render a graceful empty state */ }
    return [];
  }, [authHeaders]);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/keys', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setKeyProviders(data.providers || []);
        setGhPat(data.ghPat || null);
      }
    } catch (_) { /* ignore */ }
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
          setLastRefreshedAt(new Date().toISOString());
          const activeBuild = anyRunActive(runs);
          const activeDeploy = (data.deployments || []).some(d => ['pending', 'in_progress', 'building', 'queued'].includes(d.state));
          const active = activeBuild || activeDeploy;
          if (active && pollIntervalRef.current !== POLL_FAST) startPolling(POLL_FAST);
          else if (!active && pollIntervalRef.current === POLL_FAST) startPolling(POLL_SLOW);
        })
        .catch(() => {});
    }, interval);
  }, []);

  useEffect(() => {
    if (!authenticated) return undefined;
    fetchKeys();
    fetchBuildStatus().then(runs => {
      startPolling(anyRunActive(runs) ? POLL_FAST : POLL_SLOW);
    });
    return () => clearInterval(pollRef.current);
  }, [authenticated, fetchBuildStatus, startPolling, fetchKeys]);

  const handleRefreshAll = async () => {
    setRefreshing(true);
    await Promise.all([fetchDomains(), fetchBuildStatus(), fetchKeys()]);
    setRefreshing(false);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    storedToken.current = token;
    await fetchDomains();
  };

  // ─── Build triggers ────────────────────────────────────────────────────
  const [buildingMap, setBuildingMap] = useState({});

  const handleTriggerBuild = async (slug, pages) => {
    const action = pages === 'benchmark' ? 'benchmark' : 'build';
    setBuildingMap(prev => ({ ...prev, [slug]: action }));
    setError(null);
    try {
      const res = await fetch('/api/admin/trigger-build', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(pages ? { domain: slug, pages } : { domain: slug }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Build trigger failed');
      setTimeout(async () => {
        await fetchBuildStatus();
        startPolling(POLL_FAST);
      }, 3000);
    } catch (err) {
      setError(err.message);
    }
    setBuildingMap(prev => { const next = { ...prev }; delete next[slug]; return next; });
  };

  const handleRerunBuild = (run) => {
    if (!run.domain) return;
    handleTriggerBuild(run.domain, run.scope || undefined);
  };

  // ─── Update data (Replace CSV / Set PDF link / Upload small PDF zip) ──
  const [updateOpenSlug, setUpdateOpenSlug] = useState(null);
  const [updatingSlug, setUpdatingSlug] = useState(null);
  const [updateError, setUpdateError] = useState(null);

  const handleToggleUpdate = (slug) => {
    setUpdateOpenSlug(prev => (prev === slug ? null : slug));
    setUpdateError(null);
  };

  const submitUpdate = async (slug, payload) => {
    setUpdatingSlug(slug);
    setUpdateError(null);
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: slug, updateOnly: true, ...payload }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error(text.slice(0, 200)); }
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setUpdateOpenSlug(null);
      await fetchDomains();
    } catch (err) {
      setUpdateError(err.message);
    }
    setUpdatingSlug(null);
  };

  const handleUpdateCsv = async (slug, file) => {
    const csvContent = await file.text();
    await submitUpdate(slug, { csvContent, csvFilename: file.name });
  };
  const handleUpdatePdfUrl = async (slug, url) => {
    await submitUpdate(slug, { pdfUrl: url });
  };
  const handleUpdateZip = async (slug, file) => {
    if (file.size > ZIP_HARD_LIMIT_MB * 1024 * 1024) {
      setUpdateError(`This zip is over the ${ZIP_HARD_LIMIT_MB} MB limit — use "Set PDF link" instead.`);
      return;
    }
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(file);
    });
    await submitUpdate(slug, { pdfZipBase64: base64, pdfZipFilename: file.name });
  };

  // ─── Delete domain ──────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleConfirmDelete = async (confirmText) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/admin/delete-domain', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: deleteTarget.slug, confirm: confirmText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setDeleteTarget(null);
      setToast(`Deleted — commit ${(data.commitSha || '').slice(0, 7)}`);
      domainsHeadingRef.current?.focus();
      await fetchDomains();
    } catch (err) {
      setDeleteError(err.message);
    }
    setDeleting(false);
  };

  // ─── AI keys ────────────────────────────────────────────────────────────
  const [revealedProvider, setRevealedProvider] = useState(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keySaveState, setKeySaveState] = useState({});

  const handleRevealKey = (name) => {
    setRevealedProvider(name);
    setKeyDraft('');
    setShowPassword(false);
    setKeySaveState(prev => { const next = { ...prev }; delete next[name]; return next; });
  };
  const handleCancelRevealKey = () => {
    setRevealedProvider(null);
    setKeyDraft('');
  };

  const handleSaveKey = async (provider, { skipValidation } = {}) => {
    const value = keyDraft.trim();
    if (!value) return;
    setKeySaveState(prev => ({ ...prev, [provider.name]: { phase: 'saving' } }));
    try {
      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: provider.name, value, ...(skipValidation ? { skipValidation: true } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setKeySaveState(prev => ({ ...prev, [provider.name]: { phase: 'success', message: data.note || (data.validated ? 'Verified and saved' : 'Saved') } }));
        setKeyDraft('');
        setRevealedProvider(null);
        fetchKeys();
      } else if (res.status === 502) {
        setKeySaveState(prev => ({ ...prev, [provider.name]: { phase: 'error', message: data.error || 'Could not verify the key right now.', canSkip: true } }));
      } else {
        setKeySaveState(prev => ({ ...prev, [provider.name]: { phase: 'error', message: data.error || 'Save failed.' } }));
      }
    } catch (err) {
      setKeySaveState(prev => ({ ...prev, [provider.name]: { phase: 'error', message: err.message } }));
    }
  };

  // ─── Activity: on-demand log fetch, filter, pagination ────────────────
  const [expandedLogRunId, setExpandedLogRunId] = useState(null);
  const [logStates, setLogStates] = useState({});
  const [activityFilter, setActivityFilter] = useState('all');
  const [activityVisibleCount, setActivityVisibleCount] = useState(10);

  const handleToggleLog = (runId) => {
    if (expandedLogRunId === runId) { setExpandedLogRunId(null); return; }
    setExpandedLogRunId(runId);
    if (!logStates[runId]) {
      setLogStates(prev => ({ ...prev, [runId]: { loading: true } }));
      fetch(`/api/admin/build-logs?run_id=${runId}`, { headers: authHeaders() })
        .then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
        .then(({ ok, data }) => {
          setLogStates(prev => ({ ...prev, [runId]: ok ? { data } : { error: data.error || 'Could not load the log.' } }));
        })
        .catch(err => setLogStates(prev => ({ ...prev, [runId]: { error: err.message } })));
    }
  };

  // ─── New domain wizard ──────────────────────────────────────────────────
  const [wizardOpen, setWizardOpen] = useState(false);
  const wizardRef = useRef(null);
  const [wizard, setWizard] = useState(loadPersistedWizard);
  const [csvFile, setCsvFile] = useState(null);
  const [pdfZipFile, setPdfZipFile] = useState(null);
  const [proposing, setProposing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [pendingCreate, setPendingCreate] = useState(null);

  const patchWizard = (fields) => setWizard(w => ({ ...w, ...fields }));

  useEffect(() => {
    if (!wizardOpen) return;
    try { sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(wizard)); } catch (_) { /* ignore */ }
  }, [wizard, wizardOpen]);

  useEffect(() => {
    const dirty = wizardOpen && (wizard.displayName.trim() || wizard.newDomain.trim() || wizard.csvHeaders.length > 0);
    if (!dirty) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [wizardOpen, wizard.displayName, wizard.newDomain, wizard.csvHeaders.length]);

  useEffect(() => {
    if (!pendingCreate || pendingCreate.timedOut) return;
    if (buildStatus.some(r => r.kind === 'build' && r.domain === pendingCreate.domain)) {
      setPendingCreate(null);
      return;
    }
    if (Date.now() - pendingCreate.since > 3 * 60 * 1000) {
      setPendingCreate(pc => (pc ? { ...pc, timedOut: true } : pc));
    }
  }, [buildStatus, pendingCreate]);

  const handleOpenWizard = () => {
    setWizardOpen(true);
    setCreateError(null);
  };
  // Bring the wizard (rendered below the cards) into view when it opens.
  useEffect(() => {
    if (wizardOpen) wizardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [wizardOpen]);
  const handleCancelWizard = () => {
    setWizardOpen(false);
    setWizard(emptyWizard());
    setCsvFile(null);
    setPdfZipFile(null);
    try { sessionStorage.removeItem(WIZARD_STORAGE_KEY); } catch (_) { /* ignore */ }
  };

  const handleCsvSelected = async (file) => {
    setCsvFile(file || null);
    if (!file) { patchWizard({ csvFileName: '', csvHeaders: [], csvSampleRows: [], rowCount: 0 }); return; }
    const text = await file.text();
    const { headers, rows, rowCount } = parseCSV(text);
    patchWizard({ csvFileName: file.name, csvHeaders: headers, csvSampleRows: rows, rowCount });
  };

  const handlePropose = async () => {
    if (!wizard.csvHeaders.length) { setCreateError('Upload a CSV first'); return; }
    setProposing(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/admin/propose-yaml', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domainSlug: wizard.newDomain,
          description: wizard.domainDescription,
          csvHeaders: wizard.csvHeaders,
          csvSampleRows: wizard.csvSampleRows,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Proposal failed');
      if (data.yaml) {
        // What the user typed in step 1 wins over the AI's guess (it renamed "Test Domain"
        // to "Test Domain Explorer" in testing).
        const proposed = { ...data.yaml };
        if (wizard.displayName.trim()) proposed.display_name = wizard.displayName.trim();
        // 'method' is the prefilled default, so only an edited noun overrides the AI's.
        if ((wizard.methodNoun || '').trim() && wizard.methodNoun.trim() !== 'method') proposed.method_noun = wizard.methodNoun.trim();
        patchWizard({ proposedConfig: proposed, editedConfig: JSON.parse(JSON.stringify(proposed)) });
      } else {
        throw new Error(data.parseError || 'The AI response could not be parsed — try "Use default mapping" instead.');
      }
    } catch (err) {
      setCreateError(err.message);
    }
    setProposing(false);
  };

  const handleUseDefaultMapping = () => {
    const columns = defaultColumnMapping(wizard.csvHeaders);
    const base = wizard.editedConfig || {
      display_name: wizard.displayName,
      display_subject: wizard.methodNoun ? `${wizard.methodNoun}s` : '',
      display_short: wizard.displayName,
      method_noun: wizard.methodNoun || 'method',
      query_hint: wizard.domainDescription,
    };
    patchWizard({ editedConfig: { ...base, columns } });
  };

  const handleCreate = async () => {
    if (!csvFile || !wizard.newDomain.trim()) { setCreateError('Domain name and CSV file are required'); return; }
    setUploading(true);
    setCreateError(null);
    try {
      const csvContent = await csvFile.text();
      const cfg = wizard.editedConfig || {};
      const slug = wizard.newDomain.trim().replace(/\s+/g, '_').toLowerCase();
      const dashed = slug.replace(/_/g, '-');
      const bm = cfg.benchmarks || {};
      const includeBenchmarks = wizard.includeBenchmarks && Array.isArray(bm.metrics) && bm.metrics.length > 0;
      const benchmarkConfig = includeBenchmarks ? {
        results_section_keywords: bm.results_section_keywords || ['experiment', 'result', 'evaluation', 'comparison', 'benchmark'],
        ablation_section_keywords: bm.ablation_section_keywords || ['ablation'],
        metrics: bm.metrics,
        conditions: bm.conditions || [],
        datasets: bm.datasets || [],
        method_aliases: bm.method_aliases || {},
        consistency: bm.consistency || { cv_thresholds: { rate: 0.10, time: 0.25, count: 0.20, default: 0.15 }, min_papers_for_validation: 2 },
        corpus: { tei_dir: `datasets/${dashed}/tei`, pdf_dir: `datasets/${dashed}/papers`, methods_csv: `datasets/${dashed}/${csvFile.name}` },
      } : undefined;

      let pdfZipBase64;
      let pdfZipFilename;
      if (wizard.papersMode === 'zip' && pdfZipFile) {
        pdfZipBase64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(pdfZipFile);
        });
        pdfZipFilename = pdfZipFile.name;
      }
      const pdfUrl = wizard.papersMode === 'drive' ? (wizard.pdfUrl.trim() || undefined) : undefined;

      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: slug,
          csvContent,
          csvFilename: csvFile.name,
          pdfUrl,
          pdfZipBase64,
          pdfZipFilename,
          displayName: cfg.display_name || wizard.displayName.trim() || undefined,
          methodNoun: cfg.method_noun || wizard.methodNoun.trim() || undefined,
          yamlConfig: cfg,
          benchmarkConfig,
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error(text.slice(0, 200)); }
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      if (wizard.startBuildNow) {
        handleTriggerBuild(slug, includeBenchmarks ? 'new-paper' : 'all');
        setPendingCreate({ domain: slug, since: Date.now(), timedOut: false });
      }
      handleCancelWizard();
      await fetchDomains();
      document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      setCreateError(err.message);
    }
    setUploading(false);
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

  const latestRunByDomain = {};
  for (const r of buildStatus) {
    if (!r.domain) continue;
    const existing = latestRunByDomain[r.domain];
    if (!existing || new Date(r.created_at) > new Date(existing.created_at)) latestRunByDomain[r.domain] = r;
  }
  const activeDomainSlugs = new Set(
    buildStatus.filter(r => r.status === 'in_progress' || r.status === 'queued').map(r => r.domain)
  );

  return (
    <div className="admin-page">
      <div className="admin-container">
        <header className="admin-top">
          <h1>Domain Management</h1>
          <nav className="admin-mininav" aria-label="Admin sections">
            <a href="#overview">Overview</a>
            <a href="#domains">Domains</a>
            <a href="#activity">Activity</a>
            <a href="#settings">Settings</a>
          </nav>
        </header>

        {error && <div className="admin-error">{error}</div>}
        {toast && <div className="admin-toast" role="status">{toast}</div>}

        <section id="overview" className="admin-section">
          <h2>Overview</h2>
          <p className="admin-hint">Add a domain, watch it build, and manage AI keys from this one page — the links above jump to each part.</p>
          <HealthStrip
            runs={buildStatus}
            deployments={deployments}
            domains={domains}
            keyProviders={keyProviders}
            ghPat={ghPat}
            lastRefreshedAt={lastRefreshedAt}
            refreshing={refreshing}
            onRefresh={handleRefreshAll}
          />
        </section>

        <section id="domains" className="admin-section">
          <div className="admin-section-header">
            <h2 ref={domainsHeadingRef} tabIndex={-1}>Domains</h2>
          </div>
          <DomainsSection
            domains={domains}
            loading={loadingDomains}
            runsByDomain={latestRunByDomain}
          latestDeploy={deployments[0]}
            activeDomainSlugs={activeDomainSlugs}
            buildingMap={buildingMap}
            updateOpenSlug={updateOpenSlug}
            onToggleUpdate={handleToggleUpdate}
            updating={updatingSlug}
            updateError={updateError}
            onSubmitCsv={handleUpdateCsv}
            onSubmitPdfUrl={handleUpdatePdfUrl}
            onSubmitZip={handleUpdateZip}
            onBuild={slug => handleTriggerBuild(slug)}
            onBuildBenchmarks={slug => handleTriggerBuild(slug, 'benchmark')}
            onDelete={domain => { setDeleteTarget(domain); setDeleteError(null); }}
            onOpenWizard={handleOpenWizard}
          />
          {/* The wizard opens BELOW the cards so existing domains stay in view. */}
          {wizardOpen && (
            <div ref={wizardRef} className="admin-wizard-anchor">
            <DomainWizard
              wizard={wizard}
              csvFile={csvFile}
              pdfZipFile={pdfZipFile}
              domains={domains}
              keyProviders={keyProviders}
              proposing={proposing}
              uploading={uploading}
              createError={createError}
              patch={patchWizard}
              setEditedConfig={cfg => patchWizard({ editedConfig: cfg })}
              onCsvSelected={handleCsvSelected}
              onZipSelected={file => setPdfZipFile(file || null)}
              onPropose={handlePropose}
              onUseDefaultMapping={handleUseDefaultMapping}
              onCreate={handleCreate}
              onCancel={handleCancelWizard}
            />
            </div>
          )}
        </section>

        <section id="activity" className="admin-section">
          <h2>Activity</h2>
          {pendingCreate && (
            <div className="admin-pending-banner">
              {pendingCreate.timedOut
                ? <span>Not started — press Build on the card for &ldquo;{pendingCreate.domain}&rdquo;.</span>
                : <span>Saved to GitHub &rarr; Build queued (~1 min) &rarr; Building (~15&ndash;40 min) &rarr; Website update (~3 min) &rarr; Live at /{pendingCreate.domain.replace(/_/g, '-')}</span>}
              <button type="button" className="admin-btn" onClick={() => setPendingCreate(null)}>Dismiss</button>
            </div>
          )}
          <ActivitySection
            runs={buildStatus}
            domains={domains}
            deployments={deployments}
            filter={activityFilter}
            onFilterChange={setActivityFilter}
            expandedLogRunId={expandedLogRunId}
            logStates={logStates}
            onToggleLog={handleToggleLog}
            onRerun={handleRerunBuild}
            visibleCount={activityVisibleCount}
            onShowOlder={() => setActivityVisibleCount(c => c + 10)}
          />
        </section>

        <section id="settings" className="admin-section">
          <SettingsSection
            providers={keyProviders}
            ghPat={ghPat}
            revealedProvider={revealedProvider}
            keyDraft={keyDraft}
            showPassword={showPassword}
            keySaveState={keySaveState}
            onReveal={handleRevealKey}
            onCancelReveal={handleCancelRevealKey}
            onKeyDraftChange={setKeyDraft}
            onToggleShowPassword={() => setShowPassword(v => !v)}
            onSave={provider => handleSaveKey(provider)}
            onSaveSkipValidation={provider => handleSaveKey(provider, { skipValidation: true })}
            explorerEnabled={explorerEnabled}
            onToggleExplorer={onToggleExplorer}
          />
        </section>
      </div>

      {deleteTarget && (
        <DeleteDialog
          domain={deleteTarget}
          busy={deleting}
          error={deleteError}
          onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}

export default AdminPage;
