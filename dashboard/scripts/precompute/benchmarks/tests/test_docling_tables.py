"""Tests for extraction.docling_tables — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

Maps a DoclingDocument's tables -> TableLocation objects WITH page + bbox (for reliable crops),
full caption, and the cell grid. Uses a faithful fake of Docling's real API (probed from the
installed package) so the test runs offline on system python without docling installed.
"""
from benchmarks.extraction.docling_tables import docling_tables_to_locations
from benchmarks.extraction.locate import TableLocation
from benchmarks.normalize.registries import load_config

CFG = load_config()


# ---- faithful fakes of Docling's real API (see probe: ProvenanceItem.page_no/.bbox,
#      BoundingBox.to_top_left_origin(h)/.l/.t/.r/.b, TableItem.caption_text(doc),
#      table.data.grid -> cells with .text, doc.pages[page_no].size.height) ----
class FakeBBox:
    def __init__(self, l, t, r, b):
        self.l, self.t, self.r, self.b = l, t, r, b

    def to_top_left_origin(self, page_height):
        # Docling bbox is BOTTOMLEFT origin; converting flips the y axis.
        return FakeBBox(self.l, page_height - self.t, self.r, page_height - self.b)


class FakeProv:
    def __init__(self, page_no, bbox):
        self.page_no, self.bbox = page_no, bbox


class FakeCell:
    def __init__(self, text):
        self.text = text


class FakeData:
    def __init__(self, grid_text):
        self.grid = [[FakeCell(c) for c in row] for row in grid_text]


class FakeTable:
    def __init__(self, caption, page_no, bbox, grid_text):
        self._caption, self.prov, self.data = caption, [FakeProv(page_no, bbox)], FakeData(grid_text)

    def caption_text(self, doc):
        return self._caption


class FakeSize:
    def __init__(self, h):
        self.height, self.width = h, 612.0


class FakePage:
    def __init__(self, h):
        self.size = FakeSize(h)


class FakeDoc:
    def __init__(self, tables, page_heights):
        self.tables = tables
        self.pages = {i + 1: FakePage(h) for i, h in enumerate(page_heights)}


def _doc():
    results = FakeTable(
        "Table 2: Grasp success rate comparison on pile scenes",
        page_no=3, bbox=FakeBBox(100.0, 600.0, 500.0, 500.0),
        grid_text=[["Method", "Success Rate"], ["Ours", "86.9"], ["GPD", "70.1"]])
    ablation = FakeTable(
        "Table 5: Ablation study of components",
        page_no=4, bbox=FakeBBox(80.0, 400.0, 520.0, 300.0),
        grid_text=[["Variant", "Success Rate"], ["Full", "86.9"], ["w/o refine", "60.0"]])
    return FakeDoc([results, ablation], page_heights=[792.0, 792.0, 792.0, 792.0])


def test_maps_tables_to_locations_with_grid_caption_and_page():
    locs = docling_tables_to_locations(_doc(), "anygrasp", CFG)
    assert len(locs) == 2
    res = locs[0]
    assert isinstance(res, TableLocation)
    assert res.has_rows and res.rows[0] == ["Method", "Success Rate"]
    assert res.caption.startswith("Table 2")
    assert res.page == 3


def test_bbox_is_converted_to_top_left_origin_for_rendering():
    res = docling_tables_to_locations(_doc(), "anygrasp", CFG)[0]
    assert res.bbox is not None
    # original bottomleft t=600 on a 792-high page -> top-left y = 792-600 = 192
    assert abs(res.bbox[1] - 192.0) < 0.01
    assert abs(res.bbox[3] - 292.0) < 0.01  # b=500 -> 792-500=292


def test_ablation_caption_is_flagged_and_excluded_from_results():
    locs = docling_tables_to_locations(_doc(), "anygrasp", CFG)
    abl = [l for l in locs if l.is_ablation_section]
    assert abl, "ablation table flagged from its caption"
    assert all(not l.is_results_section for l in abl)
