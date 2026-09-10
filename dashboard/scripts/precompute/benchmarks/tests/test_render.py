"""Tests for extraction.render — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify."""
import os
import tempfile

import fitz  # PyMuPDF
from benchmarks.extraction.render import render_page_crop, find_caption_page


def _make_fixture_pdf():
    """Build the one-page fixture at test time: PDFs are never committed to the repo."""
    path = os.path.join(tempfile.mkdtemp(prefix='render-fixture-'), 'mini.pdf')
    doc = fitz.open()
    page = doc.new_page(width=400, height=500)
    for y, size, text in [(60, 12, 'Table 1: Success rate on pile scenes (%)'),
                          (120, 11, 'Method        Success Rate'),
                          (150, 11, 'Ours          86.9'),
                          (180, 11, 'GPD           70.1'),
                          (300, 10, 'Some other body text far from the table region.')]:
        page.insert_text((40, y), text, fontsize=size, fontname='helv')
    doc.save(path)
    doc.close()
    return path


FX_PDF = _make_fixture_pdf()


def test_renders_full_page_png_bytes():
    png = render_page_crop(FX_PDF, page=0, bbox=None, dpi=150)
    assert isinstance(png, (bytes, bytearray))
    assert png[:8] == b'\x89PNG\r\n\x1a\n'  # PNG magic


def test_bbox_crop_is_smaller_than_full_page():
    full = render_page_crop(FX_PDF, page=0, bbox=None, dpi=100)
    crop = render_page_crop(FX_PDF, page=0, bbox=[30, 40, 260, 200], dpi=100)
    assert crop[:8] == b'\x89PNG\r\n\x1a\n'
    assert len(crop) < len(full)  # a sub-region renders to fewer bytes than the whole page


def test_finds_caption_page_by_text():
    assert find_caption_page(FX_PDF, "Table 1: Success rate on pile scenes") == 0


def test_missing_caption_returns_none():
    assert find_caption_page(FX_PDF, "Nonexistent Table 99") is None
