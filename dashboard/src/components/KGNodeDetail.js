/**
 * KGNodeDetail — Detail panel for a selected graph node.
 *
 * For papers/methods, shows:
 *   - Method card (year, planning approach, hardware, input, scene)
 *   - Lineage: what this paper cites (predecessors) and what cites it (successors)
 *   - Connections grouped by type
 *
 * Surfaces method-comparability info for "which method should I adopt?" workflows.
 */

import React, { useState, useMemo, useEffect } from 'react';
import Tooltip from './Tooltip';
import { HighlightedText } from '../highlighter';

function trimToSentence(text) {
  if (!text) return text;
  let t = text.trim();
  // The extractor grabs a fixed-width window around the citation marker, so the
  // text often STARTS mid-word ("raining"→training, "pproaches"→approaches). Drop
  // that leading fragment: if it starts lowercase, jump to the next sentence start
  // (". A"), or failing that drop the leading partial word — so a quote never
  // begins mid-word.
  if (/^[a-z]/.test(t)) {
    const sent = t.match(/[.?!]\s+(?=[A-Z])/);
    if (sent && sent.index < t.length * 0.6) {
      t = t.slice(sent.index + sent[0].length);
    } else {
      const sp = t.indexOf(' ');
      if (sp > 0 && sp < 15) t = t.slice(sp + 1);
    }
  }
  // Trim a trailing partial sentence.
  const lastDot = t.lastIndexOf('.');
  const lastQ  = t.lastIndexOf('?');
  const lastEx = t.lastIndexOf('!');
  const cut = Math.max(lastDot, lastQ, lastEx);
  if (cut > t.length * 0.4) return t.slice(0, cut + 1);
  return t;
}

// Render a citation context, BOLDING the cited paper's own bracket. The extractor
// wraps that one reference in 【…】 so we can show WHICH bracket is this citation
// (the others in the sentence are co-cited and stay plain). Degrades to plain text
// when no marker is present (e.g. KG data built before the marker landed).
function renderCtx(text) {
  const t = trimToSentence(text);
  if (!t) return t;
  const parts = String(t).split(/【([^】]*)】/);
  if (parts.length === 1) return t;
  return parts.map((p, i) =>
    i % 2 === 1 ? <strong key={i} className="kgnd-cite-ref">{p}</strong> : p
  );
}

const TYPE_LABELS = {
  paper: 'Paper', method: 'Method', technique: 'Technique',
  claim: 'Claim', hardware: 'Hardware', attribute: 'Attribute',
  figure: 'Figure', table: 'Table',
  impl_language: 'Language', author: 'Author',
  institution: 'Institution', reference: 'External ref', equation: 'Equation',
};

const TYPE_COLORS = {
  paper: '#16657d', method: '#2563eb', technique: '#7c3aed',
  claim: '#8691a0', hardware: '#16794e',
  figure: '#d97706', table: '#0891b2',
  impl_language: '#6366f1', author: '#be185d',
  institution: '#0369a1', reference: '#94a3b8', equation: '#db2777',
};

const EDGE_LABELS = {
  uses_backbone: 'uses', uses_loss: 'uses loss',
  // trained_on is Groq-extracted from paper text (paper → technique:dataset) — it
  // indicates the paper *mentions* the dataset, not that the model is actually
  // trained on it. Ground-truth training/evaluation is CSV-driven `evaluated_on`.
  trained_on: 'discusses',
  uses_technique: 'uses', described_in: 'described in', cites: 'cites',
  outperforms: 'outperforms', uses_hardware: 'uses hardware',
  contributes: 'contributes', implements_step: 'implements',
  has_limitation: 'limitation', compares: 'compares',
  addresses_problem: 'addresses',
  authored_by: 'author', affiliated_with: 'affiliated with',
  published_from: 'from', cites_external: 'cites',
  has_equation: 'equation', has_figure: 'figure', has_table: 'table',
  evaluated_on: 'evaluated on',  // CSV-derived, ground truth
  uses_dataset: 'uses dataset',  // TEI table mining
  // Paper-paper relations that previously had no row labels because they
  // were only surfaced by the citation-lineage block (which only handled
  // `cites`). Hub papers like VGN have dozens of these and they were
  // silently dropped from the panel.
  cited_by_external: 'cited by',
  co_cited_with: 'co-cited with',
  semantically_similar: 'semantically similar to',
  shares_bibliography: 'shares bibliography with',
  compared_against: 'compared against',
  cites_external_back: 'cited by external',
};

// Friendly group titles for the relation-grouped connections section.
// Keys are edge types; rendering falls back to the edge type itself.
const RELATION_TITLES = {
  cites: 'Cites (in corpus)',
  cites_external: 'Cites (external references)',
  cited_by_external: 'Cited by external papers',
  outperforms: 'Outperforms',
  compared_against: 'Compared against',
  semantically_similar: 'Semantically similar',
  co_cited_with: 'Co-cited with',
  shares_bibliography: 'Shares bibliography',
  uses_technique: 'Techniques used',
  uses_backbone: 'Backbone',
  uses_loss: 'Loss',
  uses_hardware: 'Hardware',
  uses_dataset: 'Datasets',
  trained_on: 'Discussed datasets',
  evaluated_on: 'Evaluated on',
  has_table: 'Tables',
  has_figure: 'Figures',
  has_equation: 'Equations',
  authored_by: 'Authors',
  affiliated_with: 'Institutions',
  contributes: 'Contributions',
  has_limitation: 'Limitations',
  addresses_problem: 'Problems addressed',
  compares: 'Comparison claims',
  implements_step: 'Implementation steps',
  described_in: 'Described in',
};

// One-line plain-language explainer per edge type. Surfaces under the
// header on entity-typed detail panels (technique, hardware, dataset,
// author, institution, reference) so the user knows what "uses_technique"
// or "evaluated_on" actually means without leaving the panel.
const EDGE_EXPLAINERS = {
  uses_technique: 'Papers that mention this technique as part of their method.',
  uses_backbone:  'Papers that build their model on this backbone.',
  uses_loss:      'Papers that train with this loss function.',
  uses_hardware:  'Papers that ran experiments on this hardware.',
  uses_dataset:   'Papers that used this dataset.',
  trained_on:     'Papers that mention training on this dataset.',
  evaluated_on:   'Papers that benchmark against this dataset.',
  authored_by:    'Papers credited to this author.',
  affiliated_with:'Authors based at this institution.',
  published_from: 'Papers from this institution.',
  cited_by_external: 'External (non-corpus) papers that cite this work.',
  cites_external: 'This corpus paper cites this external reference.',
  cites:          'In-corpus citation between two papers.',
  contributes:    'Contributions claimed by the source paper.',
  has_limitation: 'Limitations claimed by the source paper.',
  addresses_problem: 'Problem the source paper addresses.',
  compares:       'Comparison claim made by the source paper.',
  has_table:      'Table extracted from the source paper.',
  has_figure:     'Figure extracted from the source paper.',
  has_equation:   'Equation extracted from the source paper.',
  described_in:   'Method described in this paper.',
};

// Order in which relation groups appear when shown. Anything not listed
// falls through to the end in count-desc order.
const RELATION_ORDER = [
  'outperforms', 'compared_against',
  'cited_by_external', 'cites', 'cites_external',
  'co_cited_with', 'semantically_similar', 'shares_bibliography',
  'uses_technique', 'uses_backbone', 'uses_loss', 'trained_on', 'uses_dataset', 'evaluated_on',
  'uses_hardware',
  'authored_by', 'affiliated_with',
  'contributes', 'has_limitation', 'addresses_problem', 'compares',
  'has_table', 'has_figure', 'has_equation',
  'described_in', 'implements_step',
];

// Parse a pipe-delimited markdown table into rows of cells.
// Returns null if text doesn't look like a table we can parse cleanly.
function parseMarkdownTable(text) {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    if (!line.includes('|')) continue;
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line)) continue; // separator
    const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.length >= 2) rows.push(cells);
  }
  if (rows.length < 2) return null;
  // Normalize column count
  const maxCols = Math.max(...rows.map(r => r.length));
  return rows.map(r => {
    while (r.length < maxCols) r.push('');
    return r.slice(0, maxCols);
  });
}

export default function KGNodeDetail({
  selection, onClose, onNodeClick, onHoverEntity,
  query, anchorNames, termDictionary,
  // Layout props — when the panel is rendered as a side panel beside the
  // graph (placement='side'), papers/methods default to a COMPACT view
  // (first subheading only) with an Expand button. expanded=true reveals
  // the full layout (overlay-wide panel). Non-paper nodes always render
  // their single subheading and ignore expanded/onToggleExpanded.
  placement = 'side',
  expanded = false,
  onToggleExpanded,
}) {
  const [expandedGroups, setExpandedGroups] = useState({});

  const { node, neighbors, edges } = selection || {};

  // Reset accordion state whenever the selected node changes.
  useEffect(() => { setExpandedGroups({}); }, [node]);

  // Role of this node in the current query's answer. Drives the eyebrow line
  // at the top of the panel — researchers should see at a glance why they
  // landed on this node.
  const queryRole = useMemo(() => {
    if (!node || !anchorNames || anchorNames.size === 0) return null;
    const labelMatch = anchorNames.has(node.label);
    if (labelMatch) {
      return { kind: 'anchor', text: 'Anchor for your query' };
    }
    // Does this node connect to any anchor?
    const connectedAnchors = new Set();
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      const otherId = sId === node.id ? tId : (tId === node.id ? sId : null);
      if (otherId == null) return;
      const other = (neighbors || []).find(n => n.id === otherId);
      if (other && anchorNames.has(other.label)) {
        connectedAnchors.add(other.label);
      }
    });
    if (connectedAnchors.size > 0) {
      const list = [...connectedAnchors].slice(0, 2).join(', ');
      const more = connectedAnchors.size > 2 ? ` +${connectedAnchors.size - 2}` : '';
      const verb = connectedAnchors.size > 1
        ? 'Shared by'
        : 'Connected to';
      return {
        kind: 'connected',
        text: `${verb} ${list}${more}`,
        anchors: [...connectedAnchors],
      };
    }
    return { kind: 'context', text: 'Supporting context — not directly answering your query' };
  }, [node, edges, neighbors, anchorNames]);

  // Group connections by RELATION (edge type) instead of just node type.
  // This is the only place the user can see paper↔paper relations like
  // `cited_by_external`, `outperforms`, `compared_against`, `co_cited_with`,
  // `semantically_similar`. Previously those edges were dropped because the
  // node-type grouping lumped every paper neighbor into one bucket which
  // was then hidden whenever any internal `cites` lineage existed.
  // Each entry is { type, neighbors: [{node, edge, direction}] } so the
  // renderer can show e.g. "Cited by external papers (18)".
  const connectionsByRelation = useMemo(() => {
    if (!node || !edges || !neighbors) return [];
    const byRelation = new Map();
    const neighborsById = new Map((neighbors || []).map(n => [n.id, n]));
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      let otherId;
      let direction;
      if (sId === node.id) { otherId = tId; direction = 'out'; }
      else if (tId === node.id) { otherId = sId; direction = 'in'; }
      else return;
      const other = neighborsById.get(otherId);
      if (!other) return;
      const type = e.type || 'other';
      if (!byRelation.has(type)) byRelation.set(type, []);
      byRelation.get(type).push({ node: other, edge: e, direction });
    });
    // Stable order: explicit RELATION_ORDER first, then anything else by
    // size descending. Within a group, dedupe neighbors so the same paper
    // doesn't appear twice if there are duplicate edge entries.
    const orderIndex = new Map(RELATION_ORDER.map((t, i) => [t, i]));
    const entries = [...byRelation.entries()].map(([type, arr]) => {
      const seen = new Set();
      const deduped = arr.filter(item => {
        if (seen.has(item.node.id)) return false;
        seen.add(item.node.id);
        return true;
      });
      return [type, deduped];
    });
    entries.sort((a, b) => {
      const ai = orderIndex.has(a[0]) ? orderIndex.get(a[0]) : 1000 + (-a[1].length);
      const bi = orderIndex.has(b[0]) ? orderIndex.get(b[0]) : 1000 + (-b[1].length);
      return ai - bi;
    });
    return entries;
  }, [node, edges, neighbors]);

  // ── Derived sets used by the Calli-style spec card and the narrative
  //    block. These pull values out of `neighbors`/`edges` so we can
  //    present the COMPARE-shaped table at the top instead of relegating
  //    the same info to a "Method Profile" card later in the panel.
  const paperFacts = useMemo(() => {
    if (!node) return {};
    // Find linked method node (paper -- described_in --> method).
    const linkedMethod = (neighbors || []).find(n => n.type === 'method');
    const meta = (linkedMethod && linkedMethod.meta) || node.meta || {};
    const authors = (neighbors || [])
      .filter(n => n.type === 'author')
      .map(n => n.label);
    const institutions = (neighbors || [])
      .filter(n => n.type === 'institution')
      .map(n => n.label);
    // Techniques are split by sub-edge-type so the chip ribbon can label
    // each group (Backbone / Technique / Loss). Earlier these three were
    // collapsed into one bucket, which meant a chip like "Binary CE"
    // rendered identically to "PointNet" even though one is a loss and
    // the other a backbone.
    const techniqueGroups = { backbone: [], technique: [], loss: [] };
    const benchmarks = [];
    const hardware = [];
    const datasets = [];
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      const otherId = sId === node.id ? tId : (tId === node.id ? sId : null);
      if (!otherId) return;
      const other = (neighbors || []).find(n => n.id === otherId);
      if (!other) return;
      if (e.type === 'uses_backbone') techniqueGroups.backbone.push(other.label);
      else if (e.type === 'uses_loss') techniqueGroups.loss.push(other.label);
      else if (e.type === 'uses_technique') techniqueGroups.technique.push(other.label);
      else if (e.type === 'evaluated_on') benchmarks.push(other.label);
      else if (e.type === 'uses_dataset' || e.type === 'trained_on') datasets.push(other.label);
      else if (e.type === 'uses_hardware') hardware.push(other.label);
    });
    // Stable dedupe + a flat techniques list (keeps any code that still
    // peeks at .techniques.length working without forcing every reader
    // to re-implement the union).
    const uniq = arr => Array.from(new Set(arr));
    const dedupedGroups = {
      backbone: uniq(techniqueGroups.backbone),
      technique: uniq(techniqueGroups.technique),
      loss: uniq(techniqueGroups.loss),
    };
    const techniques = uniq([
      ...dedupedGroups.backbone,
      ...dedupedGroups.technique,
      ...dedupedGroups.loss,
    ]);
    return {
      meta,
      authors: uniq(authors),
      institutions: uniq(institutions),
      techniques,
      techniqueGroups: dedupedGroups,
      benchmarks: uniq(benchmarks),
      datasets: uniq(datasets),
      hardware: uniq(hardware),
      year: meta.year || node.year,
    };
  }, [node, neighbors, edges]);

  // Pull contribution / limitation / problem claim nodes the paper has, so
  // the narrative block can render a 3-column "what this paper says about
  // itself" view. Each claim node carries a `value` (sentence-level claim
  // text) and an optional subtype.
  const claimSets = useMemo(() => {
    const sets = { contribution: [], limitation: [], problem: [] };
    const addClaim = (other, edgeType) => {
      if (edgeType === 'contributes' && other.type === 'contribution') {
        sets.contribution.push(other);
      } else if (edgeType === 'has_limitation' && other.type === 'limitation') {
        sets.limitation.push(other);
      } else if (edgeType === 'addresses_problem' && other.type === 'problem') {
        sets.problem.push(other);
      }
    };
    // Primary source: in-graph edges from Cytoscape selection
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      if (sId !== node?.id) return;
      const other = (neighbors || []).find(n => n.id === tId);
      if (!other) return;
      addClaim(other, e.type);
    });
    return sets;
  }, [node, edges, neighbors]);

  // Asymmetric "Compared with" rail: outperforms / compared_against /
  // semantically_similar. These are the rows that carry a TEI-table pull
  // quote when the model picked them up from a structured benchmark
  // table; we render that quote inline so the panel earns the KG work
  // visually instead of just listing types.
  const comparedWith = useMemo(() => {
    if (!node) return [];
    const rows = [];
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      let otherId, direction;
      if (sId === node.id) { otherId = tId; direction = 'out'; }
      else if (tId === node.id) { otherId = sId; direction = 'in'; }
      else return;
      const other = (neighbors || []).find(n => n.id === otherId);
      if (!other) return;
      if (!['outperforms', 'compared_against', 'semantically_similar'].includes(e.type)) return;
      rows.push({
        other,
        type: e.type,
        direction,
        metric: e.metric,
        margin: e.margin,
        winner_value: e.winner_value,
        loser_value: e.loser_value,
        table_caption: e.table_caption,
      });
    });
    return rows;
  }, [node, edges, neighbors]);

  // Citation timeline: per-year bins of citation events, stacked by
  // stance. Pulled from `cites` (in-corpus, stance from TEI), `cited_by_external`
  // (S2-derived, no stance), and `cites_external`. The timeline tells a
  // researcher when this paper was active in the citation web and how
  // its reception evolved — replacing the previous one-line hub summary
  // with something worth looking at.
  const citeTimeline = useMemo(() => {
    if (!node || !edges || !neighbors) return null;
    const byYear = new Map(); // year → { builds_on, neutral, differs_from, external }
    const neighborsById = new Map((neighbors || []).map(n => [n.id, n]));
    const recordYear = (yr, key) => {
      if (!Number.isFinite(yr) || yr < 1990 || yr > 2030) return;
      if (!byYear.has(yr)) byYear.set(yr, { builds_on: 0, neutral: 0, differs_from: 0, external: 0 });
      byYear.get(yr)[key] = (byYear.get(yr)[key] || 0) + 1;
    };
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      const otherId = sId === node.id ? tId : (tId === node.id ? sId : null);
      if (!otherId) return;
      const other = neighborsById.get(otherId);
      if (!other) return;
      const yr = Number.parseInt(String(other.year || other.meta?.year || '').match(/\d{4}/)?.[0] || '', 10);
      if (e.type === 'cites' || e.type === 'cites_external') {
        recordYear(yr, e.sentiment || 'neutral');
      } else if (e.type === 'cited_by_external') {
        recordYear(yr, 'external');
      }
    });
    if (byYear.size === 0) return null;
    const years = [...byYear.keys()].sort();
    const yMin = years[0]; const yMax = years[years.length - 1];
    const bars = [];
    for (let y = yMin; y <= yMax; y += 1) {
      const v = byYear.get(y) || { builds_on: 0, neutral: 0, differs_from: 0, external: 0 };
      bars.push({ year: y, ...v, total: v.builds_on + v.neutral + v.differs_from + v.external });
    }
    const peak = Math.max(...bars.map(b => b.total), 1);
    return { yMin, yMax, bars, peak };
  }, [node, edges, neighbors]);

  // ── Entity detail: universal pattern for non-paper node types
  // (technique, hardware, dataset, author, institution, reference,
  // claim subtypes, figure/table/equation). Computes:
  //   - the dominant relation type connecting this entity to papers
  //     (so the header reads "Used by N papers" / "From N papers" / etc.)
  //   - the list of connected papers (clickable, dedupe by id)
  //   - year range, top co-occurring nodes (only meaningful for technique)
  //   - the edge-type explainer line
  // Returns null if there's literally nothing to show — caller (the
  // hasContent gate below) uses that to decide whether to render at all.
  const entityDetail = useMemo(() => {
    if (!node || !edges || !neighbors) return null;
    if (node.type === 'paper' || node.type === 'method') return null; // those use the rich paper layout
    const neighborsById = new Map((neighbors || []).map(n => [n.id, n]));
    const connectedPapers = []; // { paper, edgeType, direction }
    const otherNeighbors = [];  // non-paper connections
    const edgeTypeCounts = {};
    (edges || []).forEach(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      let otherId, direction;
      if (sId === node.id) { otherId = tId; direction = 'out'; }
      else if (tId === node.id) { otherId = sId; direction = 'in'; }
      else return;
      const other = neighborsById.get(otherId);
      if (!other) return;
      const t = e.type || 'other';
      edgeTypeCounts[t] = (edgeTypeCounts[t] || 0) + 1;
      if (other.type === 'paper' || other.type === 'method') {
        connectedPapers.push({ paper: other, edgeType: t, direction });
      } else {
        otherNeighbors.push({ node: other, edgeType: t, direction });
      }
    });
    // Group papers by edge type — that's where the signal is. A
    // technique connected to 12 papers via a mix of uses_backbone /
    // uses_technique / uses_loss tells you HOW it's used, not just
    // that it's used. Within a group, dedupe by paper id (a paper that
    // uses the same technique twice in different sections still shows
    // once per group). Across groups, the same paper can appear if it
    // genuinely uses the entity at multiple "levels" (e.g. PointNet as
    // both backbone and a referenced technique).
    const papersByRelation = new Map();
    const seenPerRelation = new Map(); // edgeType -> Set<paperId>
    connectedPapers.forEach(({ paper, edgeType, direction }) => {
      if (!papersByRelation.has(edgeType)) papersByRelation.set(edgeType, []);
      if (!seenPerRelation.has(edgeType)) seenPerRelation.set(edgeType, new Set());
      const seen = seenPerRelation.get(edgeType);
      if (seen.has(paper.id)) return;
      seen.add(paper.id);
      papersByRelation.get(edgeType).push({ paper, edge: { type: edgeType }, direction });
    });
    // Total unique papers across all relations (drives the header count).
    const allPaperIds = new Set();
    connectedPapers.forEach(({ paper }) => allPaperIds.add(paper.id));
    const dedupedPapers = [...allPaperIds].map(pid => ({
      paper: connectedPapers.find(c => c.paper.id === pid).paper,
    }));
    // Dominant edge type → drives the header verb.
    const dominantEdgeType = Object.entries(edgeTypeCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    // Order relations by frequency descending; this is what the panel
    // walks to render the per-relation sections.
    const relationOrder = [...papersByRelation.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k]) => k);
    // Year span over connected papers
    const years = dedupedPapers
      .map(({ paper }) => Number.parseInt(String(paper.year || paper.meta?.year || '').match(/\d{4}/)?.[0] || '', 10))
      .filter(y => Number.isFinite(y) && y >= 1990 && y <= 2030);
    const yearMin = years.length ? Math.min(...years) : null;
    const yearMax = years.length ? Math.max(...years) : null;
    // For techniques: top 3 co-occurring techniques (techniques used
    // by the same papers as this one)
    let coOccurring = [];
    if (node.type === 'technique' && dedupedPapers.length > 0) {
      const occCounts = {};
      const paperIds = new Set(dedupedPapers.map(p => p.paper.id));
      (edges || []).forEach(e => {
        if (e.type !== 'uses_technique' && e.type !== 'uses_backbone' && e.type !== 'uses_loss') return;
        const sId = typeof e.source === 'object' ? e.source.id : e.source;
        const tId = typeof e.target === 'object' ? e.target.id : e.target;
        const paperId = sId === node.id ? null : (paperIds.has(sId) ? sId : (paperIds.has(tId) ? tId : null));
        const techId = tId === node.id ? null : (paperIds.has(tId) ? sId : (paperIds.has(sId) ? tId : null));
        if (!paperId || !techId) return;
        const tech = neighborsById.get(techId);
        if (!tech || tech.id === node.id) return;
        occCounts[tech.id] = occCounts[tech.id] || { node: tech, count: 0 };
        occCounts[tech.id].count += 1;
      });
      coOccurring = Object.values(occCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
    }
    return {
      dominantEdgeType,
      connectedPapers: dedupedPapers,
      papersByRelation,
      relationOrder,
      otherNeighbors,
      yearMin,
      yearMax,
      coOccurring,
      explainer: dominantEdgeType ? EDGE_EXPLAINERS[dominantEdgeType] : null,
    };
  }, [node, edges, neighbors]);

  // Header verb for non-paper entities. Different relations read
  // differently: "Used by N papers" vs "Cited by N papers" vs "From N papers".
  const entityHeaderText = useMemo(() => {
    if (!entityDetail) return null;
    const n = entityDetail.connectedPapers.length;
    if (n === 0) return null;
    const t = entityDetail.dominantEdgeType;
    const word = n === 1 ? 'paper' : 'papers';
    if (t === 'authored_by') return `Authored ${n} ${word}`;
    if (t === 'affiliated_with' || t === 'published_from') return `${n} ${word} from this institution`;
    if (t === 'cited_by_external') return `Cited by ${n} external ${word}`;
    if (t === 'has_table' || t === 'has_figure' || t === 'has_equation') return `Extracted from ${n} ${word}`;
    if (t === 'contributes' || t === 'has_limitation' || t === 'addresses_problem' || t === 'compares') return `Claimed by ${n} ${word}`;
    if (t === 'evaluated_on' || t === 'trained_on' || t === 'uses_dataset') return `Used by ${n} ${word}`;
    if (t === 'uses_technique' || t === 'uses_backbone' || t === 'uses_loss') return `Used by ${n} ${word}`;
    if (t === 'uses_hardware') return `Used by ${n} ${word}`;
    if (t === 'described_in') return `Described in ${n} ${word}`;
    if (t === 'cites_external') return `Cited by ${n} corpus ${word}`;
    return `Connected to ${n} ${word}`;
  }, [entityDetail]);

  // Count of documented connections for the provenance footer.
  const provenance = useMemo(() => {
    return { observed: (edges || []).length };
  }, [edges]);

  // Hub summary: when a node has many connections, the "X of many" list is
  // hard to read at a glance. Surface aggregate stats — top connected
  // type and a year histogram pulled from neighbors carrying a year — so
  // the user gets the shape of the hub before drilling into individual rows.
  const hubSummary = useMemo(() => {
    const all = neighbors || [];
    const HUB_THRESHOLD = 20;
    if (all.length < HUB_THRESHOLD) return null;
    // Top connected type + count
    const typeCounts = {};
    all.forEach(n => {
      const t = n.type || 'other';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
    // Year histogram from any neighbor carrying a `year` (papers + refs do).
    // Skip values like 'nan' / 0 / non-numeric.
    const years = [];
    all.forEach(n => {
      const y = n.year ?? n.meta?.year;
      const num = Number.parseInt(String(y || '').match(/\d{4}/)?.[0] || '', 10);
      if (Number.isFinite(num) && num >= 1990 && num <= 2030) years.push(num);
    });
    let yearMin = null, yearMax = null, hist = null;
    if (years.length >= 3) {
      yearMin = Math.min(...years);
      yearMax = Math.max(...years);
      const buckets = {};
      years.forEach(y => { buckets[y] = (buckets[y] || 0) + 1; });
      const range = yearMax - yearMin;
      const peakCount = Math.max(...Object.values(buckets));
      hist = [];
      for (let y = yearMin; y <= yearMax; y += 1) {
        hist.push({ year: y, count: buckets[y] || 0 });
      }
      // Cap to a reasonable bar count so the strip stays readable.
      if (hist.length > 16) {
        // Bin by 2-year groups when the range is wide.
        const step = Math.ceil(hist.length / 16);
        const binned = [];
        for (let i = 0; i < hist.length; i += step) {
          const slice = hist.slice(i, i + step);
          const ys = slice.map(h => h.year);
          const c = slice.reduce((s, h) => s + h.count, 0);
          binned.push({
            year: ys[0] === ys[ys.length - 1] ? `${ys[0]}` : `${ys[0]}–${ys[ys.length - 1]}`,
            count: c,
          });
        }
        hist = binned;
      }
      // Normalize bar heights to peak.
      const maxC = Math.max(...hist.map(b => b.count), 1);
      hist = hist.map(b => ({ ...b, h: Math.max(0.05, b.count / maxC) }));
      void range; void peakCount;
    }
    return { total: all.length, topType, yearMin, yearMax, hist };
  }, [neighbors]);

  // Separate citation lineage, carrying stance + in-text context from TEI
  const lineage = useMemo(() => {
    if (!node) return { citesOut: [], citesIn: [], stanceCounts: { builds_on: 0, neutral: 0, differs_from: 0 } };
    const citesOut = []; // papers THIS node cites (predecessors/influences)
    const citesIn = [];  // papers that cite THIS node (successors/descendants)
    const stanceCounts = { builds_on: 0, neutral: 0, differs_from: 0 };

    (edges || []).forEach(e => {
      if (e.type !== 'cites') return;
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      const enriched = {
        sentiment: e.sentiment || 'neutral',
        contexts: e.contexts || [],
        mentions: e.mentions || 0,
      };

      if (src === node.id) {
        const target = (neighbors || []).find(n => n.id === tgt);
        if (target) {
          citesOut.push({ ...target, ...enriched });
          stanceCounts[enriched.sentiment] = (stanceCounts[enriched.sentiment] || 0) + 1;
        }
      } else if (tgt === node.id) {
        const source = (neighbors || []).find(n => n.id === src);
        if (source) {
          citesIn.push({ ...source, ...enriched });
        }
      }
    });
    return { citesOut, citesIn, stanceCounts };
  }, [node, edges, neighbors]);

  if (!selection) return null;

  const hasLineage = lineage.citesOut.length > 0 || lineage.citesIn.length > 0;

  const toggleGroup = (key) => {
    setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const INITIAL_SHOW = 5;

  // Final gate: does this node have ANY meaningful content to show? If
  // not, return null so the panel literally doesn't open. Reason: an
  // empty panel for a node with no surfaceable info reads as "the app
  // is broken." Better to do nothing.
  const hasContent = (() => {
    if (node.type === 'paper' || node.type === 'method') return true; // rich layout always renders
    if (entityDetail && entityDetail.connectedPapers.length > 0) return true;
    if (node.value && node.value !== node.label) return true; // claim/equation/reference text
    if (Array.isArray(node.cells) && node.cells.length > 0) return true; // table cells
    if (node.latex) return true;
    return false;
  })();
  if (!hasContent) return null;

  // The paper-only sections (spec card, compared-with rail, chip ribbons,
  // narrative block, lineage + timeline) all assume the clicked node is
  // a paper or its 1:1 method twin. For any other node type the entity
  // block above is the entire panel content. Gate each paper-only block
  // on this flag so technique / hardware / dataset / author / institution
  // / reference / claim / figure / table / equation nodes don't leak
  // paper-shaped content. Found by: clicking a technique node and seeing
  // the chip ribbon stuff connected papers in as if they were techniques.
  const isPaper = node.type === 'paper' || node.type === 'method';

  // Compact key/value pairs for the spec card. Order follows the COMPARE
  // grasp-planning sheet (robot-manipulation.org) so a roboticist's eye
  // lands on the same fields they already scan there.
  const specRows = isPaper ? [
    { key: 'Input',         value: paperFacts.meta?.input },
    { key: 'Output',        value: paperFacts.meta?.output },
    { key: 'End-effector',  value: paperFacts.meta?.effector },
    { key: 'Object config', value: paperFacts.meta?.scene },
    { key: 'Planning',      value: paperFacts.meta?.planning },
    { key: 'Training',      value: paperFacts.meta?.training },
    { key: 'Datasets',      value: paperFacts.datasets.length ? paperFacts.datasets.join(', ') : null },
    { key: 'Hardware',      value: paperFacts.hardware.length ? paperFacts.hardware.join(', ') : null },
  ].filter(r => r.value && r.value !== 'nan' && r.value !== 'undefined') : [];
  const hasSpec = specRows.length > 0;

  const isCompact = false;

  return (
    <div className={`kgnd-panel ${placement === 'side' ? 'kgnd-panel-side' : ''} ${expanded ? 'kgnd-panel-expanded' : ''}`}>
      {/* Header bar — title + (Expand toggle, paper/method only) + close.
          The full identity (year, authors, venue, institution) sits in a
          thin strip below to keep the dark banner reserved for the title
          alone. */}
      <div className="detail-panel-header">
        <h3>{node.label}</h3>
        <div className="kgnd-panel-actions">
          {isPaper && onToggleExpanded && placement === 'side' && (
            <button
              className="kgnd-panel-expand"
              onClick={onToggleExpanded}
              title="Open full-width view below the graph for the complete 2-column layout"
            >
              ↗ Expand
            </button>
          )}
          {placement === 'bottom' && onToggleExpanded && (
            <button
              className="kgnd-panel-expand"
              onClick={onToggleExpanded}
              title="Collapse back to the side panel"
            >
              ↙ Collapse
            </button>
          )}
          <button className="kgnd-panel-close" onClick={onClose}>&times;</button>
        </div>
      </div>

      <div className="detail-panel-body">
        {/* Identity strip — Calli's spreadsheet-style "what is this thing"
            line: year · venue · authors · institution. Single row, no
            decoration. The `kgnd-id-strip` class is read by the body grid
            in App.css to span full width. */}
        <div className="kgnd-id-strip">
          <span className="kgnd-id-type" style={{ background: TYPE_COLORS[node.type] || '#8691a0' }}>
            {TYPE_LABELS[node.type] || node.type}
          </span>
          {paperFacts.year && <span className="kgnd-id-fact">{paperFacts.year}</span>}
          {paperFacts.authors.length > 0 && (
            <span className="kgnd-id-fact kgnd-id-authors">
              {paperFacts.authors.slice(0, 3).join(', ')}
              {paperFacts.authors.length > 3 && ` +${paperFacts.authors.length - 3}`}
            </span>
          )}
          {paperFacts.institutions.length > 0 && (
            <span className="kgnd-id-fact kgnd-id-inst">
              {paperFacts.institutions.slice(0, 2).join(' · ')}
            </span>
          )}
          <span className="kgnd-id-degree">
            {`${(neighbors || []).length} edges`}
          </span>
        </div>

        {/* Why this node is in your query's subgraph */}
        {queryRole && (
          <div className={`kgnd-role kgnd-role-${queryRole.kind}`}>
            <span className="kgnd-role-dot" aria-hidden />
            <span className="kgnd-role-text">{queryRole.text}</span>
            {query && <span className="kgnd-role-query">"{query}"</span>}
          </div>
        )}

        {/* Entity detail block — non-paper nodes (technique, hardware,
            dataset, author, institution, reference, claim subtypes,
            figures/tables/equations). Single universal pattern: a
            header verb + optional explainer + connected-papers list +
            optional co-occurring chips + year span. The hasContent
            gate above guarantees we only render when this list has
            entries or the node carries text/cells/latex. */}
        {entityDetail && entityHeaderText && (
          <div className="kgnd-entity">
            <div className="kgnd-entity-head">
              <span className="kgnd-entity-count">{entityHeaderText}</span>
              {entityDetail.yearMin && entityDetail.yearMax && (
                <span className="kgnd-entity-years">
                  {entityDetail.yearMin === entityDetail.yearMax
                    ? entityDetail.yearMin
                    : `${entityDetail.yearMin}–${entityDetail.yearMax}`}
                </span>
              )}
            </div>
            {entityDetail.coOccurring.length > 0 && (
              <div className="kgnd-entity-cooccur">
                <span className="kgnd-entity-cooccur-label">Often appears with</span>
                <div className="kgnd-chips">
                  {entityDetail.coOccurring.map(({ node: n, count }, i) => (
                    <span
                      key={i}
                      className="kgnd-chip kgnd-chip-tech"
                      onClick={() => onNodeClick && onNodeClick(n)}
                      title={`Co-occurs in ${count} ${count === 1 ? 'paper' : 'papers'}`}
                    >
                      {n.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* Per-edge-type sections — the signal is HOW the entity is
                used (backbone vs. mentioned technique vs. loss), not just
                a flat paper list. Each group has its own header, the
                explainer line for that relation, and a collapsible list
                of papers under it. */}
            {entityDetail.relationOrder.map(relationType => {
              const items = entityDetail.papersByRelation.get(relationType) || [];
              if (items.length === 0) return null;
              const titleVerb = (function () {
                switch (relationType) {
                  case 'uses_backbone':    return 'Used as backbone';
                  case 'uses_technique':   return 'Used as technique component';
                  case 'uses_loss':        return 'Used as loss';
                  case 'uses_dataset':     return 'Used as dataset';
                  case 'trained_on':       return 'Mentioned for training';
                  case 'evaluated_on':     return 'Used for evaluation';
                  case 'uses_hardware':    return 'Used as hardware';
                  case 'authored_by':      return 'Papers authored';
                  case 'affiliated_with':  return 'Papers affiliated';
                  case 'published_from':   return 'Papers from this institution';
                  case 'cited_by_external':return 'Cited by external papers';
                  case 'cites_external':   return 'External reference cited by';
                  case 'has_table':        return 'Source paper (table)';
                  case 'has_figure':       return 'Source paper (figure)';
                  case 'has_equation':     return 'Source paper (equation)';
                  case 'contributes':      return 'Claimed by';
                  case 'has_limitation':   return 'Claimed by';
                  case 'addresses_problem':return 'Claimed by';
                  case 'compares':         return 'Claimed by';
                  case 'described_in':     return 'Described in';
                  default: return RELATION_TITLES[relationType] || relationType;
                }
              })();
              const expandKey = `entityRel-${relationType}`;
              const isExpanded = !!expandedGroups[expandKey];
              const showCount = isExpanded ? items.length : 5;
              const explainer = EDGE_EXPLAINERS[relationType];
              return (
                <div key={relationType} className="kgnd-entity-rel">
                  <div className="kgnd-entity-rel-head">
                    <span className="kgnd-entity-rel-title">{titleVerb}</span>
                    <span className="kgnd-entity-rel-count">{items.length}</span>
                  </div>
                  {explainer && (
                    <div className="kgnd-entity-rel-explainer">{explainer}</div>
                  )}
                  <div className="kgnd-entity-papers">
                    {items.slice(0, showCount).map(({ paper }, i) => (
                      <div
                        key={i}
                        className="kgnd-entity-paper"
                        onClick={() => onNodeClick && onNodeClick(paper)}
                        onMouseEnter={() => onHoverEntity && onHoverEntity(paper)}
                        onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                      >
                        {paper.label}
                      </div>
                    ))}
                  </div>
                  {items.length > 5 && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup(expandKey)}>
                      {isExpanded ? 'Show less' : `Show all ${items.length}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* HERO — Method spec card. Two-column key/value grid in the
            COMPARE column order. This is the first thing a roboticist
            wants to see when comparing methods, so it earns the visual
            weight here instead of being relegated below the graph. */}
        {hasSpec && (
          <div className="kgnd-spec-card kgnd-slot-left">
            <div className="kgnd-spec-eyebrow">Method spec</div>
            <div className="kgnd-spec-grid">
              {specRows.map(({ key, value }) => (
                <div key={key} className="kgnd-spec-row">
                  <span className="kgnd-spec-key">{key}</span>
                  <span className="kgnd-spec-val">{value}</span>
                </div>
              ))}
            </div>
            {paperFacts.meta?.description && paperFacts.meta.description !== 'nan' && (
              <p className="kgnd-spec-desc">
                <HighlightedText
                  text={paperFacts.meta.description}
                  termDictionary={termDictionary}
                  query={query}
                />
              </p>
            )}
          </div>
        )}

        {/* Compared-with rail — outperforms / compared_against / semantic
            similarity, with TEI-table provenance inline as a pull quote
            when the edge carries it. This is the move that pays for the
            table extractor visually: the user sees the actual metric and
            margin that drove the relation, not just the relation type. */}
        {!isCompact && isPaper && comparedWith.length > 0 && (() => {
          const cwKey = 'comparedWith';
          const cwExpanded = !!expandedGroups[cwKey];
          const CW_INITIAL = 8;
          const cwVisible = cwExpanded ? comparedWith : comparedWith.slice(0, CW_INITIAL);
          const cwHasMore = comparedWith.length > CW_INITIAL;
          return (
          <div className="kgnd-compared kgnd-slot-right">
            <div className="kgnd-compared-eyebrow">
              Compared with
              <span className="kgnd-compared-count"> · {comparedWith.length}</span>
            </div>
            {cwVisible.map((row, i) => {
              const arrow = row.direction === 'out' ? '→'
                : row.direction === 'in' ? '←'
                : '↔';
              const verb = row.type === 'outperforms'
                ? (row.direction === 'in' ? 'outperformed by' : 'outperforms')
                : row.type === 'compared_against'
                  ? 'compared against'
                  : 'similar to';
              return (
                <div
                  key={i}
                  className={`kgnd-cmp-row kgnd-cmp-${row.type}`}
                  onClick={() => onNodeClick && onNodeClick(row.other)}
                  onMouseEnter={() => onHoverEntity && onHoverEntity(row.other)}
                  onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                >
                  <span className="kgnd-cmp-arrow">{arrow}</span>
                  <span className="kgnd-cmp-target">{row.other.label}</span>
                  <span className="kgnd-cmp-verb">{verb}</span>
                  {row.metric && (
                    <span className="kgnd-cmp-metric">
                      {row.metric}
                      {typeof row.winner_value === 'number' && typeof row.loser_value === 'number' && (
                        <span className="kgnd-cmp-values">
                          {' '}{row.winner_value} vs {row.loser_value}
                        </span>
                      )}
                    </span>
                  )}
                  {row.table_caption && (
                    <div className="kgnd-cmp-quote">"{row.table_caption}"</div>
                  )}
                </div>
              );
            })}
            {cwHasMore && (
              <button
                className="kgnd-show-all"
                onClick={() => setExpandedGroups(g => ({ ...g, [cwKey]: !cwExpanded }))}
              >
                {cwExpanded ? `Show top ${CW_INITIAL}` : `Show all ${comparedWith.length}`}
              </button>
            )}
          </div>
          );
        })()}


        {/* Description / Table body / Equation / External ref */}
        {(() => {
          // Structured table cells from TEI (preferred)
          if (node.type === 'table' && Array.isArray(node.cells) && node.cells.length > 0) {
            const [head, ...body] = node.cells;
            return (
              <div className="kgnd-table-wrap">
                {node.caption && <div className="kgnd-table-caption">{node.caption}</div>}
                <table className="kgnd-table">
                  <thead><tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                  <tbody>
                    {body.map((r, i) => (
                      <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                {node.paper_id && (
                  <div className="kgnd-table-source">From paper: <strong>{node.paper_id}</strong></div>
                )}
              </div>
            );
          }
          // Equation: render latex monospaced
          if (node.type === 'equation' && node.latex) {
            return <pre className="kgnd-equation">{node.latex}</pre>;
          }
          // External reference: structured citation card
          if (node.type === 'reference') {
            return (
              <div className="kgnd-reference">
                {Array.isArray(node.authors) && node.authors.length > 0 && (
                  <div className="kgnd-ref-authors">{node.authors.join(', ')}</div>
                )}
                <div className="kgnd-ref-title">{node.label}</div>
                <div className="kgnd-ref-meta">
                  {node.year && <span>{node.year}</span>}
                  {node.venue && <span>{node.venue}</span>}
                  {node.doi && <a href={`https://doi.org/${node.doi}`} target="_blank" rel="noreferrer">DOI</a>}
                  {node.arxiv && <a href={`https://arxiv.org/abs/${node.arxiv}`} target="_blank" rel="noreferrer">arXiv</a>}
                </div>
              </div>
            );
          }
          // Author: show institution
          if (node.type === 'author' && node.institution) {
            return <p className="detail-description"><strong>Institution:</strong> {node.institution}</p>;
          }
          // Fallback: legacy markdown parse for pre-TEI tables, else plain text
          if (node.value && node.value !== node.label) {
            const tableRows = node.type === 'table' ? parseMarkdownTable(node.value) : null;
            if (tableRows) {
              const [head, ...body] = tableRows;
              return (
                <div className="kgnd-table-wrap">
                  <table className="kgnd-table">
                    <thead><tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                    <tbody>
                      {body.map((r, i) => (
                        <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {node.paper_id && (
                    <div className="kgnd-table-source">From paper: <strong>{node.paper_id}</strong></div>
                  )}
                </div>
              );
            }
            return (
              <p className="detail-description">
                <HighlightedText text={node.value} termDictionary={termDictionary} query={query} />
              </p>
            );
          }
          return null;
        })()}

        {/* Chip ribbons — Techniques / Benchmarks. Hardware was previously
            duplicated here AND in the spec card; per the no-redundant-info
            rule the spec card carries it (Calli's COMPARE mental model)
            and chips stay for the scan-and-filter affordances. Tufte
            data-ink ratio: don't repeat ink that already exists. */}
        {isPaper && (paperFacts.techniques.length + paperFacts.benchmarks.length) > 0 && (
          <div className="kgnd-ribbons kgnd-slot-left">
            {paperFacts.techniques.length > 0 && (
              <div className="kgnd-ribbon">
                <span className="kgnd-ribbon-label">Techniques</span>
                {/* Sub-grouped by edge type so the user can tell whether
                    something like "Binary CE" is a backbone, a method
                    component, or a loss. Sub-headers are inline pills
                    with a small colon; only renders for groups that have
                    chips. */}
                <div className="kgnd-chip-subgroups">
                  {paperFacts.techniqueGroups.backbone.length > 0 && (
                    <div className="kgnd-chip-subgroup">
                      <span className="kgnd-chip-subgroup-label">Backbone</span>
                      <div className="kgnd-chips">
                        {paperFacts.techniqueGroups.backbone.map((t, i) => (
                          <span key={i} className="kgnd-chip kgnd-chip-tech">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {paperFacts.techniqueGroups.technique.length > 0 && (
                    <div className="kgnd-chip-subgroup">
                      <span className="kgnd-chip-subgroup-label">Technique</span>
                      <div className="kgnd-chips">
                        {paperFacts.techniqueGroups.technique.map((t, i) => (
                          <span key={i} className="kgnd-chip kgnd-chip-tech">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {paperFacts.techniqueGroups.loss.length > 0 && (
                    <div className="kgnd-chip-subgroup">
                      <span className="kgnd-chip-subgroup-label">Loss</span>
                      <div className="kgnd-chips">
                        {paperFacts.techniqueGroups.loss.map((t, i) => (
                          <span key={i} className="kgnd-chip kgnd-chip-tech">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {paperFacts.benchmarks.length > 0 && (
              <div className="kgnd-ribbon">
                <span className="kgnd-ribbon-label">Benchmarks</span>
                <div className="kgnd-chips">
                  {paperFacts.benchmarks.slice(0, 8).map((b, i) => (
                    <span key={i} className="kgnd-chip kgnd-chip-bench">{b}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Narrative block — Contributions / Limitations / Problems
            Addressed. Three-column grid where each bullet is the
            sentence-level claim text the LLM extractor pulled from the
            paper, with the claim-node id available for traceback. This
            is the only narrative-shaped section; everything above is
            table-shaped. */}
        {!isCompact && isPaper && (claimSets.contribution.length + claimSets.limitation.length + claimSets.problem.length) > 0 && (
          <div className="kgnd-narrative kgnd-slot-right">
            {claimSets.contribution.length > 0 && (
              <div className="kgnd-narr-col">
                <div className="kgnd-narr-head">Contributions</div>
                <ul className="kgnd-narr-list">
                  {claimSets.contribution.slice(0, expandedGroups.contribution ? 20 : 4).map((c, i) => (
                    <li key={i} onClick={() => onNodeClick && onNodeClick(c)}>{c.value || c.label}</li>
                  ))}
                </ul>
                {claimSets.contribution.length > 4 && (
                  <button className="kgnd-show-all" onClick={() => toggleGroup('contribution')}>
                    {expandedGroups.contribution ? 'Show less' : `Show all ${claimSets.contribution.length}`}
                  </button>
                )}
              </div>
            )}
            {claimSets.limitation.length > 0 && (
              <div className="kgnd-narr-col">
                <div className="kgnd-narr-head">Limitations</div>
                <ul className="kgnd-narr-list">
                  {claimSets.limitation.slice(0, expandedGroups.limitation ? 20 : 4).map((c, i) => (
                    <li key={i} onClick={() => onNodeClick && onNodeClick(c)}>{c.value || c.label}</li>
                  ))}
                </ul>
                {claimSets.limitation.length > 4 && (
                  <button className="kgnd-show-all" onClick={() => toggleGroup('limitation')}>
                    {expandedGroups.limitation ? 'Show less' : `Show all ${claimSets.limitation.length}`}
                  </button>
                )}
              </div>
            )}
            {claimSets.problem.length > 0 && (
              <div className="kgnd-narr-col">
                <div className="kgnd-narr-head">Problem addressed</div>
                <ul className="kgnd-narr-list">
                  {claimSets.problem.slice(0, expandedGroups.problem ? 20 : 4).map((c, i) => (
                    <li key={i} onClick={() => onNodeClick && onNodeClick(c)}>{c.value || c.label}</li>
                  ))}
                </ul>
                {claimSets.problem.length > 4 && (
                  <button className="kgnd-show-all" onClick={() => toggleGroup('problem')}>
                    {expandedGroups.problem ? 'Show less' : `Show all ${claimSets.problem.length}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Lineage + timeline row. Lineage on the left (citation rows
            with stance), timeline on the right (yearly stance-coded bars).
            Both fall to one column on narrow viewports. */}
        {!isCompact && isPaper && (hasLineage || citeTimeline) && (
          <div className="kgnd-lineage-row kgnd-slot-right">
        {hasLineage && (() => {
          const sc = lineage.stanceCounts || { builds_on: 0, neutral: 0, differs_from: 0 };
          const totalOut = lineage.citesOut.length;
          const renderCite = (n, i, dirArrow) => {
            const key = `cite-${i}-${n.id}`;
            const stance = n.sentiment || 'neutral';
            const ctxExpanded = !!expandedGroups[key];
            const hasCtx = Array.isArray(n.contexts) && n.contexts.length > 0;
            return (
              <div key={key} className={`kgnd-cite-item stance-${stance}`}>
                <div
                  className="kgnd-cite-row"
                  onClick={() => onNodeClick && onNodeClick(n)}
                  onMouseEnter={() => onHoverEntity && onHoverEntity(n)}
                  onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                >
                  <span className="kgnd-cite-arrow">{dirArrow}</span>
                  <span className="kgnd-cite-name">{n.label}</span>
                  <span className={`kgnd-cite-stance stance-${stance}`}>
                    {stance === 'builds_on' ? 'builds on' : stance === 'differs_from' ? 'differs' : 'neutral'}
                  </span>
                  {n.mentions > 1 && (
                    <span className="kgnd-cite-mentions">{n.mentions}×</span>
                  )}
                  {hasCtx && (
                    <button
                      className="kgnd-cite-ctx-btn"
                      onClick={(ev) => { ev.stopPropagation(); toggleGroup(key); }}
                      title="Show in-text context"
                    >{ctxExpanded ? '−' : '“”'}</button>
                  )}
                </div>
                {hasCtx && ctxExpanded && (
                  <div className="kgnd-cite-ctx">
                    <div className="kgnd-cite-ctx-caption">Sentence(s) where this citation occurs — the cited paper appears as one of the bracketed [n] reference markers, not by name.</div>
                    {n.contexts.map((c, j) => (
                      <blockquote key={j} className="kgnd-cite-ctx-quote">{renderCtx(c)}</blockquote>
                    ))}
                  </div>
                )}
              </div>
            );
          };
          return (
            <div className="kgnd-lineage">
              <div className="kgnd-lineage-title">Paper Lineage <Tooltip text="Each row is a paper in this one's citation chain (the two lists are labelled by direction). The colored tag is that citation's stance: 'builds on' = extends the work, 'differs' = contrasts with it, 'neutral' = references it without taking a side. The N× badge = how many times it's cited in the text — higher means deeper engagement." wide><span className="chart-help">?</span></Tooltip></div>

              {totalOut > 0 && (
                <div className="kgnd-lineage-section">
                  <div className="kgnd-lineage-label">
                    <span className="kgnd-lineage-arrow">&#8592;</span>
                    This paper cites — earlier work ({totalOut})
                  </div>
                  {/* Stance breakdown for outgoing citations */}
                  {(sc.builds_on + sc.differs_from) > 0 && (
                    <div className="kgnd-stance-strip">
                      {sc.builds_on > 0 && <span className="stance-chip stance-builds_on">{sc.builds_on} extends</span>}
                      {sc.neutral > 0 && <span className="stance-chip stance-neutral">{sc.neutral} neutral</span>}
                      {sc.differs_from > 0 && <span className="stance-chip stance-differs_from">{sc.differs_from} contrasts</span>}
                    </div>
                  )}
                  {lineage.citesOut
                    .slice()
                    .sort((a, b) => {
                      const rank = { differs_from: 0, builds_on: 1, neutral: 2 };
                      return (rank[a.sentiment || 'neutral'] - rank[b.sentiment || 'neutral']);
                    })
                    .slice(0, expandedGroups.citesOut ? 20 : 4)
                    .map((n, i) => renderCite(n, i, '\u2190'))}
                  {totalOut > 4 && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup('citesOut')}>
                      {expandedGroups.citesOut ? 'Show less' : `Show all ${totalOut}`}
                    </button>
                  )}
                </div>
              )}

              {lineage.citesIn.length > 0 && (
                <div className="kgnd-lineage-section">
                  <div className="kgnd-lineage-label">
                    <span className="kgnd-lineage-arrow">&#8594;</span>
                    Cited by — later work ({lineage.citesIn.length})
                  </div>
                  {lineage.citesIn
                    .slice(0, expandedGroups.citesIn ? 20 : 4)
                    .map((n, i) => renderCite(n, i + 1000, '\u2192'))}
                  {lineage.citesIn.length > 4 && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup('citesIn')}>
                      {expandedGroups.citesIn ? 'Show less' : `Show all ${lineage.citesIn.length}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Citation timeline — stance-coded yearly bars. Sits next to
            lineage when the panel is wide enough; replaces the old
            one-line hub summary (which left the right of the panel
            empty). Built from cites + cites_external + cited_by_external. */}
        {citeTimeline && (
          <div className="kgnd-cite-time">
            <div className="kgnd-cite-time-eyebrow">Citation activity</div>
            <div className="kgnd-cite-time-bars" aria-hidden>
              {citeTimeline.bars.map((b, i) => {
                const h = (px) => `${(px / citeTimeline.peak) * 100}%`;
                return (
                  <div key={i} className="kgnd-cite-time-bar" title={`${b.year}: ${b.builds_on} extends · ${b.neutral} neutral · ${b.differs_from} contrasts · ${b.external} cited by external`}>
                    {b.builds_on > 0    && <span className="kgnd-cite-time-seg builds_on"    style={{height: h(b.builds_on)}}    />}
                    {b.neutral > 0      && <span className="kgnd-cite-time-seg neutral"      style={{height: h(b.neutral)}}      />}
                    {b.differs_from > 0 && <span className="kgnd-cite-time-seg differs_from" style={{height: h(b.differs_from)}} />}
                    {b.external > 0     && <span className="kgnd-cite-time-seg external"     style={{height: h(b.external)}}     />}
                  </div>
                );
              })}
            </div>
            <div className="kgnd-cite-time-axis">
              <span>{citeTimeline.yMin}</span>
              <span>{citeTimeline.yMax}</span>
            </div>
            <div className="kgnd-cite-time-legend">
              <span><i style={{background:'#16794e'}} /> extends</span>
              <span><i style={{background:'#94a3b8'}} /> neutral</span>
              <span><i style={{background:'#c2410c'}} /> contrasts</span>
              <span><i style={{background:'var(--primary, #185A7C)', opacity: 0.55}} /> cited externally</span>
            </div>
          </div>
        )}
          </div>
        )}

        {/* Connections grouped by RELATION (edge type). The lineage block
            above already covers internal `cites` with stance info, so skip
            that one type here to avoid duplication. Everything else \u2014 every
            paper\u2194paper relation (cited_by_external, outperforms,
            compared_against, semantically_similar, co_cited_with), every
            paper\u2192entity relation (uses_technique, has_table, authored_by,
            etc.) \u2014 appears here as its own collapsible group with the
            actual neighbor rows underneath. */}
        {/* connectionsByRelation only renders for paper / method nodes.
            For non-paper entities the entityDetail block above already
            owns the per-edge-type breakdown; rendering this group set
            would duplicate the same paper list under different titles. */}
        {!isCompact && connectionsByRelation.length > 0 && (node.type === 'paper' || node.type === 'method') && (
          <div className="kgnd-connections kgnd-slot-left">
            {connectionsByRelation.map(([relationType, items]) => {
              if (relationType === 'cites' && hasLineage) return null;
              // Edge types now covered by the dedicated panel sections
              // above — skip them here so the user doesn't see the same
              // info twice in different formats.
              const COVERED_BY_OTHER_BLOCKS = new Set([
                'uses_technique', 'uses_backbone', 'uses_loss',
                'evaluated_on', 'uses_dataset', 'trained_on',
                'uses_hardware',
                'authored_by', 'affiliated_with', 'published_from',
                'contributes', 'has_limitation', 'addresses_problem',
                'outperforms', 'compared_against', 'semantically_similar',
                'described_in',
              ]);
              if (COVERED_BY_OTHER_BLOCKS.has(relationType)) return null;
              const isExpanded = expandedGroups[relationType];
              const showCount = isExpanded ? items.length : INITIAL_SHOW;
              const hasMore = items.length > INITIAL_SHOW;
              const groupTitle = RELATION_TITLES[relationType] || (EDGE_LABELS[relationType] || relationType);
              // Color the group dot by the dominant node type in the group
              // (most rows in a paper-cites-paper group are paper-typed,
              // so the color stays meaningful).
              const dominantNodeType = items[0]?.node?.type || 'other';
              return (
                <div key={relationType} className="kgnd-group">
                  <div className="kgnd-group-head" onClick={() => hasMore && toggleGroup(relationType)} style={{ cursor: hasMore ? 'pointer' : 'default' }}>
                    <span className="kgnd-group-dot" style={{ background: TYPE_COLORS[dominantNodeType] || '#8691a0' }} />
                    <span className="kgnd-group-title">{groupTitle}</span>
                    <span className="kgnd-group-n">{items.length}</span>
                    {hasMore && <span className="kgnd-group-toggle">{isExpanded ? '\u25BE' : '\u25B8'}</span>}
                  </div>
                  {items.slice(0, showCount).map(({ node: n, edge, direction }, i) => {
                    // Direction-aware verb: "cited by external" reads
                    // differently when this node is the citer vs. the
                    // cited. We only flip the label when the relation is
                    // asymmetric and we're on the receiving end.
                    let verb = EDGE_LABELS[relationType] || relationType;
                    if (direction === 'in') {
                      if (relationType === 'cites' || relationType === 'cites_external') verb = 'cited by';
                      else if (relationType === 'outperforms') verb = 'outperformed by';
                      else if (relationType === 'cited_by_external') verb = 'cites this';
                      else if (relationType === 'authored_by') verb = 'wrote';
                    }
                    // Provenance for outperforms: surface the metric name
                    // and margin so the row carries why the model thinks
                    // so, not just the bare claim.
                    const metricNote = edge?.metric ? ` \u00B7 ${edge.metric}` : '';
                    return (
                      <div
                        key={i}
                        className="kgnd-conn"
                        onClick={() => onNodeClick && onNodeClick(n)}
                        onMouseEnter={() => onHoverEntity && onHoverEntity(n)}
                        onMouseLeave={() => onHoverEntity && onHoverEntity(null)}
                      >
                        <span className="metadata-key">{verb}{metricNote}</span>
                        <span className="metadata-val">{n.label}</span>
                      </div>
                    );
                  })}
                  {hasMore && (
                    <button className="kgnd-show-all" onClick={() => toggleGroup(relationType)}>
                      {isExpanded ? 'Show less' : `Show all ${items.length}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Provenance footer — Harrison's lab consistently surfaces
            "how was this assembled" in the UI rather than tooltips.
            One thin strip with: observed vs predicted edge counts and
            avg confidence. Always visible, always last. */}
        <div className="kgnd-provenance">
          <span className="kgnd-prov-item">
            <span className="kgnd-prov-key">documented connections</span>
            <span className="kgnd-prov-val">{provenance.observed}</span>
          </span>
          {provenance.predicted > 0 && (
            <span className="kgnd-prov-item">
              <span className="kgnd-prov-key">suggested</span>
              <span className="kgnd-prov-val">{provenance.predicted}</span>
            </span>
          )}
          {provenance.avgConf !== null && (
            <span className="kgnd-prov-item">
              <span className="kgnd-prov-key">avg. confidence</span>
              <span className="kgnd-prov-val">{Math.round(provenance.avgConf * 100)}%</span>
            </span>
          )}
          {paperFacts.meta?.year && (
            <span className="kgnd-prov-item">
              <span className="kgnd-prov-key">paper</span>
              <span className="kgnd-prov-val">{node.paper_id || node.id}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
