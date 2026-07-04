export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, max_tokens = 1024, temperature = 0.3, response_format } = req.body || {};
  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'messages required' });
  }

  // Try HuggingFace first, fall back to Groq
  const hfToken = process.env.HF_API_TOKEN || process.env.HF_TOKEN || '';
  const groqKey = process.env.GROQ_API_KEY || '';
  const hfModel = process.env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct';
  const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

  // Attempt HuggingFace
  if (hfToken) {
    try {
      const hfRes = await fetch(
        `https://api-inference.huggingface.co/models/${hfModel}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${hfToken}`,
          },
          body: JSON.stringify({ messages, max_tokens, temperature, ...(response_format ? { response_format } : {}) }),
        }
      );
      if (hfRes.ok) {
        const data = await hfRes.json();
        return res.status(200).json(data);
      }
      const hfErr = await hfRes.text().catch(() => '');
      console.warn(`HF ${hfRes.status}: ${hfErr.slice(0, 200)}, falling back to Groq`);
    } catch (e) {
      console.warn('HF failed, trying Groq:', e.message);
    }
  }

  // Fallback to Groq
  if (groqKey) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`,
        },
        body: JSON.stringify({ model: groqModel, messages, max_tokens, temperature, ...(response_format ? { response_format } : {}) }),
      });
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

  return res.status(500).json({ error: 'No LLM API key configured. Set HF_API_TOKEN or GROQ_API_KEY in Vercel env vars.' });
}
