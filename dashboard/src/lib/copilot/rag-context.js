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
export function buildMethodSummaries(methods, { summaryColumns, shortNames } = {}) {
  const cols = (summaryColumns && summaryColumns.length) ? summaryColumns : DEFAULT_SUMMARY_COLUMNS;
  const shorts = shortNames || DEFAULT_SHORT_NAMES;
  return methods.map(m => {
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

  const ragText = chunks.slice(0, 6).map((chunk, i) => {
    const paper = chunk.metadata?.paper_title || chunk.metadata?.paper_id || 'Unknown';
    const section = chunk.metadata?.section || '';
    const text = (chunk.text || '').slice(0, 400);
    return `[${paper}${section ? ' - ' + section : ''}] (relevance: ${(chunk.score || 0).toFixed(3)})\n${text}`;
  }).join('\n\n');

  return { ragText, ragCitations };
}
