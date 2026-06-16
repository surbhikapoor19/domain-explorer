// Copilot RAG context formatting + per-method summaries for the LLM prompt.
// Extracted verbatim from ai-pipeline.js (behaviour-preserving). Behaviour
// changes (de-truncation, relevance ranking/capping) land here as a follow-up
// so each concern is independently unit-testable.

// Grasp fallbacks, used only when the domain config supplies no summary columns
// (a new domain provides these via domain-config.json priorityDims / shortNames).
export const DEFAULT_SUMMARY_COLUMNS = [
  'Planning Method', 'End-effector Hardware', 'Input Data',
  'Training Data', 'Object Configuration',
];
export const DEFAULT_SHORT_NAMES = {
  'Planning Method': 'Plan', 'Training Data': 'Train', 'End-effector Hardware': 'Gripper',
  'Object Configuration': 'Objects', 'Input Data': 'Input', 'Output Pose': 'Output',
  'Corresponding Dataset (see repository linked above)': 'Dataset',
  'Simulator (see repository linked above)': 'Sim', 'Backbone': 'Backbone',
  'Metric(s) Used ': 'Metrics', 'Camera Position(s)': 'Camera', 'Language': 'Lang',
  'Description': 'Desc',
};

// Summarize each method over the domain's most meaningful columns for the LLM
// prompt. `summaryColumns`/`shortNames` come from the active domain config
// (priorityDims + shortNames); for grasp with no config they fall back above.
export function buildMethodSummaries(methods, { summaryColumns, shortNames, limit, prioritize } = {}) {
  const cols = (summaryColumns && summaryColumns.length) ? summaryColumns : DEFAULT_SUMMARY_COLUMNS;
  const shorts = shortNames || DEFAULT_SHORT_NAMES;

  // Stable-sort prioritized methods (in the order they are named) to the front;
  // everything else keeps its original relative order. Names not present in
  // `methods` are ignored.
  let ordered = methods;
  if (prioritize && prioritize.length) {
    const priorityRank = new Map();
    prioritize.forEach((name, idx) => {
      if (!priorityRank.has(name)) priorityRank.set(name, idx);
    });
    ordered = methods
      .map((m, idx) => ({ m, idx }))
      .sort((a, b) => {
        const ra = priorityRank.has(a.m.name) ? priorityRank.get(a.m.name) : Infinity;
        const rb = priorityRank.has(b.m.name) ? priorityRank.get(b.m.name) : Infinity;
        if (ra !== rb) return ra - rb;
        return a.idx - b.idx; // stable for equal priority (incl. both non-prioritized)
      })
      .map(({ m }) => m);
  }

  // Cap the number of emitted lines after prioritization, if requested.
  if (typeof limit === 'number' && limit < ordered.length) {
    ordered = ordered.slice(0, limit);
  }

  return ordered.map(m => {
    const parts = cols.map(col => {
      const val = m.metadata?.[col] || '';
      if (!val) return null;
      const short = shorts[col] || col;
      return `${short}=${val}`;
    }).filter(Boolean);
    return `- ${m.name}: ${parts.join('; ')}`;
  }).join('\n');
}

export function formatRagContext(chunks) {
  if (!chunks || !chunks.length) return { ragText: '', ragCitations: [] };

  const ragCitations = chunks.map((chunk, i) => ({
    rank: i + 1,
    paper_id: chunk.metadata?.paper_id || '',
    paper_title: chunk.metadata?.paper_title || chunk.metadata?.paper_id || '',
    section: chunk.metadata?.section || '',
    layer: chunk.metadata?.layer || '',
    content_type: chunk.metadata?.content_type || '',
    rhetorical_role: chunk.metadata?.rhetorical_role || '',
    snippet: (chunk.text || '').slice(0, 200),
    full_text: chunk.text || '',
    score: chunk.score || 0,
  }));

  // Rank-aware character caps: top-3 chunks keep more of their text (1500),
  // ranks 4-6 keep a smaller window (900). Stops starving the LLM of the most
  // relevant paper text while bounding total prompt size.
  const ragText = chunks.slice(0, 6).map((chunk, i) => {
    const paper = chunk.metadata?.paper_title || chunk.metadata?.paper_id || 'Unknown';
    const section = chunk.metadata?.section || '';
    const cap = i < 3 ? 1500 : 900;
    const text = (chunk.text || '').slice(0, cap);
    return `[${paper}${section ? ' - ' + section : ''}] (relevance: ${(chunk.score || 0).toFixed(3)})\n${text}`;
  }).join('\n\n');

  return { ragText, ragCitations };
}
