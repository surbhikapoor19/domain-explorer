"""Copilot query→leaderboard keyword derivation — AUTHORED BY ORCHESTRATOR.

build_benchmarks.py derives benchmarkData.copilot.{metric,condition}_keywords from
the domain's benchmark-config aliases + direction, so the frontend copilot routes
natural-language ranking queries to the right metric/condition for ANY domain with
no hand-authored per-domain keyword list."""
from benchmarks.aggregate.build_benchmarks import _copilot_keywords, build_benchmark_json
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4

MOTION_CFG = {
    "metrics": [
        {"id": "success_rate", "unit": "%", "higher_is_better": True, "type": "rate",
         "aliases": ["success rate", "solve rate", "sr"]},
        {"id": "planning_time", "unit": "s", "higher_is_better": False, "type": "time",
         "aliases": ["planning time", "computation time", "runtime"]},
        {"id": "path_length", "unit": "m", "higher_is_better": False, "type": "count",
         "aliases": ["path length", "trajectory length"]},
    ],
    "conditions": [
        {"id": "narrow_passage", "aliases": ["narrow passage", "narrow", "bug trap"]},
        {"id": "cluttered", "aliases": ["cluttered", "clutter"]},
    ],
}


def test_metric_keywords_include_aliases_and_direction():
    mk = _copilot_keywords(MOTION_CFG)['metric_keywords']
    # config aliases are preserved verbatim (lower-cased)
    assert 'success rate' in mk['success_rate']
    assert 'planning time' in mk['planning_time']
    # directional generics keyed off higher_is_better
    assert 'highest' in mk['success_rate'] and 'best' in mk['success_rate']
    assert 'fastest' in mk['planning_time'] and 'shortest' in mk['planning_time']
    assert 'fastest' not in mk['success_rate']     # success_rate is higher-is-better
    # primary (first higher-is-better rate) gets generic quality words
    assert 'performance' in mk['success_rate']
    assert 'performance' not in mk['planning_time']
    # no grasp-specific leakage into a motion config
    assert 'gsr' not in mk['success_rate']
    assert 'declutter' not in str(mk)


def test_directional_generics_attach_to_one_metric_per_direction():
    """No two same-direction metrics may both carry a bare directional word, else
    "fastest"/"best" ties and routes by arbitrary config order."""
    mk = _copilot_keywords(MOTION_CFG)['metric_keywords']
    # planning_time is the primary (time) cost metric → owns 'fastest'/'shortest'.
    # path_length is also lower-is-better but NOT primary → must NOT carry them.
    assert 'fastest' in mk['planning_time']
    assert 'fastest' not in mk['path_length']
    assert 'shortest' not in mk['path_length']
    # path_length still resolves via its own literal alias
    assert 'path length' in mk['path_length']
    # exactly one metric carries each bare directional word
    assert sum('fastest' in v for v in mk.values()) == 1
    assert sum('best' in v for v in mk.values()) == 1


def test_condition_keywords_from_aliases():
    ck = _copilot_keywords(MOTION_CFG)['condition_keywords']
    assert 'narrow passage' in ck['narrow_passage']
    assert 'cluttered' in ck['cluttered']
    assert set(ck.keys()) == {'narrow_passage', 'cluttered'}


def test_empty_config_is_safe():
    out = _copilot_keywords({})
    assert out == {'metric_keywords': {}, 'condition_keywords': {}}


def test_build_benchmark_json_emits_copilot_block():
    cfg = load_config()   # grasp default config
    records = records_from_v4({
        "outperforms_both_csv": [
            {"winner_csv": "AnyGrasp", "loser_csv": "GPD", "metric": "Success Rate (%)",
             "winner_val": 86.9, "loser_val": 70.1, "margin": 16.8, "paper": "anygrasp"}],
        "cross_paper": {}}, cfg)
    out = build_benchmark_json(records, cfg)
    assert 'copilot' in out
    assert 'metric_keywords' in out['copilot'] and 'condition_keywords' in out['copilot']
    assert 'success_rate' in out['copilot']['metric_keywords']
    # derived from grasp config aliases, so grasp synonyms ARE present here
    assert any('gsr' in kw or 'grasp success' in kw
               for kw in out['copilot']['metric_keywords']['success_rate'])
