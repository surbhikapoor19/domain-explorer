"""run_docling: iterate a PDF dir through ONE shared DocumentConverter — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. Runs offline (injected fake converter / monkeypatched constructor),
so it needs neither docling nor model downloads.
"""
import json
import os
import benchmarks.extraction.run_extraction as RE
from benchmarks.extraction.run_extraction import run_docling, extract_paper_docling
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


# --- VLM-outage cache contract: a paper whose image table was lost because every
#     vision provider was down must NOT be cached, so it retries once quota recovers. ---

class LLMUnavailable(Exception):
    """Stand-in whose class NAME matches what the code checks for (the real exception is
    llm_fallback.LLMUnavailable; the code identifies it by ``type(e).__name__`` to avoid
    importing across the sys.path boundary in a unit test)."""


def test_run_docling_skips_cache_for_vlm_failed_paper(tmp_path, monkeypatch):
    (tmp_path / "image_paper.pdf").write_bytes(b"%PDF-1.4")
    cache = str(tmp_path / "cache.json")

    def fake_extract(pdf_path, slug, cfg, resolver, *, converter=None, crop_saver=None,
                     vlm_client=None, vlm_failed_out=None):
        # Simulate an image table that got zero rows because the VLM was exhausted.
        if vlm_failed_out is not None:
            vlm_failed_out.append((slug, 0))
        return []

    monkeypatch.setattr(RE, "extract_paper_docling", fake_extract)
    manifest = {}
    run_docling(str(tmp_path), CFG, _resolver(), converter=_FakeConverter(),
                vlm_client=lambda png: None, cache_path=cache, manifest_out=manifest)

    saved = json.load(open(cache))
    assert "image_paper" not in saved.get("papers", {})   # NOT cached -> retries next build
    assert manifest["image_paper"][0] == "vlm-failed"


def test_run_docling_caches_paper_without_vlm_failure(tmp_path, monkeypatch):
    (tmp_path / "clean_paper.pdf").write_bytes(b"%PDF-1.4")
    cache = str(tmp_path / "cache.json")

    def fake_extract(pdf_path, slug, cfg, resolver, *, converter=None, crop_saver=None,
                     vlm_client=None, vlm_failed_out=None):
        return []   # empty but NOT a VLM failure (e.g. a paper with no results table)

    monkeypatch.setattr(RE, "extract_paper_docling", fake_extract)
    manifest = {}
    run_docling(str(tmp_path), CFG, _resolver(), converter=_FakeConverter(),
                cache_path=cache, manifest_out=manifest)

    saved = json.load(open(cache))
    assert "clean_paper" in saved.get("papers", {})       # cached (empty is a valid hit)
    assert manifest["clean_paper"][0] == "extracted"


def test_extract_paper_docling_born_digital_survives_vlm_outage():
    # A born-digital table must keep its rows even when the VLM is down: the VLM failure
    # falls through to Docling's own cells, and the paper is NOT flagged for retry.
    def dead_vlm(png):
        raise LLMUnavailable("every vision provider exhausted")

    vlm_failed = []
    recs = extract_paper_docling(
        "x.pdf", "paperx", CFG, _resolver(), converter=_FakeConverter(),
        render_fn=lambda *a, **k: b"PNG", vlm_client=dead_vlm, vlm_failed_out=vlm_failed)

    assert any(r.metric_id == "success_rate" for r in recs)   # Docling cells recovered
    assert vlm_failed == []                                   # complete -> not flagged


# --- image-table fake: structure detected (has_rows) but the value cells carry no
#     readable numbers (pixels), so only a VLM could read them. ---
class _ImgDoc:
    def __init__(self):
        self.tables = [_Table("Table 2: success rate (%)", 3, _BBox(100, 600, 500, 500),
                              [["Method", "Success Rate"], ["Ours", "fig"], ["GPD", "fig"]])]
        self.pages = {1: _Page(792.0), 2: _Page(792.0), 3: _Page(792.0)}


class _ImgRes:
    document = _ImgDoc()


class _ImgConverter:
    def convert(self, pdf):
        return _ImgRes()


def test_extract_paper_docling_flags_image_table_on_vlm_outage():
    # Non-numeric value cells -> Docling recovers zero rows; with the VLM down the table
    # is a real loss -> flagged so the caller refuses to cache and retries next build.
    def dead_vlm(png):
        raise LLMUnavailable("every vision provider exhausted")

    vlm_failed = []
    recs = extract_paper_docling(
        "img.pdf", "imgpaper", CFG, _resolver(), converter=_ImgConverter(),
        render_fn=lambda *a, **k: b"PNG", vlm_client=dead_vlm, vlm_failed_out=vlm_failed)

    assert recs == []                # nothing recoverable from the image cells
    assert vlm_failed == [("imgpaper", 0)]   # flagged for retry
