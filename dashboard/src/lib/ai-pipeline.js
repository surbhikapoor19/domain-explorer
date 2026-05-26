import { chat as llmChat } from './llm-client';
import { loadRagChunks, loadKgFull } from './data-loader';
import { searchChunks, classifyIntent, initChunks } from './rag-search';
import { initGraph, extractSubgraph } from './kg-graph';
import { runQueryPipeline } from './query-engine';
import { recomputeUmap } from './umap';
import { spellCorrectQuery } from './spell-correct';
import { GRASP_DEFAULTS } from '../DomainContext';

const SUMMARY_COLUMNS = [
  'Planning Method', 'End-effector Hardware', 'Input Data',
  'Training Data', 'Object Configuration',
];

const SHORT_COLUMN_NAMES = {
  'Planning Method': 'Plan', 'Training Data': 'Train', 'End-effector Hardware': 'Gripper',
  'Object Configuration': 'Objects', 'Input Data': 'Input', 'Output Pose': 'Output',
  'Corresponding Dataset (see repository linked above)': 'Dataset',
  'Simulator (see repository linked above)': 'Sim', 'Backbone': 'Backbone',
  'Metric(s) Used ': 'Metrics', 'Camera Position(s)': 'Camera', 'Language': 'Lang',
  'Description': 'Desc',
};

function smartSplit(value) {
  if (!value) return [];
  const s = String(value).trim();
  if (!s) return [];
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { parts.push(current.trim()); current = ''; continue; }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function buildMethodSummaries(methods) {
  return methods.map(m => {
    const parts = SUMMARY_COLUMNS.map(col => {
      const val = m.metadata?.[col] || '';
      if (!val) return null;
      const short = SHORT_COLUMN_NAMES[col] || col;
      return `${short}=${val}`;
    }).filter(Boolean);
    return `- ${m.name}: ${parts.join('; ')}`;
  }).join('\n');
}

function buildClusterStats(responseData, weights) {
  const clusters = {};
  responseData.forEach(pt => {
    if (!clusters[pt.cluster]) clusters[pt.cluster] = [];
    clusters[pt.cluster].push(pt);
  });

  const weightedCols = Object.entries(weights)
    .filter(([col, w]) => w > 0 && col !== 'Description')
    .map(([col]) => col);
  const keyCols = ['Planning Method', 'End-effector Hardware', 'Object Configuration', 'Input Data', 'Training Data'];

  const clusterStats = [];
  const lines = [`GROUPING RESULTS (${responseData.length} methods in ${Object.keys(clusters).length} groups):\n`];

  for (const cid of Object.keys(clusters).sort((a, b) => Number(a) - Number(b))) {
    const members = clusters[cid];
    const names = members.map(m => m.name);

    const labelCols = Object.entries(weights)
      .filter(([c]) => c !== 'Description')
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([c]) => c);

    const dominant = labelCols.map(col => {
      const vals = members.flatMap(m => smartSplit(m.metadata?.[col] || ''));
      if (!vals.length) return null;
      const counts = {};
      vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      return Object.entries(counts).sort(([, a], [, b]) => b - a)[0][0];
    }).filter(Boolean);

    const label = dominant.length ? dominant.join(' / ') : `Group ${cid}`;
    lines.push(`Group "${label}" (${members.length} methods): ${names.join(', ')}`);

    const stat = { id: Number(cid), label, methods: names, size: members.length, topAttributes: {} };

    for (const col of weightedCols) {
      const vals = members.flatMap(m => smartSplit(m.metadata?.[col] || ''));
      if (vals.length) {
        const counts = {};
        vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
        const top = Object.entries(counts).sort(([, a], [, b]) => b - a).slice(0, 3);
        const short = SHORT_COLUMN_NAMES[col] || col;
        const summary = top.map(([v, c]) => `${v} (${c})`).join(', ');
        lines.push(`  ${short}: ${summary}`);
        if (keyCols.includes(col)) {
          stat.topAttributes[short] = top.map(([v, c]) => ({ value: v, count: c }));
        }
      }
    }
    lines.push('');
    stat.label = label;
    clusterStats.push(stat);
  }

  // Value → cluster map
  const valueClusterMap = {};
  for (const col of weightedCols) {
    const vcm = {};
    responseData.forEach(pt => {
      smartSplit(pt.metadata?.[col] || '').forEach(part => {
        if (!vcm[part]) vcm[part] = [];
        vcm[part].push(pt.cluster);
      });
    });
    valueClusterMap[col] = {};
    for (const [val, clusterIds] of Object.entries(vcm)) {
      const counts = {};
      clusterIds.forEach(c => { counts[c] = (counts[c] || 0) + 1; });
      valueClusterMap[col][val] = Number(Object.entries(counts).sort(([, a], [, b]) => b - a)[0][0]);
    }
  }

  const idToLabel = {};
  clusterStats.forEach(s => { idToLabel[s.id] = s.label; });

  lines.push('DOMINANT GROUP PER VALUE:');
  for (const [col, mapping] of Object.entries(valueClusterMap)) {
    if (Object.keys(mapping).length) {
      const short = SHORT_COLUMN_NAMES[col] || col;
      const pairs = Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))
        .map(([v, c]) => `${v}→"${idToLabel[c] || `Group ${c}`}"`);
      lines.push(`  ${short}: ${pairs.join(', ')}`);
    }
  }

  return {
    summaryText: lines.join('\n'),
    clusterStats,
    clusteringInfo: {
      n_clusters: Object.keys(clusters).length,
      cluster_labels: responseData.map(d => d.cluster),
      value_cluster_map: valueClusterMap,
    },
  };
}

function buildInsightPrompt(query, responseData, clusterStats, weights, highlightMethods, ragText, kgContext, methodSummaries, branding = {}) {
  const methodNoun = branding.methodNoun || 'method';
  const subject = branding.productSubject || 'grasp planning';
  const compactClusters = clusterStats.map(cs =>
    `- ${cs.label} (${cs.size} ${methodNoun}s): ${cs.methods.slice(0, 5).join(', ')}`
  ).join('\n');

  return `You are an expert research assistant for a robotic ${subject} visualization tool. A researcher has queried the system and you have access to real data from academic papers and clustering analysis.

RESEARCHER'S QUESTION: "${query}"

EVIDENCE FROM PAPERS:
${ragText || '(No paper excerpts available for this query)'}

KNOWLEDGE GRAPH INSIGHTS:
${kgContext || '(No structured knowledge available)'}

RELEVANT METHODS IN THE DATASET:
${methodSummaries}

CLUSTERING RESULTS (${responseData.length} methods in ${clusterStats.length} groups):
${compactClusters}

Highlighted methods (most relevant to query): ${highlightMethods.slice(0, 6).join(', ')}

INSTRUCTIONS:
Write exactly 3-5 bullet points that answer the researcher's question. Each bullet must start with "- ".

Rules:
1. Lead with evidence from the paper excerpts. Quote specific techniques, equations, or results by paper name (e.g., "Contact-GraspNet uses a binary cross-entropy loss on predicted contact points").
2. When no paper excerpt covers a point, draw on the method metadata (planning approach, gripper type, etc.) to provide grounded analysis.
3. Connect findings to the clustering: explain why methods using similar approaches end up in the same group.
4. Be specific and technical. Avoid generic statements like "various methods use different approaches."
5. Never reference cluster numbers. Use group names like "the sampling-based parallel-jaw group."
6. Always use the exact method names as provided in the data (e.g., "Grasp Pose Detection (GPD)" not just "GPD", "Volumetric Grasping Network (VGN)" not just "VGN"). This ensures methods are correctly linked in the interface.
7. Do NOT use markdown formatting like **bold** or *italic*. Write plain text only. The interface has its own highlighting system that automatically color-codes technique names, method names, and domain terms.

Respond with ONLY the bullet points, nothing else.`;
}

function runGroundingCheck(insightText, methods, kgNodes) {
  const grounded = [];
  const ungrounded = [];

  const allKnown = new Set();
  methods.forEach(m => allKnown.add(m.name.replace(/\u{1F916}\s*/gu, '').trim().toLowerCase()));
  if (kgNodes) {
    kgNodes.forEach(n => {
      if (n.label) allKnown.add(n.label.toLowerCase());
    });
  }

  const mentions = new Set();
  // CamelCase or hyphenated method names
  const camelRe = /\b([A-Z][a-z]+(?:[-]?[A-Z][a-z]+)+(?:\+\+)?(?:\s*\([^)]+\))?)\b/g;
  let match;
  while ((match = camelRe.exec(insightText)) !== null) mentions.add(match[1]);
  // ALLCAPS acronyms
  const acroRe = /\b([A-Z]{2,6}(?:-[A-Z]+)?)\b/g;
  const skip = new Set(['RGB', 'RGBD', 'CNN', 'GNN', 'MLP', 'LLM', 'DOF', 'SAM', 'GPU',
    'CPU', 'PDF', 'API', 'IOU', 'MAP', 'BCE', 'MSE', 'SGD', 'IEEE',
    'ICRA', 'IROS', 'RSS', 'CVPR', 'ICLR', 'RAG', 'KG', 'HGT', 'RL', 'IL', 'SE', 'TSDF', 'BPS', 'FPS', 'NMS']);
  while ((match = acroRe.exec(insightText)) !== null) {
    if (!skip.has(match[1])) mentions.add(match[1]);
  }

  for (const mention of mentions) {
    const lower = mention.toLowerCase();
    const found = [...allKnown].some(known => known.length > 3 && (lower.includes(known) || known.includes(lower)));
    if (found) grounded.push(mention);
    else ungrounded.push(mention);
  }

  return { grounded, ungrounded };
}

function formatRagContext(chunks) {
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

export async function runAIQuery(query, allMethods, tfidfMatrices, descEmbeddings, queryKeywords, defaultK, domainOpts = {}) {
  const DEFAULT_WEIGHTS = domainOpts.defaultWeights || GRASP_DEFAULTS.defaultWeights;
  const domainBranding = domainOpts.branding || GRASP_DEFAULTS.branding;
  // Step 0: Spell correction
  const methodNames = allMethods.map(m => m.name);
  const { text: correctedQuery, corrected: wasSpellCorrected } = await spellCorrectQuery(query, queryKeywords, methodNames);
  const effectiveQuery = correctedQuery;

  // Step 1: Deterministic pipeline
  const { weights: newWeights, colorBy: newColorBy, filterMethods } =
    runQueryPipeline(effectiveQuery, DEFAULT_WEIGHTS, allMethods, queryKeywords);

  // Step 2: UMAP + clustering
  const methods = filterMethods
    ? allMethods.filter(m => filterMethods.includes(m.name))
    : allMethods;

  let recomputed;
  if (methods.length === 0) {
    recomputed = allMethods;
  } else {
    try {
      recomputed = recomputeUmap(tfidfMatrices, descEmbeddings, newWeights, methods, defaultK);
    } catch (e) {
      console.warn('UMAP recomputation failed, using original positions:', e);
      recomputed = methods;
    }
  }

  const highlightMethods = filterMethods || recomputed.slice(0, 8).map(m => m.name);
  const { summaryText, clusterStats, clusteringInfo } = buildClusterStats(recomputed, newWeights);
  const methodSummaries = buildMethodSummaries(recomputed);

  // Step 3: RAG retrieval (client-side)
  let ragText = '';
  let ragCitations = [];
  let ragAnalytics = {};
  try {
    const ragChunks = await loadRagChunks();
    if (ragChunks.length) {
      initChunks(ragChunks);
      // We need a query embedding for RAG search. For now, use intent-based filtering without embedding.
      // The chunks are scored by layer matching.
      const intent = classifyIntent(effectiveQuery);
      const queryWords = effectiveQuery.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const scored = ragChunks
        .filter(c => c.text)
        .map(c => {
          const text = c.text.toLowerCase();
          let score = 0;
          queryWords.forEach(w => { if (text.includes(w)) score += 1; });
          return { ...c, score: score / (queryWords.length || 1) };
        })
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      const formatted = formatRagContext(scored);
      ragText = formatted.ragText;
      ragCitations = formatted.ragCitations;

      const paperSet = new Set(scored.map(c => c.metadata?.paper_id).filter(Boolean));
      ragAnalytics = { papers: [...paperSet], totalChunks: scored.length };
    }
  } catch (e) {
    console.warn('RAG retrieval failed:', e);
  }

  // Step 4: KG context
  let kgContext = '';
  let kgTraversal = [];
  try {
    const kgData = await loadKgFull();
    if (kgData && kgData.nodes && kgData.nodes.length) {
      initGraph(kgData);
      // Find paper IDs related to the query methods
      const methodNames = highlightMethods.slice(0, 5);
      const paperIds = kgData.nodes
        .filter(n => n.type === 'paper' && methodNames.some(m =>
          (n.label || '').toLowerCase().includes(m.toLowerCase().replace(/[^a-z]/g, ''))
        ))
        .map(n => n.id);

      if (paperIds.length > 0) {
        const subgraph = extractSubgraph(paperIds);
        kgTraversal = [{
          step: 'subgraph',
          description: `Extracted subgraph around ${paperIds.length} papers`,
          detail: `${subgraph.nodes.length} nodes, ${subgraph.links.length} edges`,
          edges: subgraph.links,
          nodes: subgraph.nodes,
        }];

        // Build structured KG context
        const edgesByType = {};
        subgraph.links.forEach(e => {
          if (!edgesByType[e.type]) edgesByType[e.type] = [];
          edgesByType[e.type].push(e);
        });
        const contextParts = Object.entries(edgesByType).map(([type, edges]) =>
          `${type}: ${edges.length} relationships`
        );
        kgContext = contextParts.join('\n');
      }
    }
  } catch (e) {
    console.warn('KG context failed:', e);
  }

  // Step 5: LLM insight
  let insightText = '';
  let grounding = { grounded: [], ungrounded: [] };
  try {
    const prompt = buildInsightPrompt(
      effectiveQuery, recomputed, clusterStats, newWeights,
      highlightMethods, ragText, kgContext, methodSummaries, domainBranding
    );
    insightText = await llmChat([{ role: 'user', content: prompt }]);
    if (insightText.startsWith('```')) {
      const lines = insightText.split('\n');
      insightText = lines.slice(1, -1).join('\n');
    }

    // Guardrail: validate entity mentions
    try {
      const kgData = await loadKgFull();
      grounding = runGroundingCheck(insightText, allMethods, kgData?.nodes || []);
    } catch (e) {}
  } catch (llmErr) {
    insightText = `- Query processed. ${recomputed.length} methods shown.${filterMethods ? `\n- Filtered to: ${filterMethods.join(', ')}.` : ''}\n- (LLM unavailable: ${llmErr.message})`;
  }

  // Step 6: Traversal narrative
  let traversalNarrative = '';
  if (kgContext && kgTraversal.length) {
    try {
      const stepSummaries = kgTraversal
        .filter(s => s.step !== 'summary' && s.step !== 'query_intent' && s.edges?.length > 0)
        .map(s => `${s.description} (${s.detail})`);

      if (stepSummaries.length) {
        const narratePrompt =
          `A researcher asked: "${effectiveQuery}"\n\n` +
          `The knowledge graph traversal found:\n` +
          stepSummaries.map(s => `- ${s}`).join('\n') + '\n\n' +
          `Structured facts found:\n${kgContext}\n\n` +
          `Write 2-3 sentences explaining what the graph found and WHY it matters ` +
          `for the researcher's question. Be specific about paper names and techniques. ` +
          `Do not repeat the question. Start with the most important finding.\n\n` +
          `IMPORTANT: Do NOT use markdown formatting like **bold** or *italic*. ` +
          `Write plain text only. The interface has its own highlighting system.`;

        traversalNarrative = await llmChat(
          [{ role: 'user', content: narratePrompt }],
          { maxTokens: 300, temperature: 0.2 }
        );
      }
    } catch (e) {}
  }

  // Build method relevance scores
  const methodRelevance = recomputed.slice(0, 10).map(m => ({
    name: m.name,
    score: highlightMethods.includes(m.name) ? 0.9 : 0.5,
  }));

  return {
    success: true,
    umapData: recomputed,
    weights: newWeights,
    colorBy: newColorBy,
    filterMethods,
    highlightMethods,
    clusterStats,
    clustering: clusteringInfo,
    insight: insightText,
    grounding,
    ragCitations,
    ragAnalytics,
    methodRelevance,
    kgContext,
    kgTraversal,
    traversalNarrative: traversalNarrative || undefined,
    paperRelevance: methodRelevance,
    spellCorrection: wasSpellCorrected ? { original: query, corrected: effectiveQuery } : null,
  };
}
