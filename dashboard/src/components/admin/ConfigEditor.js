import React, { useState } from 'react';

// Role/facet mapping editor + KG-alias / benchmark JSON editors + the YAML preview
// generator. Moved out of AdminPage.js verbatim (logic unchanged) — only the CSS
// class names picked up the admin- prefix so they can share the redesigned styles.

const ROLE_OPTIONS = [
  'identity.name', 'identity.description', 'identity.citation', 'identity.year', 'identity.code',
  'method.family', 'method.backbone', 'method.middleware', 'method.ik_controller',
  'train.regime', 'train.simulator',
  'input.modality', 'input.sensor',
  'output.shape',
  'hardware.platform',
  'env.context',
  'eval.benchmark', 'eval.metric',
  'meta.language', 'meta.license', 'meta.maintainer',
];

const FACET_OPTIONS = ['categorical', 'numeric', 'text', 'url', 'identifier'];

export { ROLE_OPTIONS, FACET_OPTIONS };

export function ConfigEditor({ config, onChange, csvHeaders }) {
  const update = (key, value) => onChange({ ...config, [key]: value });

  const updateColumn = (colName, field, value) => {
    const cols = { ...config.columns };
    cols[colName] = { ...cols[colName], [field]: value };
    update('columns', cols);
  };

  const updateLlm = (key, value) => {
    update('llm', { ...config.llm, [key]: value });
  };

  const updateListItem = (listKey, idx, value) => {
    const arr = [...(config.llm?.[listKey] || [])];
    arr[idx] = value;
    updateLlm(listKey, arr);
  };

  // Tolerant JSON editing for the nested KG-alias / benchmark blocks: keep the raw
  // text locally, only commit to editedConfig when it parses, surface an inline
  // error otherwise (so a half-typed object never corrupts the config).
  const [rawJson, setRawJson] = useState({});
  const [jsonErr, setJsonErr] = useState({});
  const commitJson = (stateKey, raw, apply, clear) => {
    setRawJson(p => ({ ...p, [stateKey]: raw }));
    if (!raw.trim()) { clear(); setJsonErr(p => ({ ...p, [stateKey]: null })); return; }
    try { apply(JSON.parse(raw)); setJsonErr(p => ({ ...p, [stateKey]: null })); }
    catch (e) { setJsonErr(p => ({ ...p, [stateKey]: e.message })); }
  };
  const updateKgAlias = (cat, raw) => commitJson(`kg.${cat}`, raw,
    parsed => update('kg_aliases', { ...(config.kg_aliases || {}), [cat]: parsed }),
    () => { const ka = { ...(config.kg_aliases || {}) }; delete ka[cat]; update('kg_aliases', ka); });
  const kgValue = (cat) => rawJson[`kg.${cat}`] !== undefined ? rawJson[`kg.${cat}`]
    : (config.kg_aliases?.[cat] ? JSON.stringify(config.kg_aliases[cat], null, 2) : '');
  const updateBenchmarks = (raw) => commitJson('benchmarks', raw,
    parsed => update('benchmarks', parsed), () => update('benchmarks', undefined));
  const benchValue = () => rawJson.benchmarks !== undefined ? rawJson.benchmarks
    : (config.benchmarks ? JSON.stringify(config.benchmarks, null, 2) : '');
  const taStyle = { width: '100%', fontFamily: 'monospace', fontSize: '0.82em' };
  const errStyle = { color: '#c0392b', fontSize: '0.8em', display: 'block', marginTop: 2 };

  return (
    <div className="admin-config-editor">
      <div className="admin-config-section">
        <h4>Identity</h4>
        <div className="admin-config-row">
          <label>Display Name</label>
          <input type="text" value={config.display_name || ''} onChange={e => update('display_name', e.target.value)} />
        </div>
        <div className="admin-config-row">
          <label>Subject (plural)</label>
          <input type="text" value={config.display_subject || ''} onChange={e => update('display_subject', e.target.value)} placeholder="e.g., motion planning algorithms" />
        </div>
        <div className="admin-config-row">
          <label>Short Name</label>
          <input type="text" value={config.display_short || ''} onChange={e => update('display_short', e.target.value)} placeholder="e.g., motion planning" />
        </div>
        <div className="admin-config-row">
          <label>Method Noun</label>
          <input type="text" value={config.method_noun || ''} onChange={e => update('method_noun', e.target.value)} placeholder="method, algorithm, technique" />
        </div>
        <div className="admin-config-row">
          <label>Search Hint</label>
          <input type="text" value={config.query_hint || ''} onChange={e => update('query_hint', e.target.value)} />
        </div>
        <div className="admin-config-row">
          <label>Google Drive folder (optional — nightly CSV auto-sync)</label>
          <input type="url" value={config.drive_folder || ''} onChange={e => update('drive_folder', e.target.value)}
            placeholder="https://drive.google.com/drive/folders/<FOLDER_ID>" />
        </div>
      </div>

      <div className="admin-config-section">
        <h4>Column Mappings</h4>
        <p className="admin-config-hint">Map each CSV column to a semantic role and facet type.</p>
        <div className="admin-column-map-grid">
          <div className="admin-column-map-header">
            <span>CSV Column</span><span>Role</span><span>Facet</span>
          </div>
          {csvHeaders.map(col => {
            const mapping = config.columns?.[col] || {};
            return (
              <div key={col} className="admin-column-map-row">
                <span className="admin-column-map-name" title={col}>{col}</span>
                <select value={mapping.role || ''} onChange={e => updateColumn(col, 'role', e.target.value)}>
                  <option value="">— select role —</option>
                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <select value={mapping.facet || ''} onChange={e => updateColumn(col, 'facet', e.target.value)}>
                  <option value="">— select facet —</option>
                  {FACET_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      <div className="admin-config-section">
        <h4>LLM Prompts</h4>
        <div className="admin-config-row">
          <label>Domain Subject</label>
          <input type="text" value={config.llm?.domain_subject || ''} onChange={e => updateLlm('domain_subject', e.target.value)} placeholder="e.g., robotic motion planning" />
        </div>
        <div className="admin-config-list-section">
          <label>Claim Extraction Focus (what to look for in papers)</label>
          {(config.llm?.claim_extraction_focus || ['', '', '', '']).map((item, i) => (
            <input key={i} type="text" value={item} onChange={e => updateListItem('claim_extraction_focus', i, e.target.value)} placeholder={`Focus area ${i + 1}`} />
          ))}
        </div>
        <div className="admin-config-list-section">
          <label>Example Queries</label>
          {(config.llm?.query_rewrite_examples || ['', '', '']).map((item, i) => (
            <input key={i} type="text" value={item} onChange={e => updateListItem('query_rewrite_examples', i, e.target.value)} placeholder={`Example query ${i + 1}`} />
          ))}
        </div>
      </div>

      <div className="admin-config-section">
        <h4>Domain Context</h4>
        <div className="admin-config-row">
          <label>Color-By Roles (comma-separated)</label>
          <input
            type="text"
            value={(config.default_color_by_roles || []).join(', ')}
            onChange={e => update('default_color_by_roles', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
        <div className="admin-config-row">
          <label>Extra Datasets (comma-separated — domain-specific benchmarks to recognize in papers)</label>
          <input
            type="text"
            value={(config.extra_datasets || []).join(', ')}
            onChange={e => update('extra_datasets', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
        <div className="admin-config-row">
          <label>Extra Keywords (comma-separated — domain-specific terms)</label>
          <input
            type="text"
            value={(config.extra_keywords || []).join(', ')}
            onChange={e => update('extra_keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        </div>
      </div>

      <div className="admin-config-section">
        <h4>Knowledge Graph Aliases</h4>
        <p className="admin-config-hint">
          Normalize entity surface forms to one canonical label so the graph doesn&rsquo;t fragment a
          planner / robot / problem across spelling variants. Each is a JSON object{' '}
          <code>{'{ "alias": "Canonical Name" }'}</code>. Leave blank to inherit the built-in defaults.
        </p>
        {['technique', 'hardware', 'problem'].map(cat => (
          <div className="admin-config-row" key={cat}>
            <label>{cat[0].toUpperCase() + cat.slice(1)} aliases</label>
            <textarea
              rows={5} style={taStyle} value={kgValue(cat)}
              onChange={e => updateKgAlias(cat, e.target.value)}
              placeholder={cat === 'technique'
                ? '{\n  "rrt*": "RRT*",\n  "chomp": "CHOMP"\n}'
                : (cat === 'hardware' ? '{\n  "franka": "Franka Emika Panda"\n}' : '{\n  "narrow passage": "narrow-passage planning"\n}')}
            />
            {jsonErr[`kg.${cat}`] && <span style={errStyle}>Invalid JSON: {jsonErr[`kg.${cat}`]}</span>}
          </div>
        ))}
      </div>

      <div className="admin-config-section">
        <h4>Benchmark Metrics</h4>
        <p className="admin-config-hint">
          Metrics / conditions / datasets the benchmark extractor and the copilot&rsquo;s ranking
          answers depend on. The copilot&rsquo;s query vocabulary is auto-derived from these aliases at
          build time. JSON with <code>metrics</code>, <code>conditions</code>, <code>datasets</code>.
        </p>
        <div className="admin-config-row">
          <textarea
            rows={12} style={taStyle} value={benchValue()}
            onChange={e => updateBenchmarks(e.target.value)}
            placeholder={'{\n  "metrics": [\n    {"id": "success_rate", "unit": "%", "higher_is_better": true, "type": "rate", "aliases": ["success rate", "sr"]},\n    {"id": "planning_time", "unit": "s", "higher_is_better": false, "type": "time", "aliases": ["planning time", "runtime"]}\n  ],\n  "conditions": [\n    {"id": "cluttered", "aliases": ["cluttered", "clutter"]}\n  ],\n  "datasets": []\n}'}
          />
          {jsonErr.benchmarks && <span style={errStyle}>Invalid JSON: {jsonErr.benchmarks}</span>}
        </div>
      </div>
    </div>
  );
}

export function generateYamlPreview(domainSlug, config, csvFilename, pdfUrl) {
  const slug = (domainSlug || '').trim().replace(/\s+/g, '_').toLowerCase();
  const dashed = slug.replace(/_/g, '-');
  const lines = [];
  lines.push(`domain: ${slug}`);
  lines.push(`display_name: "${config.display_name || ''}"`);
  lines.push(`display_subject: "${config.display_subject || ''}"`);
  lines.push(`display_short: "${config.display_short || ''}"`);
  lines.push(`ecosystem: "COMPARE Ecosystem"`);
  lines.push(`tagline: "AI-in-the-Loop"`);
  lines.push(`query_hint: '${config.query_hint || ''}'`);
  lines.push(`method_noun: "${config.method_noun || 'method'}"`);
  lines.push('');
  lines.push(`csv_path: datasets/${dashed}/${csvFilename || `${slug}.csv`}`);
  lines.push(`papers_dir: datasets/${dashed}/papers/`);
  if (pdfUrl) lines.push(`pdf_url: "${pdfUrl}"`);
  if (config.drive_folder) lines.push(`drive_folder: "${config.drive_folder}"`);
  lines.push('');
  lines.push('columns:');
  for (const [col, mapping] of Object.entries(config.columns || {})) {
    if (mapping.role) {
      const parts = [`role: ${mapping.role}`];
      if (mapping.facet) parts.push(`facet: ${mapping.facet}`);
      lines.push(`  "${col}": { ${parts.join(', ')} }`);
    }
  }
  lines.push('');
  lines.push('llm:');
  lines.push(`  domain_subject: "${config.llm?.domain_subject || ''}"`);
  lines.push('  claim_extraction_focus:');
  for (const item of (config.llm?.claim_extraction_focus || [])) {
    if (item) lines.push(`    - "${item}"`);
  }
  lines.push('  query_rewrite_examples:');
  for (const item of (config.llm?.query_rewrite_examples || [])) {
    if (item) lines.push(`    - "${item}"`);
  }
  lines.push('');
  lines.push('default_color_by_roles:');
  for (const r of (config.default_color_by_roles || [])) {
    lines.push(`  - ${r}`);
  }
  if (config.extra_datasets?.length) {
    lines.push('');
    lines.push('extra_datasets:');
    for (const d of config.extra_datasets) lines.push(`  - "${d}"`);
  }
  if (config.extra_keywords?.length) {
    lines.push('');
    lines.push('extra_keywords:');
    for (const k of config.extra_keywords) lines.push(`  - "${k}"`);
  }
  const ka = config.kg_aliases || {};
  const aliasCats = ['technique', 'hardware', 'problem'].filter(c => ka[c] && Object.keys(ka[c]).length);
  if (aliasCats.length) {
    lines.push('');
    lines.push('kg_aliases:');
    for (const cat of aliasCats) {
      lines.push(`  ${cat}:`);
      for (const [alias, canonical] of Object.entries(ka[cat])) {
        lines.push(`    "${alias}": "${canonical}"`);
      }
    }
  }
  if (config.benchmarks?.metrics?.length) {
    lines.push('');
    lines.push(`# + benchmark config (${config.benchmarks.metrics.length} metrics) written to`);
    lines.push(`#   dashboard/scripts/precompute/benchmarks/config/${slug}.json`);
  }
  return lines.join('\n');
}
