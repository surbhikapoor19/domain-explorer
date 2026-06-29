"""Emit kg-full.json — complete normalized knowledge graph.

Consumed by:
  - KGGraphViz (full view)        → nodes[].{id,label,type,subtype,degree,...}
                                     links[].{source,target,type,inferred,
                                              confidence,semantic_relevance,
                                              sentiment,contexts,mentions}
  - KGSubgraph (paper-scoped)     → same fields, filtered client-side
  - KGNodeDetail (per-node)       → node.meta.*, cells, latex, authors, ...

Normalization: legacy KG dumps used 'edges' but the front-end's loader
expects 'links'. We rename to 'links' here so the JSON is canonical.
"""
import json
import os

# Sentence-fragment node types whose labels are extracted spans (vs named-entity
# types like method/paper/hardware, whose labels must stay the short entity name).
_SENTENCE_TYPES = {'contribution', 'comparison', 'problem', 'limitation', 'figure'}


def _clean_label(value):
    """A clean graph label from full text: short, never cut mid-word."""
    v = (value or '').strip()
    if len(v) <= 90:
        return v
    cut = v[:90]
    sp = cut.rfind(' ')
    if sp > 40:
        cut = cut[:sp]
    return cut.rstrip(' ,;:') + '…'


def detruncate_labels(nodes):
    """De-truncate node labels that the backend KG build cut mid-word (~60 chars),
    restoring from each node's full ``value`` for sentence-fragment node types so a
    graph label never reads like "...allowing ima". Idempotent; in-place."""
    for nd in nodes or []:
        if nd.get('type') not in _SENTENCE_TYPES:
            continue
        val, lab = nd.get('value'), nd.get('label') or ''
        if (isinstance(val, str) and val and lab and len(val) > len(lab)
                and val.startswith(lab[:min(len(lab), 40)])):
            nd['label'] = _clean_label(val)
    return nodes


def export_kg_full(kg_data, edges, output_dir):
    kg_normalized = {**kg_data, 'links': edges}
    kg_normalized.pop('edges', None)
    detruncate_labels(kg_normalized.get('nodes'))
    from .._safe_write import safe_write_json
    safe_write_json(os.path.join(output_dir, 'kg-full.json'), kg_normalized, label='empty KG')
    n_nodes = len(kg_normalized.get('nodes', []))
    print(f"  kg-full.json: {n_nodes} nodes, {len(edges)} edges")
