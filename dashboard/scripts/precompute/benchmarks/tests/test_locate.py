"""Tests for extraction.locate — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify."""
import os
from benchmarks.extraction.locate import locate_tables, TableLocation
from benchmarks.normalize.registries import load_config

FX = os.path.join(os.path.dirname(__file__), 'fixtures', 'mini.tei.xml')


def test_locates_all_three_tables():
    locs = locate_tables(FX, load_config())
    assert len(locs) == 3
    assert all(isinstance(l, TableLocation) for l in locs)


def test_results_table_with_rows_is_classified():
    locs = locate_tables(FX, load_config())
    res = next(l for l in locs if l.has_rows)
    assert res.is_results_section is True
    assert res.is_ablation_section is False
    assert res.rows and res.rows[0]  # has a header row of cells
    assert 'Quantitative' in res.section_label or res.is_results_section


def test_image_table_has_no_rows_but_keeps_caption():
    locs = locate_tables(FX, load_config())
    imgs = [l for l in locs if not l.has_rows]
    assert imgs, "at least one image (no-row) table present"
    assert all(l.caption for l in imgs), "caption preserved even when rows are empty"


def test_ablation_section_is_marked_and_excluded_from_results():
    locs = locate_tables(FX, load_config())
    abl = [l for l in locs if l.is_ablation_section]
    assert abl, "ablation table is flagged"
    assert all(not l.is_results_section for l in abl), "ablation is never also results"


def test_image_table_in_results_section_is_selected_for_vlm():
    # an image table sitting in a results (Experiments) section must be
    # results=True AND has_rows=False so the orchestrator routes it to the VLM path
    locs = locate_tables(FX, load_config())
    exp_img = [l for l in locs if l.is_results_section and not l.has_rows]
    assert exp_img, "an image table sits in a results section and is VLM-eligible"
