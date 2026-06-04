from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.normalize.registries import load_config

CFG = load_config()

V4 = {
  "outperforms_both_csv": [
    {"winner_csv": "AnyGrasp", "loser_csv": "Grasp Pose Detection (GPD)",
     "metric": "Success Rate (%)", "winner_val": 86.9, "loser_val": 70.1,
     "margin": 16.8, "paper": "anygrasp"}
  ],
  "cross_paper": {
    "Grasp detection via Implicit Geometry and Affordance (GIGA)|pile": [
      {"paper": "edge-grasp-network", "value": 75.2, "raw": "75.2 ± 2.2"},
      {"paper": "grasp-detection-via-implicit-geometry-and-affordance-giga", "value": 86.9, "raw": "86.9 (73 / 84)"}
    ]
  }
}

def test_outperforms_pair_becomes_two_records_with_canonical_metric():
    recs = records_from_v4(V4, CFG)
    sr = [r for r in recs if r.metric_id == "success_rate"]
    assert len(sr) >= 2
    assert {r.method_id for r in sr} >= {"AnyGrasp", "Grasp Pose Detection (GPD)"}
    assert all(r.unit == "%" and r.higher_is_better is True for r in sr)

def test_pile_is_recognized_as_condition_not_metric():
    recs = records_from_v4(V4, CFG)
    giga = [r for r in recs if r.method_id and "GIGA" in r.method_id]
    assert giga, "GIGA records present"
    assert all(r.condition == "pile" for r in giga)
    assert all(r.metric_id != "pile" for r in giga)
