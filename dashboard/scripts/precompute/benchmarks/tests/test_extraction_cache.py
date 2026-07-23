"""Per-PDF extraction-cache acceptance tests (section (g) 1-13) — AUTHORED BY ORCHESTRATOR.

Everything runs offline: extract_paper_docling is monkeypatched with a call-counting fake,
_default_converter is monkeypatched (or asserted never called), and tiny temp files whose
bytes drive the sha256 stand in for real PDFs. No docling / pymupdf / network needed.
"""
import os
import sys
import json

import pytest

import benchmarks.extraction.cache as CACHE
import benchmarks.extraction.run_extraction as RE
from benchmarks.types import ResultRecord
from benchmarks.normalize.registries import load_config, MethodResolver

GRASP_CFG = os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json')
CFG = load_config(GRASP_CFG)


# ---------------------------------------------------------------- helpers ----
def _rec(paper_id, method_id="AnyGrasp", value=80.0, **over):
    kw = dict(paper_id=paper_id, method_raw="AnyGrasp", method_id=method_id,
              metric_raw="Success Rate", metric_id="success_rate", unit="%",
              higher_is_better=True, condition="pile", value=value, value_str=str(value))
    kw.update(over)
    return ResultRecord(**kw)


def _resolver():
    return MethodResolver(["AnyGrasp", "Grasp Pose Detection (GPD)"],
                          alias_seeds={"gpd": "Grasp Pose Detection (GPD)", "ours": "AnyGrasp"})


def _write_pdfs(pdf_dir, names):
    pdf_dir.mkdir(parents=True, exist_ok=True)
    for n in names:
        (pdf_dir / (n + ".pdf")).write_bytes(("%PDF-1.4 " + n).encode())
    return pdf_dir


def _fake_extract(counter, raise_on=None):
    """Stand-in for extract_paper_docling: counts calls, yields one record per paper."""
    def _fake(pdf_path, paper_id, cfg, resolver, **kw):
        counter["n"] += 1
        if raise_on is not None and paper_id == raise_on:
            raise RuntimeError(f"boom on {paper_id}")
        return [_rec(paper_id)]
    return _fake


def _patch_extractor(monkeypatch, counter, raise_on=None):
    monkeypatch.setattr(RE, "extract_paper_docling", _fake_extract(counter, raise_on))
    monkeypatch.setattr(RE, "_default_converter", lambda: object())


def _pids(records):
    return {r.paper_id for r in records}


# 1 ---- round-trip put -> save -> load -> get_hit equals input dicts --------
def test_1_roundtrip_put_save_load_get_hit(tmp_path):
    recs = [_rec("p1"), _rec("p1", method_id="Grasp Pose Detection (GPD)", value=70.1)]
    expected = [dict(r.__dict__) for r in recs]
    path = str(tmp_path / "cache.json")
    cache = {}
    CACHE.put_entry(cache, "p1", "sha1", "salt1", recs)
    CACHE.save_cache(path, cache)
    loaded = CACHE.load_cache(path)
    assert CACHE.get_hit(loaded, "p1", "sha1", "salt1") == expected


# 2 ---- miss semantics ------------------------------------------------------
def test_2_miss_semantics_and_empty_hit(tmp_path):
    cache = {}
    CACHE.put_entry(cache, "p1", "shaA", "saltA", [_rec("p1")])
    CACHE.put_entry(cache, "zero", "shaZ", "saltA", [])          # extracted, no tables
    assert CACHE.get_hit(cache, "absent", "shaA", "saltA") is None
    assert CACHE.get_hit(cache, "p1", "DIFFERENT", "saltA") is None
    assert CACHE.get_hit(cache, "p1", "shaA", "DIFFERENT") is None
    assert CACHE.get_hit(cache, "zero", "shaZ", "saltA") == []   # [] is a HIT, not a miss


# 3 ---- salt sensitivity ----------------------------------------------------
def test_3_salt_sensitivity_and_key_order_stability(tmp_path, monkeypatch):
    base = CACHE.compute_salt(CFG)
    # config dict change
    cfg2 = dict(CFG); cfg2["__probe__"] = "x"
    assert CACHE.compute_salt(cfg2) != base
    # vlm flag change
    assert CACHE.compute_salt(CFG, vlm_enabled=True) != CACHE.compute_salt(CFG, vlm_enabled=False)
    # a source file's bytes change
    src = tmp_path / "src.py"
    src.write_bytes(b"v1")
    monkeypatch.setattr(CACHE, "SALT_SOURCE_FILES", [str(src)])
    s1 = CACHE.compute_salt(CFG)
    src.write_bytes(b"v2-different")
    s2 = CACHE.compute_salt(CFG)
    assert s1 != s2
    # stable across dict key ordering
    d1 = {"a": 1, "b": {"x": 1, "y": 2}}
    d2 = {"b": {"y": 2, "x": 1}, "a": 1}
    assert CACHE.compute_salt(d1) == CACHE.compute_salt(d2)


# 3b ---- salt covers the resolution/normalization sources (FIX 1) -----------
def test_3_salt_covers_resolution_sources(tmp_path, monkeypatch):
    """The resolver/normalizer code shapes record CONTENT (method_id, unit, metric
    normalization), so a change there must invalidate the cache. Assert both files
    are folded into the salt AND that changing registries.py's bytes changes it."""
    import shutil
    here = os.path.dirname(os.path.abspath(CACHE.__file__))
    registries = os.path.normpath(os.path.join(here, '..', 'normalize', 'registries.py'))
    units = os.path.normpath(os.path.join(here, '..', 'normalize', 'units.py'))
    salt_srcs = {os.path.normpath(p) for p in CACHE.SALT_SOURCE_FILES}
    assert registries in salt_srcs      # resolver logic folded into the salt
    assert units in salt_srcs           # unit normalization folded into the salt
    # changing registries.py's bytes changes the salt (cache invalidated)
    copy = tmp_path / "registries.py"
    shutil.copyfile(registries, copy)
    monkeypatch.setattr(CACHE, "SALT_SOURCE_FILES", [str(copy)])
    s1 = CACHE.compute_salt(CFG)
    with open(copy, "ab") as f:
        f.write(b"\n# resolver logic change\n")
    s2 = CACHE.compute_salt(CFG)
    assert s1 != s2


# 3c ---- salt covers the vision-fallback source (Gemini-primary reorder) -----
def test_3_salt_covers_llm_fallback_source(tmp_path, monkeypatch):
    """The shared vision fallback (repo-root scripts/lib/llm_fallback.py) drives the
    VLM image-table extraction; its provider order/logic shapes record CONTENT, so it
    must be folded into the salt. Assert it's in SALT_SOURCE_FILES, that its path
    actually RESOLVES (a wrong path would be a silent no-op in _source_digest), and
    that changing its bytes changes the salt."""
    import shutil
    llm_srcs = [p for p in CACHE.SALT_SOURCE_FILES if 'llm_fallback.py' in p]
    assert llm_srcs, "llm_fallback.py must be in SALT_SOURCE_FILES"
    llm = llm_srcs[0]
    assert os.path.exists(llm), f"llm_fallback.py salt path does not resolve: {llm}"
    # changing its bytes changes the salt (cache invalidated)
    copy = tmp_path / "llm_fallback.py"
    shutil.copyfile(llm, copy)
    monkeypatch.setattr(CACHE, "SALT_SOURCE_FILES", [str(copy)])
    s1 = CACHE.compute_salt(CFG)
    with open(copy, "ab") as f:
        f.write(b"\n# vision provider reorder\n")
    s2 = CACHE.compute_salt(CFG)
    assert s1 != s2


# 4 ---- warm run is free ----------------------------------------------------
def test_4_warm_run_no_extractor_calls(tmp_path, monkeypatch):
    pdf_dir = _write_pdfs(tmp_path / "pdfs", ["a", "b"])
    cache_file = str(tmp_path / "cache.json")
    counter = {"n": 0}
    _patch_extractor(monkeypatch, counter)
    recs1, _ = RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    assert counter["n"] == 2
    recs2, _ = RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    assert counter["n"] == 2  # zero new extractor calls on the warm run
    assert [r.__dict__ for r in recs2] == [r.__dict__ for r in recs1]


# 5 ---- one new PDF -> exactly one extraction -------------------------------
def test_5_one_new_pdf_one_extraction(tmp_path, monkeypatch):
    pdf_dir = _write_pdfs(tmp_path / "pdfs", ["a", "b"])
    cache_file = str(tmp_path / "cache.json")
    counter = {"n": 0}
    _patch_extractor(monkeypatch, counter)
    RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    assert counter["n"] == 2
    _write_pdfs(pdf_dir, ["c"])
    recs, _ = RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    assert counter["n"] == 3  # exactly one more call
    assert _pids(recs) == {"a", "b", "c"}


# 6 ---- prune a removed PDF -------------------------------------------------
def test_6_prune_removed_pdf(tmp_path, monkeypatch):
    pdf_dir = _write_pdfs(tmp_path / "pdfs", ["a", "b"])
    cache_file = str(tmp_path / "cache.json")
    counter = {"n": 0}
    _patch_extractor(monkeypatch, counter)
    RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    (pdf_dir / "b.pdf").unlink()
    recs, _ = RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    assert _pids(recs) == {"a"}
    saved = CACHE.load_cache(cache_file)
    assert "b" not in saved["papers"] and "a" in saved["papers"]


# 7 ---- cache_refresh re-extracts all ---------------------------------------
def test_7_cache_refresh_reextracts_all(tmp_path, monkeypatch):
    pdf_dir = _write_pdfs(tmp_path / "pdfs", ["a", "b"])
    cache_file = str(tmp_path / "cache.json")
    counter = {"n": 0}
    _patch_extractor(monkeypatch, counter)
    RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    assert counter["n"] == 2
    RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file, cache_refresh=True)
    assert counter["n"] == 4  # both re-extracted despite warm cache
    saved = CACHE.load_cache(cache_file)
    assert set(saved["papers"]) == {"a", "b"}  # cache rewritten, still valid


# 8 ---- partial failure: completed paper stays cached, exception propagates --
def test_8_partial_failure_saves_completed_paper(tmp_path, monkeypatch):
    pdf_dir = _write_pdfs(tmp_path / "pdfs", ["a", "b", "c"])
    cache_file = str(tmp_path / "cache.json")
    counter = {"n": 0}
    _patch_extractor(monkeypatch, counter, raise_on="b")
    with pytest.raises(RuntimeError):
        RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    saved = CACHE.load_cache(cache_file)
    assert "a" in saved["papers"]                 # completed before the failure
    assert "b" not in saved["papers"] and "c" not in saved["papers"]


# 9 ---- resolution refresh on cached records --------------------------------
def test_9_refresh_resolution(tmp_path):
    resolver = MethodResolver(["AnyGrasp"], alias_seeds={"ours": "AnyGrasp"})
    r_none = _rec("x", method_id=None, method_raw="AnyGrasp", is_own_method=False)
    r_fixed = _rec("y", method_id="Fixed", method_raw="Whatever", is_own_method=False)
    r_own = _rec("anygrasp", method_id=None, method_raw="Ours", is_own_method=True)
    RE._refresh_resolution([r_none, r_fixed, r_own], resolver)
    assert r_none.method_id == "AnyGrasp"          # filled via method_raw
    assert r_fixed.method_id == "Fixed"            # non-None never overwritten
    assert r_own.method_id == "AnyGrasp"           # own-method binds via paper_id


# 10 ---- corrupt cache file -> full extraction, no crash --------------------
def test_10_corrupt_cache_full_extraction(tmp_path, monkeypatch):
    pdf_dir = _write_pdfs(tmp_path / "pdfs", ["a", "b"])
    cache_file = tmp_path / "cache.json"
    cache_file.write_bytes(b"{ this is not valid json ]]]")
    counter = {"n": 0}
    _patch_extractor(monkeypatch, counter)
    recs, _ = RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=str(cache_file))
    assert counter["n"] == 2                       # everything re-extracted
    assert _pids(recs) == {"a", "b"}
    assert set(CACHE.load_cache(str(cache_file))["papers"]) == {"a", "b"}  # rewritten cleanly


# 11 ---- all-cached run never builds the converter --------------------------
def test_11_all_cached_never_builds_converter(tmp_path, monkeypatch):
    pdf_dir = _write_pdfs(tmp_path / "pdfs", ["a", "b"])
    cache_file = str(tmp_path / "cache.json")
    counter = {"n": 0}
    _patch_extractor(monkeypatch, counter)                       # working converter for run 1
    RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)
    assert counter["n"] == 2

    def _boom():
        raise AssertionError("converter must NOT be built on an all-cached run")
    monkeypatch.setattr(RE, "_default_converter", _boom)
    recs, _ = RE.run_docling(str(pdf_dir), CFG, _resolver(), cache_path=cache_file)  # must not raise
    assert counter["n"] == 2                        # no new extraction
    assert _pids(recs) == {"a", "b"}


# 12 ---- CLI plumbing: main() forwards --cache/--cache-refresh --------------
def _main_argv(tmp_path, extra):
    pdir = tmp_path / "pdfs"; pdir.mkdir()
    (pdir / "a.pdf").write_bytes(b"%PDF-1.4")
    csvp = tmp_path / "m.csv"; csvp.write_text("Name\nAnyGrasp\n")
    outp = tmp_path / "rr.json"
    return ["prog", "--engine", "docling", "--no-vlm", "--config", GRASP_CFG,
            "--pdf-dir", str(pdir), "--methods-csv", str(csvp), "--output", str(outp)] + extra


def test_12_main_forwards_cache_flags(tmp_path, monkeypatch):
    captured = {}

    def fake_rd(pdf_dir, cfg, resolver, **kw):
        captured.update(kw)
        return [], []
    monkeypatch.setattr(RE, "run_docling", fake_rd)
    cachep = tmp_path / "cache.json"
    monkeypatch.setattr(sys, "argv", _main_argv(tmp_path, ["--cache", str(cachep), "--cache-refresh"]))
    RE.main()
    assert captured["cache_path"] == str(cachep)
    assert captured["cache_refresh"] is True


def test_12_main_cache_defaults_off(tmp_path, monkeypatch):
    captured = {}

    def fake_rd(pdf_dir, cfg, resolver, **kw):
        captured.update(kw)
        return [], []
    monkeypatch.setattr(RE, "run_docling", fake_rd)
    monkeypatch.setattr(sys, "argv", _main_argv(tmp_path, []))
    RE.main()
    assert captured["cache_path"] is None
    assert captured["cache_refresh"] is False


# 13 ---- gate: _benchmark_stale + step_benchmark --cache-refresh ------------
def _ingest_domain():
    from pathlib import Path
    repo = Path(__file__).resolve().parents[5]        # .../domain-explorer
    sys.path.insert(0, str(repo / "scripts"))
    import ingest_domain
    return ingest_domain


def test_13_benchmark_stale_gate(tmp_path):
    ingest = _ingest_domain()
    pdf_dir = _write_pdfs(tmp_path / "papers", ["a", "b"])
    cache_file = tmp_path / "extraction-cache.json"
    salt = CACHE.compute_salt(load_config(GRASP_CFG), engine="docling", vlm_enabled=False)
    cache = {}
    for p in sorted(pdf_dir.glob("*.pdf")):
        CACHE.put_entry(cache, p.name[:-4], CACHE.sha256_file(str(p)), salt, [])
    CACHE.save_cache(str(cache_file), cache)
    # every PDF cached under the current hash+salt -> not stale
    assert ingest._benchmark_stale(cache_file, pdf_dir, GRASP_CFG, False) is False
    # changed PDF bytes -> stale
    (pdf_dir / "a.pdf").write_bytes(b"%PDF-1.4 a CHANGED")
    assert ingest._benchmark_stale(cache_file, pdf_dir, GRASP_CFG, False) is True
    # a new PDF not in the cache -> stale
    _write_pdfs(pdf_dir, ["a"])  # restore a to its cached bytes
    _write_pdfs(pdf_dir, ["c"])  # brand new paper
    assert ingest._benchmark_stale(cache_file, pdf_dir, GRASP_CFG, False) is True


def test_13_benchmark_stale_on_salt_change(tmp_path):
    ingest = _ingest_domain()
    pdf_dir = _write_pdfs(tmp_path / "papers", ["a", "b"])
    cache_file = tmp_path / "extraction-cache.json"
    cache = {}
    for p in sorted(pdf_dir.glob("*.pdf")):
        # entries stored under a stale/wrong salt -> current salt won't match
        CACHE.put_entry(cache, p.name[:-4], CACHE.sha256_file(str(p)), "f" * 16, [])
    CACHE.save_cache(str(cache_file), cache)
    assert ingest._benchmark_stale(cache_file, pdf_dir, GRASP_CFG, False) is True


def test_13_step_benchmark_appends_cache_refresh_under_force(tmp_path, monkeypatch):
    import subprocess
    ingest = _ingest_domain()

    class _R:
        returncode = 0
        stdout = ""
        stderr = ""

    calls = []
    monkeypatch.setattr(subprocess, "run",
                        lambda argv, **kw: (calls.append([str(x) for x in argv]) or _R()))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    dataset = tmp_path / "datasets" / "motion-planning"
    dataset.mkdir(parents=True)
    (dataset / "motion_planning.csv").write_text("Name\nBIT*\nRRT*\n")
    papers = dataset / "papers"; papers.mkdir()
    output = tmp_path / "out"; output.mkdir()
    chroma = tmp_path / "chroma"; chroma.mkdir()
    paths = {"dataset": dataset, "papers": papers, "output": output,
             "slug_dashed": "motion-planning", "chroma": chroma}

    # FORCE_BENCHMARK=1 -> --cache-refresh appended; --cache always present.
    monkeypatch.setenv("FORCE_BENCHMARK", "1")
    ingest.step_benchmark(paths, "motion_planning")
    extract = next(c for c in calls if "--engine" in c)
    assert "--cache" in extract
    assert str(chroma / "extraction-cache.json") in extract
    assert "--cache-refresh" in extract

    # Without a force signal -> --cache present, --cache-refresh absent.
    calls.clear()
    monkeypatch.delenv("FORCE_BENCHMARK", raising=False)
    ingest.FORCE = False
    ingest.step_benchmark(paths, "motion_planning")
    extract2 = next(c for c in calls if "--engine" in c)
    assert "--cache" in extract2
    assert "--cache-refresh" not in extract2
