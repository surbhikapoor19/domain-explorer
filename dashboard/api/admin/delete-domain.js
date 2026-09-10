import { repoInfo, isProtected, commitChanges } from '../../lib/admin-github.js';

const DOMAIN_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Every path this domain owns in the repo (blobs only, prefix-boundary safe so
// e.g. `datasets/test-domain-2/...` survives deleting `test-domain`).
function pathsForDomain(tree, domain, slug) {
  const domainUs = domain.replace(/-/g, '_');
  const yamlBlob = tree.find(t => t.type === 'blob' &&
    (t.path === `domains/${domainUs}.yaml` || t.path === `domains/${domainUs}.yml`));
  if (!yamlBlob) return null; // domain not found

  const paths = [];
  for (const t of tree) {
    if (t.type !== 'blob') continue;
    if (t.path === `domains/${domainUs}.yaml` || t.path === `domains/${domainUs}.yml`) {
      paths.push(t.path);
    } else if (t.path.startsWith(`datasets/${slug}/`)) {
      paths.push(t.path);
    } else if (t.path.startsWith(`dashboard/public/data-${slug}/`)) {
      paths.push(t.path);
    } else if (t.path === `dashboard/scripts/precompute/benchmarks/config/${domainUs}.json`) {
      paths.push(t.path);
    }
  }
  return paths;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ghToken = (process.env.GH_PAT || '').trim();
  if (!ghToken) {
    return res.status(500).json({ error: 'GH_PAT not configured' });
  }

  const { domain, confirm } = req.body || {};
  if (!domain || !DOMAIN_RE.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain name' });
  }
  if (confirm !== domain) {
    return res.status(400).json({ error: 'Typed confirmation does not match the domain' });
  }
  if (isProtected(domain)) {
    return res.status(403).json({ error: `${domain} is a core domain and can't be deleted from the admin` });
  }

  const { owner, repo, headers } = repoInfo();
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const slug = domain.replace(/_/g, '-');

  async function fetchTree(treeSha) {
    const treeRes = await fetch(`${base}/git/trees/${treeSha}?recursive=1`, { headers });
    if (!treeRes.ok) throw new Error(`Failed to get tree: ${treeRes.status}`);
    const treeData = await treeRes.json();
    if (treeData.truncated) {
      throw new Error('Repo tree is truncated — too large to safely delete a domain from the admin');
    }
    return treeData.tree;
  }

  try {
    // Resolve the current base tree sha up front, purely to check the domain
    // exists before touching anything (404 must never write).
    const refRes = await fetch(`${base}/git/ref/heads/main`, { headers });
    if (!refRes.ok) throw new Error(`Failed to get branch ref: ${refRes.status}`);
    const refData = await refRes.json();
    const commitRes = await fetch(`${base}/git/commits/${refData.object.sha}`, { headers });
    if (!commitRes.ok) throw new Error(`Failed to get commit: ${commitRes.status}`);
    const commitData = await commitRes.json();

    const initialTree = await fetchTree(commitData.tree.sha);
    const initialPaths = pathsForDomain(initialTree, domain, slug);
    if (!initialPaths) {
      return res.status(404).json({ error: `Domain ${domain} not found` });
    }

    let removedPaths = initialPaths;
    const { commitSha } = await commitChanges({
      message: `Remove domain: ${domain}\n\nDeleted via admin panel`,
      // Recompute against the fresh tree on every retry attempt (a concurrent
      // push could have moved main between attempts).
      buildDeletions: async (baseTreeSha) => {
        const tree = await fetchTree(baseTreeSha);
        const paths = pathsForDomain(tree, domain, slug) || [];
        removedPaths = paths;
        return paths;
      },
    });

    // Best-effort: clear this domain's pipeline caches. Never fails the request.
    let cachesCleared = 0;
    try {
      const cachesRes = await fetch(
        `${base}/actions/caches?key=pipeline-cache-${slug}-&per_page=100`, { headers });
      if (cachesRes.ok) {
        const cachesData = await cachesRes.json();
        const keyRe = new RegExp(`^pipeline-cache-${slug}-\\d+$`);
        for (const c of cachesData.actions_caches || []) {
          if (!keyRe.test(c.key)) continue;
          const delRes = await fetch(`${base}/actions/caches/${c.id}`, { method: 'DELETE', headers });
          if (delRes.ok) cachesCleared++;
        }
      }
    } catch (_) { /* cache cleanup is best-effort */ }

    return res.status(200).json({ success: true, commitSha, removed: removedPaths, cachesCleared });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
