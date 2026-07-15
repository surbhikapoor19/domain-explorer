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

const MAX_TOKENS_CAP = 2500;
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

  const groqKey = process.env.GROQ_API_KEY || '';
  const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  if (!groqKey) {
    return res.status(500).json({ error: 'No LLM API key configured. Set GROQ_API_KEY in Vercel env vars.' });
  }

  const callGroq = () => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model: groqModel, messages, max_tokens: cappedMaxTokens, temperature,
      // gpt-oss are REASONING models: their hidden reasoning consumes
      // max_tokens. Keep it short or long prompts produce empty/truncated
      // answers (and json_object mode hard-400s with an empty generation).
      ...(/gpt-oss/i.test(groqModel) ? { reasoning_effort: 'low' } : {}),
      ...(response_format ? { response_format } : {}),
    }),
  });

  try {
    let groqRes = await callGroq();
    // One retry with backoff on a transient failure (429 rate-limit / 5xx) —
    // these are the cases worth retrying; a 4xx like a bad request is not.
    if (!groqRes.ok && (groqRes.status === 429 || groqRes.status >= 500)) {
      await new Promise(r => setTimeout(r, 2000));
      groqRes = await callGroq();
    }
    if (groqRes.ok) {
      const data = await groqRes.json();
      return res.status(200).json(data);
    }
    const errText = await groqRes.text();
    return res.status(groqRes.status).json({ error: errText });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
