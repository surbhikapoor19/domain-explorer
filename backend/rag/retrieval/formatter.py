"""Format retrieved chunks for LLM prompt injection and frontend display."""

from .retriever import RetrievedChunk


def estimate_tokens(text: str) -> int:
    """Approximate token count using whitespace splitting."""
    return len(text.split())


def format_for_prompt(chunks: list, token_budget: int = 3000) -> str:
    """Format retrieved chunks as text for LLM prompt injection.

    Chunks are sorted by relevance. Stops adding chunks when token budget
    is reached. Returns a formatted text block.

    Args:
        chunks: List of RetrievedChunk sorted by score descending.
        token_budget: Maximum tokens of retrieved text to include.

    Returns:
        Formatted string for injection into LLM prompt.
    """
    if not chunks:
        return ""

    lines = []
    total_tokens = 0

    for chunk in chunks:
        chunk_tokens = estimate_tokens(chunk.text)
        if total_tokens + chunk_tokens > token_budget and lines:
            break

        header = f'--- From "{chunk.paper_title}"'
        # Prefer canonical section_type (from GROBID) → LLM sees "[method section]"
        # instead of guessing from the raw heading string.
        stype = getattr(chunk, 'section_type', '') or ''
        if stype:
            header += f' [{stype} section]'
        elif chunk.section:
            header += f' ({chunk.section}'
            if chunk.subsection and chunk.subsection != chunk.section:
                header += f" > {chunk.subsection}"
            header += ')'
        header += f' (relevance: {chunk.score:.2f}) ---'

        lines.append(header)
        lines.append(chunk.text)
        lines.append("")

        total_tokens += chunk_tokens

    return '\n'.join(lines).strip()


def _extract_author_year(text: str) -> str:
    """Extract author-year citations as comma-separated string."""
    import re
    matches = re.findall(r'\(([A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?)[.,]?\s*(\d{4})\)', text)
    citations = list(dict.fromkeys(f"{m[0]}, {m[1]}" for m in matches))
    return ', '.join(citations) if citations else ''


def format_chunk_citations(chunks: list) -> list:
    """Format chunks as structured data for the frontend.

    Returns a list of citation dicts for rendering in the InsightCard.
    """
    citations = []
    for chunk in chunks:
        # Return full text for top chunks so frontend can do keyword highlighting
        text = chunk.text
        snippet = text[:300] + "..." if len(text) > 300 else text

        citations.append({
            "paper_title": chunk.paper_title,
            "paper_id": chunk.paper_id,
            "section": chunk.section,
            "subsection": chunk.subsection or "",
            "layer": chunk.layer,
            "chunk_type": getattr(chunk, 'chunk_type', ''),
            "content_type": getattr(chunk, 'content_type', ''),
            "rhetorical_role": getattr(chunk, 'rhetorical_role', ''),
            "domain_topics": getattr(chunk, 'domain_topics', ''),
            "score": chunk.score,
            "snippet": snippet,
            "full_text": text,
            "citations": _extract_author_year(text),
            "chunk_id": chunk.chunk_id,
            "page": getattr(chunk, 'page', 0),
        })
    return citations
