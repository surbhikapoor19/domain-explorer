from benchmarks.normalize.registries import (
    load_config, MetricRegistry, ConditionRegistry, MethodResolver)

CFG = load_config()

def test_metric_canonicalizes_aliases():
    reg = MetricRegistry(CFG)
    assert reg.resolve("GSR (%)").id == "success_rate"
    assert reg.resolve("grasp success rate").id == "success_rate"
    assert reg.resolve("DR (%)").id == "declutter_rate"

def test_metric_carries_unit_and_direction():
    reg = MetricRegistry(CFG)
    m = reg.resolve("Latency (ms)")
    assert m.id == "latency" and m.higher_is_better is False and m.type == "time"

def test_metric_unknown_returns_none_id():
    reg = MetricRegistry(CFG)
    assert reg.resolve("Col_2").id is None
    assert reg.resolve("Box Cylinder Bowl Mug Average Success Rate").id == "success_rate"

def test_condition_detection():
    cond = ConditionRegistry(CFG)
    assert cond.resolve("pile") == "pile"
    assert cond.resolve("Packed Scene") == "packed"
    assert cond.resolve("random clutter") is None

def test_method_resolver_scores_confidence():
    methods = ["AnyGrasp", "Grasp Pose Detection (GPD)"]
    r = MethodResolver(methods, alias_seeds={"gpd": "Grasp Pose Detection (GPD)"})
    hit = r.resolve("GPD")
    assert hit.method_id == "Grasp Pose Detection (GPD)" and hit.confidence == "high"
    miss = r.resolve("SomeUnknownBaseline")
    assert miss.method_id is None and miss.confidence == "low"


def test_timing_metrics_routed_distinctly_not_pooled_as_latency():
    """Different timing semantics must resolve to different metrics so they don't
    pool into one leaderboard (the 6-DoF GraspNet sampling-vs-latency bug)."""
    reg = MetricRegistry(CFG)
    assert reg.resolve("Sampling time (ms)").id == "sampling_time"
    assert reg.resolve("Total Time").id == "total_time"
    assert reg.resolve("Latency (ms)").id == "latency"
    # a generic bare "Time" column still falls back to latency
    assert reg.resolve("Time").id == "latency"


def test_completion_rate_is_its_own_metric_not_success_rate():
    """Scene-completion is a different measurement than grasp-success; must not pool."""
    reg = MetricRegistry(CFG)
    assert reg.resolve("Completion Rate").id == "completion_rate"
    assert reg.resolve("Success Rate").id == "success_rate"
    assert reg.resolve("GSR (%)").id == "success_rate"
