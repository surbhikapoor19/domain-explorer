"""Tests for extraction.render — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify."""
import os
from benchmarks.extraction.render import render_page_crop, find_caption_page

FX_PDF = os.path.join(os.path.dirname(__file__), 'fixtures', 'mini.pdf')


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
