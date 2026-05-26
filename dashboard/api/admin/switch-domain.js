export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { domain } = req.body || {};
  if (!domain) {
    return res.status(400).json({ error: 'domain is required' });
  }

  const ghToken = process.env.GH_PAT;
  if (!ghToken) {
    return res.status(500).json({ error: 'GH_PAT not configured' });
  }

  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'surbhikapoor19';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'domain-explorer';

  try {
    // Trigger a domain-switch workflow that copies precomputed data
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_type: 'domain-switch',
          client_payload: { domain },
        }),
      }
    );

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text();
      return res.status(dispatchRes.status).json({
        error: `GitHub dispatch failed: ${dispatchRes.status}`,
        detail: errText,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Domain switch to ${domain} triggered. Vercel will redeploy with the new data.`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
