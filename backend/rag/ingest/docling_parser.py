"""Docling-based PDF parser (VLM-backed layout + OCR).

Uses IBM's Docling library with the Granite-Docling-258M model for
high-fidelity document understanding: layout detection, table structure,
LaTeX equations, figure captions, and correct reading order.

Requires: pip install docling
Works on CPU (~2-5 sec/page) or GPU (~0.1 sec/page).
Falls back gracefully if not installed.
"""

import logging
import os

from .pdf_parser import ParsedPaper, ParsedSection, ParsedFigure, clean_extracted_text

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy import with graceful fallback
# ---------------------------------------------------------------------------

_DOCLING_AVAILABLE = False
try:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling_core.types.doc import (
        DocItemLabel,
        SectionHeaderItem,
        TableItem,
        PictureItem,
    )
    _DOCLING_AVAILABLE = True
except ImportError:
    pass


def is_docling_available() -> bool:
    """Check whether docling is installed and importable."""
    return _DOCLING_AVAILABLE


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_page(item) -> int:
    """Extract 0-based page number from an item's provenance."""
    try:
        if hasattr(item, 'prov') and item.prov:
            return item.prov[0].page_no
    except (IndexError, AttributeError):
        pass
    return 0


def _table_to_text(item) -> str:
    """Convert a TableItem to a markdown table string."""
    try:
        data = item.data
        if data is None:
            return ""
        num_rows = data.num_rows
        num_cols = data.num_cols
        if num_rows == 0 or num_cols == 0:
            return ""

        # Build grid from cells
        grid = [["" for _ in range(num_cols)] for _ in range(num_rows)]
        for cell in data.table_cells:
            r, c = cell.row_span[0], cell.col_span[0]
            if r < num_rows and c < num_cols:
                grid[r][c] = cell.text.strip()

        # Format as markdown table
        lines = []
        for i, row in enumerate(grid):
            lines.append("| " + " | ".join(row) + " |")
            if i == 0:
                lines.append("| " + " | ".join("---" for _ in row) + " |")
        return "\n".join(lines)
    except Exception as e:
        logger.debug(f"Table conversion failed: {e}")
        return str(getattr(item, 'text', ''))


def _get_caption(item, doc) -> str:
    """Try to extract caption text from a floating item (table/picture)."""
    # Docling stores captions as references; try common access patterns
    try:
        if hasattr(item, 'captions') and item.captions:
            parts = []
            for cap_ref in item.captions:
                ref_path = cap_ref.cref if hasattr(cap_ref, 'cref') else str(cap_ref)
                # Resolve reference to get text
                if hasattr(cap_ref, 'resolve'):
                    resolved = cap_ref.resolve(doc)
                    if hasattr(resolved, 'text'):
                        parts.append(resolved.text)
                elif hasattr(cap_ref, 'obj'):
                    if hasattr(cap_ref.obj, 'text'):
                        parts.append(cap_ref.obj.text)
            if parts:
                return ' '.join(parts)
    except Exception:
        pass

    # Fallback: check if item itself has text (some versions)
    text = getattr(item, 'text', '')
    if text and len(text) > 10:
        return text
    return ""


# ---------------------------------------------------------------------------
# Main parser
# ---------------------------------------------------------------------------

def parse_pdf_docling(
    pdf_path: str,
    paper_id: str = None,
    ocr: bool = False,
    table_mode: str = "inline",
    max_pages: int = 0,
) -> ParsedPaper:
    """Parse a PDF using Docling's DocumentConverter.

    Args:
        pdf_path: Path to the PDF file.
        paper_id: Identifier for the paper. Defaults to filename stem.
        ocr: Whether to enable OCR for scanned PDFs.
        table_mode: "inline" embeds tables in parent section text,
                    "sections" creates separate ParsedSection per table.
        max_pages: Max pages to process (0 = all).

    Returns:
        ParsedPaper with same structure as the PyMuPDF parser.

    Raises:
        ImportError: If docling is not installed.
    """
    if not _DOCLING_AVAILABLE:
        raise ImportError(
            "Docling is not installed. Install with: pip install docling"
        )

    if paper_id is None:
        paper_id = os.path.splitext(os.path.basename(pdf_path))[0]

    # Configure pipeline
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = ocr
    pipeline_options.do_table_structure = True

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        }
    )

    # Convert — max_num_pages is passed to convert(), not pipeline options
    convert_kwargs = {}
    if max_pages > 0:
        convert_kwargs['max_num_pages'] = max_pages

    logger.info(f"Docling: converting {os.path.basename(pdf_path)}")
    result = converter.convert(pdf_path, **convert_kwargs)
    doc = result.document

    # Raw text via markdown export (high quality from Docling)
    raw_text = clean_extracted_text(doc.export_to_markdown())

    # Walk the document tree to build structured output
    title = ""
    abstract = ""
    sections = []
    figures = []
    pending_captions = []  # captions seen before their figure

    current_section_title = ""
    current_section_level = 1
    current_section_lines = []
    current_page_start = 0
    current_page_end = 0
    found_first_header = False

    def _flush_section():
        """Save current section if non-empty."""
        nonlocal current_section_lines
        if current_section_title and current_section_lines:
            text = clean_extracted_text('\n'.join(current_section_lines))
            if text:
                sections.append(ParsedSection(
                    title=current_section_title,
                    level=current_section_level,
                    text=text,
                    page_start=current_page_start,
                    page_end=current_page_end,
                ))
        current_section_lines = []

    # Body text labels (TEXT is the primary one; PARAGRAPH exists but rarely used)
    _TEXT_LABELS = {DocItemLabel.TEXT, DocItemLabel.PARAGRAPH, DocItemLabel.LIST_ITEM, DocItemLabel.CODE}

    for item, _hierarchy in doc.iterate_items():
        page = _get_page(item)
        label = getattr(item, 'label', None)

        # Explicit title label (some PDFs have this)
        if label == DocItemLabel.TITLE:
            title = getattr(item, 'text', '') or title
            continue

        # Section headers
        if label == DocItemLabel.SECTION_HEADER:
            header_text = getattr(item, 'text', '').strip()

            # First section_header is often the paper title (before any body text)
            if not found_first_header and not current_section_lines:
                found_first_header = True
                if not title:
                    title = header_text
                    continue

            _flush_section()
            current_section_title = header_text
            current_section_level = min(getattr(item, 'level', 1), 2)
            current_page_start = page
            current_page_end = page
            continue

        # Skip reference entries, footnotes, page headers/footers
        if label in (DocItemLabel.REFERENCE, DocItemLabel.FOOTNOTE,
                     DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
            continue

        # Captions — associate with nearest figure/table or store as text
        if label == DocItemLabel.CAPTION:
            caption_text = getattr(item, 'text', '')
            if caption_text:
                pending_captions.append((caption_text, page))
            continue

        # Body text
        if label in _TEXT_LABELS:
            text = getattr(item, 'text', '')
            if not text:
                continue

            # Check for inline abstract (e.g., "Abstract— We introduce...")
            if not abstract and text.lower().startswith('abstract'):
                import re
                remainder = re.sub(r'^abstract[\s:\-—–*]*', '', text, flags=re.IGNORECASE).strip()
                if remainder:
                    abstract = remainder
                    # Also add to current section if we have one
                    if current_section_title:
                        current_section_lines.append(remainder)
                        current_page_end = page
                    continue

            if current_section_title:
                current_section_lines.append(text)
                current_page_end = page
            continue

        # Equations / formulas
        if label == DocItemLabel.FORMULA:
            text = getattr(item, 'text', '')
            if text and current_section_title:
                current_section_lines.append(text)
                current_page_end = page
            continue

        # Tables
        if label in (DocItemLabel.TABLE, DocItemLabel.DOCUMENT_INDEX):
            table_text = _table_to_text(item)
            if not table_text:
                continue

            if table_mode == "inline" and current_section_title:
                current_section_lines.append(table_text)
                current_page_end = page
            elif table_mode == "sections":
                _flush_section()
                caption = ""
                if pending_captions:
                    caption = pending_captions.pop(0)[0]
                if not caption:
                    caption = _get_caption(item, doc)
                table_title = caption if caption else f"Table (page {page + 1})"
                sections.append(ParsedSection(
                    title=table_title,
                    level=2,
                    text=table_text,
                    page_start=page,
                    page_end=page,
                ))
            continue

        # Figures / pictures
        if label in (DocItemLabel.PICTURE, DocItemLabel.CHART):
            caption = ""
            # Check pending captions first
            if pending_captions:
                caption = pending_captions.pop(0)[0]
            if not caption:
                caption = _get_caption(item, doc)
            if caption:
                figures.append(ParsedFigure(
                    caption=caption,
                    page=page,
                    nearby_text="",
                ))
            continue

    # Flush final section
    _flush_section()

    # Also create figures from any remaining unclaimed captions
    for caption_text, cap_page in pending_captions:
        figures.append(ParsedFigure(caption=caption_text, page=cap_page))

    # Extract abstract from sections if not found inline
    if not abstract:
        for sec in sections:
            if sec.title.lower().strip() == "abstract":
                abstract = sec.text
                break

    # Fallback: one big section if none detected
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
