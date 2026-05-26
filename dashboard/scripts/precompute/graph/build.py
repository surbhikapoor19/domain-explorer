"""Graph Reasoning page builder.

Coverage contract — guarantees the following for the Graph page:
  - kg-full.json          (KGGraphViz full view, KGSubgraph, KGNodeDetail)
  - kg-macro.json         (KGGraphViz default 'macro' view)
  - kg-landing.json       (KGLanding dashboard sections)
  - kg-predictions.json   (KGGraphViz 'Predicted Edges' toggle)
  - kg-contradictions.json (ContradictionPanel)

Optional method_df enables benchmarkCoverage and temporal sections of the
landing dashboard. If the KG file is missing, every output is written as an
empty stub so the front-end never 404s.
"""
import json
import os

from ._loader import load_kg
from .kg_contradictions import export_kg_contradictions
from .kg_full import export_kg_full
from .kg_landing import export_kg_landing
from .kg_macro import export_kg_macro
from .kg_predictions import export_kg_predictions

EMPTY_OUTPUTS = (
    'kg-full.json', 'kg-macro.json', 'kg-landing.json',
    'kg-predictions.json', 'kg-contradictions.json',
)


def _write_empty_stubs(output_dir):
    print("  WARNING: knowledge_graph.json not found, writing empty stubs")
    for name in EMPTY_OUTPUTS:
        with open(os.path.join(output_dir, name), 'w') as f:
            json.dump({} if 'landing' in name or 'full' in name or 'macro' in name else [], f)


def build(chroma_dir, output_dir, method_df=None, domain_cfg=None):
    os.makedirs(output_dir, exist_ok=True)

    loaded = load_kg(chroma_dir)
    if loaded is None:
        _write_empty_stubs(output_dir)
        return
    kg_data, nodes, edges, node_by_id = loaded
    print(f"Graph: KG loaded — {len(nodes)} nodes, {len(edges)} edges")

    print("[graph 1/5] kg-full.json ...")
    export_kg_full(kg_data, edges, output_dir)

    print("[graph 2/5] kg-macro.json ...")
    export_kg_macro(nodes, edges, output_dir, method_df=method_df,
                    node_by_id=node_by_id, domain_cfg=domain_cfg)

    print("[graph 3/5] kg-landing.json ...")
    export_kg_landing(nodes, edges, node_by_id, method_df, output_dir)

    print("[graph 4/5] kg-predictions.json ...")
    export_kg_predictions(
        chroma_dir, output_dir,
        node_by_id=node_by_id, edges=edges, method_df=method_df,
        domain_cfg=domain_cfg,
    )

    print("[graph 5/5] kg-contradictions.json ...")
    export_kg_contradictions(kg_data, output_dir)

    # Slim HGT metrics for the predictions side panel (per-relation AUC
    # chips + model-card footer). Strip the per-epoch training log and
    # keep only the headline test metrics + per-type breakdown the UI
    # actually reads.
    print("[graph 6/6] hgt-metrics.json ...")
    metrics_in = os.path.join(chroma_dir, 'hgt_schema', 'latest_metrics.json')
    metrics_out = os.path.join(output_dir, 'hgt-metrics.json')
    if os.path.exists(metrics_in):
        with open(metrics_in) as f:
            m = json.load(f)
        slim = {
            'version': m.get('version'),
            'timestamp': m.get('timestamp'),
            'n_params': m.get('config', {}).get('n_params'),
            'n_nodes': m.get('config', {}).get('n_nodes'),
            'n_edges_total': m.get('config', {}).get('n_edges_total'),
            'epochs': m.get('config', {}).get('epochs'),
            'hidden_dim': m.get('config', {}).get('hidden_dim'),
            'num_layers': m.get('config', {}).get('num_layers'),
            'overall': {
                'auc_roc': m.get('test_metrics', {}).get('auc_roc'),
                'hits_at_10': m.get('test_metrics', {}).get('hits_at_10'),
                'ndcg_at_10': m.get('test_metrics', {}).get('ndcg_at_10'),
                'mrr': m.get('test_metrics', {}).get('mrr'),
            },
            'per_type': {
                k: {'auc': v.get('auc'), 'hits_at_10': v.get('hits_at_10'), 'n_pos': v.get('n_pos')}
                for k, v in m.get('test_metrics', {}).get('per_type', {}).items()
            },
        }
        with open(metrics_out, 'w') as f:
            json.dump(slim, f, indent=2)
        print(f"  hgt-metrics.json: AUC={slim['overall']['auc_roc']:.3f}, Hits@10={slim['overall']['hits_at_10']:.3f}, {len(slim['per_type'])} relation types")
    else:
        print(f"  WARNING: {metrics_in} not found, writing empty stub")
        with open(metrics_out, 'w') as f:
            json.dump({}, f)
