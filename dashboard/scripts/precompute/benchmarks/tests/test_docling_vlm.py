"""VLM-on-Docling-crops path — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

The hybrid: Docling localizes the table (bbox -> crop) AND supplies its extracted cell text as
ground truth; the VLM reads the crop for SEMANTICS (method/metric/value); the found-in-crop
guardrail verifies VLM values against Docling's cells, so hallucinated values are rejected.
The VLM client is injected, so this runs offline.
"""
import json
from benchmarks.extraction.run_extraction import extract_paper_docling
from benchmarks.normalize.registries import load_config, MethodResolver

CFG = load_config()


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
        # Docling-extracted cells include the printed numbers (ground truth for verification)
        self.tables = [_Table("Table 2: Success rate on pile (%)", 3, _BBox(100.0, 600.0, 500.0, 500.0),
                              [["Method", "Success Rate"], ["Ours", "86.9"], ["GPD", "70.1"]])]
        self.pages = {1: _Page(792.0), 2: _Page(792.0), 3: _Page(792.0)}


class _Conv:
    def convert(self, p):
        class R:
            document = _Doc()
        return R()


def _resolver():
    return MethodResolver(["AnyGrasp", "Grasp Pose Detection (GPD)"],
                          alias_seeds={"gpd": "Grasp Pose Detection (GPD)", "ours": "AnyGrasp"})


def _run(vlm):
    return extract_paper_docling("p.pdf", "anygrasp", CFG, _resolver(), converter=_Conv(),
                                 render_fn=lambda *a: b'PNG',
                                 crop_saver=lambda pid, i, png: f"/crops/{pid}_t{i}.png",
                                 vlm_client=vlm)


def test_vlm_reads_crop_for_semantics_and_verifies_against_docling_cells():
    vlm = lambda png: json.dumps({"rows": [
        {"method": "Ours", "metric": "Success Rate", "condition": "pile", "value": 86.9,
         "value_str": "86.9", "is_own": True},
        {"method": "GPD", "metric": "Success Rate", "condition": "pile", "value": 70.1,
         "value_str": "70.1", "is_own": False}]})
    recs = _run(vlm)
    by = {r.method_id: r for r in recs if r.method_id}
    assert "AnyGrasp" in by and "Grasp Pose Detection (GPD)" in by
    assert by["AnyGrasp"].extractor == "vlm"
    assert by["AnyGrasp"].verified is True           # 86.9 present in Docling cells
    assert by["AnyGrasp"].crop_image == "/crops/anygrasp_t0.png"
    assert by["AnyGrasp"].metric_id == "success_rate"
    assert by["AnyGrasp"].condition == "pile"


def test_vlm_hallucination_rejected_against_docling_cell_text():
    vlm = lambda png: json.dumps({"rows": [
        {"method": "Ours", "metric": "Success Rate", "value": 999.9, "value_str": "999.9", "is_own": True}]})
    recs = _run(vlm)
    a = [r for r in recs if r.method_id == "AnyGrasp"]
    assert a and a[0].verified is False              # 999.9 not in Docling cells -> rejected
    assert a[0].extraction_conf == "low"
