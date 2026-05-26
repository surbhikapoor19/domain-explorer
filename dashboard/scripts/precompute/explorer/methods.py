"""Emit methods.json — full enriched method records.

Consumed by the AI pipeline (ai-pipeline.js) for query rewriting and method
relevance scoring. Not rendered directly by any Explorer component, but the
pipeline result feeds InsightCard / AnalyticsDashboard / MethodTable.
"""
import json
import math
import os

from ..shared.derived_features import compute_derived_features


def _clean(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def export_methods(df, output_dir, domain_cfg=None):
    derived = compute_derived_features(df, domain_cfg)
    df_out = df.copy()
    for col, values in derived.items():
        df_out[col] = values
    records = [{k: _clean(v) for k, v in r.items()} for r in df_out.to_dict(orient='records')]
    with open(os.path.join(output_dir, 'methods.json'), 'w') as f:
        json.dump(records, f, allow_nan=False)
    noun = domain_cfg.method_noun if domain_cfg else 'method'
    print(f"  methods.json: {len(records)} {noun}s")
    return df_out
