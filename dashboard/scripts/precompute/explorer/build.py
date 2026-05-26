"""Explorer page builder.

Coverage contract — guarantees the following files for the Explorer page:
  - domain-config.json             (branding, column config for all pages)
  - methods.json                  (ai-pipeline)
  - tfidf-matrices.json           (umap.js recompute)
  - description-embeddings.json   (umap.js recompute)
  - umap-default.json             (ScatterPlot, NetworkGraph, ClusterGraph,
                                    MethodTable, DetailPanel, ClusterLegend,
                                    ClusterInsight, WeightSliders)
  - term-dictionary.json          (InsightCard, InsightBullets — also used by Graph)
  - query-keywords.json           (ai-pipeline)
"""
import json
import os

import pandas as pd

from ..shared.config import DomainConfig
from .description_embeddings import export_description_embeddings
from .methods import export_methods
from .query_keywords import export_query_keywords
from .term_dictionary import export_term_dictionary
from .tfidf import export_tfidf_matrices
from .umap_layout import export_umap_default


def _export_domain_config(domain_cfg, output_dir):
    """Emit domain-config.json — consumed by the React frontend for branding,
    column names, weight labels, and LLM prompt context."""
    all_short_names = dict(domain_cfg.short_names)
    for dc in domain_cfg.derived_columns:
        if dc not in all_short_names:
            all_short_names[dc] = dc

    payload = {
        'domain': domain_cfg.domain,
        'displayName': domain_cfg.display_name,
        'methodNoun': domain_cfg.method_noun,
        'shortNames': all_short_names,
        'columnRoles': domain_cfg.column_roles,
        'derivedColumns': domain_cfg.derived_columns,
        'priorityDims': [
            {'key': k, 'label': v} for k, v in domain_cfg.priority_dims
        ],
        'defaultWeights': domain_cfg.weights,
        'weightColumns': list(domain_cfg.weights.keys()),
        'tableColumns': domain_cfg.table_columns,
        'colorByOptions': domain_cfg.color_by_options,
        'branding': domain_cfg.branding,
    }
    with open(os.path.join(output_dir, 'domain-config.json'), 'w') as f:
        json.dump(payload, f)
    print(f"  domain-config.json: {domain_cfg.display_name} ({domain_cfg.domain})")


def build(csv_path, output_dir, embeddings_cache, domain_cfg=None):
    if domain_cfg is None:
        domain_cfg = DomainConfig.default_grasp()
    os.makedirs(output_dir, exist_ok=True)
    df = pd.read_csv(csv_path)
    print(f"Explorer: loaded {len(df)} {domain_cfg.method_noun}s from {csv_path}")

    print("[explorer 0/7] domain-config.json ...")
    _export_domain_config(domain_cfg, output_dir)

    print("[explorer 1/7] methods.json ...")
    export_methods(df, output_dir, domain_cfg)

    print("[explorer 2/7] tfidf-matrices.json ...")
    tfidf = export_tfidf_matrices(df, output_dir, domain_cfg)

    print("[explorer 3/7] description-embeddings.json ...")
    desc_emb = export_description_embeddings(df, embeddings_cache, output_dir)

    print("[explorer 4/7] umap-default.json ...")
    export_umap_default(df, tfidf, desc_emb, output_dir, domain_cfg)

    print("[explorer 5/7] term-dictionary.json ...")
    export_term_dictionary(output_dir)

    print("[explorer 6/7] query-keywords.json ...")
    export_query_keywords(output_dir)

    return df
