"""HGT training pipeline (Phase 1 + Phase 2 + Phase 3).

Phase 1 fixes:
  - InfoNCE loss replaces BCE (temperature-scaled contrastive)
  - Type-constrained negative sampling (64:1 ratio)
  - Bibliometric relations excluded from loss (kept for message passing)
  - Data leakage fix: edge types with <5 edges go to train only
  - DistMult decoder (relation-aware scoring)
  - Early stopping on validation MRR
  - Reduced capacity (2 layers, hidden=64, dropout=0.3)

Phase 2 additions:
  - Metapath augmentation (virtual edges from 2-hop paths)
  - Edge dropout regularization per epoch (15% drop rate)
  - TEI-extracted outperforms edges (wired via schema pipeline)

Phase 3 additions:
  - GraphCL contrastive pre-training of the encoder before fine-tuning
  - NT-Xent loss on dual augmented graph views (feature mask + edge drop)
  - 2-stage training: pretrain encoder → fine-tune encoder + decoder

Usage:
    python -m hgt.run --schema-dir chroma_db/hgt_schema --epochs 300 --pretrain
"""

import json
import logging
import os
import time
from datetime import datetime

import numpy as np
import torch
import torch.nn.functional as F
from torch_geometric.data import HeteroData

from .config import (
    BIBLIOMETRIC_RELATIONS_WITH_REV,
    EARLY_STOPPING_METRIC,
    EARLY_STOPPING_PATIENCE,
    EDGE_DROPOUT,
    EPOCHS,
    FEATURE_DIM,
    HIDDEN_DIM,
    LEARNING_RATE,
    LOG_EVERY,
    MIN_EDGES_FOR_SPLIT,
    NEG_RATIO,
    NUM_LAYERS,
    DROPOUT,
    PRETRAIN_EDGE_DROP,
    PRETRAIN_EPOCHS,
    PRETRAIN_FEAT_MASK,
    PRETRAIN_TEMPERATURE,
    SPLIT_SEED,
    TEMPERATURE,
    TRAIN_RATIO,
    USE_CONTRASTIVE_PRETRAIN,
    USE_EDGE_DROPOUT,
    USE_METAPATH_AUGMENTATION,
    USE_RELATION_WEIGHTS,
    VAL_RATIO,
    WEIGHT_DECAY,
)
from .schema import load_schema
from .model import (
    schema_to_heterodata,
    HeteroLinkPredictor,
    save_model,
)
from .evaluate import evaluate, print_report
from .augment import add_metapath_edges, create_contrastive_views, edge_dropout

logger = logging.getLogger(__name__)


def split_edges(data, train_ratio=TRAIN_RATIO, val_ratio=VAL_RATIO, seed=SPLIT_SEED):
    """Split edges into train/val/test per edge type.

    Edge types with fewer than MIN_EDGES_FOR_SPLIT edges are placed
    entirely in train (no val/test) to prevent data leakage.
    """
    np.random.seed(seed)
    splits = {}
    for edge_key in data.edge_types:
        ei = data[edge_key].edge_index
        n = ei.shape[1]
        if n < MIN_EDGES_FOR_SPLIT:
            # All edges go to train only — no val/test leakage
            splits[edge_key] = {
                'train': ei,
                'val': torch.zeros((2, 0), dtype=torch.long),
                'test': torch.zeros((2, 0), dtype=torch.long),
            }
            logger.warning(
                f"  {edge_key[1]}: only {n} edges, all assigned to train (no val/test)"
            )
            continue
        perm = torch.tensor(np.random.permutation(n))
        tr = int(train_ratio * n)
        va = int((train_ratio + val_ratio) * n)
        splits[edge_key] = {
            'train': ei[:, perm[:tr]],
            'val': ei[:, perm[tr:va]],
            'test': ei[:, perm[va:]],
        }
    return splits


def build_split_data(data, splits, split_name='train'):
    """Build a HeteroData with only the specified split's edges."""
    split_data = HeteroData()
    for nt in data.node_types:
        if hasattr(data[nt], 'x') and data[nt].x is not None:
            split_data[nt].x = data[nt].x
            split_data[nt].num_nodes = data[nt].num_nodes
    for edge_key, sp in splits.items():
        ei = sp[split_name]
        if ei.shape[1] > 0:
            split_data[edge_key].edge_index = ei
    return split_data


def get_x_dict(data):
    """Extract feature dict from HeteroData."""
    return {
        nt: data[nt].x
        for nt in data.node_types
        if hasattr(data[nt], 'x') and data[nt].x is not None
    }


def sample_type_constrained_negatives(
    edge_index, edge_key, data, num_neg_per_pos,
):
    """Sample type-constrained negatives for a given edge type.

    For meta-relation (src_type, rel, tgt_type), corrupt target nodes
    by sampling only from nodes of tgt_type. This prevents the model
    from learning trivial type-discrimination shortcuts.
    """
    src_type, _, tgt_type = edge_key
    n_pos = edge_index.shape[1]
    total_neg = n_pos * num_neg_per_pos

    num_tgt = data[tgt_type].num_nodes
    pos_set = set(zip(edge_index[0].tolist(), edge_index[1].tolist()))

    # Batch sample with rejection
    neg_src = []
    neg_tgt = []

    # Repeat each positive source index num_neg_per_pos times
    src_repeated = edge_index[0].repeat_interleave(num_neg_per_pos)
    # Sample random targets of the correct type
    tgt_random = torch.randint(0, num_tgt, (total_neg,), dtype=torch.long)

    for i in range(total_neg):
        s = src_repeated[i].item()
        t = tgt_random[i].item()
        if (s, t) not in pos_set:
            neg_src.append(s)
            neg_tgt.append(t)

    # If rejection sampling dropped too many, fill with unchecked samples
    while len(neg_src) < total_neg:
        s = src_repeated[len(neg_src) % total_neg].item()
        t = np.random.randint(0, num_tgt)
        neg_src.append(s)
        neg_tgt.append(t)

    return torch.tensor([neg_src[:total_neg], neg_tgt[:total_neg]], dtype=torch.long)


def info_nce_loss(pos_logits, neg_logits_flat, num_neg_per_pos, temperature):
    """InfoNCE loss over positive/negative logit pairs.

    For each positive edge, computes:
        L = -log(exp(pos/τ) / (exp(pos/τ) + Σ exp(neg_i/τ)))

    Args:
        pos_logits: (n_pos,) raw scores for positive edges
        neg_logits_flat: (n_pos * num_neg,) raw scores for negatives
        num_neg_per_pos: number of negatives per positive
        temperature: τ scaling factor
    """
    n_pos = pos_logits.shape[0]
    neg_logits = neg_logits_flat[:n_pos * num_neg_per_pos].view(n_pos, num_neg_per_pos)

    pos_scaled = pos_logits / temperature  # (n_pos,)
    neg_scaled = neg_logits / temperature  # (n_pos, num_neg)

    # log-sum-exp over [positive, negatives] for numerical stability
    all_logits = torch.cat([pos_scaled.unsqueeze(1), neg_scaled], dim=1)  # (n_pos, 1+num_neg)
    log_denom = torch.logsumexp(all_logits, dim=1)  # (n_pos,)

    loss = -(pos_scaled - log_denom).mean()
    return loss


def nt_xent_loss(z1_dict, z2_dict, temperature=0.1):
    """NT-Xent loss for contrastive pre-training across node types.

    For each node type, treats (z1[i], z2[i]) as a positive pair
    and all other nodes as negatives.
    """
    total_loss = 0.0
    n_types = 0

    for nt in z1_dict:
        if nt not in z2_dict:
            continue
        z1 = F.normalize(z1_dict[nt], dim=1)
        z2 = F.normalize(z2_dict[nt], dim=1)
        N = z1.shape[0]
        if N < 2:
            continue

        pos_sim = (z1 * z2).sum(dim=1) / temperature
        sim_matrix = z1 @ z2.T / temperature
        log_denom = torch.logsumexp(sim_matrix, dim=1)
        loss = -(pos_sim - log_denom).mean()

        total_loss += loss
        n_types += 1

    return total_loss / max(n_types, 1)


def pretrain_contrastive(
    model, train_data,
    epochs=PRETRAIN_EPOCHS,
    lr=LEARNING_RATE,
    feat_mask_rate=PRETRAIN_FEAT_MASK,
    edge_drop_rate=PRETRAIN_EDGE_DROP,
    temperature=PRETRAIN_TEMPERATURE,
    log_every=10,
):
    """GraphCL-style contrastive pre-training of the encoder.

    Creates two augmented views of the training graph each epoch
    (feature masking + edge dropout), encodes both, and minimizes
    NT-Xent loss to align same-node embeddings across views.
    Only trains the encoder — the decoder is untouched.
    """
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=WEIGHT_DECAY)

    print(f"[Pretrain] GraphCL contrastive pre-training ({epochs} epochs)")
    print(f"[Pretrain] feat_mask={feat_mask_rate}, edge_drop={edge_drop_rate}, τ={temperature}")

    best_loss = float('inf')
    best_state = None

    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()

        view1, view2 = create_contrastive_views(train_data, feat_mask_rate, edge_drop_rate)
        h1 = model(get_x_dict(view1), view1.edge_index_dict)
        h2 = model(get_x_dict(view2), view2.edge_index_dict)

        loss = nt_xent_loss(h1, h2, temperature)
        loss.backward()
        optimizer.step()

        if (epoch + 1) % log_every == 0 or epoch == 0:
            l = loss.item()
            print(f"  Pretrain {epoch+1}/{epochs}: loss={l:.4f}")
            if l < best_loss:
                best_loss = l
                best_state = {k: v.clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)
        print(f"[Pretrain] Complete — best loss={best_loss:.4f}")

    return model


def _build_relation_weights(train_data) -> dict:
    """Inverse-log-frequency weight per meta-relation, excluding bibliometric."""
    weights = {}
    for edge_key in train_data.edge_types:
        if edge_key in BIBLIOMETRIC_RELATIONS_WITH_REV:
            continue
        n = max(1, train_data[edge_key].edge_index.shape[1])
        weights[edge_key] = 1.0 / np.log1p(n)
    if not weights:
        return {}
    mean_w = sum(weights.values()) / len(weights)
    return {k: v / mean_w for k, v in weights.items()}


def train_and_evaluate(
    schema_dir: str,
    epochs: int = EPOCHS,
    hidden_dim: int = HIDDEN_DIM,
    lr: float = LEARNING_RATE,
    log_every: int = LOG_EVERY,
    num_layers: int = NUM_LAYERS,
    dropout: float = DROPOUT,
    neg_ratio: int = NEG_RATIO,
    temperature: float = TEMPERATURE,
    relation_weights: bool = USE_RELATION_WEIGHTS,
    patience: int = EARLY_STOPPING_PATIENCE,
    use_metapath: bool = USE_METAPATH_AUGMENTATION,
    use_edge_dropout: bool = USE_EDGE_DROPOUT,
    edge_drop_rate: float = EDGE_DROPOUT,
    use_pretrain: bool = USE_CONTRASTIVE_PRETRAIN,
    pretrain_epochs: int = PRETRAIN_EPOCHS,
    pretrain_feat_mask: float = PRETRAIN_FEAT_MASK,
    pretrain_edge_drop: float = PRETRAIN_EDGE_DROP,
    pretrain_temperature: float = PRETRAIN_TEMPERATURE,
):
    """Full training pipeline with Phase 1 + Phase 2 + Phase 3 improvements."""
    features, node_mappings, node_metadata, edges, meta_relations = load_schema(schema_dir)
    data = schema_to_heterodata(features, edges, meta_relations)

    if use_metapath:
        print("[Train] Adding metapath virtual edges...")
        data = add_metapath_edges(data, edges)
        print(f"[Train] Post-metapath edge types: {len(data.edge_types)}")

    splits = split_edges(data)
    train_data = build_split_data(data, splits, 'train')

    n_train = sum(s['train'].shape[1] for s in splits.values())
    n_val = sum(s['val'].shape[1] for s in splits.values())
    n_test = sum(s['test'].shape[1] for s in splits.values())
    print(f"[Train] Edges: {n_train} train, {n_val} val, {n_test} test")

    # Count semantic vs bibliometric training edges
    n_semantic = sum(
        s['train'].shape[1] for ek, s in splits.items()
        if ek not in BIBLIOMETRIC_RELATIONS_WITH_REV and 'rev_' not in ek[1]
    )
    n_biblio = sum(
        s['train'].shape[1] for ek, s in splits.items()
        if ek in BIBLIOMETRIC_RELATIONS_WITH_REV and 'rev_' not in ek[1]
    )
    print(f"[Train] Semantic: {n_semantic} edges trained | Bibliometric: {n_biblio} edges (msg-passing only)")

    metadata = (list(data.node_types), list(data.edge_types))
    feat_dims = {nt: features[nt].shape[1] for nt in features if features[nt].shape[0] > 0}
    in_dims = set(feat_dims.values())
    if len(in_dims) > 1:
        raise ValueError(f"Heterogeneous input dims across node types {feat_dims}; all must match.")
    in_dim = next(iter(in_dims)) if in_dims else FEATURE_DIM
    model = HeteroLinkPredictor(
        metadata=metadata, in_dim=in_dim,
        hidden_dim=hidden_dim, num_layers=num_layers, dropout=dropout,
    )
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[Train] Model: {n_params:,} parameters "
          f"(in_dim={in_dim}, hidden={hidden_dim}, layers={num_layers}, dropout={dropout})")
    print(f"[Train] Loss: InfoNCE (τ={temperature}, neg_ratio={neg_ratio})")

    if use_pretrain:
        pretrain_contrastive(
            model, train_data,
            epochs=pretrain_epochs,
            lr=lr,
            feat_mask_rate=pretrain_feat_mask,
            edge_drop_rate=pretrain_edge_drop,
            temperature=pretrain_temperature,
        )

    rel_weights = _build_relation_weights(train_data) if relation_weights else None
    if rel_weights:
        sorted_w = sorted(rel_weights.items(), key=lambda kv: -kv[1])
        print("[Train] Relation weights (top 5 rare):",
              [(k[1], round(v, 2)) for k, v in sorted_w[:5]])
        print("[Train] Relation weights (top 5 bulk):",
              [(k[1], round(v, 2)) for k, v in sorted_w[-5:]])

    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=WEIGHT_DECAY)

    train_log = []
    best_val_metric = -1
    best_epoch = 0
    best_state = None
    start = time.time()

    if use_edge_dropout:
        print(f"[Train] Edge dropout enabled: {edge_drop_rate:.0%} per epoch")

    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()

        epoch_data = edge_dropout(train_data, edge_drop_rate) if use_edge_dropout else train_data
        x_dict = get_x_dict(epoch_data)
        h_dict = model(x_dict, epoch_data.edge_index_dict)

        loss = torch.tensor(0.0, requires_grad=True)

        for edge_key in epoch_data.edge_types:
            # Skip bibliometric relations in loss computation
            if edge_key in BIBLIOMETRIC_RELATIONS_WITH_REV:
                continue

            ei = epoch_data[edge_key].edge_index
            if ei.shape[1] < 2:
                continue
            src_t, _, tgt_t = edge_key

            # Positive logits (raw, pre-sigmoid for InfoNCE)
            pos_logits = model.score_raw(h_dict, src_t, ei[0], tgt_t, ei[1], edge_type=edge_key)

            # Type-constrained negative sampling
            neg_ei = sample_type_constrained_negatives(ei, edge_key, epoch_data, neg_ratio)
            neg_logits = model.score_raw(
                h_dict, src_t, neg_ei[0], tgt_t, neg_ei[1], edge_type=edge_key
            )

            edge_loss = info_nce_loss(pos_logits, neg_logits, neg_ratio, temperature)

            if rel_weights is not None:
                edge_loss = edge_loss * rel_weights.get(edge_key, 1.0)

            loss = loss + edge_loss

        loss.backward()
        optimizer.step()

        # Periodic validation + logging
        if (epoch + 1) % log_every == 0 or epoch == 0:
            val_metrics = evaluate(model, data, splits, 'val', train_data)
            entry = {
                'epoch': epoch + 1,
                'train_loss': round(loss.item(), 4),
                'val_auc': val_metrics['auc_roc'],
                'val_semantic_auc': val_metrics.get('semantic_auc', 0),
                'val_f1': val_metrics['f1'],
                'val_mrr': val_metrics['mrr'],
                'val_semantic_mrr': val_metrics.get('semantic_mrr', 0),
                'val_hits10': val_metrics['hits_at_10'],
                'val_ndcg10': val_metrics['ndcg_at_10'],
            }
            train_log.append(entry)
            print(
                f"  Epoch {epoch+1}/{epochs}: loss={loss.item():.4f} | "
                f"sem_AUC={val_metrics.get('semantic_auc', 0):.4f} "
                f"sem_MRR={val_metrics.get('semantic_mrr', 0):.4f} "
                f"AUC={val_metrics['auc_roc']:.4f} "
                f"MRR={val_metrics['mrr']:.4f} "
                f"H@10={val_metrics['hits_at_10']:.4f}"
            )

            # Early stopping check
            current_metric = val_metrics.get(f'semantic_{EARLY_STOPPING_METRIC}',
                                              val_metrics.get(EARLY_STOPPING_METRIC, 0))
            if current_metric > best_val_metric:
                best_val_metric = current_metric
                best_epoch = epoch + 1
                best_state = {k: v.clone() for k, v in model.state_dict().items()}
            elif (epoch + 1) - best_epoch >= patience:
                print(f"\n[Train] Early stopping at epoch {epoch+1} "
                      f"(best {EARLY_STOPPING_METRIC}={best_val_metric:.4f} at epoch {best_epoch})")
                break

    elapsed = time.time() - start
    print(f"\n[Train] Complete in {elapsed:.1f}s")

    # Restore best model
    if best_state is not None:
        model.load_state_dict(best_state)
        print(f"[Train] Restored best model from epoch {best_epoch}")

    # Final evaluation
    test_metrics = evaluate(model, data, splits, 'test', train_data)
    val_metrics = evaluate(model, data, splits, 'val', train_data)

    # Get embeddings from best model
    model.eval()
    with torch.no_grad():
        x_dict = get_x_dict(data)
        h_dict_full = model(x_dict, train_data.edge_index_dict)
        h_dict_np = {k: v.numpy() for k, v in h_dict_full.items()}

    # Save versioned artifacts
    version = datetime.now().strftime('%Y%m%d_%H%M%S')
    version_dir = os.path.join(schema_dir, 'versions', version)
    os.makedirs(version_dir, exist_ok=True)

    save_model(model, h_dict_np, version_dir)
    save_model(model, h_dict_np, schema_dir)

    report = {
        'version': version,
        'timestamp': datetime.now().isoformat(),
        'phase': 'phase3' if use_pretrain else ('phase2' if (use_metapath or use_edge_dropout) else 'phase1'),
        'config': {
            'epochs': epochs,
            'actual_epochs': best_epoch,
            'hidden_dim': hidden_dim,
            'num_layers': num_layers,
            'dropout': dropout,
            'lr': lr,
            'loss': 'InfoNCE',
            'temperature': temperature,
            'neg_ratio': neg_ratio,
            'decoder': 'DistMult',
            'relation_weights': relation_weights,
            'early_stopping_patience': patience,
            'early_stopping_metric': EARLY_STOPPING_METRIC,
            'use_metapath_augmentation': use_metapath,
            'use_edge_dropout': use_edge_dropout,
            'edge_drop_rate': edge_drop_rate if use_edge_dropout else 0,
            'n_params': n_params,
            'n_nodes': sum(features[t].shape[0] for t in features),
            'n_edges_total': n_train + n_val + n_test,
            'n_edges_train': n_train,
            'n_edges_val': n_val,
            'n_edges_test': n_test,
            'n_semantic_train': n_semantic,
            'n_bibliometric_train': n_biblio,
            'use_contrastive_pretrain': use_pretrain,
            'pretrain_epochs': pretrain_epochs if use_pretrain else 0,
        },
        'training': {
            'elapsed_seconds': round(elapsed, 1),
            'final_loss': round(loss.item(), 4),
            'best_epoch': best_epoch,
            'best_val_metric': round(best_val_metric, 4),
            'log': train_log,
        },
        'val_metrics': val_metrics,
        'test_metrics': test_metrics,
    }

    report_path = os.path.join(version_dir, 'metrics.json')
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2)

    with open(os.path.join(schema_dir, 'latest_metrics.json'), 'w') as f:
        json.dump(report, f, indent=2)

    print_report(val_metrics, test_metrics, version)

    print(f"\n  Artifacts saved to: {version_dir}")
    print(f"  Latest metrics:     {schema_dir}/latest_metrics.json")

    return report
