const PROVIDERS = {
  default: {
    name: 'Default (server-side)',
    defaultModel: '',
    requiresKey: false,
  },
  huggingface: {
    name: 'HuggingFace (BYOK)',
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    requiresKey: true,
  },
  groq: {
    name: 'Groq (BYOK)',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresKey: true,
  },
};

export function getProviders() { return PROVIDERS; }

export function loadSettings() {
  try {
    const saved = localStorage.getItem('grasp-llm-settings');
    if (saved) return JSON.parse(saved);
  } catch {}
  return { provider: 'default', apiKey: '', model: '' };
}

export function saveSettings(settings) {
  localStorage.setItem('grasp-llm-settings', JSON.stringify(settings));
}

async function callProxy(messages, opts = {}) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature ?? 0.3,
    }),
  });
  if (!res.ok) throw new Error(`LLM proxy error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callHuggingFace(messages, settings, opts = {}) {
  const model = settings.model || PROVIDERS.huggingface.defaultModel;
  const url = `https://api-inference.huggingface.co/models/${model}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
  const res = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ messages, max_tokens: opts.maxTokens || 1024, temperature: opts.temperature ?? 0.3 }),
  });
  if (!res.ok) throw new Error(`HuggingFace API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGroq(messages, settings, opts = {}) {
  if (!settings.apiKey) throw new Error('Groq requires an API key. Add it in Settings.');
  const model = settings.model || PROVIDERS.groq.defaultModel;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens || 1024, temperature: opts.temperature ?? 0.3 }),
  });
  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export async function chat(messages, settingsOverride) {
  const settings = settingsOverride || loadSettings();
  const opts = typeof settingsOverride === 'object' && !settingsOverride.provider ? settingsOverride : {};
  switch (settings.provider) {
    case 'groq': return callGroq(messages, settings, opts);
    case 'huggingface': return callHuggingFace(messages, settings, opts);
    case 'default':
    default: return callProxy(messages, opts);
  }
}
