import { isProtected } from '../../lib/admin-github.js';

// Read a top-level `key: value` line, stripping surrounding quotes and a
// trailing `# comment` (same regex style as fetch_missing_pdfs.py's _yaml_csv_path).
function yamlValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!m) return '';
  let value = m[1].trim().replace(/^['"]|['"]$/g, '');
  value = value.replace(/\s+#.*$/, '').trim();
  return value;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'surbhikapoor19';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'domain-explorer';
  const ghToken = (process.env.GH_PAT || '').trim();

  try {
    const ghHeaders = ghToken
      ? { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' }
      : { Accept: 'application/vnd.github.v3+json' };
    const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

    // Pin every read to main's current commit. The branch listing and raw.githubusercontent
    // URLs are cached for minutes, so a domain the admin just deleted (or created) kept
    // showing stale; SHA-pinned listings return SHA-pinned download URLs.
    let ref = 'main';
    try {
      const refRes = await fetch(`${base}/git/ref/heads/main`, { headers: ghHeaders });
      if (refRes.ok) ref = (await refRes.json()).object.sha;
    } catch (_) { /* fall back to the branch name */ }

    const domainsRes = await fetch(`${base}/contents/domains?ref=${ref}`, { headers: ghHeaders });
    if (!domainsRes.ok) {
      // Surface it: an empty list here used to read as "no domains" when the token had expired.
      return res.status(502).json({ error: `GitHub returned ${domainsRes.status} while listing domains — check the GitHub token under Settings.` });
    }

    const files = await domainsRes.json();
    const yamlFiles = files.filter(f => f.name.endsWith('.yaml') || f.name.endsWith('.yml'));

    const domains = [];
    for (const f of yamlFiles) {
      const slug = f.name.replace(/\.(yaml|yml)$/, '');
      const slugDashed = slug.replace(/_/g, '-');
      const contentRes = await fetch(f.download_url);
      const yamlText = await contentRes.text();
      const displayName = yamlText.match(/display_name:\s*["']?([^"'\n]+)/)?.[1] || slug;
      const methodNoun = yamlText.match(/method_noun:\s*["']?([^"'\n]+)/)?.[1] || 'method';
      const csvPath = yamlText.match(/csv_path:\s*["']?([^"'\n]+)/)?.[1] || '';
      const pdfUrl = yamlValue(yamlText, 'pdf_url');
      const driveFolder = yamlValue(yamlText, 'drive_folder');
      const explorerEnabled = yamlValue(yamlText, 'explorer_enabled') === 'true';

      let hasData = false;
      let hasKG = false;
      let methodCount = 0;

      try {
        const dataRes = await fetch(
          `${base}/contents/dashboard/public/data-${slugDashed}?ref=${ref}`,
          { headers: ghHeaders }
        );
        if (dataRes.ok) {
          const dataFiles = await dataRes.json();
          const methods = dataFiles.find(df => df.name === 'methods.json');
          const kgFull = dataFiles.find(df => df.name === 'kg-full.json');
          hasData = !!methods && methods.size > 10;
          hasKG = !!kgFull && kgFull.size > 100;

          if (methods && methods.size > 10) {
            try {
              const mRes = await fetch(methods.download_url);
              const mData = await mRes.json();
              methodCount = Array.isArray(mData) ? mData.length : 0;
            } catch (_) {}
          }
        }
      } catch (_) {}

      domains.push({
        slug,
        displayName: displayName.trim(),
        methodNoun: methodNoun.trim(),
        csvPath: csvPath.trim(),
        yamlFile: f.name,
        hasData,
        hasKG,
        methodCount,
        protected: isProtected(slug),
        pdfUrl,
        driveFolder,
        explorerEnabled,
      });
    }

    return res.status(200).json({ domains });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
