"""ChromaDB storage operations for paper chunks.

Handles collection creation, chunk upserting, and deletion.
Uses PersistentClient so the index survives restarts.
"""

import numpy as np
import chromadb

from .chunker import Chunk
from ..config import RAGConfig


def get_client(config: RAGConfig) -> chromadb.ClientAPI:
    """Create a persistent ChromaDB client."""
    return chromadb.PersistentClient(path=config.chroma_persist_dir)


def create_or_get_collection(config: RAGConfig, client: chromadb.ClientAPI = None):
    """Get or create the paper chunks collection."""
    if client is None:
        client = get_client(config)
    return client.get_or_create_collection(
        name=config.collection_name,
        metadata={"hnsw:space": "cosine"}
    )


def upsert_chunks(collection, chunks: list, embeddings: np.ndarray, extra_metadata: dict = None):
    """Batch upsert chunks with embeddings and metadata into ChromaDB.

    Args:
        collection: ChromaDB collection.
        chunks: List of Chunk objects.
        embeddings: numpy array of shape (n_chunks, dim).
        extra_metadata: optional dict merged into every chunk's metadata (e.g. the
            incremental-memoization stamp {"pdf_sha256": ..., "ingest_salt": ...}).
    """
    if not chunks:
        return

    extra = extra_metadata or {}

    # ChromaDB has a batch limit; process in batches of 500
    batch_size = 500
    for i in range(0, len(chunks), batch_size):
        batch_chunks = chunks[i:i + batch_size]
        batch_embeddings = embeddings[i:i + batch_size]

        collection.upsert(
            ids=[c.chunk_id for c in batch_chunks],
            embeddings=[e.tolist() for e in batch_embeddings],
            documents=[c.text for c in batch_chunks],
            metadatas=[{
                "paper_id": c.paper_id,
                "paper_title": c.paper_title,
                "layer": c.layer,
                "chunk_type": c.chunk_type,
                "section": c.section,
                "subsection": c.subsection or "",
                "section_type": getattr(c, 'section_type', '') or "",
                "page": c.page,
                "position": c.position,
                "token_count": c.token_count,
                "domain_topics": ", ".join(c.domain_topics) if c.domain_topics else "",
                "rhetorical_role": c.rhetorical_role or "",
                "content_type": c.content_type or "",
                "citations": ", ".join(c.metadata.get('citations', [])) if c.metadata.get('citations') else "",
                **extra,
            } for c in batch_chunks]
        )


def delete_paper(collection, paper_id: str):
    """Remove all chunks for a paper (for re-ingestion)."""
    collection.delete(where={"paper_id": paper_id})


def get_paper_hash(collection, paper_id: str):
    """Return the (pdf_sha256, ingest_salt) stamped on a paper's chunks, or None.

    None means the paper is absent, or it was ingested before the incremental
    stamp existed (so it should be re-ingested). Reads a single chunk's metadata.
    """
    res = collection.get(where={"paper_id": paper_id}, limit=1, include=["metadatas"])
    metas = (res or {}).get("metadatas") or []
    if not metas:
        return None
    meta = metas[0] or {}
    sha = meta.get("pdf_sha256")
    salt = meta.get("ingest_salt")
    if sha is None or salt is None:
        return None
    return (sha, salt)


def list_paper_ids(collection) -> set:
    """Return the distinct set of paper_ids currently stored in the collection."""
    res = collection.get(include=["metadatas"])
    metas = (res or {}).get("metadatas") or []
    return {m.get("paper_id") for m in metas if m and m.get("paper_id")}


def get_collection_stats(collection) -> dict:
    """Return basic stats about the collection."""
    count = collection.count()
    sample = collection.peek(limit=5) if count > 0 else {}
    return {
        "total_chunks": count,
        "sample_ids": sample.get("ids", []),
    }
