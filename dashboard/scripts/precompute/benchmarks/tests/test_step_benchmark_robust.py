"""Robustness of ingest_domain.step_benchmark's benchmark reconciliation.

The old behaviour SEEDED the baseline from benchmark-comparisons.json only when the
persisted result-records.json had 0 records. That is brittle: a prior build (or any
Docling run) leaves result-records.json NON-empty, so the seed never fires and the
published (vision) baseline is never reconstructed — new papers can no longer merge
in without a manual reset.

The robust behaviour (asserted here) reconstructs the baseline from the
currently-published benchmark-comparisons.json on EVERY build, regardless of whether
result-records.json is empty, then merges the fresh Docling extraction on top:
  - published papers P1..Pn are preserved from benchmark-comparisons.json (NOT from
    the stale result-records.json),
  - a fresh Docling record for a NEW paper P(n+1) is merged in,
  - the merge is idempotent (a second build yields the same set).

subprocess.run is monkeypatched, so nothing actually runs Docling: the fake extract
writes the fresh record for the new paper to its --output path, and the fake export
reconstructs benchmark-comparisons.json from --from-records.
"""
import json
import sys
import subprocess
from dataclasses import asdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]  # .../domain-explorer
sys.path.insert(0, str(REPO / 'scripts'))
import ingest_domain  # noqa: E402

from benchmarks.types import ResultRecord  # noqa: E402


class _R:
    returncode = 0
    stdout = ''
    stderr = ''


def _rec(paper_id, method, value):
    """A ResultRecord as a plain dict (what result-records.json stores)."""
    return asdict(ResultRecord(
        paper_id=paper_id, method_raw=method, method_id=method,
        metric_raw="Success Rate", metric_id="success_rate", unit="%",
        higher_is_better=True, dataset_raw="", dataset_id=None, condition="pile",
        value=value, value_str=str(value), extractor="vlm", verified=True))


def _cmp_row(paper_id, method, value, grade="B"):
    """One benchmark-comparisons.json ``results`` row (keys the reconstruction reads)."""
    return {
        "method": method, "method_resolved": True,
        "metric_id": "success_rate", "metric_raw": "Success Rate",
        "unit": "%", "higher_is_better": True,
        "dataset_id": None, "dataset_raw": "", "condition": "pile",
        "value": value, "value_str": str(value), "is_own_method": False,
        "extractor": "vlm", "table_caption": "", "section_label": "results",
        "page": 3, "crop_image": None, "paper_id": paper_id, "grade": grade,
    }


def _rec_to_cmp_row(rec):
    """Map a result-records.json record dict -> a comparisons ``results`` row so the
    fake export keeps benchmark-comparisons.json consistent with the merged records."""
    return {
        "method": rec.get("method_id") or rec.get("method_raw"),
        "method_resolved": rec.get("method_id") is not None,
        "metric_id": rec.get("metric_id"), "metric_raw": rec.get("metric_raw") or "",
        "unit": rec.get("unit"), "higher_is_better": rec.get("higher_is_better"),
        "dataset_id": rec.get("dataset_id"), "dataset_raw": rec.get("dataset_raw") or "",
        "condition": rec.get("condition"), "value": rec.get("value"),
        "value_str": rec.get("value_str") or "", "is_own_method": rec.get("is_own_method", False),
        "extractor": rec.get("extractor") or "vlm", "table_caption": rec.get("table_caption") or "",
        "section_label": rec.get("section_label") or "", "page": rec.get("page"),
        "crop_image": rec.get("crop_image"), "paper_id": rec.get("paper_id"), "grade": "B",
    }


# Values that make the two sources distinguishable: if the baseline were (wrongly)
# taken from the stale result-records.json, p1 would carry P1_STALE and p2 would be
# absent. The published comparisons carry P1_PUBLISHED and include p2.
P1_PUBLISHED = 86.9
P1_STALE = 11.1
P2_PUBLISHED = 70.0
P3_FRESH = 55.5


def _paths(tmp_path, slug="motion-planning"):
    dataset = tmp_path / "datasets" / slug
    dataset.mkdir(parents=True)
    # CSV Name column -> present_ids {p1, p2, p3}
    (dataset / "motion_planning.csv").write_text("Name\nP1\nP2\nP3\n")
    papers = dataset / "papers"
    papers.mkdir()
    output = tmp_path / "out-data"
    output.mkdir()
    chroma = tmp_path / "chroma"
    chroma.mkdir()
    return {"dataset": dataset, "papers": papers, "output": output,
            "slug_dashed": slug, "chroma": chroma}


def _install_fake_run(monkeypatch, fresh_records):
    """subprocess.run stub: fake extract writes ``fresh_records`` to --output; fake
    export rebuilds benchmark-comparisons.json from --from-records."""
    def _fake_run(argv, **kw):
        argv = [str(x) for x in argv]
        if '--engine' in argv:                       # Docling extract
            out = Path(argv[argv.index('--output') + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps({'records': fresh_records}))
        elif any('benchmark_data.py' in a for a in argv):   # export
            recs = json.loads(Path(argv[argv.index('--from-records') + 1]).read_text())['records']
            out_dir = Path(argv[argv.index('--output-dir') + 1])
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / 'benchmark-comparisons.json').write_text(
                json.dumps({'results': [_rec_to_cmp_row(r) for r in recs]}))
        return _R()
    monkeypatch.setattr(subprocess, "run", _fake_run)


def test_baseline_reconstructed_from_comparisons_despite_nonempty_result_records(tmp_path, monkeypatch):
    """P1..P2 come from the PUBLISHED comparisons (not the stale result-records.json),
    and a fresh Docling record for the NEW paper p3 is merged in — even though
    result-records.json is NON-empty and disagrees with the published baseline."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("FORCE_BENCHMARK", "1")   # bypass the warm-cache skip
    monkeypatch.delenv("FORCE_BENCHMARK_OVERWRITE", raising=False)
    paths = _paths(tmp_path)

    # Published, hand-curated comparisons covering p1..p2 (the source of truth).
    (paths['output'] / "benchmark-comparisons.json").write_text(json.dumps({"results": [
        _cmp_row("p1", "M1", P1_PUBLISHED),
        _cmp_row("p2", "M2", P2_PUBLISHED),
    ]}))
    # STALE, NON-empty result-records.json left by a prior build: a wrong p1 value,
    # NO p2, and a ghost paper not in the CSV. None of this must influence the baseline.
    (paths['chroma'] / "result-records.json").write_text(json.dumps({"records": [
        _rec("p1", "M1", P1_STALE),
        _rec("ghost", "Ghost", 1.0),
    ]}))

    _install_fake_run(monkeypatch, fresh_records=[_rec("p3", "M3", P3_FRESH)])
    ingest_domain.step_benchmark(paths, "motion_planning")

    merged = json.loads((paths['chroma'] / "result-records.json").read_text())["records"]
    by = {r["paper_id"]: r for r in merged}

    # p1, p2 preserved from the PUBLISHED comparisons (p2 existed ONLY there), p3 merged in.
    assert set(by) == {"p1", "p2", "p3"}
    assert by["p1"]["value"] == P1_PUBLISHED   # published wins, NOT the stale 11.1
    assert "ghost" not in by                    # stale-only content discarded
    assert by["p3"]["value"] == P3_FRESH        # fresh Docling record for the new paper


def test_reconstruction_is_idempotent_on_second_build(tmp_path, monkeypatch):
    """A second build (published comparisons now already include p3) yields the same
    paper set — the merge is a fixed point, no dependence on result-records emptiness."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("FORCE_BENCHMARK", "1")
    monkeypatch.delenv("FORCE_BENCHMARK_OVERWRITE", raising=False)
    paths = _paths(tmp_path)

    (paths['output'] / "benchmark-comparisons.json").write_text(json.dumps({"results": [
        _cmp_row("p1", "M1", P1_PUBLISHED),
        _cmp_row("p2", "M2", P2_PUBLISHED),
    ]}))
    (paths['chroma'] / "result-records.json").write_text(json.dumps({"records": [
        _rec("p1", "M1", P1_STALE),
    ]}))
    _install_fake_run(monkeypatch, fresh_records=[_rec("p3", "M3", P3_FRESH)])

    ingest_domain.step_benchmark(paths, "motion_planning")
    first = json.loads((paths['chroma'] / "result-records.json").read_text())["records"]
    first_by = {r["paper_id"]: r["value"] for r in first}

    ingest_domain.step_benchmark(paths, "motion_planning")   # re-run, no reset
    second = json.loads((paths['chroma'] / "result-records.json").read_text())["records"]
    second_by = {r["paper_id"]: r["value"] for r in second}

    assert first_by == {"p1": P1_PUBLISHED, "p2": P2_PUBLISHED, "p3": P3_FRESH}
    assert second_by == first_by   # idempotent: same set, same values on re-run
