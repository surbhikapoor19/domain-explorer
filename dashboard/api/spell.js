export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, domainTerms } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'query required' });
  }

  const groqKey = process.env.GROQ_API_KEY || '';
  if (!groqKey) {
    return res.status(200).json({ corrected: query, changed: false });
  }

  const termList = (domainTerms || []).slice(0, 100).join(', ');

  const messages = [
    {
      role: 'system',
      content: `You are a spell-correction preprocessor for a robotic grasp planning search tool. Fix typos, misspellings, and word boundary errors in the user's search query. Use the domain vocabulary to guide corrections.

Domain terms: ${termList}

Rules:
- Fix misspellings to the closest domain term when applicable (e.g. "graso" → "grasp", "sunction" → "suction")
- Fix word boundary errors (e.g. "al lothers" → "all others", "graspnet work" → "graspnet work")
- Preserve technical terms with numbers exactly (e.g. "6dof", "se3", "3d")
- Preserve acronyms exactly (e.g. "VGN", "GPD", "RGBD")
- Do NOT change the meaning or add/remove words
- Return ONLY the corrected query text, nothing else`
    },
    {
      role: 'user',
      content: query
    }
  ];

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_SPELL_MODEL || 'llama-3.1-8b-instant',
        messages,
        max_tokens: 256,
        temperature: 0,
      }),
    });

    if (!groqRes.ok) {
      return res.status(200).json({ corrected: query, changed: false });
    }

    const data = await groqRes.json();
    const corrected = (data.choices?.[0]?.message?.content || query).trim();

    if (!corrected || corrected.length > query.length * 3) {
      return res.status(200).json({ corrected: query, changed: false });
    }

    return res.status(200).json({
      corrected,
      changed: corrected.toLowerCase() !== query.toLowerCase(),
    });
  } catch (e) {
    return res.status(200).json({ corrected: query, changed: false });
  }
}
