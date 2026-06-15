"""ingest_domain.step_benchmark builds the Docling CLI + export, domain-agnostic — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. subprocess.run is monkeypatched, so nothing actually runs Docling.
"""
import sys
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]  # .../domain-explorer
sys.path.insert(0, str(REPO / 'scripts'))
import ingest_domain  # noqa: E402


class _R:
    returncode = 0
    stdout = ''
    stderr = ''


def _paths(tmp_path, slug="motion-planning"):
    dataset = tmp_path / "datasets" / slug
    dataset.mkdir(parents=True)
    (dataset / "motion_planning.csv").write_text("Name\nBIT*\nRRT*\n")
    papers = dataset / "papers"
    papers.mkdir()
    output = tmp_path / "out-data"
    output.mkdir()
    return {"dataset": dataset, "papers": papers, "output": output,
            "slug_dashed": slug, "chroma": tmp_path / "chroma"}


def test_step_benchmark_registered_in_all_steps():
    assert 'benchmark' in ingest_domain.ALL_STEPS


def test_step_benchmark_builds_docling_extract_then_export(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: (calls.append([str(x) for x in argv]) or _R()))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)  # -> --no-vlm
    paths = _paths(tmp_path)
    ingest_domain.step_benchmark(paths, "motion_planning")

    # 1) the Docling extraction call
    extract = next(c for c in calls if '--engine' in c)
    assert 'docling' in extract
    assert str(paths['papers']) in extract                     # --pdf-dir
    assert any('/data-motion-planning/crops' in x for x in extract)  # --crops-url (per-domain, NOT grasp)
    assert any(x.endswith('motion_planning.json') for x in extract)  # --config
    assert '--no-vlm' in extract                               # no API key -> Docling-only
    # 2) the export call -> benchmark-comparisons.json in the domain output dir
    export = next(c for c in calls if any('benchmark_data.py' in x for x in c))
    assert any('--from-records' in x for x in export)
    assert str(paths['output']) in export


def test_step_benchmark_skips_when_output_exists(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: (calls.append(argv) or _R()))
    monkeypatch.delenv("FORCE_BENCHMARK", raising=False)
    paths = _paths(tmp_path)
    (paths['output'] / "benchmark-comparisons.json").write_text("{}")
    ingest_domain.step_benchmark(paths, "motion_planning")
    assert calls == []  # already built + not forced -> no subprocess


def test_step_benchmark_uses_vlm_when_key_present(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: (calls.append([str(x) for x in argv]) or _R()))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    paths = _paths(tmp_path)
    ingest_domain.step_benchmark(paths, "motion_planning")
    extract = next(c for c in calls if '--engine' in c)
    assert '--no-vlm' not in extract  # key present -> VLM enabled
