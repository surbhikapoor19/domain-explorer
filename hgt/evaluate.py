"""Evaluation metrics for heterogeneous link prediction.

Reports per-relation AUC, MRR, Hits@k, NDCG@10, split into
semantic vs bibliometric categories. Bibliometric relations
(co_authored_with, co_cited_with, etc.) are reported separately
since they're excluded from the training loss.
"""

import logging
from collections import defaultdict

import numpy as np
import torch
from sklearn.metrics import roc_auc_score, average_precision_score

from .config import BIBLIOMETRIC_RELATIONS

logger = logging.getLogger(__name__)

# Edge type names (middle element of the tuple) for bibliometric relations
_BIBLIO_EDGE_NAMES = {rel for _, rel, _ in BIBLIOMETRIC_RELATIONS}


def evaluate(model, data, splits, split_name, train_data, neg_per_query=50):
    """Evaluate link prediction on a split.

    Returns dict with global metrics + per_type breakdown + semantic/bibliometric split.
    """
    model.eval()
    with torch.no_grad():
        x_dict = {
            nt: data[nt].x
            for nt in data.node_types
            if hasattr(data[nt], 'x') and data[nt].x is not None
        }
        h_dict = model(x_dict, train_data.edge_index_dict)

        all_pos_scores = []
        all_neg_scores = []
        hits_at = {1: [], 5: [], 10: []}
        mrr_values = []
        ndcg_at_10_values = []
        per_type = defaultdict(lambda: {
            'pos': [], 'neg': [], 'n': 0,
            'mrr': [], 'hits1': [], 'hits3': [], 'hits10': [], 'ndcg10': [],
        })

        for edge_key in data.edge_types:
            src_t, edge_t, tgt_t = edge_key
            if 'rev_' in edge_t:
                continue

            if edge_key not in splits:
                continue
            ei = splits[edge_key].get(split_name)
            if ei is None:
                continue
            n_pos = ei.shape[1]
            if n_pos < 1:
                continue

            pos_scores = model.predict_link(
                h_dict, src_t, ei[0], tgt_t, ei[1], edge_type=edge_key
            ).numpy()
            all_pos_scores.extend(pos_scores.tolist())
            per_type[edge_t]['pos'].extend(pos_scores.tolist())
            per_type[edge_t]['n'] += n_pos

            neg_src = []
            neg_tgt = []
            pos_set = set(zip(ei[0].tolist(), ei[1].tolist()))
            attempts = 0
            while len(neg_src) < n_pos and attempts < n_pos * 10:
                s = np.random.randint(0, data[src_t].num_nodes)
                t = np.random.randint(0, data[tgt_t].num_nodes)
                if (s, t) not in pos_set:
                    neg_src.append(s)
                    neg_tgt.append(t)
                attempts += 1
            neg_ei = torch.tensor([neg_src, neg_tgt], dtype=torch.long)
            neg_scores = model.predict_link(
                h_dict, src_t, neg_ei[0], tgt_t, neg_ei[1], edge_type=edge_key
            ).numpy()
            all_neg_scores.extend(neg_scores.tolist())
            per_type[edge_t]['neg'].extend(neg_scores.tolist())

            for idx in range(min(n_pos, neg_per_query)):
                src_idx = ei[0, idx].item()
                true_score = float(pos_scores[idx])

                rand_tgts = torch.tensor(
                    np.random.randint(0, data[tgt_t].num_nodes, neg_per_query),
                    dtype=torch.long,
                )
                rand_scores = model.predict_link(
                    h_dict, src_t,
                    torch.full((neg_per_query,), src_idx, dtype=torch.long),
                    tgt_t, rand_tgts,
                    edge_type=edge_key,
                ).numpy()

                rank = int((rand_scores >= true_score).sum()) + 1
                rr = 1.0 / rank
                ndcg10 = (1.0 / np.log2(rank + 1)) if rank <= 10 else 0.0

                for k in hits_at:
                    hits_at[k].append(1 if rank <= k else 0)
                mrr_values.append(rr)
                ndcg_at_10_values.append(ndcg10)
                per_type[edge_t]['mrr'].append(rr)
                per_type[edge_t]['hits1'].append(1 if rank <= 1 else 0)
                per_type[edge_t]['hits3'].append(1 if rank <= 3 else 0)
                per_type[edge_t]['hits10'].append(1 if rank <= 10 else 0)
                per_type[edge_t]['ndcg10'].append(ndcg10)

    scores = np.array(all_pos_scores + all_neg_scores)
    labels = np.array([1] * len(all_pos_scores) + [0] * len(all_neg_scores))

    preds_bin = (scores >= 0.5).astype(int)
    tp = int(((preds_bin == 1) & (labels == 1)).sum())
    fp = int(((preds_bin == 1) & (labels == 0)).sum())
    fn = int(((preds_bin == 0) & (labels == 1)).sum())
    tn = int(((preds_bin == 0) & (labels == 0)).sum())

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    accuracy = (tp + tn) / len(labels) if len(labels) > 0 else 0

    try:
        auc = roc_auc_score(labels, scores)
    except ValueError:
        auc = 0.0
    try:
        ap = average_precision_score(labels, scores)
    except ValueError:
        ap = 0.0

    type_metrics = {}
    for etype, vals in per_type.items():
        if vals['pos'] and vals['neg']:
            t_labels = [1] * len(vals['pos']) + [0] * len(vals['neg'])
            t_scores = vals['pos'] + vals['neg']
            try:
                t_auc = roc_auc_score(t_labels, t_scores)
            except ValueError:
                t_auc = 0.0
            type_metrics[etype] = {
                'auc': round(t_auc, 4),
                'mrr': round(float(np.mean(vals['mrr'])), 4) if vals['mrr'] else 0,
                'hits_at_1': round(float(np.mean(vals['hits1'])), 4) if vals['hits1'] else 0,
                'hits_at_3': round(float(np.mean(vals['hits3'])), 4) if vals['hits3'] else 0,
                'hits_at_10': round(float(np.mean(vals['hits10'])), 4) if vals['hits10'] else 0,
                'ndcg_at_10': round(float(np.mean(vals['ndcg10'])), 4) if vals['ndcg10'] else 0,
                'n_pos': vals['n'],
                'avg_pos_score': round(float(np.mean(vals['pos'])), 4),
                'avg_neg_score': round(float(np.mean(vals['neg'])), 4),
                'category': 'bibliometric' if etype in _BIBLIO_EDGE_NAMES else 'semantic',
            }

    # Aggregate semantic-only metrics (excluding bibliometric)
    sem_pos = []
    sem_neg = []
    sem_mrr = []
    sem_hits10 = []
    for etype, vals in per_type.items():
        if etype in _BIBLIO_EDGE_NAMES:
            continue
        sem_pos.extend(vals['pos'])
        sem_neg.extend(vals['neg'])
        sem_mrr.extend(vals['mrr'])
        sem_hits10.extend(vals['hits10'])

    sem_auc = 0.0
    if sem_pos and sem_neg:
        try:
            s_labels = [1] * len(sem_pos) + [0] * len(sem_neg)
            s_scores = sem_pos + sem_neg
            sem_auc = roc_auc_score(s_labels, s_scores)
        except ValueError:
            pass

    return {
        'accuracy': round(accuracy, 4),
        'precision': round(precision, 4),
        'recall': round(recall, 4),
        'f1': round(f1, 4),
        'auc_roc': round(auc, 4),
        'avg_precision': round(ap, 4),
        'hits_at_1': round(float(np.mean(hits_at[1])), 4) if hits_at[1] else 0,
        'hits_at_5': round(float(np.mean(hits_at[5])), 4) if hits_at[5] else 0,
        'hits_at_10': round(float(np.mean(hits_at[10])), 4) if hits_at[10] else 0,
        'mrr': round(float(np.mean(mrr_values)), 4) if mrr_values else 0,
        'ndcg_at_10': round(float(np.mean(ndcg_at_10_values)), 4) if ndcg_at_10_values else 0,
        'n_pos': len(all_pos_scores),
        'n_neg': len(all_neg_scores),
        'per_type': type_metrics,
        'semantic_auc': round(sem_auc, 4),
        'semantic_mrr': round(float(np.mean(sem_mrr)), 4) if sem_mrr else 0,
        'semantic_hits_at_10': round(float(np.mean(sem_hits10)), 4) if sem_hits10 else 0,
    }


def print_report(val_metrics, test_metrics, version=''):
    """Print a formatted evaluation report."""
    print(f"\n{'='*60}")
    print(f"MODEL EVALUATION REPORT{' — v' + version if version else ''}")
    print(f"{'='*60}")

    for split_name, metrics in [('VAL', val_metrics), ('TEST', test_metrics)]:
        print(f"\n  {split_name} ({metrics['n_pos']} pos, {metrics['n_neg']} neg):")
        print(f"    Global AUC-ROC:   {metrics['auc_roc']:.4f}")
        print(f"    Semantic AUC:     {metrics.get('semantic_auc', 0):.4f}")
        print(f"    Semantic MRR:     {metrics.get('semantic_mrr', 0):.4f}")
        print(f"    Semantic H@10:    {metrics.get('semantic_hits_at_10', 0):.4f}")
        print(f"    F1:               {metrics['f1']:.4f}")
        print(f"    Hits@10:          {metrics['hits_at_10']:.4f}")
        print(f"    MRR:              {metrics['mrr']:.4f}")
        print(f"    NDCG@10:          {metrics['ndcg_at_10']:.4f}")

        if metrics.get('per_type'):
            sem_types = {k: v for k, v in metrics['per_type'].items()
                         if v.get('category') != 'bibliometric'}
            bib_types = {k: v for k, v in metrics['per_type'].items()
                         if v.get('category') == 'bibliometric'}

            if sem_types:
                print(f"\n    Semantic relations:")
                for etype, tm in sorted(sem_types.items(), key=lambda x: -x[1]['auc']):
                    print(f"      {etype:30s} AUC={tm['auc']:.4f}  MRR={tm['mrr']:.4f}  "
                          f"H@10={tm['hits_at_10']:.4f}  (n={tm['n_pos']})")

            if bib_types:
                print(f"\n    Bibliometric relations (message-passing only, not trained):")
                for etype, tm in sorted(bib_types.items(), key=lambda x: -x[1]['auc']):
                    print(f"      {etype:30s} AUC={tm['auc']:.4f}  (n={tm['n_pos']})")
