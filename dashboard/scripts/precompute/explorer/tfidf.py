"""Emit tfidf-matrices.json — per-column TF-IDF vectors.

Consumed by ai-pipeline.js / umap.js to recompute UMAP coordinates whenever
the user changes weight sliders or runs an AI query.
"""
import json
import os

from sklearn.feature_extraction.text import TfidfVectorizer

from ..shared.config import DEFAULT_WEIGHTS, DomainConfig
from ..shared.csv_utils import normalize_multi_value


def export_tfidf_matrices(df, output_dir, domain_cfg=None):
    weights = domain_cfg.weights if domain_cfg else DEFAULT_WEIGHTS
    result = {}
    for col in weights:
        if col == 'Description' or col not in df.columns:
            continue
        texts = df[col].fillna('').apply(normalize_multi_value)
        try:
            vec = TfidfVectorizer(max_features=50, ngram_range=(1, 2))
            result[col] = vec.fit_transform(texts).toarray().tolist()
        except Exception as e:
            print(f"  Warning: TF-IDF skip '{col}': {e}")
    with open(os.path.join(output_dir, 'tfidf-matrices.json'), 'w') as f:
        json.dump(result, f)
    print(f"  tfidf-matrices.json: {len(result)} columns")
    return result
