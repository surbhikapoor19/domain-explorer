"""Link prediction using trained HGT embeddings + DistMult decoder.

Uses the learned node embeddings and per-relation DistMult weights
to predict missing edges. Scoring now matches training exactly:
raw dot-product through the DistMult decoder (no L2 normalization).

The original predictor applied L2 normalization before scoring
(cosine similarity), creating a mismatch with training which used
raw dot-product. This fix aligns the two.
"""

import json
import logging
import os
from collections import Counter

import numpy as np
import torch

from .config import FEATURE_DIM, USE_METAPATH_AUGMENTATION

logger = logging.getLogger(__name__)

PREDICTION_TARGETS = [
    ('paper', 'has_limitation',     'limitation',    'Papers likely missing extracted limitations'),
    ('paper', 'addresses_problem',  'problem',       'Papers likely addressing problems not yet linked'),
    ('paper', 'compares',           'comparison',    'Papers with comparison claims not yet captured'),
    ('paper', 'contributes',        'contribution',  'Papers likely with contributions not yet extracted'),
    ('paper', 'outperforms',        'paper',         'Papers structurally positioned for head-to-head comparison'),
    ('paper', 'uses_technique',     'technique',     'Papers likely using techniques not yet extracted'),
    ('paper', 'compared_against',   'paper',         'Papers likely benchmarked head-to-head but not yet linked'),
]


def predict_missing_edges(
    embeddings: dict,
    node_mappings: dict,
    node_metadata: dict,
    existing_edges: list,
    model=None,
    top_k: int = 5,
    min_confidence: float = 0.5,
    original_features: dict = None,
) -> list:
    """Predict missing edges using the DistMult decoder.

    When a trained model is provided, uses its DistMult decoder for
    scoring (matching training exactly). Falls back to raw dot-product
    when no model is available.
    """
    existing_sets = {}
    for edge in existing_edges:
        key = (edge['src_type'], edge['edge_type'], edge['tgt_type'])
        if key not in existing_sets:
            existing_sets[key] = set()
        existing_sets[key].add((edge['src_idx'], edge['tgt_idx']))

    predictions = []

    for src_type, edge_type, tgt_type, description in PREDICTION_TARGETS:
        if src_type not in embeddings or tgt_type not in embeddings:
            continue

        src_emb = embeddings[src_type]
        tgt_emb = embeddings[tgt_type]
        n_src, n_tgt = src_emb.shape[0], tgt_emb.shape[0]

        if n_src == 0 or n_tgt == 0:
            continue

        # Score using DistMult decoder if model available, else raw dot-product
        # NO L2 normalization — matches training scoring exactly
        edge_key = (src_type, edge_type, tgt_type)

        if model is not None and hasattr(model, 'decoder'):
            src_t = torch.tensor(src_emb, dtype=torch.float32)
            tgt_t = torch.tensor(tgt_emb, dtype=torch.float32)
            with torch.no_grad():
                # Batch score: for each src, score against all targets
                scores = np.zeros((n_src, n_tgt), dtype=np.float32)
                for i in range(n_src):
                    src_expanded = src_t[i].unsqueeze(0).expand(n_tgt, -1)
                    s = model.decoder(src_expanded, tgt_t, edge_key)
                    scores[i] = s.numpy()
        else:
            # Fallback: raw dot-product + sigmoid (no normalization)
            scores = 1.0 / (1.0 + np.exp(-(src_emb @ tgt_emb.T)))

        existing = existing_sets.get(edge_key, set())
        src_metadata = node_metadata.get(src_type, [])
        tgt_metadata = node_metadata.get(tgt_type, [])

        for src_idx in range(n_src):
            row = scores[src_idx].copy()

            for tgt_idx in range(n_tgt):
                if (src_idx, tgt_idx) in existing:
                    row[tgt_idx] = -1
                if src_type == tgt_type and src_idx == tgt_idx:
                    row[tgt_idx] = -1

            top_indices = np.argsort(row)[-top_k:][::-1]
            for tgt_idx in top_indices:
                score = float(row[tgt_idx])
                if score < min_confidence:
                    continue

                src_meta = src_metadata[src_idx] if src_idx < len(src_metadata) else {}
                tgt_meta = tgt_metadata[tgt_idx] if tgt_idx < len(tgt_metadata) else {}

                predictions.append({
                    'src_type': src_type,
                    'edge_type': edge_type,
                    'tgt_type': tgt_type,
                    'src_idx': int(src_idx),
                    'tgt_idx': int(tgt_idx),
                    'confidence': round(score, 4),
                    'src_id': src_meta.get('original_id', ''),
                    'src_label': src_meta.get('label', ''),
                    'tgt_id': tgt_meta.get('original_id', ''),
                    'tgt_label': tgt_meta.get('label', ''),
                    'tgt_value': tgt_meta.get('value', ''),
                    'description': description,
                    'inferred': True,
                })

    predictions.sort(key=lambda x: x['confidence'], reverse=True)

    if original_features is not None:
        filtered = []
        for p in predictions:
            src_type = p['src_type']
            tgt_type = p['tgt_type']
            src_idx = p['src_idx']
            tgt_idx = p['tgt_idx']

            if src_type in original_features and tgt_type in original_features:
                src_feat = original_features[src_type][src_idx]
                tgt_feat = original_features[tgt_type][tgt_idx]
                sim = float(np.dot(src_feat, tgt_feat) / (
                    np.linalg.norm(src_feat) * np.linalg.norm(tgt_feat) + 1e-8
                ))
                p['semantic_relevance'] = round(sim, 4)
                if src_type == tgt_type and sim < 0.3:
                    continue
                filtered.append(p)
            else:
                filtered.append(p)
        predictions = filtered

    logger.info(f"Predicted {len(predictions)} missing edges (after semantic filter)")
    return predictions


def run_prediction(schema_dir: str, output_path: str = None, top_k: int = 5,
                   min_confidence: float = 0.5, use_model: bool = True):
    """Full prediction pipeline: load embeddings -> predict -> save."""
    from .model import load_embeddings, HeteroLinkPredictor
    from .schema import load_schema

    features, node_mappings, node_metadata, edges, meta_relations = load_schema(schema_dir)
    embeddings = load_embeddings(schema_dir)

    print(f"[Predict] Loaded {sum(v.shape[0] for v in embeddings.values())} node embeddings")
    print(f"[Predict] Existing edges: {len(edges)}")
    print(f"[Predict] Predicting for {len(PREDICTION_TARGETS)} relation types...")

    # Try to load the trained model for DistMult scoring
    model = None
    if use_model:
        model_path = os.path.join(schema_dir, 'hgt_model.pt')
        if os.path.exists(model_path):
            try:
                from .model import schema_to_heterodata
                from .augment import add_metapath_edges
                data = schema_to_heterodata(features, edges, meta_relations)
                if USE_METAPATH_AUGMENTATION:
                    data = add_metapath_edges(data, edges)
                metadata = (list(data.node_types), list(data.edge_types))
                feat_dims = {nt: features[nt].shape[1] for nt in features
                             if features[nt].shape[0] > 0}
                in_dim = next(iter(set(feat_dims.values()))) if feat_dims else FEATURE_DIM
                model = HeteroLinkPredictor(metadata=metadata, in_dim=in_dim)
                model.load_state_dict(torch.load(model_path, weights_only=True))
                model.eval()
                print("[Predict] Loaded DistMult decoder from trained model")
            except Exception as e:
                logger.warning(f"[Predict] Could not load model for DistMult scoring: {e}")
                model = None

    predictions = predict_missing_edges(
        embeddings=embeddings,
        node_mappings=node_mappings,
        node_metadata=node_metadata,
        existing_edges=edges,
        model=model,
        top_k=top_k,
        min_confidence=min_confidence,
        original_features=features,
    )

    type_counts = Counter(p['edge_type'] for p in predictions)
    for etype, count in type_counts.most_common():
        avg_conf = np.mean([p['confidence'] for p in predictions if p['edge_type'] == etype])
        print(f"  {etype}: {count} predictions (avg confidence: {avg_conf:.3f})")

    if output_path is None:
        output_path = os.path.join(schema_dir, 'predicted_edges.json')

    with open(output_path, 'w') as f:
        json.dump(predictions, f, indent=2)

    print(f"\n[Predict] Saved {len(predictions)} predictions to {output_path}")

    print(f"\n[Predict] Top 10 predictions:")
    for p in predictions[:10]:
        print(f"  [{p['confidence']:.3f}] {p['src_label']} --[{p['edge_type']}]--> {p['tgt_label']}")
        if p.get('tgt_value'):
            print(f"           \"{p['tgt_value'][:80]}\"")

    return predictions
