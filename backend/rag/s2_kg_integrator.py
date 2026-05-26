"""Wire chroma_db/s2_enrichment.json into the knowledge graph.

The TEI parser already gives us references *out* of each paper (the
bibliography). The Semantic Scholar API gives us two things TEI cannot:

  1. Authoritative paperIds + abstracts for the references (richer than
     TEI's title-only nodes).
  2. *Back-citations* — papers from outside the 55-paper corpus that cite
     ours. These don't appear anywhere in the TEI/CSV pipeline.

This module:
  - Enriches existing `reference` nodes (and adds new ones for refs the
    TEI parser missed) with S2 paperId + abstract + venue.
  - Adds `cited_by_external` edges from each of our 55 papers to the
    external papers that cite them. Each edge carries the in-text
    `contexts` list from S2 — the exact text snippets the citing paper
    wrote about ours. These contexts are the load-bearing input for a
    downstream SciCite citation-intent classifier.

No GROBID, no LLM calls. Pure JSON → graph wiring.
"""
import json
import logging
import os
import re
from collections import defaultdict

import networkx as nx

logger = logging.getLogger(__name__)


def _norm_title(s: str) -> str:
    """Normalize a title for fuzzy matching: lowercase, strip punctuation,
    collapse whitespace. Used to resolve TEI ref nodes against S2 records."""
    if not s:
        return ''
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return ' '.join(s.split())


def enrich_graph_with_s2(G: nx.DiGraph, s2_path: str) -> dict:
    """Read s2_enrichment.json, enrich `reference` nodes, add back-citation
    edges. Returns a stats dict for logging.

    Mutates G in place. Idempotent: re-running won't duplicate edges
    (uses (src, tgt, type) keys).
    """
    if not os.path.exists(s2_path):
        logger.warning(f"  S2 enrichment file not found at {s2_path}; skipping.")
        return {'papers': 0, 'enriched_refs': 0, 'new_refs': 0,
                'back_citations': 0, 'context_strings': 0}

    with open(s2_path) as f:
        s2 = json.load(f)

    # Build a lookup from normalized TEI ref title → reference node id.
    tei_ref_by_title = {}
    for nid, attrs in G.nodes(data=True):
        if attrs.get('type') == 'reference':
            label = attrs.get('label', '')
            key = _norm_title(label)
            if key:
                tei_ref_by_title[key] = nid

    enriched = 0
    new_refs = 0
    back_citations = 0
    context_count = 0

    for slug, entry in s2.items():
        paper_node = f"paper:{slug}"
        if paper_node not in G:
            continue

        # ── 1) Enrich (or add) reference nodes for cited works ──────────
        for ref in entry.get('references', []):
            title = ref.get('title') or ''
            if not title:
                continue
            key = _norm_title(title)
            existing = tei_ref_by_title.get(key)
            if existing:
                # Enrich the TEI node with S2 metadata.
                attrs = G.nodes[existing]
                if not attrs.get('s2_paper_id') and ref.get('paperId'):
                    attrs['s2_paper_id'] = ref['paperId']
                if not attrs.get('abstract') and ref.get('abstract'):
                    attrs['abstract'] = (ref.get('abstract') or '')[:500]
                if not attrs.get('venue') and ref.get('venue'):
                    attrs['venue'] = ref.get('venue')
                enriched += 1
            else:
                # New reference node from S2 only — TEI didn't pick it up.
                # Use the S2 paperId as the node id so future runs match.
                nid = f"ref:s2:{ref.get('paperId') or _norm_title(title)[:40]}"
                if nid in G:
                    continue
                G.add_node(
                    nid, type='reference', label=title[:200],
                    authors=[a.get('name', '') for a in (ref.get('authors') or [])][:5],
                    year=ref.get('year', ''),
                    venue=ref.get('venue', ''),
                    abstract=(ref.get('abstract') or '')[:500],
                    s2_paper_id=ref.get('paperId', ''),
                )
                tei_ref_by_title[key] = nid
                new_refs += 1
                # The paper cites this newly-added external reference.
                if not G.has_edge(paper_node, nid):
                    G.add_edge(paper_node, nid, type='cites_external', source='s2')

        # ── 2) Add back-citation edges (papers that cite ours) ──────────
        # Each entry in `citations` is a paper that cites our paper. We
        # represent these as `reference` nodes (typed `external_citing` in
        # the subtype) so the existing visualization handles them
        # uniformly, and add a `cited_by_external` edge.
        for cit in entry.get('citations', []):
            title = cit.get('title') or ''
            paper_id = cit.get('paperId') or ''
            if not title or not paper_id:
                continue
            nid = f"ref:s2cit:{paper_id}"
            if nid not in G:
                G.add_node(
                    nid, type='reference', subtype='external_citing',
                    label=title[:200],
                    authors=[a.get('name', '') for a in (cit.get('authors') or [])][:5],
                    year=cit.get('year', ''),
                    venue=cit.get('venue', ''),
                    abstract=(cit.get('abstract') or '')[:500],
                    s2_paper_id=paper_id,
                )
            if not G.has_edge(paper_node, nid):
                contexts = (cit.get('contexts') or [])[:3]
                G.add_edge(
                    paper_node, nid,
                    type='cited_by_external',
                    source='s2',
                    contexts=contexts,
                    mentions=len(contexts),
                )
                back_citations += 1
                context_count += len(contexts)

    return {
        'papers': len(s2),
        'enriched_refs': enriched,
        'new_refs': new_refs,
        'back_citations': back_citations,
        'context_strings': context_count,
    }
