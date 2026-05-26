"""Emit kg-contradictions.json — pairs of papers with conflicting claims.

Consumed by ContradictionPanel. Each record has:
  conflict_type, technique, paper_a, paper_b, claim_a, claim_a_type,
  claim_b, claim_b_type.

Detection logic lives in backend/rag/knowledge_graph.detect_contradictions —
we import it here rather than duplicate the rules.
"""
import json
import os
import sys

from ..shared.config import REPO_ROOT


def export_kg_contradictions(kg_data, output_dir):
    out_path = os.path.join(output_dir, 'kg-contradictions.json')
    try:
        sys.path.insert(0, os.path.join(REPO_ROOT, 'backend'))
        from rag.knowledge_graph import detect_contradictions
        import networkx as nx
        import inspect
        # NetworkX 3.6 changed `node_link_graph`'s default edge key from
        # 'links' to 'edges' and renamed the kwarg. Detect the signature so
        # this step works under both 3.3 (backend venv) and 3.6 (any newer
        # env) without forcing one specific networkx version.
        sig_params = set(inspect.signature(nx.node_link_graph).parameters)
        if 'edges' in sig_params:
            G = nx.node_link_graph(kg_data, edges='edges')
        elif 'link' in sig_params:
            G = nx.node_link_graph(kg_data, link='edges')
        else:
            normalized = {**kg_data}
            if 'edges' in normalized and 'links' not in normalized:
                normalized['links'] = normalized.pop('edges')
            G = nx.node_link_graph(normalized)
        contras = detect_contradictions(G)
        with open(out_path, 'w') as f:
            json.dump(contras, f)
        print(f"  kg-contradictions.json: {len(contras)} contradictions")
    except Exception as e:
        print(f"  kg-contradictions.json: skipped ({e})")
        with open(out_path, 'w') as f:
            json.dump([], f)
