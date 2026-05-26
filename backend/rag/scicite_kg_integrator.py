"""Wire chroma_db/citation_intents.json into the knowledge graph.

The SciCite classifier emits one of three intent labels per citation
context: ``background``, ``method``, or ``result``. Each label tells us
something different about the citing paper's relationship to the cited
paper:

  - background: the citing paper acknowledges the cited work as prior
    context. We do not add a graph edge for this; the existing ``cites``
    or ``cited_by_external`` edge is sufficient.
  - method: the citing paper uses something from the cited paper. We
    annotate the existing citation edge with ``intent='method'`` so the
    side panel can surface it.
  - result: the citing paper compares its results against the cited
    paper. We add a new typed edge ``compared_against`` between the two
    papers, carrying the in-text context as evidence.

Why ``compared_against`` and not ``outperforms``: the SciCite classifier
labels intent, not direction of comparison. A "result" sentence can
equally say "our method outperforms X", "X outperforms ours", or "we
obtain results comparable to X". Materializing all of them as
``outperforms`` would be inventing a directionality the model did not
emit. ``compared_against`` is honest about what we actually know
(these two papers were benchmarked head-to-head in the citing paper)
and gives the HGT trainer a real meta-relation to learn over.

Confidence threshold defaults to 0.80 so only high-confidence
intent assignments produce KG edges. Lower-confidence ones still get
recorded on the underlying citation edge as ``intent`` + ``intent_confidence``
so the dashboard can surface them without polluting the new typed edges.
"""
import json
import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_CONFIDENCE_THRESHOLD = 0.80


def enrich_graph_with_scicite_intents(
    G,
    intents_path: str,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> dict:
    """Read citation_intents.json and add compared_against edges + intent
    annotations to the graph.

    Mutates G in place. Returns a stats dict.
    """
    if not os.path.exists(intents_path):
        logger.warning(f"  SciCite intents file not found at {intents_path}; skipping.")
        return {'internal': 0, 'external_back': 0, 'compared_against_added': 0,
                'method_intent_annotated': 0, 'background_intent_annotated': 0}

    with open(intents_path) as f:
        intents = json.load(f)

    stats = {
        'internal': len(intents.get('internal', [])),
        'external_back': len(intents.get('external_back', [])),
        'compared_against_added': 0,
        'method_intent_annotated': 0,
        'background_intent_annotated': 0,
    }

    # ── Internal citations: A cites B, both in corpus ────────────────────
    for entry in intents.get('internal', []):
        src = entry.get('src')
        tgt = entry.get('tgt')
        intent = entry.get('intent')
        confidence = float(entry.get('confidence', 0))
        if not src or not tgt or not intent:
            continue
        if not (G.has_node(src) and G.has_node(tgt)):
            continue

        # Annotate the existing cites edge with the intent label (additive).
        if G.has_edge(src, tgt):
            ed = G[src][tgt]
            if intent != ed.get('intent') or confidence > float(ed.get('intent_confidence', 0)):
                ed['intent'] = intent
                ed['intent_confidence'] = round(confidence, 4)
                if intent == 'method':
                    stats['method_intent_annotated'] += 1
                elif intent == 'background':
                    stats['background_intent_annotated'] += 1

        # Result-class above threshold: add typed compared_against edge.
        if intent == 'result' and confidence >= confidence_threshold:
            if not G.has_edge(src, tgt) or G[src][tgt].get('type') != 'compared_against':
                ctx = entry.get('context', '')
                G.add_edge(
                    src, tgt,
                    type='compared_against',
                    source='scicite',
                    intent_confidence=round(confidence, 4),
                    contexts=[ctx] if ctx else [],
                )
                stats['compared_against_added'] += 1

    # ── External back-citations: external paper E cites corpus paper A ──
    for entry in intents.get('external_back', []):
        corpus_paper = entry.get('src')                  # paper:<slug>
        ext_id = entry.get('external_paper_id')          # S2 paper ID
        intent = entry.get('intent')
        confidence = float(entry.get('confidence', 0))
        if not corpus_paper or not ext_id or not intent:
            continue
        # The external-citer node was added in S2 enrichment as ref:s2cit:<id>.
        ext_node = f"ref:s2cit:{ext_id}"
        if not (G.has_node(corpus_paper) and G.has_node(ext_node)):
            continue

        # Annotate the existing cited_by_external edge.
        if G.has_edge(corpus_paper, ext_node):
            ed = G[corpus_paper][ext_node]
            if intent != ed.get('intent') or confidence > float(ed.get('intent_confidence', 0)):
                ed['intent'] = intent
                ed['intent_confidence'] = round(confidence, 4)
                if intent == 'method':
                    stats['method_intent_annotated'] += 1
                elif intent == 'background':
                    stats['background_intent_annotated'] += 1

        # Result-class above threshold: add compared_against edge from the
        # external citing paper to the corpus paper. The citing paper
        # claims a result comparison, so the edge direction is E → A.
        if intent == 'result' and confidence >= confidence_threshold:
            if not G.has_edge(ext_node, corpus_paper) or G[ext_node][corpus_paper].get('type') != 'compared_against':
                ctx = entry.get('context', '')
                G.add_edge(
                    ext_node, corpus_paper,
                    type='compared_against',
                    source='scicite',
                    intent_confidence=round(confidence, 4),
                    contexts=[ctx] if ctx else [],
                )
                stats['compared_against_added'] += 1

    return stats
