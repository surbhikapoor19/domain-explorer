"""run_docling: iterate a PDF dir through ONE shared DocumentConverter — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. Runs offline (injected fake converter / monkeypatched constructor),
so it needs neither docling nor model downloads.
"""
import os
from benchmarks.extraction.run_extraction import run_docling
from benchmarks.normalize.registries import load_config, MethodResolver

CFG = load_config(os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json'))


# ---- minimal fake Docling doc (one born-digital results table) ----
class _BBox:
    def __init__(self, l, t, r, b):
        self.l, self.t, self.r, self.b = l, t, r, b

    def to_top_left_origin(self, h):
        return _BBox(self.l, h - self.t, self.r, h - self.b)


class _Prov:
    def __init__(self, p, b):
        self.page_no, self.bbox = p, b


class _Cell:
    def __init__(self, t):
        self.text = t


class _Data:
    def __init__(self, g):
        self.grid = [[_Cell(c) for c in row] for row in g]


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
        self.tables = [_Table("Table 1: success rate (%)", 3, _BBox(100, 600, 500, 500),
                              [["Method", "Success Rate"], ["Ours", "86.9"], ["GPD", "70.1"]])]
        self.pages = {1: _Page(792.0), 2: _Page(792.0), 3: _Page(792.0)}


class _Res:
    document = _Doc()


class _FakeConverter:
    def __init__(self):
        self.n = 0

    def convert(self, pdf):
        self.n += 1
        return _Res()


def _resolver():
    return MethodResolver(["AnyGrasp", "Grasp Pose Detection (GPD)"],
                          alias_seeds={"gpd": "Grasp Pose Detection (GPD)", "ours": "AnyGrasp"})


def test_run_docling_shares_one_injected_converter_across_pdfs(tmp_path):
    for n in ("a.pdf", "b.pdf", "notes.txt"):
        (tmp_path / n).write_bytes(b"%PDF-1.4")
    conv = _FakeConverter()
    records, unknown = run_docling(str(tmp_path), CFG, _resolver(), converter=conv)
    assert conv.n == 2  # both PDFs (not the .txt) converted through the SAME instance
    methods = {r.method_id for r in records if r.method_id}
    assert "AnyGrasp" in methods and "Grasp Pose Detection (GPD)" in methods
    assert any(r.metric_id == "success_rate" for r in records)
    assert isinstance(unknown, list)


def test_run_docling_constructs_default_converter_exactly_once(tmp_path, monkeypatch):
    for n in ("a.pdf", "b.pdf"):
        (tmp_path / n).write_bytes(b"%PDF-1.4")
    count = {"n": 0}

    def fake_default():
        count["n"] += 1
        return _FakeConverter()

    # run_docling must construct its converter via a patchable _default_converter() when none is passed
    monkeypatch.setattr("benchmarks.extraction.run_extraction._default_converter", fake_default)
    run_docling(str(tmp_path), CFG, _resolver())  # converter=None -> one construction
    assert count["n"] == 1
