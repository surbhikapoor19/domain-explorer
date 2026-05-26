#!/usr/bin/env python3
"""Generate static JSON files for the Vercel dashboard.

Usage:
    cd grasp-explorer
    source backend/venv/bin/activate
    python dashboard/scripts/precompute.py

Reads from: datasets/, backend/, chroma_db/, papers/
Writes to:  dashboard/public/data/, dashboard/public/papers/
"""
import argparse
import csv
import io
import json
import os
import shutil
import sys
from collections import Counter

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import pairwise_distances
import hdbscan
import umap as umap_lib

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DEFAULT_WEIGHTS = {
    'Planning Method': 10, 'Training Data': 8, 'End-effector Hardware': 6,
    'Object Configuration': 10, 'Input Data': 6, 'Output Pose': 10,
    'Corresponding Dataset (see repository linked above)': 5,
    'Simulator (see repository linked above)': 3, 'Backbone': 5,
    'Metric(s) Used ': 5, 'Camera Position(s)': 4, 'Language': 4, 'Description': 7,
}

DERIVED_COLUMNS = [
    'Grasp Dimensionality', 'Learning Paradigm', 'Sensor Complexity',
    'Scene Difficulty', 'Gripper Type', 'ML Framework', 'Method Era',
]

SHORT_COLUMN_NAMES = {
    'Planning Method': 'Plan', 'Training Data': 'Train', 'End-effector Hardware': 'Gripper',
    'Object Configuration': 'Objects', 'Input Data': 'Input', 'Output Pose': 'Output',
    'Corresponding Dataset (see repository linked above)': 'Dataset',
    'Simulator (see repository linked above)': 'Sim', 'Backbone': 'Backbone',
    'Metric(s) Used ': 'Metrics', 'Camera Position(s)': 'Camera', 'Language': 'Lang',
    'Description': 'Desc',
}

UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.1
UMAP_METRIC = 'cosine'


def smart_split(value):
    if not value or (isinstance(value, float) and np.isnan(value)):
        return []
    s = str(value).strip()
    if not s:
        return []
    reader = csv.reader(io.StringIO(s), skipinitialspace=True)
    parts = next(reader)
    return [p.strip() for p in parts if p.strip()]


def normalize_multi_value(val):
    parts = smart_split(val)
    return ', '.join(sorted(parts)) if parts else ''


def compute_derived_features(df):
    n = len(df)
    result = {col: [''] * n for col in DERIVED_COLUMNS}
    for i in range(n):
        output = str(df.at[i, 'Output Pose']) if pd.notna(df.at[i, 'Output Pose']) else ''
        if '6-DoF' in output: result['Grasp Dimensionality'][i] = '6-DoF'
        elif '7-DoF' in output: result['Grasp Dimensionality'][i] = '7-DoF'
        elif '2D grasp' in output: result['Grasp Dimensionality'][i] = '2D'
        elif 'Grasp policy' in output: result['Grasp Dimensionality'][i] = 'Policy'
        elif 'Grasp success' in output: result['Grasp Dimensionality'][i] = 'Evaluation'
        else: result['Grasp Dimensionality'][i] = 'Other'

        method = str(df.at[i, 'Planning Method']) if pd.notna(df.at[i, 'Planning Method']) else ''
        training = str(df.at[i, 'Training Data']) if pd.notna(df.at[i, 'Training Data']) else ''
        method_parts = [p.strip() for p in method.split(',')]
        if training == 'Training-less': result['Learning Paradigm'][i] = 'Classical'
        elif all(p in ('Analytical', 'Sampling', 'Optimization') for p in method_parts): result['Learning Paradigm'][i] = 'Classical'
        elif any('Reinforcement' in p for p in method_parts): result['Learning Paradigm'][i] = 'RL-based'
        elif any(p in ('Direct regression', 'Generative') for p in method_parts): result['Learning Paradigm'][i] = 'Learning-based'
        else: result['Learning Paradigm'][i] = 'Hybrid'

        input_data = str(df.at[i, 'Input Data']) if pd.notna(df.at[i, 'Input Data']) else ''
        input_parts = smart_split(input_data)
        input_lower = input_data.lower()
        if 'natural language' in input_lower or len(input_parts) > 1: result['Sensor Complexity'][i] = 'Multimodal'
        elif any(k in input_lower for k in ('point cloud', 'tsdf', '3d', 'mesh', 'voxel')): result['Sensor Complexity'][i] = '3D'
        elif 'rgbd' in input_lower: result['Sensor Complexity'][i] = '2.5D'
        elif any(k in input_lower for k in ('rgb', 'depth')): result['Sensor Complexity'][i] = '2D'
        else: result['Sensor Complexity'][i] = 'Other'

        obj_config = str(df.at[i, 'Object Configuration']) if pd.notna(df.at[i, 'Object Configuration']) else ''
        difficulty_map = {'Singulated': 1, 'Structured': 2, 'Cluttered': 3, 'Packed': 4, 'Piled': 5, 'Stacked': 5}
        label_map = {1: 'Singulated', 2: 'Structured', 3: 'Cluttered', 4: 'Packed', 5: 'Piled'}
        parts = smart_split(obj_config)
        max_diff = max((difficulty_map.get(p, 0) for p in parts), default=0)
        result['Scene Difficulty'][i] = label_map.get(max_diff, 'Unknown')

        hardware = str(df.at[i, 'End-effector Hardware']) if pd.notna(df.at[i, 'End-effector Hardware']) else ''
        hw_parts = smart_split(hardware)
        if len(hw_parts) > 1: result['Gripper Type'][i] = 'Multi-gripper'
        elif any(k in hardware for k in ('Multi-finger', 'Three-finger')): result['Gripper Type'][i] = 'Dexterous'
        elif 'Suction' in hardware: result['Gripper Type'][i] = 'Suction'
        elif 'Two-finger' in hardware: result['Gripper Type'][i] = 'Parallel-jaw'
        else: result['Gripper Type'][i] = 'Unknown'

        lang = str(df.at[i, 'Language']) if pd.notna(df.at[i, 'Language']) else ''
        if 'PyTorch' in lang: result['ML Framework'][i] = 'PyTorch'
        elif 'TensorFlow' in lang: result['ML Framework'][i] = 'TensorFlow'
        elif 'Keras' in lang: result['ML Framework'][i] = 'Keras'
        else: result['ML Framework'][i] = 'None'

        year_val = df.at[i, 'Year (Initial Release)']
        if pd.notna(year_val):
            year = int(year_val)
            if year <= 2018: result['Method Era'][i] = 'Pioneer (2016-2018)'
            elif year <= 2021: result['Method Era'][i] = 'Growth (2019-2021)'
            else: result['Method Era'][i] = 'Modern (2022+)'
        else: result['Method Era'][i] = 'Unknown'
    return result


# ── Export functions ──────────────────────────────────────────────────────────

def export_methods(df, output_dir):
    derived = compute_derived_features(df)
    df_out = df.copy()
    for col, values in derived.items():
        df_out[col] = values
    records = df_out.where(df_out.notna(), None).to_dict(orient='records')
    with open(os.path.join(output_dir, 'methods.json'), 'w') as f:
        json.dump(records, f)
    print(f"  methods.json: {len(records)} methods")
    return df_out


def export_tfidf_matrices(df, output_dir):
    result = {}
    for col in DEFAULT_WEIGHTS:
        if col == 'Description' or col not in df.columns:
            continue
        texts = df[col].fillna('').apply(normalize_multi_value)
        try:
            vec = TfidfVectorizer(max_features=50, ngram_range=(1, 2))
            result[col] = vec.fit_transform(texts).toarray().tolist()
        except Exception as e:
            print(f"  Warning: TF-IDF skip '{col}': {e}")
    with open(os.path.join(output_dir, 'tfidf-matrices.json'), 'w') as f:
        json.dump(result, f)
    print(f"  tfidf-matrices.json: {len(result)} columns")
    return result


def export_description_embeddings(df, cache_path, output_dir):
    n = len(df)
    if os.path.exists(cache_path):
        cached = np.load(cache_path)
        if cached.shape[0] == n:
            print(f"  Loaded cached embeddings: {cached.shape}")
            pca = PCA(n_components=min(50, n - 1), random_state=42)
            reduced = pca.fit_transform(cached) if cached.shape[1] > 50 else cached
            with open(os.path.join(output_dir, 'description-embeddings.json'), 'w') as f:
                json.dump(reduced.tolist(), f)
            print(f"  description-embeddings.json: {reduced.shape}")
            return reduced

    print("  Cache not found, computing with sentence-transformers...")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')
    texts = df['Description'].fillna('').astype(str).tolist()
    full = model.encode(texts, show_progress_bar=True)
    pca = PCA(n_components=min(50, n - 1), random_state=42)
    reduced = pca.fit_transform(full)
    with open(os.path.join(output_dir, 'description-embeddings.json'), 'w') as f:
        json.dump(reduced.tolist(), f)
    print(f"  description-embeddings.json: {reduced.shape}")
    return reduced


def export_umap_default(df, tfidf_matrices, desc_embeddings, output_dir):
    n = len(df)
    feature_parts = []
    for col, weight in DEFAULT_WEIGHTS.items():
        if weight == 0:
            continue
        sqw = np.sqrt(weight)
        if col == 'Description':
            feature_parts.append(desc_embeddings * sqw)
        elif col in tfidf_matrices:
            feature_parts.append(np.array(tfidf_matrices[col]) * sqw)
    features = np.hstack(feature_parts)

    # UMAP
    n_neighbors = min(UMAP_N_NEIGHBORS, max(2, n - 1))
    dist_matrix = pairwise_distances(features, metric=UMAP_METRIC)
    reducer = umap_lib.UMAP(n_neighbors=n_neighbors, min_dist=UMAP_MIN_DIST,
                            metric='precomputed', random_state=42, n_components=2, n_jobs=1)
    coords = reducer.fit_transform(dist_matrix)

    # HDBSCAN
    if n <= 3:
        labels = [0] * n
    else:
        min_cluster = max(3, n // 15)
        clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster, min_samples=1,
                                     metric='euclidean', cluster_selection_method='eom')
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

    derived = compute_derived_features(df)
    data = []
    for i in range(n):
        row = df.iloc[i]
        metadata = {}
        for col in df.columns:
            val = row.get(col, '')
            metadata[col] = '' if pd.isna(val) else str(val)
        for col in DERIVED_COLUMNS:
            metadata[col] = derived[col][i]
        data.append({
            'id': i, 'name': str(row.get('Name', '')),
            'x': float(coords[i, 0]), 'y': float(coords[i, 1]),
            'description': str(row.get('Description', '')),
            'cluster': int(labels[i]), 'metadata': metadata,
        })

    # Build value→cluster map + cluster stats
    weighted_cols = [c for c, w in DEFAULT_WEIGHTS.items() if w > 0 and c in df.columns and c != 'Description']
    value_cluster_map = {}
    for col in weighted_cols:
        vcm = {}
        for idx, raw in enumerate(df[col].fillna('').astype(str)):
            for part in smart_split(raw):
                if part not in vcm:
                    vcm[part] = []
                vcm[part].append(labels[idx])
        value_cluster_map[col] = {v: Counter(cls).most_common(1)[0][0] for v, cls in vcm.items() if cls}

    key_cols = ['Planning Method', 'End-effector Hardware', 'Object Configuration', 'Input Data', 'Training Data']
    clusters = {}
    for pt in data:
        clusters.setdefault(pt['cluster'], []).append(pt)

    cluster_stats = []
    for cid in sorted(clusters):
        members = clusters[cid]
        names = [m['name'] for m in members]
        label_cols = sorted([c for c in DEFAULT_WEIGHTS if c != 'Description'],
                            key=lambda c: DEFAULT_WEIGHTS.get(c, 0), reverse=True)[:3]
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
                short = SHORT_COLUMN_NAMES.get(col, col)
                stat['topAttributes'][short] = [{'value': v, 'count': c} for v, c in top]
        cluster_stats.append(stat)

    result = {
        'data': data,
        'config': {'weights': DEFAULT_WEIGHTS},
        'clusterStats': cluster_stats,
        'nClusters': len(set(labels)),
        'valueClusterMap': value_cluster_map,
    }
    with open(os.path.join(output_dir, 'umap-default.json'), 'w') as f:
        json.dump(result, f)
    print(f"  umap-default.json: {n} methods, {len(set(labels))} clusters")


def export_kg_files(chroma_dir, output_dir, method_df=None):
    from collections import defaultdict

    kg_path = os.path.join(chroma_dir, 'knowledge_graph.json')
    if not os.path.exists(kg_path):
        print("  WARNING: knowledge_graph.json not found, writing empty files")
        for name in ['kg-macro.json', 'kg-landing.json', 'kg-full.json',
                     'kg-predictions.json', 'kg-contradictions.json']:
            with open(os.path.join(output_dir, name), 'w') as f:
                json.dump({}, f)
        return

    with open(kg_path) as f:
        kg_data = json.load(f)
    nodes = kg_data.get('nodes', [])
    edges = kg_data.get('edges', kg_data.get('links', []))
    print(f"  KG loaded: {len(nodes)} nodes, {len(edges)} edges")

    node_by_id = {n['id']: n for n in nodes}

    # ── kg-full.json (normalized) ──
    kg_normalized = {**kg_data, 'links': edges}
    if 'edges' in kg_normalized:
        del kg_normalized['edges']
    with open(os.path.join(output_dir, 'kg-full.json'), 'w') as f:
        json.dump(kg_normalized, f)

    # ── kg-macro.json — structural subgraph matching the backend /api/kg-macro endpoint ──
    macro_types = {'paper', 'method', 'technique', 'hardware',
                   'figure', 'table', 'impl_language', 'author',
                   'institution', 'reference', 'equation', 'dataset',
                   'contribution', 'comparison', 'limitation', 'problem'}
    macro_nodes = [n for n in nodes if n.get('type') in macro_types]
    macro_ids = {n['id'] for n in macro_nodes}
    macro_links = [e for e in edges if e.get('source') in macro_ids and e.get('target') in macro_ids]
    with open(os.path.join(output_dir, 'kg-macro.json'), 'w') as f:
        json.dump({'nodes': macro_nodes, 'links': macro_links}, f)
    print(f"  kg-macro.json: {len(macro_nodes)} nodes, {len(macro_links)} edges")

    # ── Landing page aggregations (mirrors Flask get_kg_landing) ──
    node_types = Counter(n.get('type') for n in nodes)
    edge_types = Counter(e.get('type') for e in edges)

    n_papers = node_types.get('paper', 0)
    n_methods = node_types.get('method', 0)
    n_techniques = node_types.get('technique', 0)
    n_claims = sum(node_types.get(t, 0) for t in ('contribution', 'comparison', 'limitation', 'problem', 'claim'))
    n_chunks = node_types.get('chunk', 0)
    n_citations = edge_types.get('cites', 0)

    summary = {
        'methods': n_methods, 'papers': n_papers, 'techniques': n_techniques,
        'claims': n_claims, 'chunks': n_chunks, 'citations': n_citations,
        'nodes': len(nodes), 'edges': len(edges),
    }

    # Technique co-occurrence
    paper_techniques = defaultdict(set)
    for e in edges:
        if e.get('type') in ('uses_backbone', 'uses_loss', 'trained_on', 'uses_technique'):
            src_node = node_by_id.get(e.get('source'), {})
            tgt_node = node_by_id.get(e.get('target'), {})
            if src_node.get('type') == 'paper' and tgt_node.get('type') == 'technique':
                paper_techniques[e['source']].add(tgt_node.get('label', ''))

    cooccurrence = defaultdict(int)
    tech_counts = Counter()
    for pid, techs in paper_techniques.items():
        for t in techs:
            tech_counts[t] += 1
        techs_list = sorted(techs)
        for i in range(len(techs_list)):
            for j in range(i + 1, len(techs_list)):
                pair = tuple(sorted([techs_list[i], techs_list[j]]))
                cooccurrence[pair] += 1

    cooccurrence_list = [
        {'source': p[0], 'target': p[1], 'weight': c}
        for p, c in sorted(cooccurrence.items(), key=lambda x: -x[1]) if c >= 2
    ][:30]
    technique_nodes = [{'name': n, 'count': c} for n, c in tech_counts.most_common(20)]

    # Benchmark coverage (from CSV)
    benchmark_data = []
    if method_df is not None:
        dataset_col = None
        for c in method_df.columns:
            if 'corresponding' in c.lower() and 'dataset' in c.lower():
                dataset_col = c
                break
        if dataset_col:
            method_benchmarks = defaultdict(list)
            for _, row in method_df.iterrows():
                name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
                raw = str(row.get(dataset_col, ''))
                datasets = [v.strip() for v in raw.split(',') if v.strip() and v.strip().lower() != 'nan']
                for ds in datasets:
                    method_benchmarks[ds].append(name)
            benchmark_data = [
                {'dataset': ds, 'methods': methods, 'count': len(methods)}
                for ds, methods in sorted(method_benchmarks.items(), key=lambda x: -len(x[1]))
                if len(methods) >= 1
            ][:12]

    # Temporal data (from CSV)
    temporal = []
    if method_df is not None:
        year_methods = defaultdict(list)
        for _, row in method_df.iterrows():
            name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
            year = row.get('Year (Initial Release)', '')
            if year and str(year).strip().lower() != 'nan':
                try:
                    y = int(float(str(year)))
                    if 2005 <= y <= 2030:
                        year_methods[y].append(name)
                except (ValueError, TypeError):
                    pass
        temporal = [{'year': y, 'methods': m, 'count': len(m)} for y, m in sorted(year_methods.items())]

    # Top cited papers
    cited_counts = Counter()
    for e in edges:
        if e.get('type') == 'cites':
            tgt = node_by_id.get(e.get('target'), {})
            label = tgt.get('label', '')
            if label:
                cited_counts[label] += 1
    top_cited = [{'paper': n, 'citations': c} for n, c in cited_counts.most_common(10)]

    # Top institutions
    institution_papers = defaultdict(set)
    for e in edges:
        if e.get('type') == 'published_from':
            src = node_by_id.get(e.get('source'), {})
            tgt = node_by_id.get(e.get('target'), {})
            if src.get('type') == 'paper' and tgt.get('type') == 'institution':
                institution_papers[tgt.get('label', '')].add(src.get('label', ''))
    top_institutions = [
        {'name': n, 'count': len(p), 'papers': sorted(p)[:6]}
        for n, p in sorted(institution_papers.items(), key=lambda x: -len(x[1])) if n
    ][:12]

    # Top authors (2+ papers)
    author_papers = defaultdict(set)
    for e in edges:
        if e.get('type') == 'authored_by':
            src = node_by_id.get(e.get('source'), {})
            tgt = node_by_id.get(e.get('target'), {})
            if src.get('type') == 'paper' and tgt.get('type') == 'author':
                author_papers[tgt.get('label', '')].add(src.get('label', ''))
    top_authors = [
        {'name': n, 'count': len(p), 'papers': sorted(p)[:4]}
        for n, p in sorted(author_papers.items(), key=lambda x: -len(x[1])) if n and len(p) >= 2
    ][:10]

    # Citation flow (stance)
    cite_flow = {'builds_on': 0, 'differs_from': 0, 'neutral': 0}
    for e in edges:
        if e.get('type') == 'cites':
            sentiment = e.get('sentiment', 'neutral')
            cite_flow[sentiment] = cite_flow.get(sentiment, 0) + 1

    # Top external references
    ext_ref_counts = Counter()
    ext_ref_meta = {}
    for e in edges:
        if e.get('type') == 'cites_external':
            tgt = node_by_id.get(e.get('target'), {})
            label = tgt.get('label', '')
            if label:
                ext_ref_counts[label] += 1
                if label not in ext_ref_meta:
                    ext_ref_meta[label] = {
                        'year': tgt.get('year', ''),
                        'authors': tgt.get('authors', [])[:2],
                        'venue': tgt.get('venue', ''),
                    }
    top_external_refs = [
        {'title': label, 'citations': c, **ext_ref_meta.get(label, {})}
        for label, c in ext_ref_counts.most_common(10) if c >= 2
    ]

    # Temporal distribution (from CSV years, same source as `temporal`)
    temporal_dist = Counter()
    if method_df is not None:
        for _, row in method_df.iterrows():
            year = row.get('Year (Initial Release)', '')
            if year and str(year).strip().lower() != 'nan':
                try:
                    y = int(float(str(year)))
                    if 2005 <= y <= 2030:
                        temporal_dist[y] += 1
                except (ValueError, TypeError):
                    pass

    landing = {
        'nodeTypeCounts': dict(node_types), 'edgeTypeCounts': dict(edge_types),
        'totalNodes': len(nodes), 'totalEdges': len(edges),
        'temporalDistribution': dict(sorted(temporal_dist.items())),
        'summary': summary,
        'techniqueCooccurrence': {'nodes': technique_nodes, 'links': cooccurrence_list},
        'benchmarkCoverage': benchmark_data,
        'temporal': temporal,
        'topCited': top_cited,
        'topInstitutions': top_institutions,
        'topAuthors': top_authors,
        'citeFlow': cite_flow,
        'topExternalRefs': top_external_refs,
    }
    with open(os.path.join(output_dir, 'kg-landing.json'), 'w') as f:
        json.dump(landing, f)
    print(f"  kg-landing.json: summary + {len(technique_nodes)} techniques, {len(temporal)} years, {len(top_institutions)} institutions, {len(top_authors)} authors, {len(benchmark_data)} benchmarks")

    # ── Predictions — build {nodes, links} graph from the raw edge list ──
    pred_path = os.path.join(chroma_dir, 'hgt_schema', 'predicted_edges.json')
    if os.path.exists(pred_path):
        with open(pred_path) as f:
            all_preds = json.load(f)
        min_conf = 0.55
        preds = [p for p in all_preds if p.get('confidence', 0) >= min_conf]
        pred_node_ids = set()
        for p in preds:
            pred_node_ids.add(p.get('src_id'))
            pred_node_ids.add(p.get('tgt_id'))
        # Also include 1-hop claim neighbors (contribution/comparison/limitation/problem)
        # so the side panel's narrative block can render them.
        claim_types = {'contribution', 'comparison', 'limitation', 'problem'}
        extra_claim_ids = set()
        for e in edges:
            src, tgt = e.get('source'), e.get('target')
            if src in pred_node_ids:
                tgt_node = node_by_id.get(tgt, {})
                if tgt_node.get('type') in claim_types:
                    extra_claim_ids.add(tgt)
            if tgt in pred_node_ids:
                src_node = node_by_id.get(src, {})
                if src_node.get('type') in claim_types:
                    extra_claim_ids.add(src)
        all_pred_node_ids = pred_node_ids | extra_claim_ids
        pred_nodes = []
        for nid in all_pred_node_ids:
            nd = node_by_id.get(nid, {})
            pn = {
                'id': nid,
                'label': nd.get('label', nid.split(':')[-1]),
                'type': nd.get('type', 'paper'),
                'paper_id': nd.get('paper_id', nid.replace('paper:', '') if nid.startswith('paper:') else ''),
                'prediction_degree': sum(1 for q in preds if q.get('src_id') == nid or q.get('tgt_id') == nid),
            }
            if nd.get('value'):
                pn['value'] = nd['value']
            if nd.get('confidence'):
                pn['confidence'] = nd['confidence']
            pred_nodes.append(pn)
        # Build per-paper neighbor sets for comparability computation.
        # Groups: techniques (backbone/loss/technique), datasets, hardware.
        COMPARE_EDGE_TYPES = {
            'uses_backbone': 'Backbone', 'uses_loss': 'Loss', 'uses_technique': 'Technique',
            'uses_dataset': 'Dataset', 'trained_on': 'Dataset', 'evaluated_on': 'Benchmark',
            'uses_hardware': 'Hardware',
        }
        # Pull CSV metadata for the comparability table.
        paper_to_method_label = {}
        for e in edges:
            if e.get('type') == 'described_in':
                src_n = node_by_id.get(e.get('source'), {})
                tgt_n = node_by_id.get(e.get('target'), {})
                if src_n.get('type') == 'method' and tgt_n.get('type') == 'paper':
                    paper_to_method_label[tgt_n['id']] = src_n.get('label', '')
                elif src_n.get('type') == 'paper' and tgt_n.get('type') == 'method':
                    paper_to_method_label[src_n['id']] = tgt_n.get('label', '')
        csv_meta_by_name = {}
        if method_df is not None:
            for _, row in method_df.iterrows():
                name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
                csv_meta_by_name[name] = {
                    'Planning Method': str(row.get('Planning Method', '')),
                    'End-effector Hardware': str(row.get('End-effector Hardware', '')),
                    'Object Configuration': str(row.get('Object Configuration', '')),
                    'Input Data': str(row.get('Input Data', '')),
                    'Output Pose': str(row.get('Output Pose', '')),
                    'Training Data': str(row.get('Training Data', '')),
                }

        paper_neighbors = defaultdict(lambda: defaultdict(set))
        for e in edges:
            etype = e.get('type', '')
            group = COMPARE_EDGE_TYPES.get(etype)
            if not group:
                continue
            src, tgt = e.get('source'), e.get('target')
            src_n = node_by_id.get(src, {})
            tgt_n = node_by_id.get(tgt, {})
            if src_n.get('type') == 'paper':
                paper_neighbors[src][group].add(tgt_n.get('label', ''))
            if tgt_n.get('type') == 'paper':
                paper_neighbors[tgt][group].add(src_n.get('label', ''))

        CMP_KEYS = ['Planning Method', 'End-effector Hardware', 'Object Configuration',
                     'Input Data', 'Output Pose', 'Training Data']
        CMP_SHORT = {'Planning Method': 'Planning', 'End-effector Hardware': 'End-effector',
                      'Object Configuration': 'Scene', 'Input Data': 'Input',
                      'Output Pose': 'Output', 'Training Data': 'Training'}

        def _compute_edge_context(src_id, tgt_id):
            """Compute shared_context and comparability for a paper pair."""
            shared_ctx = []
            for group in sorted(set(list(paper_neighbors[src_id].keys()) + list(paper_neighbors[tgt_id].keys()))):
                overlap = paper_neighbors[src_id][group] & paper_neighbors[tgt_id][group]
                for label in sorted(overlap):
                    shared_ctx.append({'label': f'{group}: {label}'})
            # Comparability from CSV metadata
            m_a = csv_meta_by_name.get(paper_to_method_label.get(src_id, ''), {})
            m_b = csv_meta_by_name.get(paper_to_method_label.get(tgt_id, ''), {})
            shared, differs, gaps = [], [], []
            for key in CMP_KEYS:
                short = CMP_SHORT.get(key, key)
                va = str(m_a.get(key, '')).strip()
                vb = str(m_b.get(key, '')).strip()
                if va in ('', 'nan', 'None'):
                    va = ''
                if vb in ('', 'nan', 'None'):
                    vb = ''
                if va and vb:
                    if va.lower() == vb.lower():
                        shared.append({'label': short, 'value_a': va})
                    else:
                        differs.append({'label': short, 'value_a': va, 'value_b': vb})
                elif va or vb:
                    gaps.append({'label': short, 'value_a': va or None, 'value_b': vb or None})
            cmp = {}
            if shared:
                cmp['shared'] = shared
            if differs:
                cmp['differs'] = differs
            if gaps:
                cmp['gaps'] = gaps
            return shared_ctx, cmp

        pred_links = []
        for p in preds:
            link = {
                'source': p.get('src_id'),
                'target': p.get('tgt_id'),
                'type': p.get('edge_type'),
                'confidence': round(p.get('confidence', 0), 3),
                'semantic_relevance': round(p.get('semantic_relevance', 0), 3),
                'inferred': True,
                'source_type': 'hgt',
            }
            src_type = node_by_id.get(p.get('src_id'), {}).get('type', '')
            tgt_type = node_by_id.get(p.get('tgt_id'), {}).get('type', '')
            if src_type == 'paper' and tgt_type == 'paper':
                ctx, cmp = _compute_edge_context(p.get('src_id'), p.get('tgt_id'))
                if ctx:
                    link['shared_context'] = ctx
                if cmp:
                    link['comparability'] = cmp
            pred_links.append(link)
        # Add observed edges between prediction nodes (contributes, has_limitation, etc.)
        for e in edges:
            src, tgt = e.get('source'), e.get('target')
            if src in all_pred_node_ids and tgt in all_pred_node_ids:
                etype = e.get('type', '')
                if etype in ('contributes', 'has_limitation', 'addresses_problem', 'compares',
                             'outperforms', 'cites', 'uses_backbone', 'uses_loss',
                             'uses_technique', 'described_in', 'uses_hardware',
                             'evaluated_on', 'uses_dataset', 'compared_against'):
                    pred_links.append({
                        'source': src, 'target': tgt, 'type': etype,
                        'inferred': False, 'source_type': 'observed',
                    })
        with open(os.path.join(output_dir, 'kg-predictions.json'), 'w') as f:
            json.dump({'success': True, 'nodes': pred_nodes, 'links': pred_links}, f)
        print(f"  kg-predictions.json: {len(pred_nodes)} nodes ({len(extra_claim_ids)} claim neighbors), {len(pred_links)} links")
    else:
        with open(os.path.join(output_dir, 'kg-predictions.json'), 'w') as f:
            json.dump({'success': True, 'nodes': [], 'links': []}, f)

    # ── Contradictions ──
    try:
        sys.path.insert(0, os.path.join(REPO_ROOT, 'backend'))
        from rag.knowledge_graph import detect_contradictions
        import networkx as nx
        G = nx.node_link_graph(kg_data)
        contras = detect_contradictions(G)
        with open(os.path.join(output_dir, 'kg-contradictions.json'), 'w') as f:
            json.dump(contras, f)
        print(f"  kg-contradictions.json: {len(contras)} contradictions")
    except Exception as e:
        print(f"  kg-contradictions.json: skipped ({e})")
        with open(os.path.join(output_dir, 'kg-contradictions.json'), 'w') as f:
            json.dump([], f)


def export_rag_chunks(chroma_dir, output_dir):
    try:
        import chromadb
        client = chromadb.PersistentClient(path=chroma_dir)
        collection = client.get_collection('grasp_papers')
        results = collection.get(include=['documents', 'metadatas', 'embeddings'])
        chunks = []
        for i in range(len(results['ids'])):
            doc = results['documents'][i] if results['documents'] is not None else ''
            meta = results['metadatas'][i] if results['metadatas'] is not None else {}
            emb = results['embeddings'][i] if results['embeddings'] is not None else []
            if hasattr(emb, 'tolist'):
                emb = emb.tolist()
            chunks.append({'id': results['ids'][i], 'text': doc, 'metadata': meta, 'embedding': emb})
        with open(os.path.join(output_dir, 'rag-chunks.json'), 'w') as f:
            json.dump(chunks, f)
        print(f"  rag-chunks.json: {len(chunks)} chunks")
    except Exception as e:
        print(f"  rag-chunks.json: skipped ({e})")
        with open(os.path.join(output_dir, 'rag-chunks.json'), 'w') as f:
            json.dump([], f)


def export_term_dictionary(output_dir):
    try:
        sys.path.insert(0, os.path.join(REPO_ROOT, 'backend'))
        from rag.term_engine import load_term_dictionary
        chroma_dir = os.path.join(REPO_ROOT, 'chroma_db')
        terms = load_term_dictionary(chroma_dir)
        with open(os.path.join(output_dir, 'term-dictionary.json'), 'w') as f:
            json.dump(terms if isinstance(terms, dict) else {'success': True, 'terms': terms}, f)
        print(f"  term-dictionary.json: {len(terms) if isinstance(terms, dict) else 'exported'}")
    except Exception as e:
        print(f"  term-dictionary.json: skipped ({e})")
        with open(os.path.join(output_dir, 'term-dictionary.json'), 'w') as f:
            json.dump({}, f)


def export_papers_index(papers_dir, output_dir):
    pdfs = sorted(f for f in os.listdir(papers_dir) if f.endswith('.pdf')) if os.path.isdir(papers_dir) else []
    with open(os.path.join(output_dir, 'papers-index.json'), 'w') as f:
        json.dump(pdfs, f)
    print(f"  papers-index.json: {len(pdfs)} PDFs")


def export_query_keywords(output_dir):
    try:
        sys.path.insert(0, os.path.join(REPO_ROOT, 'backend'))
        from rag.query_engine import COLUMN_KEYWORDS, COLOR_BY_KEYWORDS, ATTRIBUTE_TERMS
        data = {
            'columnKeywords': {k: list(v) if not isinstance(v, list) else v for k, v in COLUMN_KEYWORDS.items()},
            'colorByKeywords': {k: list(v) if not isinstance(v, list) else v for k, v in COLOR_BY_KEYWORDS.items()},
            'attributeTerms': ATTRIBUTE_TERMS,
        }
    except Exception as e:
        print(f"  Warning: query_engine import failed ({e}), using empty keywords")
        data = {'columnKeywords': {}, 'colorByKeywords': {}, 'attributeTerms': {}}
    with open(os.path.join(output_dir, 'query-keywords.json'), 'w') as f:
        json.dump(data, f)
    print(f"  query-keywords.json: {len(data.get('columnKeywords', {}))} column keyword sets")


def main():
    parser = argparse.ArgumentParser(description='Generate static JSON for dashboard')
    parser.add_argument('--output', default=os.path.join(REPO_ROOT, 'dashboard', 'public', 'data'))
    parser.add_argument('--csv', default=os.path.join(REPO_ROOT, 'datasets', 'csv-gp-combined.csv'))
    parser.add_argument('--papers', default=os.path.join(REPO_ROOT, 'papers'))
    parser.add_argument('--chroma', default=os.path.join(REPO_ROOT, 'chroma_db'))
    parser.add_argument('--embeddings-cache', default=os.path.join(REPO_ROOT, 'backend', '.description_embeddings.npy'))
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    print(f"Output: {args.output}\nCSV: {args.csv}\n")

    df = pd.read_csv(args.csv)
    print(f"Loaded {len(df)} methods\n")

    print("[1/9] Methods...")
    df_enriched = export_methods(df, args.output)

    print("[2/9] TF-IDF matrices...")
    tfidf = export_tfidf_matrices(df, args.output)

    print("[3/9] Description embeddings...")
    desc_emb = export_description_embeddings(df, args.embeddings_cache, args.output)

    print("[4/9] Default UMAP + clustering...")
    export_umap_default(df, tfidf, desc_emb, args.output)

    print("[5/9] Knowledge graph files...")
    export_kg_files(args.chroma, args.output, method_df=df)

    print("[6/9] RAG chunks...")
    export_rag_chunks(args.chroma, args.output)

    print("[7/9] Term dictionary...")
    export_term_dictionary(args.output)

    print("[8/9] Papers index...")
    export_papers_index(args.papers, args.output)

    print("[9/9] Query keywords...")
    export_query_keywords(args.output)

    # Copy PDFs
    papers_dest = os.path.join(os.path.dirname(args.output), 'papers')
    os.makedirs(papers_dest, exist_ok=True)
    if os.path.isdir(args.papers):
        for f in os.listdir(args.papers):
            if f.endswith('.pdf'):
                src = os.path.join(args.papers, f)
                dst = os.path.join(papers_dest, f)
                if not os.path.exists(dst):
                    shutil.copy2(src, dst)
        print(f"\nCopied PDFs to {papers_dest}")

    print("\nDone! All static JSON files generated.")


if __name__ == '__main__':
    main()
