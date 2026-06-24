# AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
#
# Pins build_cell_context: the precompute that joins each benchmark cell to its
# methods' attributes (methods.json) and its papers' KG relations (citation
# stance, technique-lineage, outperforms). Honesty invariants pinned here:
#   - method-name join is normalized (emoji-prefixed names still join); a miss
#     yields "not reported" on every field (never guessed);
#   - STATED outperforms (KG) carry evidence text but NO fabricated confidence;
#   - PREDICTED outperforms (HGT) are kept as data but tagged kind='predicted'
#     (the JS consumers gate them off — the copilot/drawer must never surface them).

from benchmarks.aggregate.cell_context import build_cell_context


# ── In-memory fixtures ───────────────────────────────────────────────────────
# A 3-method cell. Two papers (graspqp, vgn) carry KG relations; a third method
# (MysteryNet) is absent from methods.json to test the "not reported" miss path.
BENCHMARK = {
    "leaderboards": {
        "success_rate||packed": {
            "metric_id": "success_rate",
            "metric_label": "Success Rate (%)",
            "condition": "packed",
            "higher_is_better": True,
            "entries": [
                {"method": "\U0001F916 GraspQP", "value": 80.0, "source_papers": ["graspqp"]},
                {"method": "VGN", "value": 76.0, "source_papers": ["vgn"]},
                {"method": "MysteryNet", "value": 70.0, "source_papers": ["mystery"]},
            ],
        }
    },
    "cross_validations": [],
    "comparisons": [],
}

KG = {
    "nodes": [
        {"id": "paper:graspqp", "paper_id": "graspqp"},
        {"id": "paper:vgn", "paper_id": "vgn"},
        {"id": "tech:backbone:PointNet", "label": "PointNet", "type": "technique"},
    ],
    "links": [
        {"type": "cites", "source": "paper:graspqp", "target": "paper:vgn", "sentiment": "differs_from"},
        {"type": "cites", "source": "paper:vgn", "target": "paper:graspqp", "sentiment": "builds_on"},
        {"type": "uses_backbone", "source": "paper:graspqp", "target": "tech:backbone:PointNet"},
        {"type": "uses_backbone", "source": "paper:vgn", "target": "tech:backbone:PointNet"},
        {"type": "outperforms", "source": "paper:graspqp", "target": "paper:vgn",
         "evidence": "GraspQP reduces failure on packed clutter vs VGN"},
    ],
}

# HGT predictions (kg-predictions.json shape): outperforms WITH confidence.
PREDICTIONS = {
    "links": [
        {"type": "outperforms", "source": "paper:graspqp", "target": "paper:vgn",
         "confidence": 0.58, "semantic_relevance": 0.92, "inferred": True},
    ],
}

# methods.json: GraspQP is stored WITHOUT the emoji (the ~16% divergence) — the
# join must still land via normalization. MysteryNet is intentionally absent.
METHODS = [
    {"Name": "GraspQP", "Gripper Type": "Multi-finger", "End-effector Hardware": "Multi-finger",
     "Input Data": "Point cloud", "Backbone": "PointNet++", "Learning Paradigm": "Learning-based"},
    {"Name": "VGN", "Gripper Type": "Parallel-jaw", "End-effector Hardware": "Two-finger",
     "Input Data": "TSDF", "Backbone": "UNet", "Learning Paradigm": "Classical"},
]


def _ctx():
    return build_cell_context(BENCHMARK, KG, PREDICTIONS, METHODS)["success_rate||packed"]


def test_method_attributes_join_is_normalized_and_source_tagged():
    ctx = _ctx()
    g = ctx["method_attributes"]["\U0001F916 GraspQP"]["gripper"]
    assert g == {"value": "Multi-finger", "source": "method-typical (KG/CSV)"}
    assert ctx["method_attributes"]["\U0001F916 GraspQP"]["backbone"]["value"] == "PointNet++"


def test_unmatched_method_is_not_reported_never_guessed():
    ctx = _ctx()
    m = ctx["method_attributes"]["MysteryNet"]
    for field in ("gripper", "end_effector", "sensor", "backbone", "learning_paradigm"):
        assert m[field] == {"value": "not reported", "source": "not reported"}


def test_citation_stance_read_from_sentiment():
    ctx = _ctx()
    stances = {c["stance"] for c in ctx["relations"]["citations"]}
    assert "differs_from" in stances


def test_technique_lineage_shared_backbone_and_builds_on():
    ctx = _ctx()
    lineage = ctx["relations"]["technique_lineage"]
    assert "PointNet" in lineage["shared_backbones"]
    assert len(lineage["builds_on_pairs"]) >= 1


def test_outperforms_stated_has_no_fabricated_confidence():
    ctx = _ctx()
    stated = [o for o in ctx["relations"]["outperforms"] if o["kind"] == "stated"]
    assert len(stated) >= 1
    assert "evidence" in stated[0]
    assert "confidence" not in stated[0]  # GUARD: never fabricate a strength number


def test_outperforms_predicted_is_kept_as_gated_data_with_confidence():
    ctx = _ctx()
    predicted = [o for o in ctx["relations"]["outperforms"] if o["kind"] == "predicted"]
    assert len(predicted) >= 1
    assert "confidence" in predicted[0]


def test_differences_flag_a_differing_axis():
    ctx = _ctx()
    gripper = [d for d in ctx["differences"] if d["axis"] == "gripper"]
    assert gripper and gripper[0]["differ"] is True  # Multi-finger vs Parallel-jaw
