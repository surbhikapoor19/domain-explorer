"""Tests for adapters.records_io — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

Reconstructs ResultRecords from a serialized result-records.json payload, ignoring any extra
keys (forward-compatible), so the extraction artifact can be re-loaded and aggregated.
"""
from benchmarks.adapters.records_io import load_records


def test_load_records_reconstructs_dataclass_and_ignores_extra_keys():
    payload = {"records": [{
        "paper_id": "anygrasp", "method_raw": "Ours", "method_id": "AnyGrasp",
        "metric_raw": "Success Rate", "metric_id": "success_rate", "unit": "%",
        "higher_is_better": True, "condition": "pile", "value": 86.9, "value_str": "86.9",
        "crop_image": "/data-grasp-planning/crops/anygrasp_t0.png", "page": 4,
        "extractor": "vlm", "verified": True, "SOME_FUTURE_KEY": "ignored"}]}
    recs = load_records(payload)
    assert len(recs) == 1
    r = recs[0]
    assert r.method_id == "AnyGrasp"
    assert r.metric_id == "success_rate"
    assert r.crop_image == "/data-grasp-planning/crops/anygrasp_t0.png"
    assert r.page == 4
    assert r.extractor == "vlm" and r.verified is True
    assert not hasattr(r, "SOME_FUTURE_KEY")  # unknown keys dropped, no crash


def test_load_records_handles_empty_payload():
    assert load_records({}) == []
    assert load_records({"records": []}) == []
