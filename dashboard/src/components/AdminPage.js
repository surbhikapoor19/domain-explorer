import React, { useState, useEffect, useCallback, useRef } from 'react';

const STATUS_POLL_INTERVAL = 15000;

function AdminPage() {
  const [token, setToken] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [domains, setDomains] = useState([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [error, setError] = useState(null);
  const [buildStatus, setBuildStatus] = useState([]);
  const [building, setBuilding] = useState(null);
  const [switching, setSwitching] = useState(null);

  const [uploadMode, setUploadMode] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [methodNoun, setMethodNoun] = useState('method');
  const [csvFile, setCsvFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  const pollRef = useRef(null);
  const storedToken = useRef('');

  const authHeaders = useCallback(() => ({
    'x-admin-token': storedToken.current,
  }), []);

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

  const fetchBuildStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/build-status', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setBuildStatus(data.runs || []);
      }
    } catch (_) {}
  }, [authHeaders]);

  useEffect(() => {
    if (authenticated) {
      fetchBuildStatus();
      pollRef.current = setInterval(fetchBuildStatus, STATUS_POLL_INTERVAL);
      return () => clearInterval(pollRef.current);
    }
  }, [authenticated, fetchBuildStatus]);

  const handleLogin = async (e) => {
    e.preventDefault();
    storedToken.current = token;
    await fetchDomains();
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
      setTimeout(fetchBuildStatus, 3000);
    } catch (err) {
      setError(err.message);
    }
    setBuilding(null);
  };

  const handleSwitchDomain = async (domain) => {
    setSwitching(domain);
    setError(null);
    try {
      const res = await fetch('/api/admin/switch-domain', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Switch failed');
    } catch (err) {
      setError(err.message);
    }
    setSwitching(null);
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!csvFile || !newDomain.trim()) {
      setError('Domain name and CSV file are required');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const csvContent = await csvFile.text();
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: newDomain.trim().replace(/\s+/g, '_').toLowerCase(),
          csvContent,
          csvFilename: csvFile.name,
          pdfUrl: pdfUrl.trim() || undefined,
          displayName: displayName.trim() || undefined,
          methodNoun: methodNoun.trim() || undefined,
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error(text.slice(0, 200)); }
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setUploadMode(false);
      setNewDomain('');
      setDisplayName('');
      setCsvFile(null);
      setPdfUrl('');
      await fetchDomains();
    } catch (err) {
      setError(err.message);
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

  return (
    <div className="admin-page">
      <div className="admin-container">
        <div className="admin-header">
          <h2>Domain Management</h2>
          <button
            className="admin-btn admin-btn-primary"
            onClick={() => setUploadMode(!uploadMode)}
          >
            {uploadMode ? 'Cancel' : '+ New Domain'}
          </button>
        </div>

        {error && <div className="admin-error">{error}</div>}

        {uploadMode && (
          <div className="admin-upload-form">
            <h3>Add New Domain</h3>
            <form onSubmit={handleUpload}>
              <div className="admin-field">
                <label>Domain ID (e.g., motion_planning)</label>
                <input
                  type="text"
                  value={newDomain}
                  onChange={e => setNewDomain(e.target.value)}
                  placeholder="domain_name"
                  pattern="[a-z_]+"
                />
              </div>
              <div className="admin-field">
                <label>Display Name (e.g., "Motion Explorer")</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="My Explorer"
                />
              </div>
              <div className="admin-field">
                <label>Method Noun (e.g., "algorithm", "method")</label>
                <input
                  type="text"
                  value={methodNoun}
                  onChange={e => setMethodNoun(e.target.value)}
                  placeholder="method"
                />
              </div>
              <div className="admin-field">
                <label>CSV File *</label>
                <input
                  type="file"
                  accept=".csv"
                  onChange={e => setCsvFile(e.target.files[0])}
                />
              </div>
              <div className="admin-field">
                <label>PDF Papers URL (Google Drive, Dropbox link to .zip)</label>
                <input
                  type="url"
                  value={pdfUrl}
                  onChange={e => setPdfUrl(e.target.value)}
                  placeholder="https://drive.google.com/..."
                />
              </div>
              <button
                type="submit"
                className="admin-btn admin-btn-primary"
                disabled={uploading || !csvFile || !newDomain.trim()}
              >
                {uploading ? 'Uploading...' : 'Upload & Create Domain'}
              </button>
            </form>
          </div>
        )}

        <div className="admin-domains">
          <h3>Existing Domains</h3>
          {loadingDomains && <div className="admin-loading">Loading domains...</div>}
          {domains.length === 0 && !loadingDomains && (
            <div className="admin-empty">No domains configured yet.</div>
          )}
          {domains.map(d => (
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
              </div>
              <div className="admin-domain-actions">
                <button
                  className="admin-btn"
                  onClick={() => handleTriggerBuild(d.slug)}
                  disabled={building === d.slug}
                >
                  {building === d.slug ? 'Building...' : 'Build'}
                </button>
                <button
                  className="admin-btn"
                  onClick={() => handleSwitchDomain(d.slug)}
                  disabled={switching === d.slug}
                >
                  {switching === d.slug ? 'Switching...' : 'Deploy'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {buildStatus.length > 0 && (
          <div className="admin-builds">
            <h3>Recent Builds</h3>
            {buildStatus.map(run => (
              <div key={run.id} className={`admin-build-row admin-build-${run.conclusion || run.status}`}>
                <span className="admin-build-status">
                  {run.status === 'completed'
                    ? (run.conclusion === 'success' ? 'Done' : 'Failed')
                    : run.status === 'in_progress' ? 'Running...'
                    : run.status === 'queued' ? 'Queued' : run.status}
                </span>
                <span className="admin-build-name">{run.name}</span>
                <span className="admin-build-time">
                  {new Date(run.created_at).toLocaleString()}
                </span>
                {run.html_url && (
                  <a href={run.html_url} target="_blank" rel="noopener noreferrer" className="admin-build-link">View</a>
                )}
                {run.log && run.log.length > 0 && (
                  <details className="admin-build-log">
                    <summary>Log ({run.log.length} lines)</summary>
                    <pre>{run.log.join('\n')}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminPage;
