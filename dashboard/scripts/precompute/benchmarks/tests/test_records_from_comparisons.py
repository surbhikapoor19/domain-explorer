"""Acceptance M3 for adapters.records_io.records_from_comparisons — the seed that
reconstructs ResultRecords from a benchmark-comparisons.json ``results`` list so
the hand-curated vision build can seed the durable union WITHOUT re-extraction.

M3 (round-trip idempotency): reconstructed records fed back through
build_benchmark_json reproduce, for every vision paper_id, byte-identical
``results`` rows on 2nd+ runs. The grade inversion (verified = grade in {A,B};
extraction_conf = 'medium') makes build re-derive the same lone-row grade, and the
cross-validation join re-derives grade A for multi-report cells.

Uses a tiny hand-built 3-paper payload (rather than the full 2114 rows) to prove
the round-trip is a fixed point.
"""
import json
from benchmarks.adapters.records_io import records_from_comparisons
from benchmarks.aggregate.build_benchmarks import build_benchmark_json


CFG = {
    "metrics": [
        {"id": "success_rate", "type": "rate", "unit": "%",
         "higher_is_better": True, "aliases": []},
    ],
    "conditions": [],
    "consistency": {"min_papers_for_validation": 2},
}


def _row(paper_id, method, value, grade, condition="pile", metric_raw="Success Rate"):
    """One benchmark-comparisons.json ``results`` row (all keys the seed reads)."""
    return {
        "method": method, "method_resolved": True,
        "metric_id": "success_rate", "metric_label": "Success Rate (%)",
        "metric_raw": metric_raw, "value": value, "value_str": str(value),
        "unit": "%", "higher_is_better": True,
        "dataset_id": None, "dataset_raw": "", "condition": condition,
        "comparable": True, "grade": grade, "n_reports": 1, "corroboration": None,
        "is_own_method": False, "paper_id": paper_id, "table_caption": "",
        "page": 3, "extractor": "vlm", "crop_image": None, "section_label": "results",
    }


def _payload():
    # AnyGrasp: two papers agree on the SAME cell -> cross-validated grade A.
    # GPD:      a lone verified source -> grade B.
    # GPD-Weak: a lone unverified/weak source -> grade C.
    return {"results": [
        _row("papera", "AnyGrasp", 86.9, "A"),
        _row("paperb", "AnyGrasp", 87.1, "A"),
        _row("paperc", "GPD", 70.0, "B"),
        _row("paperc", "GPD-Weak", 55.0, "C", condition="packed"),
    ]}


def _round(payload):
    return build_benchmark_json(records_from_comparisons(payload), CFG)


def test_M3_round_trip_results_byte_identical_on_second_run():
    out1 = _round(_payload())          # run 1: seed -> build
    out2 = _round(out1)                # run 2: reconstruct from run-1 export -> build
    assert json.dumps(out1["results"], sort_keys=True) == \
           json.dumps(out2["results"], sort_keys=True)


def test_M3_every_vision_paper_id_reproduced_identically():
    out1 = _round(_payload())
    out2 = _round(out1)
    pids = {"papera", "paperb", "paperc"}
    assert {r["paper_id"] for r in out1["results"]} == pids
    for pid in pids:
        r1 = sorted((r for r in out1["results"] if r["paper_id"] == pid),
                    key=lambda x: (x["method"], x["metric_label"]))
        r2 = sorted((r for r in out2["results"] if r["paper_id"] == pid),
                    key=lambda x: (x["method"], x["metric_label"]))
        assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


def test_M3_grade_inversion_reproduces_A_B_C():
    """The reconstructed grades must match the source grades: cross-validated A,
    lone verified B, lone weak C — proving verified/conf inversion is faithful."""
    out = _round(_payload())
    by = {(r["method"], r["paper_id"]): r for r in out["results"]}
    assert by[("AnyGrasp", "papera")]["grade"] == "A"
    assert by[("AnyGrasp", "paperb")]["grade"] == "A"
    assert by[("AnyGrasp", "papera")]["n_reports"] == 2   # multi-report join
    assert by[("GPD", "paperc")]["grade"] == "B"          # lone verified
    assert by[("GPD-Weak", "paperc")]["grade"] == "C"     # lone weak


def test_grade_inversion_sets_verified_and_medium_conf():
    """Lone-row invariant: verified = grade in {A,B}; extraction_conf always
    'medium' (never 'low', which would force C); std_dev dropped to None."""
    recs = records_from_comparisons({"results": [
        _row("p", "M1", 90.0, "B"),
        _row("p", "M2", 40.0, "C"),
        _row("p", "M3", 95.0, "A"),
    ]})
    by = {r.method_id: r for r in recs}
    assert by["M1"].verified is True and by["M1"].extraction_conf == "medium"
    assert by["M2"].verified is False and by["M2"].extraction_conf == "medium"
    assert by["M3"].verified is True
    assert all(r.std_dev is None and r.is_ablation is False and r.bbox is None
               for r in recs)


def test_records_from_comparisons_empty_payload():
    assert records_from_comparisons({}) == []
    assert records_from_comparisons({"results": []}) == []
