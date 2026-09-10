import React from 'react';
import { StatusTag, IconRefresh } from './icons';
import { relativeTime, absoluteTime, websiteStatus, daysUntil } from './utils';

function pipelineChip(runs, domains) {
  const active = runs
    .filter(r => r.status === 'in_progress' || r.status === 'queued')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (active) {
    const domain = domains.find(d => d.slug === active.domain);
    const label = domain ? domain.displayName : (active.domain || active.title || 'a build');
    const job = (active.jobs || [])[0];
    const steps = job?.steps || [];
    const doneCount = steps.filter(s => s.status === 'completed').length;
    const stepText = steps.length ? ` — step ${Math.min(doneCount + 1, steps.length)}/${steps.length}` : '';
    return { tone: 'running', text: `Building ${label}${stepText}` };
  }
  const finished = runs
    .filter(r => r.status === 'completed')
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0];
  if (!finished) return { tone: 'muted', text: 'No builds yet' };
  if (finished.conclusion === 'failure') return { tone: 'failed', text: 'Last build failed' };
  return { tone: 'success', text: `Last build passed ${relativeTime(finished.updated_at || finished.created_at)}` };
}

function aiKeysChip(providers) {
  const total = providers.length;
  const set = providers.filter(p => p.inGitHub).length;
  const gemini = providers.find(p => p.name === 'GEMINI_API_KEY');
  const groq = providers.find(p => p.name === 'GROQ_API_KEY');
  const neitherCore = !(gemini?.inGitHub) && !(groq?.inGitHub);
  if (!total) return { tone: 'muted', text: 'Not loaded' };
  if (neitherCore) return { tone: 'failed', text: `${set} of ${total} set` };
  if (set === total) return { tone: 'success', text: `${set} of ${total} set` };
  return { tone: 'warning', text: `${set} of ${total} set` };
}

function ghTokenChip(ghPat) {
  if (!ghPat || !ghPat.present) return { tone: 'failed', text: 'Not connected' };
  const days = daysUntil(ghPat.expiresAt);
  if (days == null) return { tone: 'muted', text: 'Connected' };
  if (days <= 0) return { tone: 'failed', text: 'Expired' };
  if (days < 30) return { tone: 'warning', text: `expires in ${days} days` };
  return { tone: 'muted', text: `expires in ${days} days` };
}

function driveFoldersChip(driveStatus) {
  const entries = Object.values(driveStatus || {});
  const connected = entries.filter(e => e.folderUrl);
  if (!connected.length) return { tone: 'muted', text: 'none connected' };
  const needsAttention = connected.filter(e => ['not_public', 'not_found'].includes(e.stored?.folder?.status));
  if (needsAttention.length) return { tone: 'failed', text: `${needsAttention.length} ${needsAttention.length === 1 ? 'needs' : 'need'} attention` };
  return { tone: 'success', text: `${connected.length} connected` };
}

export default function HealthStrip({ runs, deployments, domains, keyProviders, ghPat, driveStatus, lastRefreshedAt, refreshing, onRefresh }) {
  const pipeline = pipelineChip(runs, domains);
  const latestDeploy = [...deployments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const website = websiteStatus(latestDeploy);
  const aiKeys = aiKeysChip(keyProviders);
  const ghToken = ghTokenChip(ghPat);
  const driveFolders = driveFoldersChip(driveStatus);

  return (
    <div className="admin-health-strip">
      <a className="admin-health-chip" href="#activity">
        <span className="admin-health-label">Pipeline</span>
        <StatusTag tone={pipeline.tone}>{pipeline.text}</StatusTag>
      </a>
      <a className="admin-health-chip" href="#activity">
        <span className="admin-health-label">Website</span>
        <StatusTag tone={website.tone}>{website.text}</StatusTag>
      </a>
      <a className="admin-health-chip" href="#settings">
        <span className="admin-health-label">AI keys</span>
        <StatusTag tone={aiKeys.tone}>{aiKeys.text}</StatusTag>
      </a>
      <a className="admin-health-chip" href="#settings">
        <span className="admin-health-label">GitHub token</span>
        <StatusTag tone={ghToken.tone}>{ghToken.text}</StatusTag>
      </a>
      <a className="admin-health-chip" href="#domains">
        <span className="admin-health-label">Drive folders</span>
        <StatusTag tone={driveFolders.tone}>{driveFolders.text}</StatusTag>
      </a>
      <div className="admin-health-refresh">
        <span className="admin-health-updated" title={absoluteTime(lastRefreshedAt)}>
          {lastRefreshedAt ? `Updated ${relativeTime(lastRefreshedAt)}` : ''}
        </span>
        <button type="button" className="admin-btn admin-btn-icon" onClick={onRefresh} disabled={refreshing}>
          <IconRefresh /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}
