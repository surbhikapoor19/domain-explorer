"""Hybrid structural + semantic chunker with domain-aware metadata.

Three-layer hierarchy:
  - Coarse: paper-level overview (abstract, section summaries, figure captions)
  - Mid: semantic splitting within sections (topic-boundary detection via
    sentence embeddings), with configurable overlap between chunks
  - Fine: granular sentence groups for precise retrieval

Each chunk is enriched with:
  - domain_topics: matched keywords from a configurable domain vocabulary
  - rhetorical_role: heuristic classification (algorithm_description, result, etc.)
  - content_type: theory vs implementation vs evaluation
  - chunk_type: abstract, equation, figure, citation, plain, etc.
"""

import re
import numpy as np
from abc import ABC, abstractmethod
from collections import Counter
from dataclasses import dataclass, field

from .pdf_parser import ParsedPaper, ParsedSection


# ---------------------------------------------------------------------------
# Chunk dataclass
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    chunk_id: str
    paper_id: str
    paper_title: str
    text: str
    layer: str              # "coarse", "mid", "fine"
    chunk_type: str         # "abstract", "section_summary", "figure_captions",
                            # "equation", "citation_context", "semantic_group", "paragraph"
    section: str
    subsection: str = ""
    section_type: str = ""  # intro/method/experiments/limitations/ablation/... (from GROBID)
    page: int = 0
    position: float = 0.0  # Normalized position in paper (0.0-1.0)
    token_count: int = 0
    domain_topics: list = field(default_factory=list)
    rhetorical_role: str = ""       # algorithm_description, experimental_setup, result, ...
    content_type: str = ""          # theory, implementation, evaluation
    metadata: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """Approximate token count via whitespace splitting."""
    return len(text.split())


def _normalize_section_name(title: str) -> str:
    """Strip leading numbers from section titles."""
    clean = re.sub(r'^\d+\.?\d*\.?\s*', '', title).strip()
    return clean if clean else title


def _split_paragraphs(text: str) -> list:
    """Split on double newlines."""
    paragraphs = re.split(r'\n\s*\n|\n{2,}', text)
    return [p.strip() for p in paragraphs if p.strip()]


def _split_sentences(text: str) -> list:
    """Split at sentence boundaries (period/question/exclamation followed by uppercase)."""
    sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    return [s.strip() for s in sentences if s.strip()]


SKIP_SECTIONS = {'references', 'acknowledgments', 'acknowledgements', 'bibliography'}


def _should_skip_section(name: str) -> bool:
    return name.lower().strip() in SKIP_SECTIONS


# ---------------------------------------------------------------------------
# Domain topic extraction
# ---------------------------------------------------------------------------

def extract_domain_topics(text: str, domain_keywords: list) -> list:
    """Match chunk text against a domain keyword vocabulary.

    Case-insensitive matching. Returns deduplicated list of matched keywords
    sorted by frequency of occurrence in the text.
    """
    if not domain_keywords:
        return []
    text_lower = text.lower()
    matched = []
    for kw in domain_keywords:
        kw_lower = kw.lower()
        # Use word-boundary matching for short keywords, substring for multi-word
        if ' ' in kw_lower:
            if kw_lower in text_lower:
                matched.append(kw)
        else:
            if re.search(r'\b' + re.escape(kw_lower) + r'\b', text_lower):
                matched.append(kw)
    return list(dict.fromkeys(matched))  # deduplicate preserving order


# ---------------------------------------------------------------------------
# Rhetorical role and content type classification (heuristic)
# ---------------------------------------------------------------------------

ROLE_PATTERNS = {
    'problem_statement': [
        r'\b(we address|the problem of|challenge of|goal is to|aim to)\b',
    ],
    'algorithm_description': [
        r'\b(we propose|our method|our approach|architecture|pipeline|network|module)\b',
        r'\b(algorithm \d|step \d|procedure)\b',
    ],
    'experimental_setup': [
        r'\b(we evaluate|experiment|setup|dataset|baseline|benchmark|hardware|robot platform)\b',
        r'\b(training details|hyperparameter|implementation detail|we train)\b',
    ],
    'result': [
        r'\b(table \d|figure \d|fig\.\s*\d|results show|we achieve|accuracy|success rate|outperform)\b',
        r'\b(ablation|comparison|performance|improvement|f1|precision|recall)\b',
    ],
    'comparison': [
        r'\b(compared to|in contrast|unlike|whereas|prior work|related work|existing method)\b',
    ],
    'limitation': [
        r'\b(limitation|failure|drawback|future work|open question|cannot|does not)\b',
    ],
    'definition': [
        r'\b(we define|denoted by|let \w+ be|formally|definition)\b',
    ],
}

CONTENT_TYPE_MAP = {
    'algorithm_description': 'theory',
    'definition': 'theory',
    'problem_statement': 'theory',
    'experimental_setup': 'implementation',
    'result': 'evaluation',
    'comparison': 'evaluation',
    'limitation': 'evaluation',
}


def classify_rhetorical_role(text: str) -> str:
    """Assign a rhetorical role based on keyword/pattern matching."""
    text_lower = text.lower()
    scores = {}
    for role, patterns in ROLE_PATTERNS.items():
        score = sum(1 for p in patterns if re.search(p, text_lower))
        if score > 0:
            scores[role] = score
    if not scores:
        return "general"
    return max(scores, key=scores.get)


def classify_content_type(rhetorical_role: str, section_name: str) -> str:
    """Derive content_type from rhetorical role and section name."""
    # Section-based override
    sec_lower = section_name.lower()
    if any(k in sec_lower for k in ('experiment', 'result', 'evaluation', 'ablation')):
        return 'evaluation'
    if any(k in sec_lower for k in ('method', 'approach', 'model', 'architecture', 'algorithm')):
        return 'theory'
    if any(k in sec_lower for k in ('implement', 'training', 'setup', 'detail')):
        return 'implementation'
    # Fall back to rhetorical role mapping
    return CONTENT_TYPE_MAP.get(rhetorical_role, 'general')


# ---------------------------------------------------------------------------
# Equation and citation detection
# ---------------------------------------------------------------------------

EQUATION_RE = re.compile(
    r'(?:'
    r'\\begin\{(?:equation|align|gather)\}.*?\\end\{(?:equation|align|gather)\}'
    r'|[A-Za-z]\s*=\s*[^,\n]{10,}'
    r'|\$[^$]+\$'
    r')',
    re.DOTALL
)

CITATION_RE = re.compile(
    r'(?:\[[\d,\s\-]+\]|\(\w+\s+et\s+al\.\s*,?\s*\d{4}\))',
)


def detect_chunk_type(text: str) -> str:
    """Detect whether a chunk is primarily an equation, citation context, or plain text."""
    eq_matches = len(EQUATION_RE.findall(text))
    cit_matches = len(CITATION_RE.findall(text))
    tokens = estimate_tokens(text)
    if tokens > 0:
        eq_density = eq_matches / tokens
        cit_density = cit_matches / tokens
        if eq_density > 0.02 or eq_matches >= 3:
            return "equation"
        if cit_density > 0.03 or cit_matches >= 4:
            return "citation_context"
    return "plain"


# ---------------------------------------------------------------------------
# Semantic sentence similarity (for topic-boundary detection)
# ---------------------------------------------------------------------------

def _compute_sentence_similarities(sentences: list, model) -> np.ndarray:
    """Embed sentences and compute consecutive cosine similarities.

    Returns array of shape (n_sentences - 1,) where element i is the
    cosine similarity between sentence i and sentence i+1.
    """
    if len(sentences) < 2:
        return np.array([])
    embeddings = model.encode(sentences, show_progress_bar=False)
    # Normalize
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    embeddings = embeddings / norms
    # Consecutive cosine similarities
    sims = np.array([
        np.dot(embeddings[i], embeddings[i + 1])
        for i in range(len(embeddings) - 1)
    ])
    return sims


def _find_semantic_boundaries(sims: np.ndarray, threshold: float) -> list:
    """Find indices where consecutive similarity drops below threshold.

    Returns list of split points (indices into the similarity array).
    A split at index i means: cut AFTER sentence i.
    """
    boundaries = []
    for i, sim in enumerate(sims):
        if sim < threshold:
            boundaries.append(i)
    return boundaries


def _group_sentences_by_boundaries(sentences: list, boundaries: list) -> list:
    """Group sentences into segments based on boundary indices."""
    groups = []
    start = 0
    for b in sorted(boundaries):
        cut = b + 1  # cut after sentence b
        if cut > start:
            groups.append(sentences[start:cut])
        start = cut
    if start < len(sentences):
        groups.append(sentences[start:])
    return groups


# ---------------------------------------------------------------------------
# Overlap generation
# ---------------------------------------------------------------------------

def _apply_overlap(chunks: list, overlap_ratio: float) -> list:
    """Add overlap between consecutive same-section mid-level chunks.

    Takes the last N sentences of chunk i and prepends them to chunk i+1,
    where N is determined by overlap_ratio * chunk_i token count.
    """
    if overlap_ratio <= 0 or len(chunks) < 2:
        return chunks

    result = [chunks[0]]
    for i in range(1, len(chunks)):
        prev = chunks[i - 1]
        curr = chunks[i]

        # Only overlap within same section
        if prev.section != curr.section:
            result.append(curr)
            continue

        overlap_tokens = int(prev.token_count * overlap_ratio)
        if overlap_tokens < 10:
            result.append(curr)
            continue

        # Extract trailing sentences from previous chunk
        prev_sentences = _split_sentences(prev.text)
        overlap_sents = []
        acc = 0
        for s in reversed(prev_sentences):
            t = estimate_tokens(s)
            if acc + t > overlap_tokens:
                break
            overlap_sents.insert(0, s)
            acc += t

        if overlap_sents:
            overlap_text = ' '.join(overlap_sents)
            new_text = overlap_text + ' ' + curr.text
            result.append(Chunk(
                chunk_id=curr.chunk_id,
                paper_id=curr.paper_id,
                paper_title=curr.paper_title,
                text=new_text,
                layer=curr.layer,
                chunk_type=curr.chunk_type,
                section=curr.section,
                subsection=curr.subsection,
                page=curr.page,
                position=curr.position,
                token_count=estimate_tokens(new_text),
                domain_topics=curr.domain_topics,
                rhetorical_role=curr.rhetorical_role,
                content_type=curr.content_type,
                metadata={**curr.metadata, 'has_overlap': True},
            ))
        else:
            result.append(curr)

    return result


# ---------------------------------------------------------------------------
# Enrichment: apply domain topics, rhetorical role, content type to all chunks
# ---------------------------------------------------------------------------

def extract_inline_citations(text: str) -> list:
    """Extract author-year citations from chunk text.

    Finds patterns like (Smith et al., 2022), (Smith and Jones, 2020),
    (Smith, 2019). Returns deduplicated list of citation strings.
    """
    author_year_re = re.compile(
        r'\(([A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?)[.,]?\s*(\d{4})\)'
    )
    citations = []
    for match in author_year_re.finditer(text):
        author = match.group(1).strip()
        year = match.group(2)
        citations.append(f"{author}, {year}")
    return list(dict.fromkeys(citations))  # deduplicate preserving order


def _enrich_chunk(chunk: Chunk, domain_keywords: list) -> Chunk:
    """Add domain_topics, rhetorical_role, content_type, and citations to a chunk."""
    chunk.domain_topics = extract_domain_topics(chunk.text, domain_keywords)
    chunk.rhetorical_role = classify_rhetorical_role(chunk.text)
    chunk.content_type = classify_content_type(chunk.rhetorical_role, chunk.section)

    # Extract inline citations
    chunk.metadata['citations'] = extract_inline_citations(chunk.text)

    # Detect special chunk types for non-abstract/figure chunks
    if chunk.chunk_type in ('plain', 'semantic_group', 'paragraph', 'subsection'):
        detected = detect_chunk_type(chunk.text)
        if detected != 'plain':
            chunk.chunk_type = detected

    return chunk


# ---------------------------------------------------------------------------
# Chunking strategies
# ---------------------------------------------------------------------------

class ChunkingStrategy(ABC):
    @abstractmethod
    def chunk(self, paper: ParsedPaper, config, model=None) -> list:
        pass


class CoarseChunker(ChunkingStrategy):
    """Layer 1: Paper-level overview chunks."""

    def chunk(self, paper: ParsedPaper, config, model=None) -> list:
        chunks = []
        max_tokens = config.coarse_max_tokens

        # 1. Title + Abstract
        if paper.abstract:
            text = f"{paper.title}\n\n{paper.abstract}"
            if estimate_tokens(text) > max_tokens:
                text = ' '.join(text.split()[:max_tokens])
            chunks.append(Chunk(
                chunk_id=f"{paper.paper_id}_coarse_abstract",
                paper_id=paper.paper_id,
                paper_title=paper.title,
                text=text,
                layer="coarse",
                chunk_type="abstract",
                section="Abstract",
                page=0,
                position=0.0,
                token_count=estimate_tokens(text),
            ))

        # 2. Section summaries
        total_sections = len(paper.sections) or 1
        for i, section in enumerate(paper.sections):
            section_name = _normalize_section_name(section.title)
            if _should_skip_section(section_name):
                continue

            tokens = estimate_tokens(section.text)
            if tokens <= max_tokens:
                summary_text = section.text
            else:
                paragraphs = _split_paragraphs(section.text)
                if len(paragraphs) >= 2:
                    summary_text = paragraphs[0] + "\n\n" + paragraphs[-1]
                else:
                    summary_text = ' '.join(section.text.split()[:max_tokens])

            chunks.append(Chunk(
                chunk_id=f"{paper.paper_id}_coarse_sec_{i}",
                paper_id=paper.paper_id,
                paper_title=paper.title,
                text=summary_text,
                layer="coarse",
                chunk_type="section_summary",
                section=section_name,
                page=section.page_start,
                position=round(i / total_sections, 2),
                token_count=estimate_tokens(summary_text),
            ))

        # 3. Figure/table captions
        if paper.figures:
            captions = '\n'.join(f.caption for f in paper.figures)
            chunks.append(Chunk(
                chunk_id=f"{paper.paper_id}_coarse_figures",
                paper_id=paper.paper_id,
                paper_title=paper.title,
                text=captions,
                layer="coarse",
                chunk_type="figure_captions",
                section="Figures",
                position=0.5,
                token_count=estimate_tokens(captions),
            ))

        return chunks


class SemanticChunker(ChunkingStrategy):
    """Layer 2: Structural boundaries as hard cuts, semantic similarity for
    soft topic-boundary detection within sections.

    Within each section:
    1. Split into sentences
    2. Embed every sentence with the sentence-transformer
    3. Compute consecutive cosine similarities
    4. Cut where similarity drops below threshold (topic shift)
    5. Group sentences between cuts into chunks
    6. Apply min/max token constraints (merge small groups, split large ones)
    7. Add overlap between consecutive chunks
    """

    def chunk(self, paper: ParsedPaper, config, model=None) -> list:
        chunks = []
        min_tokens = config.mid_min_tokens
        max_tokens = config.mid_max_tokens
        threshold = config.semantic_similarity_threshold
        total_sections = len(paper.sections) or 1

        for sec_idx, section in enumerate(paper.sections):
            section_name = _normalize_section_name(section.title)
            if _should_skip_section(section_name):
                continue

            sentences = _split_sentences(section.text)
            if not sentences:
                continue

            # --- Semantic boundary detection ---
            if model is not None and len(sentences) >= 3:
                sims = _compute_sentence_similarities(sentences, model)
                boundaries = _find_semantic_boundaries(sims, threshold)
                groups = _group_sentences_by_boundaries(sentences, boundaries)
            else:
                # Fallback: paragraph-based grouping
                paragraphs = _split_paragraphs(section.text)
                groups = [_split_sentences(p) for p in paragraphs if p.strip()]
                if not groups:
                    groups = [sentences]

            # --- Enforce min/max token constraints ---
            merged_groups = []
            buffer = []
            buffer_tokens = 0

            for group in groups:
                group_text = ' '.join(group)
                group_tokens = estimate_tokens(group_text)

                if buffer_tokens + group_tokens <= max_tokens:
                    buffer.extend(group)
                    buffer_tokens += group_tokens
                else:
                    if buffer and buffer_tokens >= min_tokens:
                        merged_groups.append(buffer)
                    elif buffer:
                        # Buffer too small, absorb this group into it
                        buffer.extend(group)
                        buffer_tokens += group_tokens
                        if buffer_tokens >= min_tokens:
                            merged_groups.append(buffer)
                            buffer = []
                            buffer_tokens = 0
                        continue

                    # Start new buffer
                    if group_tokens > max_tokens:
                        # Split oversized group at token boundary
                        sub_buffer = []
                        sub_tokens = 0
                        for s in group:
                            st = estimate_tokens(s)
                            if sub_tokens + st > max_tokens and sub_buffer:
                                merged_groups.append(sub_buffer)
                                sub_buffer = []
                                sub_tokens = 0
                            sub_buffer.append(s)
                            sub_tokens += st
                        buffer = sub_buffer
                        buffer_tokens = sub_tokens
                    else:
                        buffer = list(group)
                        buffer_tokens = group_tokens

            # Flush remaining buffer
            if buffer:
                if buffer_tokens >= min_tokens or not merged_groups:
                    merged_groups.append(buffer)
                elif merged_groups:
                    merged_groups[-1].extend(buffer)

            # --- Create chunk objects ---
            for chunk_idx, group in enumerate(merged_groups):
                text = ' '.join(group)
                chunks.append(Chunk(
                    chunk_id=f"{paper.paper_id}_mid_{sec_idx}_{chunk_idx}",
                    paper_id=paper.paper_id,
                    paper_title=paper.title,
                    text=text,
                    layer="mid",
                    chunk_type="semantic_group",
                    section=section_name,
                    subsection=section.title,
                    page=section.page_start,
                    position=round(sec_idx / total_sections, 2),
                    token_count=estimate_tokens(text),
                ))

        return chunks


class StructuralChunker(ChunkingStrategy):
    """Layer 2 fallback: paragraph-based grouping within sections (no embeddings needed)."""

    def chunk(self, paper: ParsedPaper, config, model=None) -> list:
        chunks = []
        min_tokens = config.mid_min_tokens
        max_tokens = config.mid_max_tokens
        total_sections = len(paper.sections) or 1

        for sec_idx, section in enumerate(paper.sections):
            section_name = _normalize_section_name(section.title)
            if _should_skip_section(section_name):
                continue

            paragraphs = _split_paragraphs(section.text)
            if not paragraphs:
                continue

            current_text = []
            current_tokens = 0
            chunk_idx = 0

            for para in paragraphs:
                para_tokens = estimate_tokens(para)

                if current_tokens + para_tokens > max_tokens and current_text:
                    text = '\n\n'.join(current_text)
                    chunks.append(Chunk(
                        chunk_id=f"{paper.paper_id}_mid_{sec_idx}_{chunk_idx}",
                        paper_id=paper.paper_id,
                        paper_title=paper.title,
                        text=text,
                        layer="mid",
                        chunk_type="subsection",
                        section=section_name,
                        subsection=section.title,
                        page=section.page_start,
                        position=round(sec_idx / total_sections, 2),
                        token_count=estimate_tokens(text),
                    ))
                    chunk_idx += 1
                    current_text = []
                    current_tokens = 0

                current_text.append(para)
                current_tokens += para_tokens

            if current_text:
                text = '\n\n'.join(current_text)
                if estimate_tokens(text) >= min_tokens or chunk_idx == 0:
                    chunks.append(Chunk(
                        chunk_id=f"{paper.paper_id}_mid_{sec_idx}_{chunk_idx}",
                        paper_id=paper.paper_id,
                        paper_title=paper.title,
                        text=text,
                        layer="mid",
                        chunk_type="subsection",
                        section=section_name,
                        subsection=section.title,
                        page=section.page_start,
                        position=round(sec_idx / total_sections, 2),
                        token_count=estimate_tokens(text),
                    ))
                elif chunks:
                    prev = chunks[-1]
                    merged = prev.text + '\n\n' + text
                    chunks[-1] = Chunk(
                        chunk_id=prev.chunk_id,
                        paper_id=prev.paper_id,
                        paper_title=prev.paper_title,
                        text=merged,
                        layer=prev.layer,
                        chunk_type=prev.chunk_type,
                        section=prev.section,
                        subsection=prev.subsection,
                        page=prev.page,
                        position=prev.position,
                        token_count=estimate_tokens(merged),
                    )

        return chunks


class FineChunker(ChunkingStrategy):
    """Layer 3: Sentence-level fine chunks for precise retrieval."""

    def chunk(self, paper: ParsedPaper, config, model=None) -> list:
        chunks = []
        max_tokens = config.fine_max_tokens
        min_tokens = config.fine_min_tokens
        total_sections = len(paper.sections) or 1

        for sec_idx, section in enumerate(paper.sections):
            section_name = _normalize_section_name(section.title)
            if _should_skip_section(section_name):
                continue

            paragraphs = _split_paragraphs(section.text)
            chunk_idx = 0

            for para in paragraphs:
                tokens = estimate_tokens(para)
                if tokens < min_tokens:
                    continue

                if tokens > max_tokens:
                    sentences = _split_sentences(para)
                    current = []
                    current_tokens = 0
                    for sent in sentences:
                        st = estimate_tokens(sent)
                        if current_tokens + st > max_tokens and current:
                            text = ' '.join(current)
                            chunks.append(Chunk(
                                chunk_id=f"{paper.paper_id}_fine_{sec_idx}_{chunk_idx}",
                                paper_id=paper.paper_id,
                                paper_title=paper.title,
                                text=text,
                                layer="fine",
                                chunk_type="paragraph",
                                section=section_name,
                                subsection=section.title,
                                page=section.page_start,
                                position=round(sec_idx / total_sections, 2),
                                token_count=estimate_tokens(text),
                            ))
                            chunk_idx += 1
                            current = []
                            current_tokens = 0
                        current.append(sent)
                        current_tokens += st
                    if current:
                        text = ' '.join(current)
                        if estimate_tokens(text) >= min_tokens:
                            chunks.append(Chunk(
                                chunk_id=f"{paper.paper_id}_fine_{sec_idx}_{chunk_idx}",
                                paper_id=paper.paper_id,
                                paper_title=paper.title,
                                text=text,
                                layer="fine",
                                chunk_type="paragraph",
                                section=section_name,
                                subsection=section.title,
                                page=section.page_start,
                                position=round(sec_idx / total_sections, 2),
                                token_count=estimate_tokens(text),
                            ))
                            chunk_idx += 1
                else:
                    chunks.append(Chunk(
                        chunk_id=f"{paper.paper_id}_fine_{sec_idx}_{chunk_idx}",
                        paper_id=paper.paper_id,
                        paper_title=paper.title,
                        text=para,
                        layer="fine",
                        chunk_type="paragraph",
                        section=section_name,
                        subsection=section.title,
                        page=section.page_start,
                        position=round(sec_idx / total_sections, 2),
                        token_count=tokens,
                    ))
                    chunk_idx += 1

        return chunks


# ---------------------------------------------------------------------------
# Strategy registry
# ---------------------------------------------------------------------------

STRATEGIES = {
    "coarse": CoarseChunker,
    "semantic": SemanticChunker,
    "structural": StructuralChunker,
    "fine": FineChunker,
}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def chunk_paper(paper: ParsedPaper, config, model=None) -> list:
    """Chunk a parsed paper using the configured strategy with full metadata enrichment.

    Args:
        paper: ParsedPaper from the PDF parser.
        config: ChunkingConfig with token limits, thresholds, domain keywords.
        model: Optional SentenceTransformer for semantic chunking. If None and
               strategy is 'semantic', falls back to structural chunking.

    Returns:
        List of Chunk objects across all three layers, enriched with domain
        topics, rhetorical roles, and content types.
    """
    all_chunks = []
    domain_keywords = getattr(config, 'domain_topics', [])

    # Layer 1: Coarse (always)
    all_chunks.extend(CoarseChunker().chunk(paper, config, model))

    # Layer 2: Mid-level (semantic or structural based on config)
    strategy_name = config.strategies[0] if config.strategies else "semantic"
    if strategy_name == "semantic":
        mid_chunks = SemanticChunker().chunk(paper, config, model)
    else:
        mid_chunks = StructuralChunker().chunk(paper, config, model)

    # Apply overlap between consecutive mid-level chunks
    mid_chunks = _apply_overlap(mid_chunks, config.mid_overlap_ratio)
    all_chunks.extend(mid_chunks)

    # Layer 3: Fine
    all_chunks.extend(FineChunker().chunk(paper, config, model))

    # Enrich all chunks with domain topics, rhetorical role, content type
    all_chunks = [_enrich_chunk(c, domain_keywords) for c in all_chunks]

    # Filter out noise chunks: too short, just emails/affiliations, or no real content
    all_chunks = [c for c in all_chunks if _is_valid_chunk(c)]

    return all_chunks


def _is_valid_chunk(chunk: Chunk) -> bool:
    """Return False for chunks that are noise (emails, affiliations, near-empty)."""
    import re
    text = chunk.text.strip()
    if not text:
        return False
    # Too short to be meaningful (15 words or fewer)
    if chunk.token_count <= 15:
        return False
    # Mostly email addresses
    emails = re.findall(r'[\w.+-]+@[\w.-]+\.\w+', text)
    non_email_text = re.sub(r'[\w.+-]+@[\w.-]+\.\w+', '', text).strip()
    if emails and len(non_email_text) < 50:
        return False
    # Table noise: mostly repeated short tokens (e.g., "Div. Suc.6 Pen.")
    if chunk.token_count < 80:
        short_tokens = [w for w in text.split() if len(w) <= 4]
        if len(short_tokens) / max(len(text.split()), 1) > 0.7:
            return False
    # Reference list content: dense citation patterns even if section name isn't "References"
    # Look for multiple numbered refs like [14], [15], or "arXiv preprint" density
    bracket_refs = re.findall(r'\[\d{1,3}\]', text)
    arxiv_count = text.lower().count('arxiv preprint') + text.lower().count('arxiv:')
    isbn_count = text.lower().count('isbn')
    pages_pattern = len(re.findall(r'pages\s+\d+', text))
    conference_pattern = len(re.findall(r'In\s+\d{4}\s+\w+', text)) + len(re.findall(r'Conference on', text))
    ref_signals = len(bracket_refs) + arxiv_count + isbn_count + pages_pattern + conference_pattern
    # If more than 40% of tokens are reference-like, it's a bibliography chunk
    if ref_signals > 4 and ref_signals / max(chunk.token_count / 10, 1) > 0.3:
        return False
    # Just author names / affiliations (no sentences — no periods)
    if '.' not in text and len(text) < 100:
        return False
    # Author lists: mostly capitalized names with no verbs/sentences
    # Heuristic: if >60% of words start with uppercase and no common sentence
    # starters, it's likely an author/affiliation block
    words = text.split()
    if len(words) >= 5 and len(words) <= 60:
        cap_ratio = sum(1 for w in words if w and w[0].isupper()) / len(words)
        has_sentence = bool(re.search(r'\b(we |our |the |this |a |an |is |are |was |were |have |has |can |will |for |from |with |using |based )', text.lower()))
        has_asterisks = text.count('*') >= 2
        has_affiliation = bool(re.search(r'(University|Institute|Lab|Center|Department|NVIDIA|Google|Meta|MIT|ETH|CMU|Stanford|Work done)', text))
        if cap_ratio > 0.6 and not has_sentence and (has_asterisks or has_affiliation):
            return False
    return True
