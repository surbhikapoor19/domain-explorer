"""Thin wrapper — real implementation lives in hgt.schema.

Kept for backward compatibility with existing imports.
"""

import sys
import os

# Ensure project root is on sys.path so `hgt` package is importable
_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from hgt.schema import (  # noqa: F401, E402
    TYPE_CONSOLIDATION,
    EDGE_CONSOLIDATION,
    HGT_NODE_TYPES,
    ROLE_BUCKETS,
    CONTENT_BUCKETS,
    TOPIC_K,
    consolidate_graph,
    compute_node_features,
    save_schema,
    load_schema,
    build_and_save,
)

from hgt.config import BASE_DIM, CONTENT_DIM, FEATURE_DIM  # noqa: F401, E402
