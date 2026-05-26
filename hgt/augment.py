"""Graph augmentation for Phase 2 + Phase 3.

Phase 2:
  - Metapath augmentation: add virtual edges from 2-hop metapaths
  - Edge dropout: randomly drop edges per epoch for regularization

Phase 3:
  - Feature masking: zero-mask random feature dimensions for contrastive views
  - Graph view generation: create two augmented views for GraphCL pre-training
"""

import copy
import logging

import numpy as np
import torch
from torch_geometric.data import HeteroData

from .config import EDGE_DROPOUT, METAPATHS

logger = logging.getLogger(__name__)


def add_metapath_edges(data: HeteroData, schema_edges: list, metapaths=None):
    """Add virtual edges from 2-hop metapaths to densify the graph.

    For each metapath (src_type, via_type, tgt_type, new_rel):
      - Find all (src_a, via_node, tgt_b) paths
      - Add new_rel edge between src_a and tgt_b
      - Deduplicate against existing edges

    Returns modified HeteroData (in-place).
    """
    if metapaths is None:
        metapaths = METAPATHS

    for src_type, via_type, tgt_type, new_rel in metapaths:
        # Find edges: src_type -> via_type
        src_to_via = {}
        via_to_tgt = {}

        for edge_key in data.edge_types:
            s, _, t = edge_key
            if s == src_type and t == via_type:
                ei = data[edge_key].edge_index
                for i in range(ei.shape[1]):
                    src_id = ei[0, i].item()
                    via_id = ei[1, i].item()
                    src_to_via.setdefault(via_id, []).append(src_id)

            if s == via_type and t == tgt_type:
                ei = data[edge_key].edge_index
                for i in range(ei.shape[1]):
                    via_id = ei[0, i].item()
                    tgt_id = ei[1, i].item()
                    via_to_tgt.setdefault(via_id, []).append(tgt_id)

        # Build new edges through via nodes
        new_src = []
        new_tgt = []
        seen = set()
        for via_id in src_to_via:
            if via_id not in via_to_tgt:
                continue
            for s in src_to_via[via_id]:
                for t in via_to_tgt[via_id]:
                    if s != t and (s, t) not in seen:
                        new_src.append(s)
                        new_tgt.append(t)
                        seen.add((s, t))

        if new_src:
            edge_key = (src_type, new_rel, tgt_type)
            new_ei = torch.tensor([new_src, new_tgt], dtype=torch.long)

            if edge_key in data.edge_types:
                existing = data[edge_key].edge_index
                data[edge_key].edge_index = torch.cat([existing, new_ei], dim=1)
            else:
                data[edge_key].edge_index = new_ei

            # Also add reverse
            rev_key = (tgt_type, f"rev_{new_rel}", src_type)
            rev_ei = torch.tensor([new_tgt, new_src], dtype=torch.long)
            if rev_key in data.edge_types:
                existing = data[rev_key].edge_index
                data[rev_key].edge_index = torch.cat([existing, rev_ei], dim=1)
            else:
                data[rev_key].edge_index = rev_ei

            logger.info(f"  Metapath {src_type}->{via_type}->{tgt_type}: added {len(new_src)} {new_rel} edges")

    return data


def edge_dropout(data: HeteroData, drop_rate: float = EDGE_DROPOUT):
    """Randomly drop edges from a copy of HeteroData for regularization.

    Returns a new HeteroData with edges randomly dropped. Never modifies
    the input — always works on a deep copy.
    """
    dropped = copy.deepcopy(data)
    for edge_key in list(dropped.edge_types):
        ei = dropped[edge_key].edge_index
        n = ei.shape[1]
        if n < 2:
            continue
        mask = torch.rand(n) > drop_rate
        if mask.sum() == 0:
            mask[0] = True
        dropped[edge_key].edge_index = ei[:, mask]
    return dropped


def feature_mask(data: HeteroData, mask_rate: float = 0.2):
    """Zero-mask random feature dimensions for contrastive view generation."""
    masked = copy.deepcopy(data)
    for nt in masked.node_types:
        if hasattr(masked[nt], 'x') and masked[nt].x is not None:
            x = masked[nt].x
            mask = torch.rand(x.shape[1]) > mask_rate
            masked[nt].x = x * mask.float().unsqueeze(0)
    return masked


def create_contrastive_views(data: HeteroData, feat_mask_rate=0.2, edge_drop_rate=0.2):
    """Create two augmented views of the graph for GraphCL pre-training."""
    view1 = feature_mask(edge_dropout(data, edge_drop_rate), feat_mask_rate)
    view2 = feature_mask(edge_dropout(data, edge_drop_rate), feat_mask_rate)
    return view1, view2
