// Copilot LLM prompt assembly. Extracted verbatim from ai-pipeline.js
// (behaviour-preserving). The follow-up restructures this for chain-of-evidence
// / numbers-first answers and makes the "robotic" framing + few-shot exemplars
// come from the active domain config instead of hardcoded grasp method names.

export function buildInsightPrompt(query, highlightMethods, ragText, kgContext, methodSummaries, branding = {}, benchmarkText = '') {
  const subject = branding.productSubject || 'grasp planning';

  return `You are an expert research assistant for a robotic ${subject} visualization tool. A researcher has queried the system and you have access to real data from academic papers.

RESEARCHER'S QUESTION: "${query}"

EVIDENCE FROM PAPERS:
${ragText || '(No paper excerpts available for this query)'}

KNOWLEDGE GRAPH INSIGHTS:
${kgContext || '(No structured knowledge available)'}

VERIFIED BENCHMARK EVIDENCE (extracted from the corpus' result tables, ranked; every row carries an evidence grade — A = corroborated by multiple papers, B = single solid source, C = low-confidence/disputed — and the source paper(s)):
${benchmarkText || '(No benchmark leaderboard matched this query)'}

RELEVANT METHODS IN THE DATASET:
${methodSummaries}

Highlighted methods (most relevant to query): ${highlightMethods.slice(0, 6).join(', ')}

INSTRUCTIONS:
Write exactly 3-5 bullet points that answer the researcher's question. Each bullet must start with "- ".

Rules:
0. If the question is about performance, rankings, "best/highest/fastest", or any quantitative comparison, LEAD with the VERIFIED BENCHMARK EVIDENCE: state the ranking with the EXACT values, name the evidence grade (A/B/C) and the source paper(s), and prefer grade A/B (explicitly flag grade C as low-confidence). Never invent a number that is not in that block; if the block says none matched, say the benchmark data doesn't cover it rather than guessing.
1. Lead with evidence from the paper excerpts. Quote specific techniques, equations, or results by paper name (e.g., "Contact-GraspNet uses a binary cross-entropy loss on predicted contact points").
2. When no paper excerpt covers a point, draw on the method metadata (planning approach, gripper type, etc.) to provide grounded analysis.
3. Be specific and technical. Avoid generic statements like "various methods use different approaches".
4. Always use the exact method names as provided in the data (e.g., "Grasp Pose Detection (GPD)" not just "GPD", "Volumetric Grasping Network (VGN)" not just "VGN"). This ensures methods are correctly linked in the interface.
5. Do NOT use markdown formatting like **bold** or *italic*. Write plain text only. The interface has its own highlighting system that automatically color-codes technique names, method names, and domain terms.

Respond with ONLY the bullet points, nothing else.`;
}
