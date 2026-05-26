"""Emit description-embeddings.json — PCA-reduced sentence-transformer vectors.

Used as the 'Description' column input to UMAP recomputation in the browser.
Cache: backend/.description_embeddings.npy (raw 384-dim) — if present, skip
re-encoding and just PCA-reduce.
"""
import json
import os

import numpy as np
from sklearn.decomposition import PCA


def export_description_embeddings(df, cache_path, output_dir):
    n = len(df)
    if os.path.exists(cache_path):
        cached = np.load(cache_path)
        if cached.shape[0] == n:
            print(f"  Loaded cached embeddings: {cached.shape}")
            pca = PCA(n_components=min(50, n - 1), random_state=42)
            reduced = pca.fit_transform(cached) if cached.shape[1] > 50 else cached
            with open(os.path.join(output_dir, 'description-embeddings.json'), 'w') as f:
                json.dump(reduced.tolist(), f)
            print(f"  description-embeddings.json: {reduced.shape}")
            return reduced

    print("  Cache not found, computing with sentence-transformers...")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')
    texts = df['Description'].fillna('').astype(str).tolist()
    full = model.encode(texts, show_progress_bar=True)
    pca = PCA(n_components=min(50, n - 1), random_state=42)
    reduced = pca.fit_transform(full)
    with open(os.path.join(output_dir, 'description-embeddings.json'), 'w') as f:
        json.dump(reduced.tolist(), f)
    print(f"  description-embeddings.json: {reduced.shape}")
    return reduced
