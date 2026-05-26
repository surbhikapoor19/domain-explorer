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

  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'surbhikapoor19';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'domain-explorer';
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?event=repository_dispatch&per_page=5`,
      { headers }
    );

    if (!runsRes.ok) {
      return res.status(runsRes.status).json({ error: 'Failed to fetch build status' });
    }

    const data = await runsRes.json();
    const runs = await Promise.all((data.workflow_runs || []).map(async (run) => {
      const result = {
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
        updated_at: run.updated_at,
        html_url: run.html_url,
        name: run.name,
      };

      if (run.status === 'in_progress' || run.status === 'queued') {
        try {
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
        } catch (_) {}
      }

      return result;
    }));

    return res.status(200).json({ runs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
