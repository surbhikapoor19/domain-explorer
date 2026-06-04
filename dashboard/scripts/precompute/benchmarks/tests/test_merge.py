"""Tests for extraction.merge — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify."""
from benchmarks.extraction.merge import merge_records
from benchmarks.types import ResultRecord


def _r(method, value, extractor, verified, condition="pile", metric="success_rate"):
    return ResultRecord(paper_id="p", method_raw=method, method_id=method,
                        metric_raw=metric, metric_id=metric, unit="%", higher_is_better=True,
                        condition=condition, value=value, value_str=str(value),
                        extractor=extractor, verified=verified)


def test_unions_distinct_records():
    out = merge_records([_r("AnyGrasp", 86.9, "tei_table", True)],
                        [_r("GPD", 70.1, "vlm", True)])
    assert {(r.method_id, r.value) for r in out} == {("AnyGrasp", 86.9), ("GPD", 70.1)}


def test_dedups_identical_and_prefers_tei_over_vlm():
    out = merge_records([_r("AnyGrasp", 86.9, "tei_table", True)],
                        [_r("AnyGrasp", 86.9, "vlm", True)])
    any_recs = [r for r in out if r.method_id == "AnyGrasp"]
    assert len(any_recs) == 1
    assert any_recs[0].extractor == "tei_table"  # born-digital preferred when both verified


def test_prefers_verified_over_unverified():
    out = merge_records([], [_r("X", 50.0, "vlm", False), _r("X", 50.0, "vlm", True)])
    xs = [r for r in out if r.method_id == "X"]
    assert len(xs) == 1 and xs[0].verified is True


def test_same_method_different_condition_not_deduped():
    out = merge_records([_r("A", 80.0, "tei_table", True, condition="pile")],
                        [_r("A", 80.0, "vlm", True, condition="packed")])
    assert len(out) == 2  # different experimental conditions are distinct, not duplicates
