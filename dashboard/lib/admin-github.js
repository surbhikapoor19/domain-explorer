// Shared GitHub helpers for the admin API (dashboard/api/admin/*.js). Lives outside
// api/ so Vercel doesn't turn it into a route.

// Core domains ship in this repo and are never deletable from the admin panel.
export const PROTECTED_DOMAINS = ['grasp_planning', 'motion_planning'];

export function isProtected(domain) {
  const normalized = String(domain || '').replace(/-/g, '_');
  return PROTECTED_DOMAINS.includes(normalized);
}

export function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

export function repoInfo() {
  const owner = process.env.GITHUB_OWNER || 'surbhikapoor19';
  const repo = process.env.GITHUB_REPO || 'domain-explorer';
  return { owner, repo, headers: ghHeaders(process.env.GH_PAT) };
}

const MAX_ATTEMPTS = 3;

/**
 * Commit a set of file writes/deletions to `main` via the Git Data API, retrying
 * from the ref when a concurrent push moves the branch (PATCH 409/422). Never
 * force-pushes.
 *
 * @param {Object} opts
 * @param {Array<{path:string, content:string}>} [opts.files] - base64 content, like upload.js's blobs.
 * @param {string[]} [opts.deletions] - paths to delete (used when buildDeletions is not given).
 * @param {string} opts.message - commit message.
 * @param {(baseTreeSha:string)=>Promise<string[]>} [opts.buildDeletions] - recompute deletion
 *   paths against the fresh tree on each attempt (used by delete-domain.js).
 * @returns {Promise<{commitSha:string}>}
 */
export async function commitChanges({ files = [], deletions = [], message, buildDeletions } = {}) {
  const { owner, repo, headers } = repoInfo();
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const branch = 'main';

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const refRes = await fetch(`${base}/git/ref/heads/${branch}`, { headers });
    if (!refRes.ok) throw new Error(`Failed to get branch ref: ${refRes.status}`);
    const refData = await refRes.json();
    const baseSha = refData.object.sha;

    const commitRes = await fetch(`${base}/git/commits/${baseSha}`, { headers });
    if (!commitRes.ok) throw new Error(`Failed to get commit: ${commitRes.status}`);
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    const deletionPaths = buildDeletions ? await buildDeletions(baseTreeSha) : deletions;
    const deletionItems = (deletionPaths || []).map(path => ({
      path, mode: '100644', type: 'blob', sha: null,
    }));

    const treeItems = [];
    for (const file of files) {
      const blobRes = await fetch(`${base}/git/blobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: file.content, encoding: 'base64' }),
      });
      if (!blobRes.ok) throw new Error(`Failed to create blob for ${file.path}: ${blobRes.status}`);
      const blobData = await blobRes.json();
      treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blobData.sha });
    }

    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: [...treeItems, ...deletionItems] }),
    });
    if (!treeRes.ok) throw new Error(`Failed to create tree: ${treeRes.status}`);
    const treeData = await treeRes.json();

    const newCommitRes = await fetch(`${base}/git/commits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, tree: treeData.sha, parents: [baseSha] }),
    });
    if (!newCommitRes.ok) throw new Error(`Failed to create commit: ${newCommitRes.status}`);
    const newCommitData = await newCommitRes.json();

    // Never force: if the branch moved (409/422), start over from a fresh ref.
    const patchRes = await fetch(`${base}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: newCommitData.sha }),
    });
    if (patchRes.ok) {
      return { commitSha: newCommitData.sha };
    }
    if (patchRes.status === 409 || patchRes.status === 422) {
      lastError = new Error(`Branch moved concurrently (attempt ${attempt}/${MAX_ATTEMPTS}): ${patchRes.status}`);
      continue;
    }
    throw new Error(`Failed to update ref: ${patchRes.status}`);
  }
  throw lastError || new Error(`Failed to update ref after ${MAX_ATTEMPTS} attempts (concurrent pushes)`);
}
