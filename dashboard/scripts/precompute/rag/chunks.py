"""Emit rag-chunks.json — every chunk with embedding + 2D UMAP layout.

Coverage contract — guarantees the fields each RAG component reads:
  RAGInsightsPage / PaperAnatomy:
    id, text, embedding, metadata.{paper_id, paper_title, section, subsection,
      layer, position, page, token_count, chunk_type, content_type,
      rhetorical_role, section_type, domain_topics, citations}
  ChunkMap (FLAT, top-level):
    x, y, paper_id, section, snippet
  rag-search (browser-side cosine retrieval):
    embedding

The flat x/y/paper_id/snippet fields close the gap that made ChunkMap render
nothing previously. UMAP is fit on the chunk embeddings using the same
hyperparameters as the Explorer's method-level UMAP.
"""
import json
import os

import numpy as np
import umap as umap_lib
from sklearn.metrics import pairwise_distances

from ..shared.config import UMAP_METRIC, UMAP_MIN_DIST, UMAP_N_NEIGHBORS
from .._safe_write import safe_write_json

SNIPPET_LEN = 240


def _make_snippet(text):
    if not text:
        return ''
    s = str(text).strip().replace('\n', ' ')
    return s if len(s) <= SNIPPET_LEN else s[:SNIPPET_LEN].rsplit(' ', 1)[0] + '…'


def _layout_chunks(embeddings):
    """2D UMAP over chunk embeddings — returns (n,2) coords, all-zeros on failure."""
    n = len(embeddings)
    if n < 4:
        return np.zeros((n, 2))
    arr = np.asarray(embeddings, dtype=float)
    n_neighbors = min(UMAP_N_NEIGHBORS, max(2, n - 1))
    try:
        dist = pairwise_distances(arr, metric=UMAP_METRIC)
        reducer = umap_lib.UMAP(
            n_neighbors=n_neighbors, min_dist=UMAP_MIN_DIST,
            metric='precomputed', random_state=42, n_components=2, n_jobs=1,
        )
        return reducer.fit_transform(dist)
    except Exception as e:
        print(f"  Warning: chunk UMAP failed ({e}), using zeros")
        return np.zeros((n, 2))


def _papers_collection(client):
    """Pick the domain's papers collection ('<slug>_papers') instead of hardcoding
    the grasp collection — each domain's ChromaDB holds its own '<slug>_papers'
    (e.g. 'motion-planning_papers'). Falls back to the only collection present."""
    try:
        names = [getattr(c, 'name', c) for c in client.list_collections()]
    except Exception:
        names = []
    papers = [n for n in names if str(n).endswith('_papers')]
    name = papers[0] if papers else (names[0] if names else 'grasp_papers')
    return client.get_collection(name)


def export_rag_chunks(chroma_dir, output_dir):
    try:
        import chromadb
        client = chromadb.PersistentClient(path=chroma_dir)
        collection = _papers_collection(client)
        results = collection.get(include=['documents', 'metadatas', 'embeddings'])
    except Exception as e:
        # No chroma collection on this run (e.g. a CSV-only rebuild without the
        # vector store). Don't blank a committed corpus — keep the existing chunks.
        print(f"  rag-chunks.json: no collection this run ({e})")
        safe_write_json(os.path.join(output_dir, 'rag-chunks.json'), [], label='no chroma collection')
        return

    ids = results['ids']
    docs = results.get('documents') or [''] * len(ids)
    metas = results.get('metadatas') or [{}] * len(ids)
    embs = results.get('embeddings')
    embeddings = []
    for i in range(len(ids)):
        e = embs[i] if embs is not None else []
        embeddings.append(e.tolist() if hasattr(e, 'tolist') else list(e))

    coords = _layout_chunks(embeddings) if embeddings and embeddings[0] else np.zeros((len(ids), 2))

    chunks = []
    for i in range(len(ids)):
        meta = metas[i] or {}
        text = docs[i] or ''
        chunks.append({
            'id': ids[i],
            'text': text,
            'metadata': meta,
            'embedding': embeddings[i],
            # Flat fields that ChunkMap reads directly:
            'x': float(coords[i, 0]),
            'y': float(coords[i, 1]),
            'paper_id': meta.get('paper_id', ''),
            'section': meta.get('section', ''),
            'snippet': _make_snippet(text),
        })

    safe_write_json(os.path.join(output_dir, 'rag-chunks.json'), chunks, label='empty chunk set')
    print(f"  rag-chunks.json: {len(chunks)} chunks (with 2D UMAP + flat fields)")
