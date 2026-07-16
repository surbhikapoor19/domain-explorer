// Server-side LLM proxy — holds the Groq key so the client never sees it.
// Groq (openai/gpt-oss-120b) is the actual provider in prod; the HF branch this
// used to try first pointed at a deprecated inference endpoint and was never
// configured (HF_API_TOKEN unset), so it's dropped rather than "fixed" — one
// less unauthenticated path to reason about.

// Simple in-memory per-IP token-bucket rate limit. Serverless instances are
// short-lived and this resets on cold start, but it still caps abuse within a
// warm instance without needing external state.
const RATE_LIMIT = { capacity: 20, refillPerSec: 20 / 60 }; // 20 requests / minute, refilling continuously
const buckets = new Map();

function allowRequest(ip) {
  const now = Date.now() / 1000;
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE_LIMIT.capacity, last: now }; buckets.set(ip, b); }
  const elapsed = now - b.last;
  b.tokens = Math.min(RATE_LIMIT.capacity, b.tokens + elapsed * RATE_LIMIT.refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Same-origin allowlist: accept requests whose Origin/Referer host matches the
// deployment's own host (or is absent, e.g. some server-to-server test tools),
// so this proxy isn't a free, key-holding relay for any third-party site.
function isAllowedOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return true; // no browser origin header (curl/tests) — allowed
  try {
    const originHost = new URL(origin).host;
    const hostHeader = req.headers.host || '';
    if (originHost === hostHeader) return true;
    const allowedEnv = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return allowedEnv.some(h => originHost === h || originHost.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const MAX_TOKENS_CAP = 4000; // headroom above the copilot's 3000-token overview budget (+ gpt-oss reasoning), while still refusing absurd requests that would burn the shared key
const MAX_BODY_BYTES = 60000; // messages payload guard — RAG+KG+benchmark context is a few KB, not tens of KB

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!allowRequest(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded — try again shortly.' });
  }

  const { messages, max_tokens = 1024, temperature = 0.3, response_format } = req.body || {};
  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'messages required' });
  }
  const bodySize = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (bodySize > MAX_BODY_BYTES) {
    return res.status(413).json({ error: `messages payload too large (${bodySize} bytes > ${MAX_BODY_BYTES})` });
  }
  const cappedMaxTokens = Math.min(Number(max_tokens) || 1024, MAX_TOKENS_CAP);

  const geminiKey = process.env.GEMINI_API_KEY || '';
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const groqKey = process.env.GROQ_API_KEY || '';
  const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  if (!geminiKey && !groqKey) {
    return res.status(500).json({ error: 'No LLM API key configured. Set GEMINI_API_KEY or GROQ_API_KEY in Vercel env vars.' });
  }

  // Gemini via its OpenAI-compatible endpoint — same request shape as Groq.
  const callGemini = () => fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${geminiKey}` },
    body: JSON.stringify({
      model: geminiModel, messages, max_tokens: cappedMaxTokens, temperature,
      ...(response_format ? { response_format } : {}),
    }),
  });

  const callGroq = () => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: groqModel, messages, max_tokens: cappedMaxTokens, temperature,
      // gpt-oss are REASONING models: hidden reasoning consumes max_tokens.
      ...(/gpt-oss/i.test(groqModel) ? { reasoning_effort: 'low' } : {}),
      ...(response_format ? { response_format } : {}),
    }),
  });

  // Gemini is the default when its key is set; Groq is the fallback. A quota/5xx
  // OR a 200-with-empty-completion on the first provider fails over to the next,
  // so a thin Gemini quota never leaves the copilot blank.
  const providers = [];
  if (geminiKey) providers.push({ name: 'gemini', call: callGemini });
  if (groqKey) providers.push({ name: 'groq', call: callGroq });

  let lastStatus = 500;
  let lastErr = 'no provider available';
  for (const p of providers) {
    try {
      let r = await p.call();
      if (!r.ok && (r.status === 429 || r.status >= 500)) {
        await new Promise(res2 => setTimeout(res2, 1500));
        r = await p.call();
      }
      if (r.ok) {
        const data = await r.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content && content.trim()) {
          return res.status(200).json(data);
        }
        lastStatus = 502; lastErr = `${p.name}: empty completion`;
        continue; // try the next provider
      }
      lastStatus = r.status; lastErr = `${p.name}: ${await r.text()}`;
    } catch (e) {
      lastStatus = 500; lastErr = `${p.name}: ${e.message}`;
    }
  }
  return res.status(lastStatus).json({ error: lastErr });
}
