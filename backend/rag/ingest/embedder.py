"""Embedding wrapper for chunk and query encoding.

Pluggable model via config. Prepends section context to chunk text
before embedding to steer vectors toward the right semantic neighborhood.
"""

import numpy as np
from sentence_transformers import SentenceTransformer

from .chunker import Chunk


class ChunkEmbedder:
    def __init__(self, model_name: str = "all-MiniLM-L6-v2", model_instance=None):
        """Initialize embedder.

        Args:
            model_name: HuggingFace model name for sentence-transformers.
            model_instance: Optional pre-loaded SentenceTransformer to reuse
                (avoids loading the model twice at runtime).
        """
        if model_instance is not None:
            self.model = model_instance
        else:
            self.model = SentenceTransformer(model_name)
        self.model_name = model_name

    def _prepare_text(self, chunk: Chunk) -> str:
        """Prepend section context to chunk text before embedding."""
        prefix = f"[{chunk.section}"
        if chunk.subsection and chunk.subsection != chunk.section:
            prefix += f": {chunk.subsection}"
        prefix += "] "
        return prefix + chunk.text

    def embed_chunks(self, chunks: list, batch_size: int = 32) -> np.ndarray:
        """Embed a list of chunks. Returns array of shape (n_chunks, dim)."""
        if not chunks:
            return np.array([])
        texts = [self._prepare_text(c) for c in chunks]
        embeddings = self.model.encode(texts, batch_size=batch_size, show_progress_bar=True)
        return np.array(embeddings)

    def embed_query(self, query: str) -> np.ndarray:
        """Embed a single query string."""
        return self.model.encode(query)
