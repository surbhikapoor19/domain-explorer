"""result-records.json -> benchmark-comparisons.json export (function + CLI) — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. The build's step_benchmark subprocesses benchmark_data.py --from-records,
so a CLI mode for export_from_records must exist alongside the existing v4 --extraction-results mode.
"""
import os
import sys
import json
import subprocess

PRE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))  # .../precompute


def _records():
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%", higher_is_better=True,
                condition="pile", dataset_raw="", dataset_id=None, std_dev=None, is_ablation=False,
                extractor="docling", table_caption="Table 2", section_label="Experiments",
                page=4, bbox=None, crop_image="/data-x/crops/p_t0.png",
                extraction_conf="high", verified=True)
    return [
        {**base, "paper_id": "anygrasp", "method_raw": "Ours", "method_id": "AnyGrasp",
         "value": 86.9, "value_str": "86.9", "is_own_method": True},
        {**base, "paper_id": "anygrasp", "method_raw": "GPD",
         "method_id": "Grasp Pose Detection (GPD)", "value": 70.1, "value_str": "70.1",
         "is_own_method": False},
    ]


def test_export_from_records_function_writes_expected_keys(tmp_path):
    sys.path.insert(0, os.path.join(PRE, 'graph'))
    import benchmark_data
    rr = tmp_path / "result-records.json"
    rr.write_text(json.dumps({"records": _records(), "stats": {}}))
    benchmark_data.export_from_records(str(rr), str(tmp_path))
    out = json.loads((tmp_path / "benchmark-comparisons.json").read_text())
    for k in ("leaderboards", "cross_validations", "comparisons", "method_index", "quarantine", "stats"):
        assert k in out
    assert out["comparisons"] and out["comparisons"][0]["winner"] == "AnyGrasp"


def test_benchmark_data_cli_from_records(tmp_path):
    rr = tmp_path / "result-records.json"
    rr.write_text(json.dumps({"records": _records(), "stats": {}}))
    r = subprocess.run(
        [sys.executable, "graph/benchmark_data.py", "--from-records", str(rr),
         "--output-dir", str(tmp_path)],
        cwd=PRE, capture_output=True, text=True)
    assert r.returncode == 0, f"stdout={r.stdout}\nstderr={r.stderr}"
    assert (tmp_path / "benchmark-comparisons.json").exists()


def test_export_refuses_to_overwrite_nonempty_with_empty(tmp_path):
    """HAZARD GUARD: a failed/empty extraction must NOT clobber good existing data."""
    sys.path.insert(0, os.path.join(PRE, 'graph'))
    import benchmark_data
    out_path = tmp_path / "benchmark-comparisons.json"
    # pre-existing GOOD data
    good = {"stats": {"n_comparisons": 488, "n_leaderboards": 9}, "leaderboards": {"x": 1}}
    out_path.write_text(json.dumps(good))
    # an EMPTY build (no records -> 0 comparisons/leaderboards)
    rr = tmp_path / "empty-records.json"
    rr.write_text(json.dumps({"records": [], "stats": {}}))
    benchmark_data.export_from_records(str(rr), str(tmp_path))
    # the good data must survive untouched
    after = json.loads(out_path.read_text())
    assert after["stats"]["n_comparisons"] == 488, "empty build must not overwrite good data"


def test_export_writes_empty_when_no_existing_file(tmp_path):
    """With nothing to protect, an empty build still writes (so first runs work)."""
    sys.path.insert(0, os.path.join(PRE, 'graph'))
    import benchmark_data
    rr = tmp_path / "empty-records.json"
    rr.write_text(json.dumps({"records": [], "stats": {}}))
    benchmark_data.export_from_records(str(rr), str(tmp_path))
    assert (tmp_path / "benchmark-comparisons.json").exists()
