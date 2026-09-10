import { repoInfo } from '../../lib/admin-github.js';

// Ordered hint rules for a failing build log. Order matters: LFS before
// rate-limit, invalid-key before missing-key (see backend-spec.md).
const HINT_RULES = [
  {
    re: /over its data quota|LFS.*(bandwidth|quota|budget)/i,
    title: 'Git LFS bandwidth quota used up',
    fix: 'Monthly GitHub LFS bandwidth exhausted; CSV-only (precompute) builds still work; PDF builds resume when the quota resets (monthly) or after buying a data pack in GitHub → Settings → Billing.',
  },
  {
    re: /API key not valid|invalid api key|invalid_api_key|\b401\b.*(key|unauthori)|unauthori[sz]ed.*key|PERMISSION_DENIED/i,
    title: 'AI key rejected by the provider',
    fix: "Key revoked or mistyped; paste a fresh key under AI keys (it's verified before saving) and re-run.",
  },
  {
    re: /No LLM API key|API key (is )?(not set|missing|not configured)|GROQ_API_KEY.*(not set|missing)|GEMINI_API_KEY.*(not set|missing)/i,
    title: 'No AI key configured',
    fix: 'Add a Gemini or Groq key under AI keys, then re-run the build.',
  },
  {
    re: /\b429\b|rate.?limit|RESOURCE_EXHAUSTED|Too Many Requests|quota exceeded/i,
    title: 'AI provider rate limit / daily quota hit',
    fix: 'Free tiers reset daily; wait and re-run (finished work is cached), or add the backup Gemini key.',
  },
  {
    re: /papers dir not found|no PDFs|0 PDFs|No papers\.zip/i,
    title: 'No paper PDFs found',
    fix: 'PDFs are auto-fetched from arXiv/OpenAlex/Semantic Scholar using the Citation column; otherwise link a shared Drive folder/zip (PDF link) or upload a small zip.',
  },
  {
    re: /KeyError: '?Name'?|No methods CSV|csv.*(not found|No such file)|ParserError: Error tokenizing/i,
    title: 'CSV problem',
    fix: 'The CSV must have a `Name` column (one row per method) and a `Citation` column; re-upload via Update data → Replace CSV.',
  },
  {
    re: /yaml\.(scanner|parser)|ScannerError|ParserError: while parsing|domains\/\S+\.ya?ml.*(not found|No such file)/i,
    title: 'Domain config (YAML) is invalid',
    fix: 'Re-generate the config in the wizard, or fix the YAML in the repo.',
  },
  {
    re: /GROBID never responded|GROBID container exited|8070.*(refused|Connection)/i,
    title: 'PDF parser (GROBID) failed to start',
    fix: 'Transient runner issue; re-run the build.',
  },
  {
    re: /push failed after|push rejected|cannot lock ref|failed to push some refs/i,
    title: "Couldn't save results (another build pushed at the same time)",
    fix: 'Re-run; nothing was lost.',
  },
  {
    re: /Could not find a version|No matching distribution|ModuleNotFoundError|No module named|pip.*ERROR/i,
    title: 'Dependency install failed',
    fix: 'Usually a temporary package-index outage; re-run. If it persists, a pinned version in requirements-ci.txt needs updating.',
  },
  {
    re: /exceeded the maximum execution time|has exceeded the maximum|timed? ?out after/i,
    title: 'Build timed out',
    fix: 'Re-run; cached work (parsed PDFs, embeddings) is reused so the next run is faster.',
  },
  {
    re: /No space left on device/i,
    title: 'Runner ran out of disk',
    fix: 'Re-run; if persistent the PDF set is too large for one runner.',
  },
];

export function hintsFor(text) {
  const t = text || '';
  const hits = [];
  for (const rule of HINT_RULES) {
    if (rule.re.test(t)) {
      hits.push({ title: rule.title, fix: rule.fix });
      if (hits.length >= 3) break;
    }
  }
  return hits;
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
const ERROR_LINE_RE = /##\[error\]|ERROR|Error:|Traceback|Exception|FAILED|fatal:/;
const EXCERPT_CAP = 12000;

export function extractFailure(logText) {
  const lines = (logText || '').split(/\r?\n/).map(l => l.replace(TIMESTAMP_RE, ''));
  // LAST ##[error]: a continue-on-error step (e.g. the OA PDF fetch) can emit an
  // earlier, non-fatal ##[error]; the step that actually failed the job reports last.
  const errIdx = lines.findLastIndex(l => l.includes('##[error]'));

  let excerptLines;
  if (errIdx === -1) {
    excerptLines = lines.slice(Math.max(0, lines.length - 80));
  } else {
    const start = Math.max(0, errIdx - 60);
    const end = Math.min(lines.length, errIdx + 3 + 1);
    excerptLines = lines.slice(start, end);
  }

  let excerpt = excerptLines.join('\n');
  if (excerpt.length > EXCERPT_CAP) excerpt = excerpt.slice(0, EXCERPT_CAP);

  // Error lines from the failing window only (whole-log matches are mostly pip/setup noise).
  const errorLines = excerptLines.filter(l => ERROR_LINE_RE.test(l)).slice(-10);
  return { excerpt, errorLines };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const runId = req.query?.run_id;
  if (!runId || !/^\d+$/.test(String(runId))) {
    return res.status(400).json({ error: 'run_id (digits) is required' });
  }

  const ghToken = process.env.GH_PAT;
  if (!ghToken) {
    return res.status(500).json({ error: 'GH_PAT not configured' });
  }

  const { owner, repo, headers } = repoInfo();
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  try {
    const [runRes, jobsRes] = await Promise.all([
      fetch(`${base}/actions/runs/${runId}`, { headers }),
      fetch(`${base}/actions/runs/${runId}/jobs?per_page=50`, { headers }),
    ]);
    if (!runRes.ok) return res.status(runRes.status).json({ error: 'Failed to fetch run' });
    const runData = await runRes.json();
    const jobsData = jobsRes.ok ? await jobsRes.json() : { jobs: [] };
    const rawJobs = jobsData.jobs || [];

    const run = {
      id: runData.id,
      title: runData.display_title || runData.name,
      name: runData.name,
      status: runData.status,
      conclusion: runData.conclusion,
      html_url: runData.html_url,
      created_at: runData.created_at,
      run_started_at: runData.run_started_at,
      updated_at: runData.updated_at,
    };

    const jobs = rawJobs.map(job => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      html_url: job.html_url,
      steps: (job.steps || []).map(step => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
        started_at: step.started_at,
        completed_at: step.completed_at,
      })),
    }));

    let failure = null;
    const runFailed = run.status === 'completed' &&
      (rawJobs.some(j => j.conclusion === 'failure') ||
       run.conclusion === 'failure' || run.conclusion === 'timed_out');

    if (runFailed) {
      const failedJob = rawJobs.find(j => j.conclusion === 'failure');
      if (failedJob) {
        const failedStep = (failedJob.steps || []).find(s => s.conclusion === 'failure') || null;
        let excerpt = '';
        let errorLines = [];
        try {
          const logsRes = await fetch(`${base}/actions/jobs/${failedJob.id}/logs`, { headers, redirect: 'manual' });
          let logText = '';
          if (logsRes.status >= 300 && logsRes.status < 400) {
            // Pre-signed, third-party log host — never forward the PAT there.
            const location = logsRes.headers.get('location');
            if (location) {
              const followRes = await fetch(location);
              logText = await followRes.text();
            }
          } else if (logsRes.ok) {
            logText = await logsRes.text();
          }
          const extracted = extractFailure(logText);
          excerpt = extracted.excerpt;
          errorLines = extracted.errorLines;
        } catch (_) {
          // log fetch failed — still return the failure block, just empty.
        }
        failure = {
          job: failedJob.name,
          step: failedStep ? failedStep.name : null,
          excerpt,
          errorLines,
          hints: hintsFor(excerpt),
          logUrl: failedJob.html_url,
        };
      }
    }

    return res.status(200).json({ run, jobs, failure });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
