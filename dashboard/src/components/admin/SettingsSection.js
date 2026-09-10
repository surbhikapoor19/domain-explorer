import React from 'react';
import { StatusTag, IconEye, IconEyeOff, IconCheck } from './icons';
import { absoluteTime, daysUntil } from './utils';

function KeyRow({ provider, revealed, onReveal, onCancel, keyValue, onKeyValueChange, showPassword, onToggleShowPassword, saveState, onSave, onSaveSkipValidation }) {
  const inputId = `admin-key-${provider.name}`;
  const saving = saveState?.phase === 'saving';
  return (
    <div className="admin-key-row">
      <div className="admin-key-row-main">
        <div className="admin-key-row-label">
          <strong>{provider.label}</strong>
          <span className="admin-hint">{provider.usedFor}</span>
        </div>
        <div className="admin-key-row-status">
          <span className="admin-key-row-status-label">GitHub</span>
          <StatusTag tone={provider.inGitHub ? 'success' : 'muted'}>
            {provider.inGitHub ? `set${provider.githubUpdatedAt ? ` · updated ${absoluteTime(provider.githubUpdatedAt)}` : ''}` : 'not set'}
          </StatusTag>
        </div>
        <div className="admin-key-row-status">
          <span className="admin-key-row-status-label">Website (Vercel)</span>
          {/* Muted either way (the website copy never blocks the pipeline), but a set key gets a check. */}
          <StatusTag tone="muted" icon={provider.inVercel ? IconCheck : undefined}>{provider.inVercel ? 'set' : 'not set · set separately in Vercel'}</StatusTag>
        </div>
        <div className="admin-key-row-actions">
          {provider.getUrl && <a href={provider.getUrl} target="_blank" rel="noopener noreferrer">Get a key &#8599;</a>}
          {!revealed && (
            <button type="button" className="admin-btn" onClick={onReveal}>
              {provider.inGitHub ? `Replace ${provider.label} key` : `Add ${provider.label} key`}
            </button>
          )}
        </div>
      </div>

      {revealed && (
        <div className="admin-key-form">
          <label htmlFor={inputId}>{provider.label} API key</label>
          <div className="admin-password-field">
            <input
              id={inputId} type={showPassword ? 'text' : 'password'} value={keyValue}
              onChange={e => onKeyValueChange(e.target.value)} autoComplete="off"
            />
            <button type="button" className="admin-password-toggle" onClick={onToggleShowPassword} aria-label={showPassword ? 'Hide key' : 'Show key'}>
              {showPassword ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
          {saving && <p className="admin-hint">Verifying with {provider.label}&hellip;</p>}
          {saveState?.phase === 'error' && <div className="admin-inline-error">{saveState.message}</div>}
          {saveState?.phase === 'success' && <StatusTag tone="success">{saveState.message || 'Saved'}</StatusTag>}
          <div className="admin-key-form-actions">
            <button type="button" className="admin-btn admin-btn-primary" disabled={saving || !keyValue.trim()} onClick={onSave}>
              {saving ? 'Verifying…' : 'Save key'}
            </button>
            <button type="button" className="admin-btn" onClick={onCancel} disabled={saving}>Cancel</button>
            {saveState?.canSkip && (
              <button type="button" className="admin-btn" onClick={onSaveSkipValidation} disabled={saving}>Save without verification</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GhTokenCard({ ghPat }) {
  if (!ghPat) return null;
  const days = daysUntil(ghPat.expiresAt);
  const tone = !ghPat.present ? 'failed' : days != null && days <= 0 ? 'failed' : days != null && days < 30 ? 'warning' : 'muted';
  return (
    <div className="admin-token-card">
      <h3>GitHub access token</h3>
      {!ghPat.present ? (
        <StatusTag tone="failed">Not connected</StatusTag>
      ) : (
        <>
          <StatusTag tone={tone}>
            {days == null ? 'Connected' : days <= 0 ? 'Expired' : `expires in ${days} days`}
          </StatusTag>
          {ghPat.expiresAt && <span className="admin-hint"> ({absoluteTime(ghPat.expiresAt)})</span>}
          {ghPat.scopes?.length > 0 && <p className="admin-hint">Scopes: {ghPat.scopes.join(', ')}</p>}
        </>
      )}
      <p className="admin-hint">When it expires, these stop working: uploads, builds, saving keys, deleting domains, and Activity.</p>
      <details className="admin-advanced-disclosure">
        <summary>How to rotate it</summary>
        <ol className="admin-rotation-steps">
          <li>In GitHub, go to Settings &rarr; Developer settings &rarr; Fine-grained tokens and generate a new one with the same scopes ({(ghPat.scopes || ['repo', 'workflow']).join(', ')}).</li>
          <li>In Vercel, open this project&rsquo;s Environment Variables and replace <code>GITHUB_TOKEN</code> with the new value.</li>
          <li>Redeploy so the website picks up the new token.</li>
        </ol>
      </details>
    </div>
  );
}

export default function SettingsSection({
  providers, ghPat, revealedProvider, keyDraft, showPassword, keySaveState,
  onReveal, onCancelReveal, onKeyDraftChange, onToggleShowPassword, onSave, onSaveSkipValidation,
  explorerEnabled, onToggleExplorer,
}) {
  return (
    <div className="admin-settings">
      <h2>AI keys</h2>
      <p className="admin-hint">
        Used by the build pipeline (extracting benchmark tables, writing summaries) and by the website&rsquo;s chat copilot.
        Stored encrypted as GitHub Actions secrets and never shown again. The website chat uses its own copy in
        Vercel&rsquo;s environment variables — update that separately in the Vercel dashboard if you rotate a key.
      </p>
      <div className="admin-key-list">
        {providers.map(p => (
          <KeyRow
            key={p.name}
            provider={p}
            revealed={revealedProvider === p.name}
            onReveal={() => onReveal(p.name)}
            onCancel={onCancelReveal}
            keyValue={keyDraft}
            onKeyValueChange={onKeyDraftChange}
            showPassword={showPassword}
            onToggleShowPassword={onToggleShowPassword}
            saveState={keySaveState[p.name]}
            onSave={() => onSave(p)}
            onSaveSkipValidation={() => onSaveSkipValidation(p)}
          />
        ))}
        {providers.length === 0 && <div className="admin-empty">Loading&hellip;</div>}
      </div>

      <GhTokenCard ghPat={ghPat} />

      <div className="admin-setting-row">
        <label className="admin-toggle-label">
          <input type="checkbox" checked={!!explorerEnabled} onChange={e => onToggleExplorer(e.target.checked)} />
          <span>Show Explorer tab</span>
        </label>
        <span className="admin-hint">
          When off, Graph Reasoning is the landing page. This toggle only affects this browser — for embeds, set{' '}
          <code>"explorerEnabled"</code> in the domain config (or add <code>?explorer=1</code> to the iframe URL),
          since localStorage does not cross the iframe boundary.
        </span>
      </div>
    </div>
  );
}
