"""Tests for the Docling orchestration path — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

extract_paper_docling: Docling doc -> locations (with page+bbox) -> records (reusing the born-digital
parser) -> a real crop rendered FROM THE BBOX (this is what GROBID captions couldn't do). All I/O
injected so it runs offline without docling/pymupdf.
"""
from benchmarks.extraction.run_extraction import extract_paper_docling
from benchmarks.normalize.registries import load_config, MethodResolver

CFG = load_config()


class _BBox:
    def __init__(self, l, t, r, b):
        self.l, self.t, self.r, self.b = l, t, r, b

    def to_top_left_origin(self, h):
        return _BBox(self.l, h - self.t, self.r, h - self.b)


class _Prov:
    def __init__(self, page_no, bbox):
        self.page_no, self.bbox = page_no, bbox


class _Cell:
    def __init__(self, t):
        self.text = t


class _Data:
    def __init__(self, grid):
        self.grid = [[_Cell(c) for c in row] for row in grid]


class _Table:
    def __init__(self, cap, page, bbox, grid):
        self._cap, self.prov, self.data = cap, [_Prov(page, bbox)], _Data(grid)

    def caption_text(self, doc):
        return self._cap


class _Size:
    def __init__(self, h):
        self.height, self.width = h, 612.0


class _Page:
    def __init__(self, h):
        self.size = _Size(h)


class _Doc:
    def __init__(self):
        self.tables = [_Table("Table 2: Success rate on pile (%)", 3,
                              _BBox(100.0, 600.0, 500.0, 500.0),
                              [["Method", "Success Rate"], ["Ours", "86.9"], ["GPD", "70.1"]])]
        self.pages = {1: _Page(792.0), 2: _Page(792.0), 3: _Page(792.0)}


class _Converter:
    def convert(self, pdf_path):
        class R:
            document = _Doc()
        return R()


def _resolver():
    return MethodResolver(["AnyGrasp", "Grasp Pose Detection (GPD)"],
                          alias_seeds={"gpd": "Grasp Pose Detection (GPD)", "ours": "AnyGrasp"})


def test_docling_path_renders_crop_from_bbox_and_attaches_provenance():
    captured = {}

    def render_fn(pdf, page, bbox):
        captured['page'] = page
        captured['bbox'] = bbox
        return b'PNGDATA'

    recs = extract_paper_docling(
        "anygrasp.pdf", "anygrasp", CFG, _resolver(),
        converter=_Converter(), render_fn=render_fn,
        crop_saver=lambda pid, idx, png: f"/data-grasp-planning/crops/{pid}_t{idx}.png")
    by = {r.method_id: r for r in recs if r.method_id}
    assert "AnyGrasp" in by
    assert by["AnyGrasp"].metric_id == "success_rate"
    assert by["AnyGrasp"].condition == "pile"
    # crop rendered FROM the bbox, attached as provenance
    assert by["AnyGrasp"].crop_image == "/data-grasp-planning/crops/anygrasp_t0.png"
    assert by["AnyGrasp"].page == 3
    # pymupdf is 0-based: docling page_no 3 -> rendered page 2; bbox converted to top-left
    assert captured['page'] == 2
    assert abs(captured['bbox'][1] - 192.0) < 0.01  # 792 - 600


def test_docling_path_skips_ablation():
    # add an ablation table to the doc and confirm it is excluded
    doc = _Doc()

    class _AblTable(_Table):
        pass
    doc.tables.append(_Table("Table 5: Ablation study", 3, _BBox(100.0, 400.0, 500.0, 300.0),
                             [["Variant", "Success Rate"], ["Full", "86.9"], ["w/o x", "60.0"]]))

    class _C:
        def convert(self, p):
            class R:
                document = doc
            return R()

    recs = extract_paper_docling("anygrasp.pdf", "anygrasp", CFG, _resolver(),
                                 converter=_C(), render_fn=lambda *a: b'P',
                                 crop_saver=lambda *a: "/c.png")
    assert all((r.is_ablation is False) for r in recs)
