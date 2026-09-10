import { repoInfo } from '../../lib/admin-github.js';

// "Build <domain> (<scope>[, forced])" — set as the workflow's run-name so the
// admin Activity feed can label runs without an extra API call per run.
const BUILD_TITLE_RE = /^Build (\S+) \(([^,)]+)(, forced)?\)/;

function parseBuildMeta(title) {
  const m = BUILD_TITLE_RE.exec(title || '');
  if (!m) return { domain: null, scope: null, forced: false };
  return { domain: m[1], scope: m[2], forced: !!m[3] };
}

function computeDuration(run) {
  const startedStr = run.run_started_at || run.created_at;
  if (!startedStr) return null;
  const startedMs = new Date(startedStr).getTime();
  const endMs = run.status === 'completed' && run.updated_at
    ? new Date(run.updated_at).getTime()
    : Date.now();
  return Math.max(0, Math.round((endMs - startedMs) / 1000));
}

async function mapRun(run, headers, isNightly) {
  const title = run.display_title || run.name;
  const meta = parseBuildMeta(title);
  const kind = isNightly ? 'nightly' : (/^Switch domain:/.test(title || '') ? 'switch' : 'build');

  const result = {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
    name: run.name,
    title,
    event: run.event,
    run_started_at: run.run_started_at,
    kind,
    domain: meta.domain,
    scope: meta.scope,
    forced: meta.forced,
    duration_s: computeDuration(run),
  };

  if (run.status === 'in_progress' || run.status === 'queued') {
    try {
      if (run.jobs_url) {
        const jobsRes = await fetch(run.jobs_url, { headers });
        if (jobsRes.ok) {
          const jobsData = await jobsRes.json();
          result.jobs = (jobsData.jobs || []).map(job => ({
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            steps: (job.steps || []).map(step => ({
              name: step.name,
              status: step.status,
              conclusion: step.conclusion,
              number: step.number,
            })),
          }));
        }
      }
    } catch (_) {}
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ghToken = process.env.GH_PAT;
  if (!ghToken) {
    return res.status(500).json({ error: 'GH_PAT not configured' });
  }

  const { owner, repo, headers } = repoInfo();
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  try {
    const [runsRes, pollRes] = await Promise.all([
      fetch(`${base}/actions/runs?event=repository_dispatch&per_page=15`, { headers }),
      fetch(`${base}/actions/workflows/sheet-poll.yml/runs?per_page=5`, { headers }).catch(() => null),
    ]);

    if (!runsRes.ok) {
      return res.status(runsRes.status).json({ error: 'Failed to fetch build status' });
    }

    const data = await runsRes.json();
    let pollRuns = [];
    if (pollRes && pollRes.ok) {
      try {
        const pollData = await pollRes.json();
        pollRuns = pollData.workflow_runs || [];
      } catch (_) {}
    }

    const dispatchRuns = await Promise.all((data.workflow_runs || []).map(r => mapRun(r, headers, false)));
    const nightlyRuns = await Promise.all(pollRuns.map(r => mapRun(r, headers, true)));

    const runs = [...dispatchRuns, ...nightlyRuns]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    let deployments = [];
    try {
      const deplRes = await fetch(
        `${base}/deployments?per_page=3&environment=Production`,
        { headers }
      );
      if (deplRes.ok) {
        const deplData = await deplRes.json();
        deployments = await Promise.all((deplData || []).map(async (d) => {
          const result = {
            id: d.id,
            sha: d.sha?.slice(0, 7),
            created_at: d.created_at,
            environment: d.environment,
            description: d.description,
          };
          try {
            const statusRes = await fetch(d.statuses_url, { headers });
            if (statusRes.ok) {
              const statuses = await statusRes.json();
              const latest = statuses[0];
              if (latest) {
                result.state = latest.state;
                result.target_url = latest.target_url || latest.log_url;
                result.updated_at = latest.updated_at;
              }
            }
          } catch (_) {}
          return result;
        }));
      }
    } catch (_) {}

    return res.status(200).json({ runs, deployments, generated_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
