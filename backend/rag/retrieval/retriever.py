"""RAG retriever: query ChromaDB with intent-based routing and multi-layer mixing."""

from dataclasses import dataclass

import numpy as np

from ..config import RAGConfig
from ..ingest.embedder import ChunkEmbedder
from ..ingest.store import create_or_get_collection, get_client
from .router import classify_intent, build_metadata_filter, QueryIntent


@dataclass
class RetrievedChunk:
    chunk_id: str
    text: str
    paper_id: str
    paper_title: str
    section: str
    subsection: str
    layer: str
    chunk_type: str
    score: float
    page: int = 0
    rank: int = 0
    content_type: str = ""
    rhetorical_role: str = ""
    domain_topics: str = ""
    section_type: str = ""  # canonical section type from GROBID (intro/method/experiments/limitations/...)


class RAGRetriever:
    def __init__(self, config: RAGConfig, embedder: ChunkEmbedder = None):
        self.config = config
        self.embedder = embedder or ChunkEmbedder(model_name=config.embedding_model)
        self._client = get_client(config)
        self._collection = create_or_get_collection(config, self._client)

    def retrieve(self, query: str, paper_ids: list = None, intent: QueryIntent = None) -> list:
        """Retrieve relevant chunks for a query.

        Args:
            query: Natural language query string.
            paper_ids: Optional list of paper IDs to restrict search to.
            intent: Optional pre-classified intent (auto-classified if None).

        Returns:
            List of RetrievedChunk objects sorted by relevance.
        """
        if self._collection.count() == 0:
            return []

        if intent is None:
            intent = classify_intent(query)

        query_embedding = self.embedder.embed_query(query)

        # Multi-layer search: query each target layer separately, then merge
        chunks = self._multi_layer_search(query_embedding, intent, paper_ids)

        # Deduplicate by chunk_id (same chunk might match across queries)
        seen = set()
        unique = []
        for chunk in chunks:
            if chunk.chunk_id not in seen:
                seen.add(chunk.chunk_id)
                unique.append(chunk)

        # Sort by score descending
        unique.sort(key=lambda c: c.score, reverse=True)

        # Assign ranks
        for i, chunk in enumerate(unique):
            chunk.rank = i + 1

        return unique

    def _multi_layer_search(self, query_embedding: np.ndarray, intent: QueryIntent, paper_ids: list = None) -> list:
        """Query ChromaDB per target layer, then merge. Falls back to broad search.

        Layer and (GROBID-derived) section_type are used as primary filters.
        """
        from .router import INTENT_SECTIONS, INTENT_SECTION_TYPES

        routing = INTENT_SECTIONS[intent]
        target_layers = routing["layers"]
        target_section_types = INTENT_SECTION_TYPES.get(intent)
        results = []
        total_top_k = (self.config.retrieval.coarse_top_k +
                       self.config.retrieval.mid_top_k +
                       self.config.retrieval.fine_top_k)

        # Strategy: try (layer + section_type) first. If nothing matches (paper
        # ingested before TEI, so section_type is missing), fall back to layer-only.
        for layer in target_layers:
            layer_top_k = {
                "coarse": self.config.retrieval.coarse_top_k,
                "mid": self.config.retrieval.mid_top_k,
                "fine": self.config.retrieval.fine_top_k,
            }
            top_k = layer_top_k.get(layer, 4)

            conditions = [{"layer": layer}]
            if target_section_types:
                conditions.append({"section_type": {"$in": target_section_types}})
            if paper_ids:
                conditions.append({"paper_id": {"$in": paper_ids}})
            where_filter = conditions[0] if len(conditions) == 1 else {"$and": conditions}

            try:
                query_result = self._collection.query(
                    query_embeddings=[query_embedding.tolist()],
                    n_results=top_k,
                    where=where_filter,
                    include=["documents", "metadatas", "distances"],
                )
            except Exception:
                continue

            # Parse results
            if not query_result or not query_result.get("ids") or not query_result["ids"][0]:
                continue

            ids = query_result["ids"][0]
            docs = query_result["documents"][0]
            metas = query_result["metadatas"][0]
            distances = query_result["distances"][0]

            for j in range(len(ids)):
                # ChromaDB returns cosine distance; convert to similarity
                score = 1.0 - distances[j]
                meta = metas[j]

                results.append(RetrievedChunk(
                    chunk_id=ids[j],
                    text=docs[j],
                    paper_id=meta.get("paper_id", ""),
                    paper_title=meta.get("paper_title", ""),
                    section=meta.get("section", ""),
                    subsection=meta.get("subsection", ""),
                    layer=meta.get("layer", ""),
                    chunk_type=meta.get("chunk_type", ""),
                    score=round(score, 4),
                    page=meta.get("page", 0),
                    content_type=meta.get("content_type", ""),
                    rhetorical_role=meta.get("rhetorical_role", ""),
                    domain_topics=meta.get("domain_topics", ""),
                    section_type=meta.get("section_type", ""),
                ))

        # Fallback: if layer-filtered search returned nothing, do a broad search
        if not results:
            where_filter = {"paper_id": {"$in": paper_ids}} if paper_ids else None
            try:
                query_result = self._collection.query(
                    query_embeddings=[query_embedding.tolist()],
                    n_results=total_top_k,
                    where=where_filter,
                    include=["documents", "metadatas", "distances"],
                )
                if query_result and query_result.get("ids") and query_result["ids"][0]:
                    ids = query_result["ids"][0]
                    docs = query_result["documents"][0]
                    metas = query_result["metadatas"][0]
                    distances = query_result["distances"][0]
                    for j in range(len(ids)):
                        score = 1.0 - distances[j]
                        meta = metas[j]
                        results.append(RetrievedChunk(
                            chunk_id=ids[j],
                            text=docs[j],
                            paper_id=meta.get("paper_id", ""),
                            paper_title=meta.get("paper_title", ""),
                            section=meta.get("section", ""),
                            subsection=meta.get("subsection", ""),
                            layer=meta.get("layer", ""),
                            chunk_type=meta.get("chunk_type", ""),
                            score=round(score, 4),
                        ))
            except Exception:
                pass

        return results
