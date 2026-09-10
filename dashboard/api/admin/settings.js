import { repoInfo } from '../../lib/admin-github.js';

// Maintainer contact shown on the admin's "Ask for help" panel, stored the
// same way as the DRIVE_STATUS_* variables: a plain GitHub Actions repo
// variable (GET/PATCH, POST to create on first write).
const VARIABLE_NAME = 'ADMIN_MAINTAINER_EMAIL';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { owner, repo, headers } = repoInfo();
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/variables`;

  try {
    if (req.method === 'GET') {
      const getRes = await fetch(`${base}/${VARIABLE_NAME}`, { headers });
      if (getRes.status === 404) return res.status(200).json({ maintainerEmail: null });
      if (!getRes.ok) throw new Error(`Failed to read ${VARIABLE_NAME}: ${getRes.status}`);
      const data = await getRes.json();
      return res.status(200).json({ maintainerEmail: data.value || null });
    }

    if (req.method === 'POST') {
      const maintainerEmail = String((req.body || {}).maintainerEmail || '').trim();
      if (!EMAIL_RE.test(maintainerEmail)) {
        return res.status(400).json({ error: 'Provide a valid email address' });
      }

      const getRes = await fetch(`${base}/${VARIABLE_NAME}`, { headers });
      const body = { name: VARIABLE_NAME, value: maintainerEmail };
      if (getRes.status === 404) {
        const createRes = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!createRes.ok) throw new Error(`Failed to create ${VARIABLE_NAME}: ${createRes.status}`);
      } else {
        if (!getRes.ok) throw new Error(`Failed to read ${VARIABLE_NAME}: ${getRes.status}`);
        const patchRes = await fetch(`${base}/${VARIABLE_NAME}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
        if (!patchRes.ok) throw new Error(`Failed to update ${VARIABLE_NAME}: ${patchRes.status}`);
      }

      return res.status(200).json({ success: true, maintainerEmail });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
