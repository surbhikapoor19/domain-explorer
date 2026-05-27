import crypto from 'crypto';

export const config = {
  api: { bodyParser: { sizeLimit: '100mb' } },
};

async function uploadToLFS(owner, repo, ghToken, fileBuffer) {
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const size = fileBuffer.length;

  const batchRes = await fetch(
    `https://github.com/${owner}/${repo}.git/info/lfs/objects/batch`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${owner}:${ghToken}`).toString('base64')}`,
        'Content-Type': 'application/vnd.git-lfs+json',
        Accept: 'application/vnd.git-lfs+json',
      },
      body: JSON.stringify({
        operation: 'upload',
        transfers: ['basic'],
        objects: [{ oid: sha256, size }],
      }),
    }
  );
  if (!batchRes.ok) {
    const errText = await batchRes.text();
    throw new Error(`LFS batch failed (${batchRes.status}): ${errText.slice(0, 200)}`);
  }
  const batchData = await batchRes.json();
  const obj = batchData.objects[0];

  if (obj.actions?.upload) {
    const uploadUrl = obj.actions.upload.href;
    const uploadHeaders = obj.actions.upload.header || {};
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { ...uploadHeaders, 'Content-Type': 'application/octet-stream' },
      body: fileBuffer,
    });
    if (!putRes.ok) throw new Error(`LFS upload failed: ${putRes.status}`);
  }

  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${size}\n`;
  return pointer;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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

  const { domain, csvContent, csvFilename, pdfUrl, displayName, methodNoun, updateOnly, pdfZipBase64 } = req.body || {};
  if (!domain) {
    return res.status(400).json({ error: 'domain is required' });
  }
  if (!updateOnly && !csvContent) {
    return res.status(400).json({ error: 'csvContent is required for new domains' });
  }

  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'surbhikapoor19';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'domain-explorer';
  const branch = 'main';

  const domainSlug = domain.replace(/_/g, '-');
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  try {
    const filesToCommit = [];
    let lfsPointer = null;
    const zipPath = `datasets/${domainSlug}/papers.zip`;

    if (updateOnly) {
      if (pdfZipBase64) {
        const zipBuffer = Buffer.from(pdfZipBase64, 'base64');
        lfsPointer = await uploadToLFS(GITHUB_OWNER, GITHUB_REPO, ghToken, zipBuffer);
        filesToCommit.push({
          path: zipPath,
          content: Buffer.from(lfsPointer).toString('base64'),
          isLfs: true,
        });
      }
    } else {
      // New domain mode
      const csvPath = `datasets/${domainSlug}/${csvFilename || `${domain}.csv`}`;
      filesToCommit.push({
        path: csvPath,
        content: Buffer.from(csvContent).toString('base64'),
      });

      const yamlContent = buildDomainYaml(domain, csvPath, domainSlug, displayName, methodNoun, pdfUrl);
      filesToCommit.push({
        path: `domains/${domain}.yaml`,
        content: Buffer.from(yamlContent).toString('base64'),
      });
    }

    // Get the current commit SHA for the branch
    const refRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${branch}`,
      { headers }
    );
    if (!refRes.ok) throw new Error(`Failed to get branch ref: ${refRes.status}`);
    const refData = await refRes.json();
    const baseSha = refData.object.sha;

    // Get the base tree
    const commitRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${baseSha}`,
      { headers }
    );
    if (!commitRes.ok) throw new Error(`Failed to get commit: ${commitRes.status}`);
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    // Create blobs for each file
    const treeItems = [];
    for (const file of filesToCommit) {
      const blobRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: file.content, encoding: 'base64' }),
        }
      );
      if (!blobRes.ok) throw new Error(`Failed to create blob for ${file.path}: ${blobRes.status}`);
      const blobData = await blobRes.json();
      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha,
      });
    }

    // Create a new tree
    const treeRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
      }
    );
    if (!treeRes.ok) throw new Error(`Failed to create tree: ${treeRes.status}`);
    const treeData = await treeRes.json();

    // Create a commit
    const newCommitRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: `${updateOnly ? 'Update' : 'Add'} domain: ${displayName || domain}\n\nUploaded via admin panel`,
          tree: treeData.sha,
          parents: [baseSha],
        }),
      }
    );
    if (!newCommitRes.ok) throw new Error(`Failed to create commit: ${newCommitRes.status}`);
    const newCommitData = await newCommitRes.json();

    // Update branch ref
    const updateRefRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ sha: newCommitData.sha }),
      }
    );
    if (!updateRefRes.ok) throw new Error(`Failed to update ref: ${updateRefRes.status}`);

    return res.status(200).json({
      success: true,
      commitSha: newCommitData.sha,
      files: filesToCommit.map(f => f.path),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildDomainYaml(domain, csvPath, domainSlug, displayName, methodNoun, pdfUrl) {
  let yaml = `domain: ${domain}
csv_path: ${csvPath}
papers_dir: datasets/${domainSlug}/papers/
display_name: "${displayName || domain.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}"
method_noun: "${methodNoun || 'method'}"
`;
  if (pdfUrl) {
    yaml += `pdf_url: "${pdfUrl}"\n`;
  }
  yaml += `\n# Column → role mappings will be auto-generated during build.\ncolumns: {}\n`;
  return yaml;
}
