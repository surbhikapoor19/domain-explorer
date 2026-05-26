"""Thin wrapper — real implementation lives in hgt.model.

Kept for backward compatibility with existing imports.
"""

import sys
import os

_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from hgt.model import (  # noqa: F401, E402
    schema_to_heterodata,
    HomoGNN,
    DistMultDecoder,
    HeteroLinkPredictor,
    save_model,
    load_embeddings,
)

# Legacy function — still importable but now lives in hgt.train
from hgt.model import save_model, load_embeddings  # noqa: F811

# Legacy training function — re-export from the old location
def sample_negative_edges(edge_index, num_nodes_src, num_nodes_tgt, num_neg):
    """Legacy wrapper for backward compat."""
    import numpy as np
    import torch
    pos_set = set(zip(edge_index[0].tolist(), edge_index[1].tolist()))
    neg_src, neg_tgt = [], []
    attempts = 0
    while len(neg_src) < num_neg and attempts < num_neg * 10:
        s = np.random.randint(0, num_nodes_src)
        t = np.random.randint(0, num_nodes_tgt)
        if (s, t) not in pos_set:
            neg_src.append(s)
            neg_tgt.append(t)
        attempts += 1
    return torch.tensor([neg_src, neg_tgt], dtype=torch.long)


def train_hgt(*args, **kwargs):
    """Legacy entry point — redirects to hgt.train."""
    raise NotImplementedError(
        "train_hgt() is deprecated. Use `python -m hgt.run` or "
        "hgt.train.train_and_evaluate() instead."
    )
