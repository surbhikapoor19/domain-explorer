"""Thin wrapper — real implementation lives in hgt.train.

Kept for backward compatibility with existing imports.
"""

import sys
import os

_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from hgt.train import (  # noqa: F401, E402
    split_edges,
    build_split_data,
    get_x_dict,
    sample_type_constrained_negatives,
    info_nce_loss,
    train_and_evaluate,
)

from hgt.evaluate import evaluate  # noqa: F401, E402

# Legacy CLI entry point
def main():
    from hgt.run import main as _main
    _main()


if __name__ == "__main__":
    main()
