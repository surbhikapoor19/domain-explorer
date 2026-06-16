"""Regression tests for two build_benchmarks.py bugs — AUTHORED BY ORCHESTRATOR.

BUG 1 (copilot routing): the grasp benchmark-comparisons.json carried NO copilot
block, so the frontend copilot only routed grasp queries by luck of grasp being the
origin domain. build_benchmark_json must ALWAYS emit a non-empty
copilot.metric_keywords for a grasp-like config, exactly as it does for other domains.

BUG 2 (grade-A tally): stats.n_grade_a reported 0 while there were really 13 grade-A
entries. The tally counted grade-A COMPARISONS, but comparisons are single-paper
pairwise wins (evidence_grade(n_papers=1)) and can never reach grade A — grade A
requires 2+ consistent papers. The multi-paper surface where grade A is meaningful is
cross_validations, so stats.n_grade_a must equal the grade-A cross_validations count.
"""
from benchmarks.aggregate.build_benchmarks import build_benchmark_json
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.types import ResultRecord

GRASP_CFG = load_config()  # the grasp default benchmark config


# ---------------------------------------------------------------------------
# BUG 1 — copilot block is emitted for a grasp-like (origin-domain) config
# ---------------------------------------------------------------------------
def test_build_emits_nonempty_copilot_metric_keywords_for_grasp_config():
    """The copilot block must NOT depend on grasp being the origin domain. A real
    grasp build (records derived from the grasp config) must carry a non-empty
    copilot.metric_keywords map keyed by the config's own metric ids."""
    records = records_from_v4({
        "outperforms_both_csv": [
            {"winner_csv": "AnyGrasp", "loser_csv": "GPD", "metric": "Success Rate (%)",
             "winner_val": 86.9, "loser_val": 70.1, "margin": 16.8, "paper": "anygrasp"}],
        "cross_paper": {}}, GRASP_CFG)
    out = build_benchmark_json(records, GRASP_CFG)

    assert 'copilot' in out, "build output must always carry a copilot block"
    mk = out['copilot']['metric_keywords']
    ck = out['copilot']['condition_keywords']
    assert mk, "copilot.metric_keywords must be non-empty for a grasp-like config"
    # keyed by the config's own metric ids (e.g. success_rate), not hand-authored
    assert 'success_rate' in mk, "metric_keywords keyed by the config's metric ids"
    assert mk['success_rate'], "the success-rate keyword list is non-empty"
    # condition routing is emitted too, so 'pile'/'packed' queries resolve
    assert ck, "copilot.condition_keywords must be non-empty for a grasp-like config"


# ---------------------------------------------------------------------------
# BUG 2 — n_grade_a equals the REAL number of grade-A entries on a fixture
# ---------------------------------------------------------------------------
def _grade_a_fixture():
    """Two papers that closely agree (consistent), both verified, high extraction
    confidence -> a genuine grade-A cross-validation for method M. A second method N
    so leaderboard buckets are emitted. Comparisons here are single-paper pairwise
    wins, so NONE of them is grade A — proving the tally must read cross_validations.
    """
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%",
                higher_is_better=True, condition="pile", extractor="tei_table",
                extraction_conf="high", verified=True)
    return [
        ResultRecord(paper_id="p1", method_raw="M", method_id="M",
                     value=90.0, value_str="90", is_own_method=True, **base),
        ResultRecord(paper_id="p2", method_raw="M", method_id="M",
                     value=91.0, value_str="91", **base),
        ResultRecord(paper_id="p1", method_raw="N", method_id="N",
                     value=70.0, value_str="70", **base),
    ]


def test_n_grade_a_counts_real_grade_a_entries_not_zero():
    out = build_benchmark_json(_grade_a_fixture(), GRASP_CFG)

    real_grade_a = sum(1 for v in out['cross_validations'] if v['grade'] == 'A')
    assert real_grade_a >= 1, "fixture must produce at least one genuine grade-A cross-validation"
    # the bug: this used to be 0 because it counted single-paper comparisons.
    assert out['stats']['n_grade_a'] == real_grade_a, (
        f"stats.n_grade_a ({out['stats']['n_grade_a']}) must equal the real "
        f"grade-A cross-validation count ({real_grade_a})")
    # and the structural reason it was 0: comparisons are never grade A
    assert all(c['grade'] != 'A' for c in out['comparisons']), \
        "single-paper comparisons can never be grade A (would always tally 0)"
