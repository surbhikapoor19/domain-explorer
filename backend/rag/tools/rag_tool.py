"""RAG search as a tool: lets the LLM request paper content on demand."""

from .registry import register_tool, ToolContext


@register_tool(
    name="search_papers",
    description="Search the academic paper corpus for relevant passages. Use this when the query asks about specific techniques, loss functions, architectures, training details, experimental results, or anything requiring actual paper content.",
    parameters={
        "type": "object",
        "properties": {
            "search_query": {
                "type": "string",
                "description": "What to search for in the papers (e.g., 'loss function for grasp quality', 'sim-to-real transfer', 'PointNet architecture')",
            },
        },
        "required": ["search_query"],
    },
    category="rag",
)
def search_papers_tool(context: ToolContext, search_query: str) -> dict:
    """Search ChromaDB for relevant paper chunks."""
    import os
    import sys

    # Get the RAG retriever from the app-level lazy singleton
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    config_path = os.path.join(base_dir, '..', 'rag_config.yaml')

    from ..config import load_config
    from ..retrieval.retriever import RAGRetriever
    from ..ingest.embedder import ChunkEmbedder
    from ..retrieval.formatter import format_for_prompt, format_chunk_citations

    config = load_config(config_path)
    embedder = ChunkEmbedder(model_name=config.embedding_model, model_instance=context.st_model)
    retriever = RAGRetriever(config=config, embedder=embedder)

    chunks = retriever.retrieve(search_query)
    if not chunks:
        return {"found": 0, "excerpts": [], "formatted": "No relevant paper content found."}

    prompt_text = format_for_prompt(chunks, token_budget=config.retrieval.token_budget)
    citations = format_chunk_citations(chunks)

    # Return both formatted text (for LLM) and structured citations (for frontend)
    return {
        "found": len(chunks),
        "formatted": prompt_text,
        "citations": citations,
    }
