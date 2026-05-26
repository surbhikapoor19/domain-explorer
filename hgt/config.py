"""Centralized configuration for the HGT training pipeline.

Single source of truth for hyperparameters, paths, and constants.
Import from here instead of scattering defaults across modules.
"""

import os

# ---------------------------------------------------------------------------
# Paths (relative to project root; override via env vars)
# ---------------------------------------------------------------------------
DEFAULT_SCHEMA_DIR = os.environ.get("HGT_SCHEMA_DIR", "chroma_db/hgt_schema")
DEFAULT_CHROMA_DIR = os.environ.get("HGT_CHROMA_DIR", "chroma_db")

# ---------------------------------------------------------------------------
# Feature dimensions
# ---------------------------------------------------------------------------
BASE_DIM = 768          # SPECTER2 or sentence-transformer (zero-padded)
CONTENT_DIM = 34        # paper-specific content channels
FEATURE_DIM = BASE_DIM + CONTENT_DIM  # 802

# ---------------------------------------------------------------------------
# Model architecture
# ---------------------------------------------------------------------------
HIDDEN_DIM = 64
NUM_LAYERS = 2
DROPOUT = 0.3

# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------
EPOCHS = 300
LEARNING_RATE = 0.001
WEIGHT_DECAY = 1e-5
LOG_EVERY = 25

# InfoNCE loss
NEG_RATIO = 64
TEMPERATURE = 0.07

# Early stopping
EARLY_STOPPING_PATIENCE = 100
EARLY_STOPPING_METRIC = "mrr"  # monitor val MRR

# Relation weighting
USE_RELATION_WEIGHTS = True

# Edge split
TRAIN_RATIO = 0.8
VAL_RATIO = 0.1
SPLIT_SEED = 42
MIN_EDGES_FOR_SPLIT = 5  # edge types below this go to train only

# ---------------------------------------------------------------------------
# Bibliometric relations — kept in graph for message passing but excluded
# from loss computation. These are 77% of test edges with near-random AUC;
# they drag the global metric without contributing learnable signal.
# ---------------------------------------------------------------------------
BIBLIOMETRIC_RELATIONS = {
    ("author", "co_authored_with", "author"),
    ("author", "colleagues_with", "author"),
    ("paper", "co_cited_with", "paper"),
    ("paper", "shares_bibliography", "paper"),
    ("author", "author_works_on", "topic"),
    # Note: cited_by_external and cites_external are kept IN the loss.
    # They're 77% of edges with low per-relation AUC, but their gradient
    # signal improves the encoder — target-relation AUC drops from 0.78
    # to 0.63 when they're excluded (tested 2026-05-20).
}

# Reverse edges are auto-generated with "rev_" prefix; exclude those too
BIBLIOMETRIC_RELATIONS_WITH_REV = BIBLIOMETRIC_RELATIONS | {
    (tgt, f"rev_{rel}", src) for src, rel, tgt in BIBLIOMETRIC_RELATIONS
}

# ---------------------------------------------------------------------------
# Phase 2: Augmentation (stubs — activated when augment.py is wired in)
# ---------------------------------------------------------------------------
EDGE_DROPOUT = 0.15
METAPATHS = [
    ("paper", "method", "paper", "shares_method"),
    ("paper", "attribute", "paper", "shares_attribute"),
    ("paper", "topic", "paper", "shares_topic"),
]
USE_METAPATH_AUGMENTATION = True
USE_EDGE_DROPOUT = True

# ---------------------------------------------------------------------------
# Phase 3: Contrastive pre-training (stubs)
# ---------------------------------------------------------------------------
PRETRAIN_EPOCHS = 100
PRETRAIN_FEAT_MASK = 0.2
PRETRAIN_EDGE_DROP = 0.2
PRETRAIN_TEMPERATURE = 0.1
USE_CONTRASTIVE_PRETRAIN = True
