// Copilot LLM prompt assembly. Extracted from ai-pipeline.js and restructured
// for chain-of-evidence / numbers-first answers. The domain framing
// (productSubject) and the few-shot exemplar method names now come from the
// active domain config (branding) or are derived from the passed
// highlightMethods, instead of hardcoded grasp method names.

export function buildInsightPrompt(query, highlightMethods, ragText, kgContext, methodSummaries, branding = {}, benchmarkText = '') {
  const subject = branding.productSubject || 'grasp planning';

  // Exemplar method names for the few-shot guidance come from the domain config
  // (branding.exampleMethods) when provided, otherwise are derived from the
  // highlighted methods most relevant to this query. This keeps the framing
  // domain-agnostic: a motion-planning domain never sees grasp method names.
  const exemplarSource = Array.isArray(branding.exampleMethods) && branding.exampleMethods.length
    ? branding.exampleMethods
    : (highlightMethods || []);
  const exemplars = exemplarSource.slice(0, 2).filter(Boolean);
  const primaryExemplar = exemplars[0] || 'the method';
  const secondaryExemplar = exemplars[1] || primaryExemplar;

  return `You are an expert research assistant for a ${subject} visualization tool. A researcher has queried the system and you have access to real data from academic papers.

RESEARCHER'S QUESTION: "${query}"

EVIDENCE FROM PAPERS:
${ragText || '(No paper excerpts available for this query)'}

KNOWLEDGE GRAPH INSIGHTS:
${kgContext || '(No structured knowledge available)'}

VERIFIED BENCHMARK EVIDENCE (extracted from the corpus' result tables, ranked; every row carries an evidence grade — A = corroborated by multiple papers, B = single solid source, C = low-confidence/disputed — and the source paper(s)):
${benchmarkText || '(No benchmark leaderboard matched this query)'}

RELEVANT METHODS IN THE DATASET:
${methodSummaries}

Highlighted methods (most relevant to query): ${(highlightMethods || []).slice(0, 6).join(', ')}

INSTRUCTIONS:
Answer the researcher's question as a chain of evidence, structured exactly like this:

- FIRST, open with a one-sentence direct answer that states the bottom line up front (a single sentence, no hedging, no preamble).
- THEN give 3 to 6 evidence points. Each evidence point must name a specific source paper AND quote either a concrete number or a specific named technique drawn from that paper. Use inline citation markers in [paper] form right after the claim they support (for example: "${primaryExemplar} reports 90.2% success [paper]" or "${secondaryExemplar} uses a contact-point loss [paper]"). Do not pad with generic statements.
- FINALLY, close with a one-line caveat noting the main limitation or uncertainty in the evidence above.

Rules:
0. If the question is about performance, rankings, "best/highest/fastest", or any quantitative comparison, LEAD with the VERIFIED BENCHMARK EVIDENCE: state the ranking with the EXACT values, name the evidence grade (A/B/C) and the source paper(s), and prefer grade A/B (explicitly flag grade C as low-confidence). Never invent a number that is not in that block; if the block says none matched, say the benchmark data doesn't cover it rather than guessing.
1. Lead with evidence from the paper excerpts. Quote specific techniques, equations, or results and attribute them with an inline [paper] citation marker (e.g., "${primaryExemplar} uses a binary cross-entropy loss on predicted contact points [paper]").
2. When no paper excerpt covers a point, draw on the method metadata (planning approach, input type, etc.) to provide grounded analysis.
3. Be specific and technical. Avoid generic statements like "various methods use different approaches".
4. Always use the exact method names as provided in the data (use the full name as it appears in the dataset, not an abbreviation alone). This ensures methods are correctly linked in the interface.
5. Do NOT use markdown formatting like **bold** or *italic*. Write plain text only. The interface has its own highlighting system that automatically color-codes technique names, method names, and domain terms.`;
}
