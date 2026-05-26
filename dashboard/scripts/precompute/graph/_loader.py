"""Shared KG loader — every Graph emitter calls load_kg() for the raw graph."""
import json
import os


def load_kg(chroma_dir):
    """Return (kg_data, nodes, edges, node_by_id) or None if KG is missing."""
    kg_path = os.path.join(chroma_dir, 'knowledge_graph.json')
    if not os.path.exists(kg_path):
        return None
    with open(kg_path) as f:
        kg_data = json.load(f)
    nodes = kg_data.get('nodes', [])
    edges = kg_data.get('edges', kg_data.get('links', []))
    node_by_id = {n['id']: n for n in nodes}
    return kg_data, nodes, edges, node_by_id
