"""Acceptance tests for the 2026-07 resolver/metric cleanup on the vision build.

Two defect classes surfaced by the heavy audit (41 papers / 83 tables):
  1. MethodResolver fuzzy-contains lets a short cell fragment STEAL a longer
     method's identity — e.g. cell "REG" was crowned as "REGNet". A fragment
     must never win; only substantial containment may.
  2. ~44% of metric cells were unresolved because the registry lacked aliases
     (Success / Suc. Rate / mAP) and whole metrics (IoU, Accuracy, UGR, FPS,
     Kept-ratio, Attempts, Penetration, Antipodal, epsilon-quality).

These are the fixed spec. Do not edit them to make code pass; fix the code.
"""
from benchmarks.normalize.registries import (
    load_config, MetricRegistry, ConditionRegistry, MethodResolver)

CFG = load_config()

# --- corpus fixture: real names that trigger the misattribution risk ---
CORPUS = [
    "REgion-based Grasp Network (REGNet)",
    "PointNetGPD",
    "Grasp Pose Detection (GPD)",
    "S4G",
    "AnyGrasp",
    "NeuGraspNet",
]
ALIASES = {"gpd": "Grasp Pose Detection (GPD)", "regnet": "REgion-based Grasp Network (REGNet)"}


# ===================== resolver conservatism =====================

def test_short_fragment_never_steals_a_longer_method():
    """'REG' (a fragment of 'REGNet') must resolve to nothing, not crown REGNet.
    This is the exact misattribution the audit caught in dex-net-2-0-gq-cnn."""
    r = MethodResolver(CORPUS, alias_seeds=ALIASES)
    hit = r.resolve("REG")
    assert hit.method_id is None and hit.confidence == "low", (
        f"'REG' wrongly resolved to {hit.method_id}")


def test_partial_fragment_below_coverage_threshold_is_rejected():
    """'Point' covers <70% of 'PointNetGPD' — a fragment, must not resolve."""
    r = MethodResolver(CORPUS, alias_seeds=ALIASES)
    assert r.resolve("Point").method_id is None
    assert r.resolve("Grasp").method_id is None  # fragment of many names


def test_legit_short_exact_names_still_resolve_high():
    """Conservatism must not break exact/alias hits for short real names."""
    r = MethodResolver(CORPUS, alias_seeds=ALIASES)
    assert r.resolve("GPD").method_id == "Grasp Pose Detection (GPD)"
    assert r.resolve("S4G").method_id == "S4G"
    assert r.resolve("AnyGrasp").method_id == "AnyGrasp"
    # explicit alias still wins
    assert r.resolve("REGNet").method_id == "REgion-based Grasp Network (REGNet)"


def test_full_name_inside_longer_cell_still_matches_medium():
    """A method name fully contained in a descriptive cell is a legitimate
    medium match and must be preserved (not thrown out by conservatism)."""
    r = MethodResolver(CORPUS, alias_seeds=ALIASES)
    hit = r.resolve("NeuGraspNet (ours)")
    assert hit.method_id == "NeuGraspNet"


# ===================== metric alias / new-metric expansion =====================

def test_success_family_resolves_to_success_rate():
    reg = MetricRegistry(CFG)
    for s in ["Success", "Suc. Rate", "Success (%)", "Grasping success",
              "Manipulation success", "Execution Success", "Place Execution Success"]:
        assert reg.resolve(s).id == "success_rate", f"{s!r} did not resolve to success_rate"


def test_map_variants_resolve_to_average_precision():
    reg = MetricRegistry(CFG)
    for s in ["mAP Classes", "mAP Instances", "mAP Tasks"]:
        assert reg.resolve(s).id == "average_precision", f"{s!r} unresolved"


def test_new_metrics_are_defined_and_resolve():
    reg = MetricRegistry(CFG)
    cases = {
        "IoU": "iou",
        "IoU (%)": "iou",
        "Accuracy": "accuracy",
        "IW Accuracy (%)": "accuracy",
        "Pose Accuracy": "accuracy",
        "Speed (FPS)": "speed_fps",
        "Overall UGR": "ugr",
        "Allegro UGR": "ugr",
        "Kept ratio (table-picking)": "kept_ratio",
        "Number of Attempts": "num_attempts",
        "Max Penetration Depth (cm)": "penetration_depth",
        "Antipodal Score": "antipodal_score",
    }
    for raw, expect in cases.items():
        assert reg.resolve(raw).id == expect, f"{raw!r} -> {reg.resolve(raw).id}, expected {expect}"


def test_new_rate_metrics_carry_direction_and_unit():
    reg = MetricRegistry(CFG)
    assert reg.resolve("IoU").higher_is_better is True
    assert reg.resolve("Accuracy").higher_is_better is True
    # fewer attempts / less penetration is better
    assert reg.resolve("Number of Attempts").higher_is_better is False
    assert reg.resolve("Max Penetration Depth (cm)").higher_is_better is False


def test_existing_metric_resolution_not_regressed():
    """Adding aliases must not cannibalize the metrics that already worked."""
    reg = MetricRegistry(CFG)
    assert reg.resolve("Success Rate").id == "success_rate"
    assert reg.resolve("GSR (%)").id == "success_rate"
    assert reg.resolve("Completion Rate").id == "completion_rate"
    assert reg.resolve("Declutter Rate").id == "declutter_rate"
    assert reg.resolve("Latency (ms)").id == "latency"
    assert reg.resolve("Sampling time (ms)").id == "sampling_time"


def test_explicit_unit_token_overrides_metric_default():
    """A timing metric printed in seconds must not be silently tagged 'ms'
    (the dex-net latency unit mislabel). Explicit unit tokens in the raw
    string win over the metric's default unit."""
    reg = MetricRegistry(CFG)
    assert reg.resolve("Planning Time (s)").unit in ("s", "sec")
    assert reg.resolve("Inference Time (ms)").unit == "ms"
