"""PDF parsing via GROBID.

GROBID converts PDFs to TEI-XML preserving document structure: hierarchical
sections, tables (as `<table>` trees), figures (with captions), formulas, and
structured bibliography. Far cleaner than text-only extraction for academic
papers.

Requires a running GROBID service (default http://localhost:8070).
Start with:
    docker run -d --rm -p 8070:8070 --name grobid lfoppiano/grobid:0.8.1

Produces the same ParsedPaper / ParsedSection / ParsedFigure dataclasses as
pdf_parser.py so the rest of the pipeline is unchanged.
"""

import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

import requests

from .pdf_parser import ParsedPaper, ParsedSection, ParsedFigure, clean_extracted_text


TEI_NS = {'tei': 'http://www.tei-c.org/ns/1.0'}
DEFAULT_GROBID_URL = os.environ.get('GROBID_URL', 'http://localhost:8070')


# Section-type heuristics for routing queries to relevant chunks.
SECTION_TYPE_PATTERNS = {
    'abstract':     [r'^abstract$'],
    'introduction': [r'^introduction', r'^1\.?\s*introduction'],
    'related_work': [r'related\s+work', r'prior\s+work', r'background'],
    'method':       [r'method', r'approach', r'our\s+model', r'architecture', r'algorithm', r'framework'],
    'experiments':  [r'experiment', r'evaluation', r'results', r'benchmark', r'empirical'],
    'ablation':     [r'ablation', r'analysis'],
    'limitations':  [r'limitation', r'discussion', r'failure\s+case'],
    'conclusion':   [r'conclusion', r'future\s+work'],
    'references':   [r'^references$', r'^bibliography'],
}


def classify_section(title: str) -> str:
    """Map a section title to a canonical section_type for query routing."""
    if not title:
        return 'other'
    t = title.lower().strip()
    for section_type, patterns in SECTION_TYPE_PATTERNS.items():
        for p in patterns:
            if re.search(p, t):
                return section_type
    return 'other'


@dataclass
class ParsedTable:
    """Structured table extracted by GROBID."""
    caption: str
    rows: list = field(default_factory=list)  # list of list-of-str cells
    section: str = ""


def is_grobid_available(url: str = DEFAULT_GROBID_URL) -> bool:
    try:
        r = requests.get(f"{url}/api/isalive", timeout=3)
        return r.status_code == 200 and 'true' in r.text.lower()
    except Exception:
        return False


def _tei_text(elem, strip=True) -> str:
    """Join all descendant text in an element (preserves order, drops tags)."""
    if elem is None:
        return ""
    parts = []
    for t in elem.itertext():
        if t:
            parts.append(t)
    s = " ".join(parts)
    s = re.sub(r'\s+', ' ', s)
    return s.strip() if strip else s


def _parse_section(div, parent_title: str = "") -> list:
    """Recursively flatten a TEI <div> into ParsedSection entries.

    GROBID nests sections as <div><head>Title</head><p>...</p><div>...</div></div>
    We flatten to a list, using level based on nesting depth.
    """
    out = []
    head = div.find('tei:head', TEI_NS)
    title = _tei_text(head) if head is not None else parent_title or "Body"
    # Accumulate all direct <p> children as the section text
    paragraphs = []
    for p in div.findall('tei:p', TEI_NS):
        txt = _tei_text(p)
        if txt:
            paragraphs.append(txt)
    if paragraphs:
        clean_title = clean_extracted_text(title)[:200]
        out.append(ParsedSection(
            title=clean_title,
            level=1,
            text=clean_extracted_text("\n\n".join(paragraphs)),
            page_start=0,
            page_end=0,
            section_type=classify_section(clean_title),
        ))
    # Recurse into nested <div>s with level+1
    for sub in div.findall('tei:div', TEI_NS):
        sub_sections = _parse_section(sub, parent_title=title)
        for s in sub_sections:
            s.level = min(s.level + 1, 3)
        out.extend(sub_sections)
    return out


def _extract_tables(root) -> list:
    """Extract TEI <figure type='table'> as ParsedTable."""
    tables = []
    for fig in root.findall('.//tei:figure', TEI_NS):
        if fig.get('type') != 'table':
            continue
        head = fig.find('tei:head', TEI_NS)
        desc = fig.find('tei:figDesc', TEI_NS)
        caption_parts = []
        if head is not None:
            caption_parts.append(_tei_text(head))
        if desc is not None:
            caption_parts.append(_tei_text(desc))
        caption = clean_extracted_text(" - ".join(p for p in caption_parts if p))
        rows = []
        t = fig.find('tei:table', TEI_NS)
        if t is not None:
            for row in t.findall('tei:row', TEI_NS):
                cells = [_tei_text(c) for c in row.findall('tei:cell', TEI_NS)]
                if any(cells):
                    rows.append(cells)
        if rows:
            tables.append(ParsedTable(caption=caption[:300], rows=rows))
    return tables


def _extract_figures(root) -> list:
    """Extract TEI <figure> (non-table) as ParsedFigure."""
    figures = []
    for fig in root.findall('.//tei:figure', TEI_NS):
        if fig.get('type') == 'table':
            continue
        head = fig.find('tei:head', TEI_NS)
        desc = fig.find('tei:figDesc', TEI_NS)
        parts = []
        if head is not None:
            parts.append(_tei_text(head))
        if desc is not None:
            parts.append(_tei_text(desc))
        caption = clean_extracted_text(" - ".join(p for p in parts if p))
        if caption:
            figures.append(ParsedFigure(caption=caption[:400], page=0))
    return figures


def parse_pdf_grobid(
    pdf_path: str,
    paper_id: str,
    grobid_url: str = DEFAULT_GROBID_URL,
    timeout: int = 120,
    tei_cache_dir: Optional[str] = None,
) -> ParsedPaper:
    """Parse a PDF via GROBID and return a ParsedPaper.

    Tables are attached as additional ParsedSection entries (title = "Table N:
    caption", level=2, text = markdown-like pipe table) so the existing chunker
    picks them up naturally. The caller can also access the raw TEI via the
    paper's ``raw_text`` attribute (we store the TEI-XML there).
    """
    if not is_grobid_available(grobid_url):
        raise RuntimeError(
            f"GROBID not reachable at {grobid_url}. "
            "Start it with: docker run -d --rm -p 8070:8070 --name grobid lfoppiano/grobid:0.8.1"
        )

    with open(pdf_path, 'rb') as f:
        files = {'input': (os.path.basename(pdf_path), f, 'application/pdf')}
        data = {
            'consolidateCitations': '0',
            'consolidateHeader': '0',
            'includeRawCitations': '0',
            'includeRawAffiliations': '0',
        }
        r = requests.post(
            f"{grobid_url}/api/processFulltextDocument",
            files=files,
            data=data,
            timeout=timeout,
        )
    r.raise_for_status()
    tei_xml = r.text
    # Persist TEI-XML for downstream TEI-aware graph builders
    if tei_cache_dir:
        os.makedirs(tei_cache_dir, exist_ok=True)
        out_path = os.path.join(tei_cache_dir, f"{paper_id}.tei.xml")
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(tei_xml)
    root = ET.fromstring(tei_xml)

    # Title
    title_el = root.find('.//tei:titleStmt/tei:title', TEI_NS)
    title = clean_extracted_text(_tei_text(title_el)) if title_el is not None else paper_id

    # Abstract
    abs_el = root.find('.//tei:profileDesc/tei:abstract', TEI_NS)
    abstract = clean_extracted_text(_tei_text(abs_el)) if abs_el is not None else ""

    # Sections: iterate <body>/<div>
    sections = []
    body = root.find('.//tei:body', TEI_NS)
    if body is not None:
        for div in body.findall('tei:div', TEI_NS):
            sections.extend(_parse_section(div))

    # Figures (non-table)
    figures = _extract_figures(root)

    # Tables: convert to ParsedSection(level=2) so chunker indexes them like content.
    tables = _extract_tables(root)
    for i, tbl in enumerate(tables, 1):
        # Render as pipe-delimited markdown table with separator row
        md_lines = []
        if tbl.rows:
            header = tbl.rows[0]
            md_lines.append("| " + " | ".join(header) + " |")
            md_lines.append("|" + "|".join(['---'] * len(header)) + "|")
            for row in tbl.rows[1:]:
                # Pad to header width
                while len(row) < len(header):
                    row.append('')
                md_lines.append("| " + " | ".join(row[:len(header)]) + " |")
        md_table = "\n".join(md_lines)
        section_title = f"Table {i}"
        if tbl.caption:
            section_title = f"Table {i}: {tbl.caption[:100]}"
        sections.append(ParsedSection(
            title=section_title,
            level=2,
            text=md_table,
            page_start=0,
            page_end=0,
            section_type='table',
        ))

    # Raw body text for fallback (concatenation of all section texts)
    raw_text = "\n\n".join(s.text for s in sections)

    return ParsedPaper(
        paper_id=paper_id,
        title=title[:300] or paper_id,
        abstract=abstract[:4000],
        sections=sections,
        figures=figures,
        raw_text=raw_text,
    )


def parse_pdf_grobid_with_tei(
    pdf_path: str,
    paper_id: str,
    grobid_url: str = DEFAULT_GROBID_URL,
    timeout: int = 120,
):
    """Variant that also returns raw TEI-XML for downstream tree-based features."""
    paper = parse_pdf_grobid(pdf_path, paper_id, grobid_url, timeout)
    # Re-fetch TEI (cheap vs re-parse) — store on paper
    with open(pdf_path, 'rb') as f:
        files = {'input': (os.path.basename(pdf_path), f, 'application/pdf')}
        r = requests.post(f"{grobid_url}/api/processFulltextDocument", files=files, timeout=timeout)
    tei_xml = r.text if r.status_code == 200 else ""
    return paper, tei_xml
