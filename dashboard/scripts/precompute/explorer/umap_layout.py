"""Emit umap-default.json — the canonical Explorer dataset.

Coverage contract (every Explorer component depends on this file):
  data[]:
    - id, name, description
    - x, y                          (ScatterPlot, NetworkGraph, ClusterGraph)
    - cluster                       (color-by 'cluster', NetworkGraph edges)
    - metadata[col]                 (every CSV column + derived columns)
  config.weights                    (WeightSliders default values)
  clusterStats[]                    (ClusterLegend, ClusterInsight, ClusterGraph)
    - id, label, methods, size, topAttributes
  nClusters                         (App.js — recompute fallback)
  valueClusterMap                   (ai-pipeline color-by routing)
"""
import json
import os
from collections import Counter

import hdbscan
import numpy as np
import pandas as pd
import umap as umap_lib
from sklearn.metrics import pairwise_distances

from ..shared.config import (
    DEFAULT_WEIGHTS, DERIVED_COLUMNS, SHORT_COLUMN_NAMES,
    DomainConfig, UMAP_METRIC, UMAP_MIN_DIST, UMAP_N_NEIGHBORS,
)
from ..shared.csv_utils import smart_split
from ..shared.derived_features import compute_derived_features


def _generate_cluster_insight(cluster_stats, noun='method'):
    """Build a template-based cluster insight from clusterStats."""
    bullets = []
    for cs in cluster_stats:
        attrs = cs.get('topAttributes', {})
        attr_parts = []
        for col_label, vals in attrs.items():
            if vals:
                top_val = vals[0]['value']
                attr_parts.append(f"{col_label}: {top_val}")
        attr_str = ', '.join(attr_parts[:3]) if attr_parts else cs['label']
        sample = cs['methods'][:3]
        sample_str = ', '.join(sample)
        if len(cs['methods']) > 3:
            sample_str += f' and {len(cs["methods"]) - 3} more'
        bullets.append(
            f'- The "{cs["label"]}" group ({cs["size"]} {noun}s) '
            f'includes {sample_str}. '
            f'Dominant attributes: {attr_str}.'
        )
    return '\n'.join(bullets)


def export_umap_default(df, tfidf_matrices, desc_embeddings, output_dir,
                        domain_cfg=None):
    weights = domain_cfg.weights if domain_cfg else DEFAULT_WEIGHTS
    derived_cols = domain_cfg.derived_columns if domain_cfg else DERIVED_COLUMNS
    short_names = domain_cfg.short_names if domain_cfg else SHORT_COLUMN_NAMES

    n = len(df)
    feature_parts = []
    for col, weight in weights.items():
        if weight == 0:
            continue
        sqw = np.sqrt(weight)
        if col == 'Description':
            feature_parts.append(desc_embeddings * sqw)
        elif col in tfidf_matrices:
            feature_parts.append(np.array(tfidf_matrices[col]) * sqw)
    features = np.hstack(feature_parts)

    n_neighbors = min(UMAP_N_NEIGHBORS, max(2, n - 1))
    dist_matrix = pairwise_distances(features, metric=UMAP_METRIC)
    reducer = umap_lib.UMAP(
        n_neighbors=n_neighbors, min_dist=UMAP_MIN_DIST,
        metric='precomputed', random_state=42, n_components=2, n_jobs=1,
    )
    coords = reducer.fit_transform(dist_matrix)

    if n <= 3:
        labels = [0] * n
    else:
        min_cluster = max(3, n // 15)
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_cluster, min_samples=1,
            metric='euclidean', cluster_selection_method='eom',
        )
        labels = clusterer.fit_predict(features).tolist()
        noise_mask = np.array(labels) == -1
        if noise_mask.any() and not noise_mask.all():
            real_idx = np.where(~noise_mask)[0]
            noise_idx = np.where(noise_mask)[0]
            dists = pairwise_distances(features[noise_idx], features[real_idx])
            for i, ni in enumerate(noise_idx):
                labels[ni] = labels[real_idx[dists[i].argmin()]]
        elif noise_mask.all():
            labels = [0] * n

    derived = compute_derived_features(df, domain_cfg)
    data = []
    for i in range(n):
        row = df.iloc[i]
        metadata = {}
        for col in df.columns:
            val = row.get(col, '')
            metadata[col] = '' if pd.isna(val) else str(val)
        for col in derived_cols:
            metadata[col] = derived.get(col, [''] * n)[i]
        data.append({
            'id': i,
            'name': str(row.get('Name', '')),
            'x': float(coords[i, 0]),
            'y': float(coords[i, 1]),
            'description': str(row.get('Description', '')),
            'cluster': int(labels[i]),
            'metadata': metadata,
        })

    weighted_cols = [
        c for c, w in weights.items()
        if w > 0 and c in df.columns and c != 'Description'
    ]
    value_cluster_map = {}
    for col in weighted_cols:
        vcm = {}
        for idx, raw in enumerate(df[col].fillna('').astype(str)):
            for part in smart_split(raw):
                vcm.setdefault(part, []).append(labels[idx])
        value_cluster_map[col] = {
            v: Counter(cls).most_common(1)[0][0] for v, cls in vcm.items() if cls
        }

    key_cols = sorted(weights, key=lambda c: weights.get(c, 0), reverse=True)[:5]
    clusters = {}
    for pt in data:
        clusters.setdefault(pt['cluster'], []).append(pt)

    cluster_stats = []
    for cid in sorted(clusters):
        members = clusters[cid]
        names = [m['name'] for m in members]
        label_cols = sorted(
            [c for c in weights if c != 'Description'],
            key=lambda c: weights.get(c, 0), reverse=True,
        )[:3]
        dominant = []
        for col in label_cols:
            vals = [p for m in members for p in smart_split(m['metadata'].get(col, ''))]
            if vals:
                dominant.append(Counter(vals).most_common(1)[0][0])
        label = ' / '.join(dominant) if dominant else f'Group {cid}'
        stat = {'id': cid, 'label': label, 'methods': names, 'size': len(members), 'topAttributes': {}}
        for col in weighted_cols:
            vals = [p for m in members for p in smart_split(m['metadata'].get(col, ''))]
            if vals and col in key_cols:
                top = Counter(vals).most_common(3)
                short = short_names.get(col, col)
                stat['topAttributes'][short] = [{'value': v, 'count': c} for v, c in top]
        cluster_stats.append(stat)

    result = {
        'data': data,
        'config': {'weights': weights},
        'clusterStats': cluster_stats,
        'nClusters': len(set(labels)),
        'valueClusterMap': value_cluster_map,
    }
    with open(os.path.join(output_dir, 'umap-default.json'), 'w') as f:
        json.dump(result, f)
    noun = domain_cfg.method_noun if domain_cfg else 'method'
    print(f"  umap-default.json: {n} {noun}s, {len(set(labels))} clusters")

    insight_text = _generate_cluster_insight(cluster_stats, noun)
    insight_payload = {'insight': insight_text, 'clusterStats': cluster_stats}
    with open(os.path.join(output_dir, 'cluster-insight.json'), 'w') as f:
        json.dump(insight_payload, f)
    print(f"  cluster-insight.json: {len(cluster_stats)} clusters")
