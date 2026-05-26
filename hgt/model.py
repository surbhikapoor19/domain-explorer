"""GNN encoder + DistMult decoder for heterogeneous link prediction.

Uses PyG's SAGEConv + to_hetero() for per-type message passing.
The DistMult decoder learns a per-relation diagonal weight vector
so different relation types get different scoring functions:

    score(src, rel, tgt) = sigmoid(sum(src * R_rel * tgt))

This replaces the relation-agnostic dot-product decoder from the
original codebase, which scored all relation types identically.
"""

import json
import logging
import os

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.data import HeteroData
from torch_geometric.nn import SAGEConv, Linear, to_hetero

from .config import HIDDEN_DIM, NUM_LAYERS, DROPOUT, FEATURE_DIM

logger = logging.getLogger(__name__)


def schema_to_heterodata(features: dict, edges: list, meta_relations: list) -> HeteroData:
    """Convert consolidated schema into PyG HeteroData.

    Adds reverse edges for all edge types so message passing
    reaches all node types (required by to_hetero).
    """
    data = HeteroData()

    for node_type, feat_array in features.items():
        if feat_array.shape[0] > 0:
            data[node_type].x = torch.tensor(feat_array, dtype=torch.float32)
            data[node_type].num_nodes = feat_array.shape[0]

    edge_dict = {}
    for edge in edges:
        fwd = (edge['src_type'], edge['edge_type'], edge['tgt_type'])
        if fwd not in edge_dict:
            edge_dict[fwd] = ([], [])
        edge_dict[fwd][0].append(edge['src_idx'])
        edge_dict[fwd][1].append(edge['tgt_idx'])

        rev = (edge['tgt_type'], f"rev_{edge['edge_type']}", edge['src_type'])
        if rev not in edge_dict:
            edge_dict[rev] = ([], [])
        edge_dict[rev][0].append(edge['tgt_idx'])
        edge_dict[rev][1].append(edge['src_idx'])

    for (src_t, edge_t, tgt_t), (src_list, tgt_list) in edge_dict.items():
        data[(src_t, edge_t, tgt_t)].edge_index = torch.tensor(
            [src_list, tgt_list], dtype=torch.long
        )

    return data


class HomoGNN(nn.Module):
    """Multi-layer SAGE that gets auto-heterogenized by to_hetero()."""

    def __init__(self, in_dim, hidden_dim, num_layers=2, dropout=0.3):
        super().__init__()
        self.proj = Linear(in_dim, hidden_dim)
        self.convs = nn.ModuleList(
            [SAGEConv(hidden_dim, hidden_dim) for _ in range(num_layers)]
        )
        self.dropout = dropout

    def forward(self, x, edge_index):
        x = self.proj(x)
        for conv in self.convs:
            x = F.relu(conv(x, edge_index))
            x = F.dropout(x, p=self.dropout, training=self.training)
        return x


class DistMultDecoder(nn.Module):
    """Per-relation diagonal scoring: score = sigmoid(sum(src * R * tgt)).

    Each relation type gets its own learnable weight vector R of size
    hidden_dim. Initialized to ones so the initial behavior approximates
    plain dot-product (smooth transition from the old decoder).
    """

    def __init__(self, hidden_dim, edge_types):
        super().__init__()
        self.rel_emb = nn.ParameterDict({
            self._key(et): nn.Parameter(torch.ones(hidden_dim))
            for et in edge_types
        })

    @staticmethod
    def _key(edge_type):
        """Flatten (src, rel, tgt) tuple into a valid ParameterDict key."""
        return '__'.join(str(t) for t in edge_type)

    def forward(self, src_emb, tgt_emb, edge_type):
        key = self._key(edge_type)
        if key not in self.rel_emb:
            return torch.sigmoid((src_emb * tgt_emb).sum(dim=-1))
        r = self.rel_emb[key]
        return torch.sigmoid((src_emb * r * tgt_emb).sum(dim=-1))

    def score_raw(self, src_emb, tgt_emb, edge_type):
        """Return raw logits (pre-sigmoid) for use with InfoNCE loss."""
        key = self._key(edge_type)
        if key not in self.rel_emb:
            return (src_emb * tgt_emb).sum(dim=-1)
        r = self.rel_emb[key]
        return (src_emb * r * tgt_emb).sum(dim=-1)


class HeteroLinkPredictor(nn.Module):
    """Heterogeneous GNN encoder + DistMult link prediction decoder."""

    def __init__(self, metadata, in_dim=FEATURE_DIM, hidden_dim=HIDDEN_DIM,
                 num_layers=NUM_LAYERS, dropout=DROPOUT):
        super().__init__()
        self.hidden_dim = hidden_dim
        self.num_layers = num_layers
        base = HomoGNN(in_dim, hidden_dim, num_layers=num_layers, dropout=dropout)
        self.encoder = to_hetero(base, metadata, aggr='mean')
        all_edge_types = metadata[1]
        self.decoder = DistMultDecoder(hidden_dim, all_edge_types)

    def forward(self, x_dict, edge_index_dict):
        return self.encoder(x_dict, edge_index_dict)

    def predict_link(self, h_dict, src_type, src_idx, tgt_type, tgt_idx, edge_type=None):
        """Score edges using the DistMult decoder.

        If edge_type is None, falls back to plain dot-product (backward compat).
        """
        src_emb = h_dict[src_type][src_idx]
        tgt_emb = h_dict[tgt_type][tgt_idx]
        if edge_type is not None:
            return self.decoder(src_emb, tgt_emb, edge_type)
        return torch.sigmoid(torch.sum(src_emb * tgt_emb, dim=-1))

    def score_raw(self, h_dict, src_type, src_idx, tgt_type, tgt_idx, edge_type):
        """Raw logits (pre-sigmoid) for InfoNCE loss."""
        src_emb = h_dict[src_type][src_idx]
        tgt_emb = h_dict[tgt_type][tgt_idx]
        return self.decoder.score_raw(src_emb, tgt_emb, edge_type)


def save_model(model, h_dict_np, output_dir):
    """Save trained model and embeddings."""
    os.makedirs(output_dir, exist_ok=True)

    torch.save(model.state_dict(), os.path.join(output_dir, 'hgt_model.pt'))

    np.savez(
        os.path.join(output_dir, 'hgt_embeddings.npz'),
        **{f'{t}_embeddings': arr for t, arr in h_dict_np.items()}
    )

    print(f"[HGT] Saved model and embeddings to {output_dir}")


def load_embeddings(output_dir):
    """Load pre-computed HGT embeddings."""
    data = np.load(os.path.join(output_dir, 'hgt_embeddings.npz'))
    return {
        key.replace('_embeddings', ''): data[key]
        for key in data.files
    }
