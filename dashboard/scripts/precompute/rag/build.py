"""RAG / Knowledge Base page builder.

Coverage contract — guarantees the following for the RAG page:
  - rag-chunks.json   (RAGInsightsPage, PaperAnatomy, ChunkMap, rag-search)
                       includes flat x/y/paper_id/snippet so ChunkMap renders.
  - papers-index.json (authoritative PDF list)
  - public/papers/    (PDF static files for PdfViewer)
"""
import os

from .chunks import export_rag_chunks
from .papers import export_papers


def build(chroma_dir, output_dir, papers_src, papers_dest):
    os.makedirs(output_dir, exist_ok=True)

    print("[rag 1/2] rag-chunks.json ...")
    export_rag_chunks(chroma_dir, output_dir)

    print("[rag 2/2] papers-index.json + PDF copy ...")
    export_papers(papers_src, output_dir, papers_dest)
