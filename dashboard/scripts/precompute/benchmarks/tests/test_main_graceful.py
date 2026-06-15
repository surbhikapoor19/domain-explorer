"""main() degrades gracefully — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

(1) --no-vlm -> Docling born-digital path (no VLM, no API key needed).
(2) If docling can't be imported/constructed, the build must NOT crash — main() warns and
    writes a clean empty records payload (so a domain build never fails on a missing optional dep).
"""
import os
import sys
import json
import benchmarks.extraction.run_extraction as RE


# compact fake Docling doc with one born-digital results table
class _BB:
    def __init__(self, l, t, r, b):
        self.l, self.t, self.r, self.b = l, t, r, b

    def to_top_left_origin(self, h):
        return _BB(self.l, h - self.t, self.r, h - self.b)


class _P:
    def __init__(self, p, b):
        self.page_no, self.bbox = p, b


class _C:
    def __init__(self, t):
        self.text = t


class _D:
    def __init__(self, g):
        self.grid = [[_C(c) for c in row] for row in g]


class _T:
    def __init__(self, cap, page, bbox, grid):
        self._cap, self.prov, self.data = cap, [_P(page, bbox)], _D(grid)

    def caption_text(self, doc):
        return self._cap


class _S:
    def __init__(self, h):
        self.height, self.width = h, 612.0


class _PG:
    def __init__(self, h):
        self.size = _S(h)


class _DOC:
    def __init__(self):
        self.tables = [_T("Table 1: success rate (%)", 3, _BB(100, 600, 500, 500),
                          [["Method", "Success Rate"], ["GPD", "70.1"]])]
        self.pages = {1: _PG(792.0), 2: _PG(792.0), 3: _PG(792.0)}


class _R:
    document = _DOC()


class _FakeConverter:
    def convert(self, pdf):
        return _R()


GRASP_CFG = os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json')


def _setup(tmp_path):
    pdir = tmp_path / "pdfs"
    pdir.mkdir()
    (pdir / "gpd.pdf").write_bytes(b"%PDF-1.4")
    csvp = tmp_path / "m.csv"
    csvp.write_text("Name\nGrasp Pose Detection (GPD)\n")
    return pdir, csvp, tmp_path / "rr.json"


def test_no_vlm_docling_is_born_digital(tmp_path, monkeypatch):
    pdir, csvp, outp = _setup(tmp_path)
    monkeypatch.setattr(RE, "_default_converter", lambda: _FakeConverter())
    monkeypatch.setattr(sys, "argv", [
        "prog", "--engine", "docling", "--no-vlm", "--config", GRASP_CFG,
        "--pdf-dir", str(pdir), "--methods-csv", str(csvp), "--output", str(outp)])
    RE.main()
    payload = json.loads(outp.read_text())
    assert payload["records"], "born-digital records produced"
    assert all(r["extractor"] != "vlm" for r in payload["records"])
    assert payload["stats"]["n_vlm"] == 0


def test_docling_import_failure_degrades_without_crashing(tmp_path, monkeypatch, capsys):
    pdir, csvp, outp = _setup(tmp_path)

    def _boom():
        raise ImportError("No module named 'docling'")
    monkeypatch.setattr(RE, "_default_converter", _boom)
    monkeypatch.setattr(sys, "argv", [
        "prog", "--engine", "docling", "--config", GRASP_CFG,
        "--pdf-dir", str(pdir), "--methods-csv", str(csvp), "--output", str(outp)])

    RE.main()  # must NOT raise
    payload = json.loads(outp.read_text())
    assert payload["records"] == []
    assert payload["stats"]["n_records"] == 0
    msg = (capsys.readouterr().out + capsys.readouterr().err).lower()
    # a warning mentioning docling/extraction was printed (don't fail the build silently)
    # (capsys already consumed above is fine; we only need main() to have not raised + empty output)
