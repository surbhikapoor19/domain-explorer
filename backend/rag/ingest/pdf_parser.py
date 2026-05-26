"""PDF parsing with PyMuPDF (fitz) + heuristic section detection.

Domain-agnostic: uses font-size changes and numbering patterns to detect
section boundaries. Falls back to known academic header keywords when available.

Switched from pdfplumber to PyMuPDF for dramatically better text extraction —
pdfplumber produced ~700 concatenated-word errors across the paper corpus;
PyMuPDF produces near-zero.
"""

import os
import re
import unicodedata
from dataclasses import dataclass, field
from statistics import median

import fitz  # PyMuPDF


# ---------------------------------------------------------------------------
# Text cleaning
# ---------------------------------------------------------------------------

# Private-use area chars (PDF font glyphs with no real meaning)
_PRIVATE_USE_RE = re.compile(r'[\uE000-\uF8FF\U000F0000-\U000FFFFD]+')

# Ligatures → normal text
_LIGATURE_MAP = {
    '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl',
    '\ufb05': 'st', '\ufb06': 'st',
}

# Hyphenated line breaks: "chal-\nlenging" → "challenging"
_HYPHEN_BREAK_RE = re.compile(r'(\w)-\s*\n\s*(\w)')

# arXiv header line
_ARXIV_LINE_RE = re.compile(r'^arXiv:\d{4}\.\d+v?\d*\s*\[.*?\]\s*\d+\s+\w+\s+\d{4}$')

# Journal/conference header boilerplate
_BOILERPLATE_RE = re.compile(
    r'^(?:IEEE\s+TRANSACTIONS\s+ON|Proceedings\s+of|'
    r'JOURNAL\s+OF\s+LATEX\s+CLASS\s+FILES|'
    r'Accepted\s+in|Published\s+in|Preprint)',
    re.IGNORECASE
)


def clean_extracted_text(text: str) -> str:
    """Clean raw text extracted from PDF.

    Fixes ligatures, private-use chars, hyphenated line breaks,
    and normalizes whitespace.
    """
    # Replace ligatures
    for lig, repl in _LIGATURE_MAP.items():
        text = text.replace(lig, repl)

    # Strip private-use area characters
    text = _PRIVATE_USE_RE.sub('', text)

    # Variation selectors and zero-width chars
    text = re.sub(r'[\uFE00-\uFE0F\u200B-\u200F\u2028-\u2029\uFEFF]', '', text)

    # Fix hyphenated line breaks: "chal-\nlenging" → "challenging"
    text = _HYPHEN_BREAK_RE.sub(r'\1\2', text)
    # Also fix "chal- lenging" (space instead of newline after hyphen)
    text = re.sub(r'(\w)- (\w)', r'\1\2', text)

    # Normalize whitespace (but preserve intentional newlines)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()


def _is_noise_line(line: str) -> bool:
    """Return True if line is boilerplate/noise that should be skipped."""
    stripped = line.strip()
    if not stripped:
        return False
    if _ARXIV_LINE_RE.match(stripped):
        return True
    if _BOILERPLATE_RE.match(stripped):
        return True
    # Page numbers
    if re.match(r'^\d{1,3}$', stripped):
        return True
    # Email addresses
    if re.match(r'^[\w.+-]+@[\w.-]+\.\w+$', stripped):
        return True
    # Lines that are just an email (possibly with surrounding text)
    if re.search(r'[\w.+-]+@[\w.-]+\.\w+', stripped) and len(stripped) < 60:
        return True
    # Short affiliation/author lines (e.g., "ETH Zürich", "MIT CSAIL")
    if len(stripped) < 40 and not any(c in stripped for c in '.!?:;') and not re.search(r'\d{4}', stripped):
        # Looks like a short name/affiliation, not a sentence
        words = stripped.split()
        if len(words) <= 5 and all(w[0].isupper() or not w[0].isalpha() for w in words if w):
            return True
    # Single characters or very short fragments
    if len(stripped) <= 3:
        return True
    return False


KNOWN_HEADERS = {
    'abstract', 'introduction', 'related work', 'background',
    'method', 'methods', 'methodology', 'approach',
    'experiment', 'experiments', 'results', 'evaluation',
    'discussion', 'conclusion', 'conclusions',
    'acknowledgments', 'acknowledgements', 'references', 'appendix',
}

NUMBERED_HEADER_RE = re.compile(r'^(\d+\.?\s+|[IVXLC]+\.?\s+)[A-Z]')
LETTERED_HEADER_RE = re.compile(r'^[A-Z]\.\s+[A-Z]')


@dataclass
class ParsedSection:
    title: str
    level: int          # 0=paper, 1=section, 2=subsection
    text: str
    page_start: int
    page_end: int
    section_type: str = ""  # canonical type: intro/method/experiments/limitations/...


@dataclass
class ParsedFigure:
    caption: str
    page: int
    nearby_text: str = ""


@dataclass
class ParsedPaper:
    paper_id: str
    title: str
    abstract: str
    sections: list = field(default_factory=list)
    figures: list = field(default_factory=list)
    raw_text: str = ""


def _get_line_records(page, page_num: int):
    """Extract lines with font-size info from a PyMuPDF page.

    Returns list of (line_text, page_num, font_size) tuples.
    Uses the dominant (most-characters) font size per line.
    """
    blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]
    records = []
    for block in blocks:
        if block.get("type") != 0:  # skip image blocks
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            # Build line text, track font size weighted by character count
            text_parts = []
            size_counts = {}
            for span in spans:
                t = span.get("text", "")
                text_parts.append(t)
                sz = round(span.get("size", 10.0), 1)
                size_counts[sz] = size_counts.get(sz, 0) + len(t)
            line_text = "".join(text_parts).strip()
            if not line_text:
                continue
            # Clean ligatures and noise at line level
            for lig, repl in _LIGATURE_MAP.items():
                line_text = line_text.replace(lig, repl)
            line_text = _PRIVATE_USE_RE.sub('', line_text).strip()
            if not line_text:
                continue
            # Dominant font size = size covering most characters
            dominant_size = max(size_counts, key=size_counts.get)
            records.append((line_text, page_num, dominant_size))
    return records


def _compute_median_font_size(line_records):
    """Compute median font size across all lines."""
    sizes = [fs for _, _, fs in line_records if fs]
    if not sizes:
        return 10.0
    return median(sizes)


def _is_header_line(line: str, font_size: float, median_size: float) -> tuple:
    """Determine if a line is a section header. Returns (is_header, level)."""
    stripped = line.strip()
    if not stripped or len(stripped) > 100:
        return False, 0

    # Reject noise lines that sometimes get larger fonts
    if _is_noise_line(stripped):
        return False, 0

    # Reject lines that are clearly not headers (emails, URLs, single chars)
    if re.match(r'^[\w.+-]+@[\w.-]+$', stripped):
        return False, 0
    if len(stripped) <= 2 and not re.match(r'^[IVXLC]+$', stripped):
        return False, 0

    # Reject numbered affiliations (e.g., "4 Department of Computer Science, ...")
    if re.match(r'^\d+\s+', stripped) and re.search(
        r'(?:Department|University|Institute|Lab|Faculty|School|Center|College)',
        stripped, re.IGNORECASE
    ):
        return False, 0

    # Check font size (headers are typically larger)
    size_boost = font_size and median_size and font_size > median_size * 1.1

    # Check known academic headers
    lower = stripped.lower().rstrip(':').strip()
    # Remove leading numbers or Roman numerals for matching
    clean = re.sub(r'^(?:\d+\.?\s*|[ivxlc]+\.?\s*)', '', lower).strip()
    is_known = clean in KNOWN_HEADERS

    # Check numbering pattern (e.g., "3. Method", "IV. Results")
    has_numbered = bool(NUMBERED_HEADER_RE.match(stripped))
    has_lettered = bool(LETTERED_HEADER_RE.match(stripped))
    # Reject lettered patterns that are actually citation entries (e.g., 'A. Nguyen, "Open-vocab..."')
    if has_lettered and re.search(r'["\u201c\u201d]|et al\.', stripped):
        has_lettered = False
    has_number = has_numbered or has_lettered

    # Subsection pattern (e.g., "3.1 Dynamics Model")
    is_subsection = bool(re.match(r'^\d+\.\d+\.?\s+', stripped))

    if is_known or has_number:
        level = 2 if is_subsection else 1
        return True, level
    if size_boost and len(stripped) < 60 and not stripped.endswith('.'):
        level = 2 if is_subsection else 1
        return True, level

    return False, 0


def _extract_figures(page_text: str, page_num: int) -> list:
    """Extract figure/table captions from a page's text."""
    figures = []
    caption_re = re.compile(
        r'((?:Figure|Fig\.|Table|Algorithm)\s*\d+[.:]\s*.+?)(?:\n\n|\n(?=[A-Z0-9])|\Z)',
        re.IGNORECASE | re.DOTALL
    )
    for match in caption_re.finditer(page_text):
        caption = match.group(1).strip()
        if len(caption) > 20:
            figures.append(ParsedFigure(caption=caption, page=page_num))
    return figures


def parse_pdf(pdf_path: str, paper_id: str = None) -> ParsedPaper:
    """Extract structured text from a PDF using PyMuPDF.

    Args:
        pdf_path: Path to the PDF file.
        paper_id: Identifier for the paper. Defaults to filename stem.

    Returns:
        ParsedPaper with title, abstract, sections, figures, and raw text.
    """
    if paper_id is None:
        paper_id = os.path.splitext(os.path.basename(pdf_path))[0]

    all_line_records = []  # (line_text, page_num, font_size)
    all_page_texts = []
    figures = []

    with fitz.open(pdf_path) as doc:
        for page_num in range(len(doc)):
            page = doc[page_num]
            # Structured extraction with font info for header detection
            records = _get_line_records(page, page_num)
            all_line_records.extend(records)
            # Build page text from line records (avoids redundant extraction)
            page_text = '\n'.join(text for text, _, _ in records)
            all_page_texts.append(page_text)
            figures.extend(_extract_figures(page_text, page_num))

    raw_text = clean_extracted_text('\n'.join(all_page_texts))
    median_size = _compute_median_font_size(all_line_records)

    # Filter out noise lines from structured records
    all_line_records = [
        (text, pn, fs) for text, pn, fs in all_line_records
        if not _is_noise_line(text)
    ]

    # Extract title: line with largest font on first 2 pages
    title = ""
    title_candidates = [
        (text, pn, fs) for text, pn, fs in all_line_records
        if pn <= 1 and text.strip()
    ]
    if title_candidates:
        max_fs = max(fs for _, _, fs in title_candidates)
        # Collect all lines at max font size (multi-line titles)
        title_lines = [
            text.strip() for text, pn, fs in title_candidates
            if fs >= max_fs - 0.5
        ]
        title = ' '.join(title_lines)
    else:
        # Fallback: first non-empty line
        for line_text, pn, fs in all_line_records:
            if line_text.strip():
                title = line_text.strip()
                break

    # Extract abstract
    abstract_lines = []
    in_abstract = False
    for line_text, pn, fs in all_line_records:
        stripped = line_text.strip()
        lower = stripped.lower()
        if lower.startswith('abstract') and not in_abstract:
            in_abstract = True
            # Handle "Abstract— text..." or "Abstract: text..." patterns
            remainder = re.sub(r'^abstract[\s:\-—]*', '', stripped, flags=re.IGNORECASE).strip()
            if remainder:
                abstract_lines.append(remainder)
            continue
        if in_abstract:
            is_hdr, _ = _is_header_line(stripped, fs, median_size)
            if is_hdr and abstract_lines:
                break
            if stripped:
                abstract_lines.append(stripped)
    abstract = clean_extracted_text(' '.join(abstract_lines))

    # Build sections (stop detecting headers after "References")
    sections = []
    current_section = None
    current_level = 1
    current_lines = []
    current_page_start = 0
    past_references = False

    for line_text, pn, fs in all_line_records:
        stripped = line_text.strip()

        if past_references:
            # After references header, everything is bibliography — just accumulate
            if current_section is not None:
                current_lines.append(stripped)
            continue

        is_hdr, level = _is_header_line(stripped, fs, median_size)

        if is_hdr and stripped.lower().rstrip(':').strip() not in ('abstract',):
            # Check if this is the references section
            clean_title = re.sub(r'^(?:\d+\.?\s*|[ivxlc]+\.?\s*)', '',
                                 stripped.lower().rstrip(':').strip()).strip()
            if clean_title in ('references', 'bibliography'):
                past_references = True

            # Save previous section with its own level
            if current_section is not None:
                section_text = clean_extracted_text('\n'.join(current_lines))
                if section_text:
                    sections.append(ParsedSection(
                        title=current_section,
                        level=current_level,
                        text=section_text,
                        page_start=current_page_start,
                        page_end=pn,
                    ))
            current_section = stripped
            current_level = level
            current_lines = []
            current_page_start = pn
        elif current_section is not None:
            current_lines.append(stripped)

    # Save last section
    if current_section and current_lines:
        section_text = clean_extracted_text('\n'.join(current_lines))
        if section_text:
            last_page = all_line_records[-1][1] if all_line_records else 0
            sections.append(ParsedSection(
                title=current_section,
                level=current_level,
                text=section_text,
                page_start=current_page_start,
                page_end=last_page,
            ))

    # If no sections detected, create one big section from raw text
    if not sections and raw_text.strip():
        sections.append(ParsedSection(
            title="Full Text",
            level=1,
            text=raw_text,
            page_start=0,
            page_end=0,
        ))

    return ParsedPaper(
        paper_id=paper_id,
        title=title,
        abstract=abstract,
        sections=sections,
        figures=figures,
        raw_text=raw_text,
    )
