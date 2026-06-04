"""Tests for extraction.vlm_extract — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

The VLM client is injected, so these run fully offline (no API calls). The found-in-crop
verification guardrail is the key safety property: a value that does not literally appear in
the table crop must be marked unverified / low-confidence (hallucination rejection).
"""
import json
from benchmarks.extraction.vlm_extract import parse_vlm_rows, verify_records
from benchmarks.extraction.locate import TableLocation
from benchmarks.normalize.registries import load_config, MethodResolver

CFG = load_config()
RES = MethodResolver(["AnyGrasp", "Grasp Pose Detection (GPD)"],
                     alias_seeds={"gpd": "Grasp Pose Detection (GPD)"})


def _loc():
    return TableLocation("anygrasp", 0, "Table 3: Success rate (%)", "Experiments",
                         True, False, has_rows=False, rows=[])


FAKE = json.dumps({"rows": [
    {"method": "AnyGrasp", "metric": "Success Rate", "condition": "pile",
     "value": 86.9, "value_str": "86.9", "is_own": True},
    {"method": "GPD", "metric": "Success Rate", "condition": "pile",
     "value": 70.1, "value_str": "70.1", "is_own": False}]})


def test_parse_vlm_rows_into_records():
    recs = parse_vlm_rows(FAKE, _loc(), CFG, RES)
    assert len(recs) == 2
    a = next(r for r in recs if r.method_id == "AnyGrasp")
    assert a.metric_id == "success_rate"
    assert a.extractor == "vlm"
    assert a.value == 86.9
    assert a.is_own_method is True
    assert a.condition == "pile"
    assert a.verified is False  # not verified until found-in-crop passes


def test_verification_rejects_hallucinated_value():
    recs = parse_vlm_rows(FAKE, _loc(), CFG, RES)
    recs[0].value_str = "999.9"  # inject a value NOT present in the crop
    verified = verify_records(recs, crop_text="Method Success Rate AnyGrasp 86.9 GPD 70.1")
    bad = next(r for r in verified if r.value_str == "999.9")
    good = next(r for r in verified if r.value_str == "70.1")
    assert bad.verified is False and bad.extraction_conf == "low"
    assert good.verified is True and good.extraction_conf == "high"
