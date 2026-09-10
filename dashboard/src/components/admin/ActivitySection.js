import React, { useState } from 'react';
import { StatusTag } from './icons';
import {
  relativeTime, absoluteTime, formatDuration, friendlyStepName, websiteStatus,
  scopeLabel, buildHelpReport, mailtoHref, githubIssueHref,
} from './utils';

function isActiveRun(run) {
  return run.status === 'in_progress' || run.status === 'queued';
}

function runTone(run) {
  if (isActiveRun(run)) return 'running';
  if (run.conclusion === 'success') return 'success';
  if (run.conclusion === 'failure') return 'failed';
  return 'muted';
}

function runStatusText(run) {
  if (run.status === 'queued') return 'Queued';
  if (run.status === 'in_progress') return 'Running';
  if (run.conclusion === 'success') return 'Passed';
  if (run.conclusion === 'failure') return 'Failed';
  return run.status || 'Unknown';
}

function titleFor(run, domains) {
  if (run.kind === 'nightly') return 'Nightly Drive sync';
  if (run.kind === 'switch') return 'Domain switch';
  // Runs from before the workflow's run-name label carry no domain/scope.
  if (!run.domain) return 'Domain build';
  const domain = domains.find(d => d.slug === run.domain);
  const label = domain ? domain.displayName : run.domain;
  return `Build · ${label} · ${scopeLabel(run.scope)}`;
}

// Steps skipped by an `if:` (e.g. Docling on a non-benchmark build) are not failures.
function stepState(step) {
  if (step.status === 'in_progress') return 'active';
  if (step.status !== 'completed') return 'pending';
  if (step.conclusion === 'success') return 'done';
  if (step.conclusion === 'skipped') return 'skipped';
  return 'failed';
}

function stepDuration(step) {
  if (!step.started_at || !step.completed_at) return '';
  const sec = (new Date(step.completed_at) - new Date(step.started_at)) / 1000;
  return formatDuration(sec);
}

// A quick way out of a failed build: a prefilled email to the maintainer, a
// prefilled GitHub issue, or a copyable plain-text report — all built from the
// same failure diagnosis already on screen.
function AskForHelp({ run, domains, failure, maintainerEmail }) {
  const [copied, setCopied] = useState(false);
  const domain = domains.find(d => d.slug === run.domain);
  const domainLabel = domain ? `${domain.displayName} (${run.domain})` : (run.domain || 'unknown domain');
  const adminUrl = typeof window !== 'undefined' ? `${window.location.origin}/admin` : undefined;
  const { subject, body } = buildHelpReport({
    title: titleFor(run, domains),
    domainLabel,
    scope: scopeLabel(run.scope),
    when: run.updated_at || run.created_at,
    failure,
    runUrl: run.html_url,
    adminUrl,
  });
  const issueHref = githubIssueHref(run.html_url, subject, body);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) { /* clipboard unavailable — nothing to crash */ }
  };

  return (
    <div className="admin-ask-help">
      <div className="admin-ask-help-actions">
        {maintainerEmail ? (
          <a href={mailtoHref(maintainerEmail, subject, body)}>Email the maintainer</a>
        ) : (
          <span className="admin-hint">Set a maintainer email in Settings to email the maintainer from here.</span>
        )}
        {issueHref && <a href={issueHref} target="_blank" rel="noopener noreferrer">Open a GitHub issue</a>}
        <button type="button" className="admin-btn admin-btn-text" onClick={handleCopy}>{copied ? 'Copied' : 'Copy report'}</button>
      </div>
      <p className="admin-hint">Your email app opens with the details filled in &mdash; nothing is sent until you press Send.</p>
    </div>
  );
}

function LogPanel({ state, run, domains, maintainerEmail, onRerun }) {
  if (state?.loading) return <div className="admin-log-panel admin-loading">Loading log&hellip;</div>;
  if (state?.error) return <div className="admin-log-panel admin-inline-error">{state.error}</div>;
  const data = state?.data;
  if (!data) return null;
  const job = (data.jobs || [])[0];

  return (
    <div className="admin-log-panel">
      {data.failure ? (
        <>
          {(data.failure.hints || []).map((hint, i) => (
            <div className="admin-hint-card" key={i}>
              <div className="admin-hint-card-title">{hint.title}</div>
              <div className="admin-hint-card-fix">Fix: {hint.fix}</div>
            </div>
          ))}
          <div className="admin-log-failing-step">Failed at step: <strong>{data.failure.step}</strong></div>
          {(data.failure.errorLines || []).map((line, i) => (
            <div className="admin-log-error-line" key={i}>{line}</div>
          ))}
          <AskForHelp run={run} domains={domains} failure={data.failure} maintainerEmail={maintainerEmail} />
          {data.failure.excerpt && (
            // The raw log is supporting detail: collapsed when a plain-language hint exists.
            <details className="admin-log-details" open={!(data.failure.hints || []).length}>
              <summary>Raw log excerpt</summary>
              <pre className="admin-log-excerpt">{data.failure.excerpt}</pre>
            </details>
          )}
        </>
      ) : (
        job && (
          <ul className="admin-step-rail">
            {(job.steps || []).map(step => (
              <li key={step.number} className={`admin-step admin-step-${stepState(step)}`}>
                <span className="admin-step-name">{step.name}</span>
                <span className="admin-step-duration">{stepState(step) === 'skipped' ? 'skipped' : stepDuration(step)}</span>
              </li>
            ))}
          </ul>
        )
      )}
      <div className="admin-log-actions">
        <button type="button" className="admin-btn" onClick={() => onRerun(run)}>Re-run this build</button>
        {(data.failure?.logUrl || run.html_url) && (
          <a className="admin-btn" href={data.failure?.logUrl || run.html_url} target="_blank" rel="noopener noreferrer">Open full log on GitHub &#8599;</a>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, domains, expanded, logState, maintainerEmail, onToggleLog, onRerun }) {
  const active = isActiveRun(run);
  const job = (run.jobs || [])[0];
  const steps = job?.steps || [];
  const done = steps.filter(s => s.status === 'completed').length;
  const currentStep = steps.find(s => s.status === 'in_progress');
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;

  return (
    <div className={`admin-run-row ${active ? 'active' : ''}`}>
      <div className="admin-run-row-main">
        <StatusTag tone={runTone(run)}>{runStatusText(run)}</StatusTag>
        <span className="admin-run-title">{titleFor(run, domains)}</span>
        <span className="admin-run-time" title={absoluteTime(run.created_at)}>{relativeTime(run.created_at)}</span>
        <span className="admin-run-duration">{active ? 'running…' : formatDuration(run.duration_s)}</span>
        {run.html_url && <a className="admin-run-github" href={run.html_url} target="_blank" rel="noopener noreferrer">GitHub &#8599;</a>}
        {!active && (
          <button type="button" className="admin-btn admin-btn-text" aria-expanded={expanded} onClick={() => onToggleLog(run.id)}>
            View logs
          </button>
        )}
      </div>
      {active && steps.length > 0 && (
        <div className="admin-run-progress">
          <div className="admin-progress-bar-track"><div className="admin-progress-bar-fill" style={{ width: `${pct}%` }} /></div>
          <span className="admin-run-progress-step">{currentStep ? friendlyStepName(currentStep.name) : `Step ${done}/${steps.length}`}</span>
        </div>
      )}
      {!active && expanded && <LogPanel state={logState} run={run} domains={domains} maintainerEmail={maintainerEmail} onRerun={onRerun} />}
    </div>
  );
}

export default function ActivitySection({
  runs, domains, deployments, maintainerEmail, filter, onFilterChange,
  expandedLogRunId, logStates, onToggleLog, onRerun,
  visibleCount, onShowOlder,
}) {
  const domainOptions = Array.from(new Set(runs.map(r => r.domain).filter(Boolean)));
  const filtered = runs.filter(r => {
    if (filter === 'all') return true;
    if (filter === 'failures') return r.conclusion === 'failure';
    return r.domain === filter;
  });
  const active = filtered.filter(isActiveRun).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const rest = filtered.filter(r => !isActiveRun(r)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const shown = rest.slice(0, visibleCount);
  const hasMore = rest.length > visibleCount;

  return (
    <div className="admin-activity">
      <div className="admin-filter-chips">
        <button type="button" className={`admin-filter-chip ${filter === 'all' ? 'active' : ''}`} onClick={() => onFilterChange('all')}>All</button>
        <button type="button" className={`admin-filter-chip ${filter === 'failures' ? 'active' : ''}`} onClick={() => onFilterChange('failures')}>Failures</button>
        {domainOptions.map(slug => {
          const domain = domains.find(d => d.slug === slug);
          return (
            <button key={slug} type="button" className={`admin-filter-chip ${filter === slug ? 'active' : ''}`} onClick={() => onFilterChange(slug)}>
              {domain ? domain.displayName : slug}
            </button>
          );
        })}
      </div>

      <div className="admin-run-list">
        {active.length === 0 && rest.length === 0 && <div className="admin-empty">No runs yet.</div>}
        {active.map(run => (
          <RunRow key={run.id} run={run} domains={domains} expanded={false} logState={null} onToggleLog={onToggleLog} onRerun={onRerun} />
        ))}
        {shown.map(run => (
          <RunRow
            key={run.id} run={run} domains={domains}
            expanded={expandedLogRunId === run.id}
            logState={logStates[run.id]}
            maintainerEmail={maintainerEmail}
            onToggleLog={onToggleLog}
            onRerun={onRerun}
          />
        ))}
      </div>
      {hasMore && (
        <button type="button" className="admin-btn" onClick={onShowOlder}>Show older</button>
      )}

      {deployments.length > 0 && (
        <div className="admin-deploys">
          <h3>Website deployments</h3>
          {deployments.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(d => {
            const ws = websiteStatus(d);
            return (
              <div key={d.id} className="admin-deploy-row">
                <StatusTag tone={ws.tone}>{ws.text}</StatusTag>
                <span className="admin-deploy-sha">{(d.sha || '').slice(0, 7)}</span>
                <span className="admin-deploy-desc">{d.description}</span>
                <span className="admin-run-time" title={absoluteTime(d.created_at)}>{relativeTime(d.created_at)}</span>
                {d.target_url && <a className="admin-run-github" href={d.target_url} target="_blank" rel="noopener noreferrer">View &#8599;</a>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
