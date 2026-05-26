"""Domain-agnostic RAG configuration. One YAML file describes any paper collection."""

import os
from dataclasses import dataclass, field
from typing import Optional

import yaml


@dataclass
class ChunkingConfig:
    coarse_max_tokens: int = 800
    mid_min_tokens: int = 200
    mid_max_tokens: int = 800
    mid_overlap_ratio: float = 0.15
    fine_min_tokens: int = 50
    fine_max_tokens: int = 300
    semantic_similarity_threshold: float = 0.35
    strategies: list = field(default_factory=lambda: ["semantic"])
    domain_topics: list = field(default_factory=list)  # Domain keyword list for topic tagging


@dataclass
class RetrievalConfig:
    coarse_top_k: int = 2
    mid_top_k: int = 4
    fine_top_k: int = 4
    token_budget: int = 3000
    rerank: bool = False


@dataclass
class ParsingConfig:
    backend: str = "pymupdf"           # "pymupdf", "docling", or "grobid"
    docling_ocr: bool = False          # Enable OCR for scanned PDFs
    docling_table_mode: str = "inline" # "inline" (embed in section) or "sections" (separate)
    docling_max_pages: int = 0         # 0 = no limit
    grobid_url: str = "http://localhost:8070"  # GROBID service endpoint


@dataclass
class RAGConfig:
    project_name: str = "default"
    domain_context: str = ""
    csv_path: str = ""
    name_column: str = "Name"
    description_column: str = "Description"
    link_column: str = "Link(s)"
    embedding_model: str = "all-MiniLM-L6-v2"
    embedding_dimensions: int = 384
    chroma_persist_dir: str = "./chroma_db"
    collection_name: str = "papers"
    parsing: ParsingConfig = field(default_factory=ParsingConfig)
    chunking: ChunkingConfig = field(default_factory=ChunkingConfig)
    retrieval: RetrievalConfig = field(default_factory=RetrievalConfig)
    tools_enabled: bool = True
    dataset_columns: list = field(default_factory=list)


def load_config(path: str) -> RAGConfig:
    """Load RAG configuration from a YAML file."""
    with open(path, 'r') as f:
        raw = yaml.safe_load(f)

    parsing_raw = raw.pop('parsing', {})
    chunking_raw = raw.pop('chunking', {})
    retrieval_raw = raw.pop('retrieval', {})

    config = RAGConfig(**{k: v for k, v in raw.items() if k in RAGConfig.__dataclass_fields__})
    config.parsing = ParsingConfig(**{k: v for k, v in parsing_raw.items() if k in ParsingConfig.__dataclass_fields__})
    config.chunking = ChunkingConfig(**{k: v for k, v in chunking_raw.items() if k in ChunkingConfig.__dataclass_fields__})
    config.retrieval = RetrievalConfig(**{k: v for k, v in retrieval_raw.items() if k in RetrievalConfig.__dataclass_fields__})

    return config


def create_default_config(project_name: str, csv_path: str, domain_context: str = "") -> RAGConfig:
    """Generate a sensible starting config for a new project."""
    return RAGConfig(
        project_name=project_name,
        domain_context=domain_context,
        csv_path=csv_path,
    )


def save_config(config: RAGConfig, path: str):
    """Save configuration to YAML."""
    data = {
        'project_name': config.project_name,
        'domain_context': config.domain_context,
        'csv_path': config.csv_path,
        'name_column': config.name_column,
        'description_column': config.description_column,
        'link_column': config.link_column,
        'embedding_model': config.embedding_model,
        'embedding_dimensions': config.embedding_dimensions,
        'chroma_persist_dir': config.chroma_persist_dir,
        'collection_name': config.collection_name,
        'parsing': {
            'backend': config.parsing.backend,
            'docling_ocr': config.parsing.docling_ocr,
            'docling_table_mode': config.parsing.docling_table_mode,
            'docling_max_pages': config.parsing.docling_max_pages,
        },
        'chunking': {
            'coarse_max_tokens': config.chunking.coarse_max_tokens,
            'mid_min_tokens': config.chunking.mid_min_tokens,
            'mid_max_tokens': config.chunking.mid_max_tokens,
            'mid_overlap_ratio': config.chunking.mid_overlap_ratio,
            'fine_min_tokens': config.chunking.fine_min_tokens,
            'fine_max_tokens': config.chunking.fine_max_tokens,
            'semantic_similarity_threshold': config.chunking.semantic_similarity_threshold,
            'strategies': config.chunking.strategies,
            'domain_topics': config.chunking.domain_topics,
        },
        'retrieval': {
            'coarse_top_k': config.retrieval.coarse_top_k,
            'mid_top_k': config.retrieval.mid_top_k,
            'fine_top_k': config.retrieval.fine_top_k,
            'token_budget': config.retrieval.token_budget,
            'rerank': config.retrieval.rerank,
        },
        'tools_enabled': config.tools_enabled,
        'dataset_columns': config.dataset_columns,
    }
    with open(path, 'w') as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)
