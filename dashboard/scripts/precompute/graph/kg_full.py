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


def export_kg_full(kg_data, edges, output_dir):
    kg_normalized = {**kg_data, 'links': edges}
    kg_normalized.pop('edges', None)
    from .._safe_write import safe_write_json
    safe_write_json(os.path.join(output_dir, 'kg-full.json'), kg_normalized, label='empty KG')
    n_nodes = len(kg_normalized.get('nodes', []))
    print(f"  kg-full.json: {n_nodes} nodes, {len(edges)} edges")
