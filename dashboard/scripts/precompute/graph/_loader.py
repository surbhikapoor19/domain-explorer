"""Shared KG loader — every Graph emitter calls load_kg() for the raw graph."""
import json
import os


def load_kg(chroma_dir, fallback_path=None):
    """Return (kg_data, nodes, edges, node_by_id) or None if KG is missing.

    Falls back to `fallback_path` (the committed kg-full.json) when the
    chroma-built knowledge_graph.json is absent. This lets a CSV-only precompute
    run re-derive the landing/macro plots from the NEW csv + the already-committed
    KG — with NO chroma and NO PDF re-ingest (the nightly sheet-poll path)."""
    kg_path = os.path.join(chroma_dir, 'knowledge_graph.json')
    if not os.path.exists(kg_path):
        if fallback_path and os.path.exists(fallback_path):
            print(f"  load_kg: chroma KG absent — using committed {os.path.basename(fallback_path)} "
                  f"(CSV-only refresh, no PDF re-ingest)")
            kg_path = fallback_path
        else:
            return None
    with open(kg_path) as f:
        kg_data = json.load(f)
    nodes = kg_data.get('nodes', [])
    edges = kg_data.get('edges', kg_data.get('links', []))
    node_by_id = {n['id']: n for n in nodes}
    return kg_data, nodes, edges, node_by_id
