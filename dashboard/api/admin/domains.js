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
  const ghToken = process.env.GH_PAT;

  try {
    // List domains from the domains/ directory in the repo
    const domainsRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/domains`,
      {
        headers: ghToken
          ? { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' }
          : { Accept: 'application/vnd.github.v3+json' },
      }
    );

    if (!domainsRes.ok) {
      return res.status(200).json({ domains: [] });
    }

    const files = await domainsRes.json();
    const yamlFiles = files.filter(f => f.name.endsWith('.yaml') || f.name.endsWith('.yml'));

    const ghHeaders = ghToken
      ? { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' }
      : { Accept: 'application/vnd.github.v3+json' };

    const domains = [];
    for (const f of yamlFiles) {
      const slug = f.name.replace(/\.(yaml|yml)$/, '');
      const slugDashed = slug.replace(/_/g, '-');
      const contentRes = await fetch(f.download_url);
      const yamlText = await contentRes.text();
      const displayName = yamlText.match(/display_name:\s*["']?([^"'\n]+)/)?.[1] || slug;
      const methodNoun = yamlText.match(/method_noun:\s*["']?([^"'\n]+)/)?.[1] || 'method';
      const csvPath = yamlText.match(/csv_path:\s*["']?([^"'\n]+)/)?.[1] || '';

      let hasData = false;
      let hasKG = false;
      let methodCount = 0;

      try {
        const dataRes = await fetch(
          `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/dashboard/public/data-${slugDashed}`,
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
      });
    }

    return res.status(200).json({ domains });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
