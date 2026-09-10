import sodium from 'libsodium-wrappers';
import { repoInfo } from '../../lib/admin-github.js';

// Allowlist of AI-provider secrets settable from the admin panel, plus UI metadata.
// GH_PAT / ADMIN_TOKEN are deliberately NOT here — they aren't settable this way.
export const PROVIDERS = {
  GEMINI_API_KEY: {
    label: 'Google Gemini', provider: 'gemini',
    usedFor: 'Build pipeline (table/figure reading) + chat copilot',
    getUrl: 'https://aistudio.google.com/app/apikey',
  },
  GEMINI_API_KEY_2: {
    label: 'Google Gemini (backup)', provider: 'gemini',
    usedFor: 'Backup when the main Gemini key hits its daily limit',
    getUrl: 'https://aistudio.google.com/app/apikey',
  },
  GROQ_API_KEY: {
    label: 'Groq', provider: 'groq',
    usedFor: 'Build pipeline (text extraction) + chat fallback + setup assistant fallback',
    getUrl: 'https://console.groq.com/keys',
  },
  HF_TOKEN: {
    label: 'Hugging Face', provider: 'hf',
    usedFor: 'Setup assistant (AI config proposal) + vision fallback',
    getUrl: 'https://huggingface.co/settings/tokens',
  },
};

const VALIDATE_TIMEOUT_MS = 15000;

// Each validator makes a cheap authenticated call and returns the raw Response
// so the caller can branch on status without the key ever landing in a URL.
const VALIDATORS = {
  gemini: (value, signal) => fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': value }, signal,
  }),
  groq: (value, signal) => fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${value}` }, signal,
  }),
  hf: (value, signal) => fetch('https://huggingface.co/api/whoami-v2', {
    headers: { Authorization: `Bearer ${value}` }, signal,
  }),
};

async function handleGet(req, res, base, headers, ghToken) {
  const secretsRes = await fetch(`${base}/actions/secrets?per_page=100`, { headers });
  const secretsByName = {};
  if (secretsRes.ok) {
    const data = await secretsRes.json();
    for (const s of data.secrets || []) secretsByName[s.name] = s;
  }

  let login = null, scopes = [], expiresAt = null;
  try {
    const userRes = await fetch('https://api.github.com/user', { headers });
    if (userRes.ok) {
      const body = await userRes.json();
      login = body.login;
      const scopesHeader = userRes.headers.get('x-oauth-scopes');
      scopes = scopesHeader ? scopesHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
      expiresAt = userRes.headers.get('github-authentication-token-expiration') || null;
    }
  } catch (_) { /* GH_PAT metadata is best-effort */ }

  const providers = Object.entries(PROVIDERS).map(([name, meta]) => {
    const secret = secretsByName[name];
    return {
      name,
      label: meta.label,
      usedFor: meta.usedFor,
      getUrl: meta.getUrl,
      inGitHub: !!secret,
      githubUpdatedAt: secret ? secret.updated_at : null,
      // The setup assistant also accepts HF_API_TOKEN on Vercel (propose-yaml.js).
      inVercel: !!process.env[name] || (name === 'HF_TOKEN' && !!process.env.HF_API_TOKEN),
    };
  });

  return res.status(200).json({
    providers,
    ghPat: { present: !!ghToken, login, scopes, expiresAt, inGitHub: !!secretsByName.GH_PAT },
    // Surfaced so a PAT/permission problem isn't misread as "no keys set".
    secretsError: secretsRes.ok ? null : `GitHub returned ${secretsRes.status} when listing secrets`,
    adminTokenSet: true,
  });
}

async function handlePost(req, res, base, headers, ghToken) {
  const { name, value: rawValue, skipValidation } = req.body || {};
  const meta = PROVIDERS[name];
  if (!meta) return res.status(400).json({ error: 'Unknown key name' });

  const value = String(rawValue ?? '').trim();
  if (!value || value.length > 1000 || /\s/.test(value)) {
    return res.status(400).json({ error: 'Invalid key value' });
  }

  let validated = false;
  let warning;
  if (!skipValidation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
    try {
      const vRes = await VALIDATORS[meta.provider](value, controller.signal);
      if (vRes.status === 429) {
        validated = true;
        warning = 'Provider is rate-limiting this key right now — saved anyway; it will work once the limit resets.';
      } else if (vRes.status >= 200 && vRes.status < 300) {
        validated = true;
      } else if (vRes.status === 400 || vRes.status === 401 || vRes.status === 403) {
        const text = await vRes.text().catch(() => '');
        let msg = text;
        try {
          const j = JSON.parse(text);
          msg = (j.error && (j.error.message || j.error)) || j.message || text;
        } catch (_) { /* not JSON — use the raw text */ }
        return res.status(422).json({ error: `${meta.label} rejected this key: ${String(msg).slice(0, 200)}` });
      } else {
        return res.status(502).json({ error: `Couldn't reach ${meta.label} to verify the key. Try again, or save without verification.` });
      }
    } catch (_) {
      return res.status(502).json({ error: `Couldn't reach ${meta.label} to verify the key. Try again, or save without verification.` });
    } finally {
      clearTimeout(timer);
    }
  }

  if (!ghToken) return res.status(500).json({ error: 'GH_PAT not configured' });

  try {
    const pkRes = await fetch(`${base}/actions/secrets/public-key`, { headers });
    if (!pkRes.ok) throw new Error(`Failed to get repo public key: ${pkRes.status}`);
    const { key_id, key } = await pkRes.json();

    await sodium.ready;
    const sealed = sodium.crypto_box_seal(value, sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
    const encrypted_value = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

    const putRes = await fetch(`${base}/actions/secrets/${name}`, {
      method: 'PUT', headers, body: JSON.stringify({ encrypted_value, key_id }),
    });
    if (putRes.status !== 201 && putRes.status !== 204) {
      throw new Error(`Failed to save secret: ${putRes.status}`);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({
    success: true,
    name,
    validated,
    ...(warning ? { warning } : {}),
    note: 'Saved as an encrypted GitHub Actions secret — used from the next build. The chat copilot on the website reads its own copy from Vercel environment variables.',
  });
}

export default async function handler(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { owner, repo, headers } = repoInfo();
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const ghToken = (process.env.GH_PAT || '').trim();

  try {
    if (req.method === 'GET') return await handleGet(req, res, base, headers, ghToken);
    if (req.method === 'POST') return await handlePost(req, res, base, headers, ghToken);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
