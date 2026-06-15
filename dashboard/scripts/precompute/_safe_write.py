"""Overwrite protection for precompute artifacts.

A partial or failed rebuild (e.g. a CSV-only run with no ChromaDB present, a
crashed extractor, or a transient load error) must NEVER blank the dashboard by
clobbering a committed, non-empty artifact with an empty/stub build. Every
precompute export routes its write through `safe_write_json`, which keeps the
existing good data when the new build is empty.

This mirrors the benchmark writer's existing guard (graph/benchmark_data.py
`_write_benchmark_json`) and generalizes it to all KG / explorer / RAG exports.
"""
import json
import os


def item_count(data):
    """Best-effort 'meaningful item count' for a precompute artifact, used only to
    decide empty-vs-non-empty. Conservative: anything we can't interpret counts as
    non-empty so we never refuse a legitimate write."""
    if data is None:
        return 0
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        # If the payload carries known container keys (graph nodes/links, umap
        # `data`, benchmark leaderboards/comparisons), its emptiness is determined
        # ONLY by those containers — so {'success': True, 'nodes': [], 'links': []}
        # correctly counts as empty (the `success` flag must not mask it).
        structural = [k for k in ('nodes', 'links', 'data', 'entries', 'leaderboards', 'comparisons', 'records')
                      if k in data and isinstance(data[k], (list, dict))]
        if structural:
            return sum(len(data[k]) for k in structural)
        if 'totalNodes' in data:
            return int(data.get('totalNodes') or 0)
        # Otherwise (distributions/config-style dict) any truthy value is content.
        return sum(1 for v in data.values() if v)
    return 1 if data else 0


def safe_write_json(path, data, dump_kwargs=None, label=None):
    """Write `data` to `path` as JSON, but REFUSE to overwrite an existing
    non-empty file with empty data. Returns True if written, False if refused."""
    if item_count(data) == 0 and os.path.exists(path):
        try:
            with open(path) as f:
                if item_count(json.load(f)) > 0:
                    print(f"  REFUSING to overwrite {os.path.basename(path)} with an empty build — "
                          f"keeping existing data{(' (' + label + ')') if label else ''}")
                    return False
        except Exception:
            pass  # unreadable/corrupt existing file -> fall through and write
    with open(path, 'w') as f:
        json.dump(data, f, **(dump_kwargs or {}))
    return True
