"""Graph Reasoning page builder.

Coverage contract — guarantees the following for the Graph page:
  - kg-full.json          (KGGraphViz full view, KGSubgraph, KGNodeDetail)
  - kg-macro.json         (KGGraphViz default 'macro' view)
  - kg-landing.json       (KGLanding dashboard sections)
  - kg-contradictions.json (ContradictionPanel)

Optional method_df enables benchmarkCoverage and temporal sections of the
landing dashboard. If the KG file is missing, every output is written as an
empty stub so the front-end never 404s.
"""
import os

from ._loader import load_kg
from .._safe_write import safe_write_json
from .kg_contradictions import export_kg_contradictions
from .kg_full import export_kg_full
from .kg_landing import export_kg_landing
from .kg_macro import export_kg_macro

EMPTY_OUTPUTS = (
    'kg-full.json', 'kg-macro.json', 'kg-landing.json',
    'kg-contradictions.json',
)


def _write_empty_stubs(output_dir):
    # KG missing (e.g. a CSV-only run with no chroma): write empty stubs so the
    # front-end never 404s — but NEVER clobber a committed non-empty artifact.
    print("  WARNING: knowledge_graph.json not found, writing empty stubs (keeping any existing non-empty data)")
    for name in EMPTY_OUTPUTS:
        empty = {} if 'landing' in name or 'full' in name or 'macro' in name else []
        safe_write_json(os.path.join(output_dir, name), empty, label='empty stub')


def build(chroma_dir, output_dir, method_df=None, domain_cfg=None):
    os.makedirs(output_dir, exist_ok=True)

    # Fall back to the committed kg-full.json so a CSV-only precompute run (no
    # chroma, no PDF re-ingest) still re-derives the landing/macro plots from the
    # new CSV + the existing KG.
    loaded = load_kg(chroma_dir, fallback_path=os.path.join(output_dir, 'kg-full.json'))
    if loaded is None:
        _write_empty_stubs(output_dir)
        return
    kg_data, nodes, edges, node_by_id = loaded
    print(f"Graph: KG loaded — {len(nodes)} nodes, {len(edges)} edges")

    print("[graph 1/4] kg-full.json ...")
    export_kg_full(kg_data, edges, output_dir)

    print("[graph 2/4] kg-macro.json ...")
    export_kg_macro(nodes, edges, output_dir, method_df=method_df,
                    node_by_id=node_by_id, domain_cfg=domain_cfg)

    print("[graph 3/4] kg-landing.json ...")
    export_kg_landing(nodes, edges, node_by_id, method_df, output_dir)

    print("[graph 4/4] kg-contradictions.json ...")
    export_kg_contradictions(kg_data, output_dir)
