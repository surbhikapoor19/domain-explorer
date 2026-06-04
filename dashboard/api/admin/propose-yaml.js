export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { domainSlug, description, csvHeaders, csvSampleRows } = req.body || {};
  if (!domainSlug || !csvHeaders || !csvSampleRows) {
    return res.status(400).json({ error: 'domainSlug, csvHeaders, and csvSampleRows are required' });
  }

  const prompt = buildPrompt(domainSlug, description, csvHeaders, csvSampleRows);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const hfToken = process.env.HF_API_TOKEN || process.env.HF_TOKEN || '';
  const groqKey = process.env.GROQ_API_KEY || '';
  const hfModel = process.env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct';
  const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  let llmResponse = null;
  let lastError = '';

  if (hfToken) {
    try {
      const hfRes = await fetch(
        `https://api-inference.huggingface.co/models/${hfModel}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hfToken}`,
          },
          body: JSON.stringify({ messages, max_tokens: 2048, temperature: 0.2 }),
        }
      );
      if (hfRes.ok) {
        const data = await hfRes.json();
        llmResponse = data.choices?.[0]?.message?.content || '';
      } else {
        const errText = await hfRes.text().catch(() => '');
        lastError = `HF ${hfRes.status}: ${errText.slice(0, 200)}`;
        console.warn(lastError);
      }
    } catch (e) {
      lastError = `HF error: ${e.message}`;
      console.warn(lastError);
    }
  }

  if (!llmResponse && groqKey) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({ model: groqModel, messages, max_tokens: 2048, temperature: 0.2 }),
      });
      if (groqRes.ok) {
        const data = await groqRes.json();
        llmResponse = data.choices?.[0]?.message?.content || '';
      } else {
        const errText = await groqRes.text().catch(() => '');
        lastError = `Groq ${groqRes.status}: ${errText.slice(0, 200)}`;
        console.warn(lastError);
      }
    } catch (e) {
      lastError = `Groq error: ${e.message}`;
      console.warn(lastError);
    }
  }

  if (!llmResponse) {
    const detail = !hfToken && !groqKey
      ? 'No LLM API key configured. Set HF_API_TOKEN or GROQ_API_KEY.'
      : lastError || 'LLM returned empty response';
    return res.status(500).json({ error: detail });
  }

  try {
    const parsed = parseYamlResponse(llmResponse);
    return res.status(200).json({ yaml: parsed, raw: llmResponse });
  } catch (e) {
    return res.status(200).json({ yaml: null, raw: llmResponse, parseError: e.message });
  }
}

const ROLE_VOCABULARY = `
Available roles (dot-separated hierarchy):
  identity.name        - The method/algorithm name (required, exactly one column)
  identity.description - Free-text description or abstract
  identity.citation    - BibTeX or citation string
  identity.year        - Year of publication or initial release
  identity.code        - URL to code repository or project page
  method.family        - Category of approach (e.g., "sampling-based", "optimization")
  method.backbone      - Neural architecture or core algorithm component
  method.middleware     - Middleware or framework used (e.g., MoveIt, ROS)
  method.ik_controller  - Inverse kinematics or controller type
  train.regime         - Training paradigm (supervised, self-supervised, sim-to-real)
  train.simulator      - Simulator used for training
  input.modality       - Input data type (point cloud, RGB-D, joint states)
  input.sensor         - Sensor type or camera configuration
  output.shape         - Output representation (6-DoF pose, joint trajectory)
  hardware.platform    - Robot or end-effector hardware
  env.context          - Scene or object configuration
  eval.benchmark       - Dataset or benchmark used for evaluation
  eval.metric          - Metric used (success rate, path length, computation time)
  meta.language        - Programming language
  meta.license         - Software license
  meta.maintainer      - Author or maintainer name

Facet types:
  categorical - Discrete values, good for color-by and filtering
  numeric     - Numbers, good for range filtering and sorting
  text        - Free-form text, embedded for search
  url         - Rendered as clickable links
  identifier  - Used for joins, not displayed directly
`;

const SYSTEM_PROMPT = `You are a domain configuration expert for the Domain Explorer platform — a visualization and analysis tool for academic research domains.

Given a CSV dataset and domain description, you produce a complete YAML configuration that maps CSV columns to semantic roles and configures LLM prompts for the domain.

You MUST respond with ONLY a JSON object (no markdown, no explanation). The JSON has these top-level keys:
- display_name (string): Human-readable name for the explorer (e.g., "Grasp Explorer")
- display_subject (string): What the domain studies, plural (e.g., "grasp planning methods")
- display_short (string): Short reference (e.g., "grasp planning")
- method_noun (string): What to call each entry - "method", "algorithm", "technique", etc.
- query_hint (string): Example query for the search bar
- columns (object): Mapping of CSV column names to {role, facet} objects
- llm (object): With keys domain_subject, claim_extraction_focus (array of 4 strings), query_rewrite_examples (array of 3 strings)
- default_color_by_roles (array): 2-4 roles that make good color encodings
- extra_datasets (array): Domain-specific dataset/benchmark names to recognize in papers (beyond the built-in list of YCB, ShapeNet, MuJoCo, etc.)
- extra_keywords (array): Domain-specific technical terms to recognize`;

function buildPrompt(domainSlug, description, csvHeaders, csvSampleRows) {
  const headerList = csvHeaders.join(', ');
  const sampleTable = csvSampleRows.map(row =>
    csvHeaders.map(h => `${h}: ${row[h] || ''}`).join(' | ')
  ).join('\n');

  return `Configure the "${domainSlug}" domain.

User's description of this domain:
${description || '(No description provided)'}

CSV columns: ${headerList}

Sample rows (first 3):
${sampleTable}

${ROLE_VOCABULARY}

Map each CSV column to the most appropriate role. Every column must be mapped. The "Name" column (or equivalent) must map to identity.name.

For claim_extraction_focus, write 4 domain-specific things to look for when extracting claims from papers (performance metrics, comparison types, common limitations, transfer/deployment patterns).

For query_rewrite_examples, write 3 natural-language queries someone studying this domain would ask.

For extra_datasets, list 5-15 dataset or benchmark names specific to this domain that papers might reference.

For extra_keywords, list 10-20 technical terms specific to this domain.

Return ONLY valid JSON, no markdown fences.`;
}

function parseYamlResponse(raw) {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const match = text.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
    if (match) text = match[1].trim();
  }
  const bracketMatch = text.match(/\{[\s\S]*\}/);
  if (bracketMatch) text = bracketMatch[0];
  return JSON.parse(text);
}
