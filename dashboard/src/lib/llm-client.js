// Client-side LLM routing. The `default` provider proxies to the server-side
// /api/chat (used in prod, where the server holds the key). Everything else is
// BYOK — the user's key is stored only in localStorage and sent straight to the
// provider, so the copilot can be tested locally without a server key.
const PROVIDERS = {
  default: {
    name: 'Default (server-side)',
    defaultModel: '',
    requiresKey: false,
  },
  huggingface: {
    name: 'Hugging Face',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    requiresKey: true,
    keyLabel: 'Hugging Face access token (hf_…)',
    keyUrl: 'https://huggingface.co/settings/tokens',
  },
  openrouter: {
    name: 'OpenRouter  (GPT-4o · Claude · Llama …)',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    requiresKey: true,
    keyLabel: 'OpenRouter API key',
    keyUrl: 'https://openrouter.ai/keys',
  },
  groq: {
    name: 'Groq',
    defaultModel: 'openai/gpt-oss-120b',
    requiresKey: true,
    keyLabel: 'Groq API key',
    keyUrl: 'https://console.groq.com/keys',
  },
  openai_compatible: {
    name: 'OpenAI-compatible (custom URL)',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    requiresBaseUrl: true,
    keyLabel: 'API key',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
  },
};

export function getProviders() { return PROVIDERS; }

export function loadSettings() {
  try {
    const saved = localStorage.getItem('grasp-llm-settings');
    if (saved) return { provider: 'default', apiKey: '', model: '', baseUrl: '', ...JSON.parse(saved) };
  } catch {}
  return { provider: 'default', apiKey: '', model: '', baseUrl: '' };
}

export function saveSettings(settings) {
  localStorage.setItem('grasp-llm-settings', JSON.stringify(settings));
}

// Server-side proxy (the `default` provider) — holds the key in the API function.
// fetch with an abort timeout so a slow/hung provider can't block the whole
// interaction indefinitely.
async function fetchWithTimeout(url, options, ms = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM request timed out after ${ms / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function callProxy(messages, opts = {}) {
  const res = await fetchWithTimeout('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature ?? 0.3,
      response_format: opts.responseFormat ? { type: opts.responseFormat } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`LLM proxy error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// One generic OpenAI-compatible chat-completions caller — every BYOK provider
// (HF router, OpenRouter, Groq, custom) speaks this dialect.
async function callOpenAICompatible(endpoint, defaultModel, messages, settings, opts = {}, extraHeaders = {}, extraBody = null) {
  const model = settings.model || defaultModel;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature ?? 0.3,
      response_format: opts.responseFormat ? { type: opts.responseFormat } : undefined,
      ...(typeof extraBody === 'function' ? extraBody(model) : (extraBody || {})),
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export async function chat(messages, settingsOverride) {
  // settingsOverride is either a full settings object (has .provider) or an
  // {maxTokens, temperature} opts bag — disambiguate on .provider.
  const settings = settingsOverride && settingsOverride.provider ? settingsOverride : loadSettings();
  const opts = settingsOverride && !settingsOverride.provider ? settingsOverride : {};
  const P = PROVIDERS;
  switch (settings.provider) {
    case 'huggingface':
      if (!settings.apiKey) throw new Error('Hugging Face requires an access token. Add it in Settings.');
      return callOpenAICompatible('https://router.huggingface.co/v1/chat/completions',
        P.huggingface.defaultModel, messages, settings, opts);
    case 'openrouter':
      if (!settings.apiKey) throw new Error('OpenRouter requires an API key. Add it in Settings.');
      return callOpenAICompatible('https://openrouter.ai/api/v1/chat/completions',
        P.openrouter.defaultModel, messages, settings, opts,
        { 'HTTP-Referer': window.location.origin, 'X-Title': 'Grasp Planning Explorer' });
    case 'groq':
      if (!settings.apiKey) throw new Error('Groq requires an API key. Add it in Settings.');
      // gpt-oss are reasoning models on Groq: hidden reasoning consumes max_tokens,
      // so cap it — same fix as the server proxy (/api/chat), else BYOK users get
      // truncated/empty answers on long prompts.
      return callOpenAICompatible('https://api.groq.com/openai/v1/chat/completions',
        P.groq.defaultModel, messages, settings, opts, {},
        (model) => (/gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {}));
    case 'openai_compatible': {
      if (!settings.baseUrl) throw new Error('Add a Base URL in Settings for the OpenAI-compatible provider.');
      const base = settings.baseUrl.replace(/\/+$/, '');
      const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      return callOpenAICompatible(endpoint, P.openai_compatible.defaultModel, messages, settings, opts);
    }
    case 'default':
    default:
      return callProxy(messages, opts);
  }
}
