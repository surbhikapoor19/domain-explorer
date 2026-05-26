"""Thin wrapper — real implementation lives in hgt.predict.

Kept for backward compatibility with existing imports.
"""

import sys
import os

_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from hgt.predict import (  # noqa: F401, E402
    PREDICTION_TARGETS,
    predict_missing_edges,
    run_prediction,
)
