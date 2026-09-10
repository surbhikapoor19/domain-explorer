import crypto from 'crypto';
import { repoInfo, commitChanges } from '../../lib/admin-github.js';

export const config = {
  api: { bodyParser: { sizeLimit: '100mb' } },
};

// Escape a value for a double-quoted YAML scalar (pdf_url etc).
function escapeYamlDoubleQuoted(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Read a top-level `key: value` line, stripping quotes + a trailing comment
// (same regex style as fetch_missing_pdfs.py's _yaml_csv_path).
function yamlValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!m) return null;
  let value = m[1].trim().replace(/^['"]|['"]$/g, '');
  value = value.replace(/\s+#.*$/, '').trim();
  return value || null;
}

function addCsvPathLine(yamlText, csvPath) {
  const line = `csv_path: ${csvPath}`;
  if (/^domain:.*$/m.test(yamlText)) {
    return yamlText.replace(/^(domain:.*)$/m, `$1\n${line}`);
  }
  return `${line}\n${yamlText}`;
}

function setPdfUrlLine(yamlText, pdfUrl) {
  const line = `pdf_url: "${escapeYamlDoubleQuoted(pdfUrl)}"`;
  if (/^pdf_url:.*$/m.test(yamlText)) {
    return yamlText.replace(/^pdf_url:.*$/m, line);
  }
  if (/^papers_dir:.*$/m.test(yamlText)) {
    return yamlText.replace(/^(papers_dir:.*)$/m, `$1\n${line}`);
  }
  return yamlText.replace(/\n?$/, `\n${line}\n`);
}

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
  const obj = (batchData.objects || [])[0] || {};
  // Per-object errors (quota, permissions) come back inside a 200 batch response.
  if (obj.error) {
    throw new Error(`LFS rejected the PDF zip (${obj.error.code}): ${obj.error.message}`);
  }

  if (obj.actions?.upload) {
    const uploadUrl = obj.actions.upload.href;
    const uploadHeaders = obj.actions.upload.header || {};
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { ...uploadHeaders, 'Content-Type': 'application/octet-stream' },
      body: fileBuffer,
    });
    if (!putRes.ok) throw new Error(`LFS upload failed: ${putRes.status}`);
    // GitHub only makes the object downloadable after the verify call; skipping it
    // left a pointer to a missing object and the build's `git lfs pull` 404'd.
    if (obj.actions.verify) {
      const verifyRes = await fetch(obj.actions.verify.href, {
        method: 'POST',
        headers: {
          ...(obj.actions.verify.header || {}),
          'Content-Type': 'application/vnd.git-lfs+json',
          Accept: 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({ oid: sha256, size }),
      });
      if (!verifyRes.ok) throw new Error(`LFS verify failed: ${verifyRes.status}`);
    }
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

  // Trim: an env value pasted with a trailing newline still works for Bearer headers (fetch strips
  // it) but corrupts the base64 Basic credentials the LFS upload uses -> "Bad credentials".
  const ghToken = (process.env.GH_PAT || '').trim();
  if (!ghToken) {
    return res.status(500).json({ error: 'GH_PAT not configured' });
  }

  const { domain, csvContent, csvFilename, pdfUrl, displayName, methodNoun, updateOnly, pdfZipBase64, yamlConfig, benchmarkConfig } = req.body || {};
  if (!domain) {
    return res.status(400).json({ error: 'domain is required' });
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(domain)) {
    return res.status(400).json({ error: 'Domain id may only use lowercase letters, digits, _ and -' });
  }
  if (!updateOnly && !csvContent) {
    return res.status(400).json({ error: 'csvContent is required for new domains' });
  }

  const { owner: GITHUB_OWNER, repo: GITHUB_REPO, headers } = repoInfo();
  const domainSlug = domain.replace(/_/g, '-');

  try {
    const filesToCommit = [];
    let lfsPointer = null;
    const zipPath = `datasets/${domainSlug}/papers.zip`;
    let message;

    if (updateOnly) {
      // Read the existing YAML so csv_path/pdf_url edits land in place.
      const contentsRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/domains/${domain}.yaml?ref=main`,
        { headers }
      );
      if (contentsRes.status === 404) {
        return res.status(404).json({ error: `Domain ${domain} not found` });
      }
      if (!contentsRes.ok) throw new Error(`Failed to fetch domain YAML: ${contentsRes.status}`);
      const contentsData = await contentsRes.json();
      let yamlText = Buffer.from(contentsData.content, 'base64').toString('utf8');
      let yamlModified = false;

      if (!csvContent && !pdfUrl && !pdfZipBase64) {
        return res.status(400).json({ error: 'Provide csvContent, pdfUrl, or pdfZipBase64 to update' });
      }

      if (csvContent) {
        let csvPath = yamlValue(yamlText, 'csv_path');
        if (!csvPath) {
          csvPath = `datasets/${domainSlug}/${csvFilename || `${domain}.csv`}`;
          yamlText = addCsvPathLine(yamlText, csvPath);
          yamlModified = true;
        }
        filesToCommit.push({ path: csvPath, content: Buffer.from(csvContent).toString('base64') });
      }

      if (pdfUrl) {
        yamlText = setPdfUrlLine(yamlText, pdfUrl);
        yamlModified = true;
      }

      if (pdfZipBase64) {
        const zipBuffer = Buffer.from(pdfZipBase64, 'base64');
        lfsPointer = await uploadToLFS(GITHUB_OWNER, GITHUB_REPO, ghToken, zipBuffer);
        filesToCommit.push({
          path: zipPath,
          content: Buffer.from(lfsPointer).toString('base64'),
          isLfs: true,
        });
      }

      if (yamlModified) {
        filesToCommit.push({
          path: `domains/${domain}.yaml`,
          content: Buffer.from(yamlText).toString('base64'),
        });
      }

      message = `Update domain: ${domain}`;
    } else {
      // New domain mode. Never overwrite an existing domain's config (e.g. re-using
      // "grasp_planning") — updates go through updateOnly.
      const existsRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/domains/${domain}.yaml?ref=main`,
        { headers }
      );
      if (existsRes.ok) {
        return res.status(409).json({ error: `A domain called ${domain} already exists. Pick another id, or use Update data on its card.` });
      }
      const csvPath = `datasets/${domainSlug}/${csvFilename || `${domain}.csv`}`;
      filesToCommit.push({
        path: csvPath,
        content: Buffer.from(csvContent).toString('base64'),
      });

      if (pdfZipBase64) {
        const zipBuffer = Buffer.from(pdfZipBase64, 'base64');
        lfsPointer = await uploadToLFS(GITHUB_OWNER, GITHUB_REPO, ghToken, zipBuffer);
        filesToCommit.push({
          path: zipPath,
          content: Buffer.from(lfsPointer).toString('base64'),
          isLfs: true,
        });
      }

      const yamlContent = yamlConfig
        ? buildFullYaml(domain, csvPath, domainSlug, pdfUrl, yamlConfig)
        : buildDomainYaml(domain, csvPath, domainSlug, displayName, methodNoun, pdfUrl);
      filesToCommit.push({
        path: `domains/${domain}.yaml`,
        content: Buffer.from(yamlContent).toString('base64'),
      });

      // Benchmark extraction config (metrics/conditions/datasets the copilot and
      // benchmark pages depend on). Hand-authored before; now optionally provided
      // from the admin panel and committed to the path the build reads.
      if (benchmarkConfig && Array.isArray(benchmarkConfig.metrics) && benchmarkConfig.metrics.length) {
        filesToCommit.push({
          path: `dashboard/scripts/precompute/benchmarks/config/${domain}.json`,
          content: Buffer.from(JSON.stringify(benchmarkConfig, null, 2)).toString('base64'),
        });
      }

      message = `Add domain: ${displayName || domain}\n\nUploaded via admin panel`;
    }

    const { commitSha } = await commitChanges({ files: filesToCommit, message });

    return res.status(200).json({
      success: true,
      commitSha,
      files: filesToCommit.map(f => f.path),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildFullYaml(domain, csvPath, domainSlug, pdfUrl, cfg) {
  const lines = [];
  lines.push(`domain: ${domain}`);
  lines.push(`display_name: "${cfg.display_name || domain}"`);
  lines.push(`display_subject: "${cfg.display_subject || ''}"`);
  lines.push(`display_short: "${cfg.display_short || ''}"`);
  lines.push(`ecosystem: "COMPARE Ecosystem"`);
  lines.push(`tagline: "AI-in-the-Loop"`);
  lines.push(`query_hint: '${(cfg.query_hint || '').replace(/'/g, "''")}'`);
  lines.push(`method_noun: "${cfg.method_noun || 'method'}"`);
  lines.push('explorer_enabled: true');
  lines.push('');
  lines.push(`csv_path: ${csvPath}`);
  lines.push(`papers_dir: datasets/${domainSlug}/papers/`);
  if (pdfUrl) lines.push(`pdf_url: "${escapeYamlDoubleQuoted(pdfUrl)}"`);
  // Google Drive folder of CSV exports — the nightly sheet-poll workflow pulls the
  // newest CSV from here and rebuilds this domain when it changes.
  if (cfg.drive_folder) lines.push(`drive_folder: "${String(cfg.drive_folder).replace(/"/g, '\\"')}"`);
  lines.push('');
  lines.push('columns:');
  for (const [col, mapping] of Object.entries(cfg.columns || {})) {
    if (mapping && mapping.role) {
      const parts = [`role: ${mapping.role}`];
      if (mapping.facet) parts.push(`facet: ${mapping.facet}`);
      if (mapping.alias_short) parts.push(`alias_short: "${mapping.alias_short}"`);
      lines.push(`  "${col}": { ${parts.join(', ')} }`);
    }
  }
  lines.push('');
  lines.push('llm:');
  lines.push(`  domain_subject: "${cfg.llm?.domain_subject || ''}"`);
  if (cfg.llm?.claim_extraction_focus?.length) {
    lines.push('  claim_extraction_focus:');
    for (const item of cfg.llm.claim_extraction_focus) {
      if (item) lines.push(`    - "${item}"`);
    }
  }
  if (cfg.llm?.query_rewrite_examples?.length) {
    lines.push('  query_rewrite_examples:');
    for (const item of cfg.llm.query_rewrite_examples) {
      if (item) lines.push(`    - "${item}"`);
    }
  }
  lines.push('');
  if (cfg.default_color_by_roles?.length) {
    lines.push('default_color_by_roles:');
    for (const r of cfg.default_color_by_roles) lines.push(`  - ${r}`);
  }
  if (cfg.extra_datasets?.length) {
    lines.push('');
    lines.push('extra_datasets:');
    for (const d of cfg.extra_datasets) lines.push(`  - "${d}"`);
  }
  if (cfg.extra_keywords?.length) {
    lines.push('');
    lines.push('extra_keywords:');
    for (const k of cfg.extra_keywords) lines.push(`  - "${k}"`);
  }
  // KG entity-normalization aliases (technique / hardware / problem). Keys + values
  // are quoted so YAML-special tokens ("rrt*", "moveit!") round-trip cleanly. Read
  // by ingest_domain.py step_kg -> build_knowledge_graph(domain_config=...).
  const ka = cfg.kg_aliases || {};
  const aliasCats = ['technique', 'hardware', 'problem'].filter(c => ka[c] && Object.keys(ka[c]).length);
  if (aliasCats.length) {
    lines.push('');
    lines.push('kg_aliases:');
    for (const cat of aliasCats) {
      lines.push(`  ${cat}:`);
      for (const [alias, canonical] of Object.entries(ka[cat])) {
        const k = String(alias).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const v = String(canonical).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`    "${k}": "${v}"`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildDomainYaml(domain, csvPath, domainSlug, displayName, methodNoun, pdfUrl) {
  let yaml = `domain: ${domain}
csv_path: ${csvPath}
papers_dir: datasets/${domainSlug}/papers/
display_name: "${displayName || domain.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}"
method_noun: "${methodNoun || 'method'}"
explorer_enabled: true
`;
  if (pdfUrl) {
    yaml += `pdf_url: "${escapeYamlDoubleQuoted(pdfUrl)}"\n`;
  }
  yaml += `\n# Column → role mappings will be auto-generated during build.\ncolumns: {}\n`;
  return yaml;
}
