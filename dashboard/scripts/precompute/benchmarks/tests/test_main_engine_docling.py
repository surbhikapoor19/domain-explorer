"""main(--engine docling) routes to run_docling + resolves paths, no grasp hardcode — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. Runs offline (fake converter, stub PDFs).
"""
import os
import sys
import json
import inspect
import benchmarks.extraction.run_extraction as RE


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
    def convert(self, pdf):
        return _Res()


GRASP_CFG = os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json')


def test_main_docling_engine_writes_records_and_no_grasp_hardcode(tmp_path, monkeypatch):
    pdir = tmp_path / "pdfs"
    pdir.mkdir()
    for n in ("anygrasp.pdf", "gpd.pdf"):
        (pdir / n).write_bytes(b"%PDF-1.4")
    csvp = tmp_path / "m.csv"
    csvp.write_text("Name,Year\nAnyGrasp,2023\nGrasp Pose Detection (GPD),2017\n")
    outp = tmp_path / "rr.json"

    monkeypatch.setattr(RE, "_default_converter", lambda: _FakeConverter())

    def _boom(*a, **k):
        raise AssertionError("TEI run() must NOT be called for --engine docling")
    monkeypatch.setattr(RE, "run", _boom)

    monkeypatch.setattr(sys, "argv", [
        "prog", "--engine", "docling", "--config", GRASP_CFG,
        "--pdf-dir", str(pdir), "--methods-csv", str(csvp), "--output", str(outp)])
    RE.main()

    payload = json.loads(outp.read_text())
    assert "records" in payload and "stats" in payload
    assert "AnyGrasp" in {r.get("method_id") for r in payload["records"]}
    # no grasp-hardcoded crop path leaked (no --crops-dir given)
    assert "/data-grasp-planning" not in outp.read_text()


def test_main_has_no_grasp_hardcoded_crops_url_default():
    # the grasp default must be gone from main() (was default='/data-grasp-planning/crops')
    assert "/data-grasp-planning" not in inspect.getsource(RE.main)
