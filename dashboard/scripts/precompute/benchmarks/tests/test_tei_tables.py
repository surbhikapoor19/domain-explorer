"""Tests for extraction.tei_tables — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

Born-digital TEI rows -> ResultRecords. Must (a) carry full PROVENANCE (exact cell text,
table caption, section) for the proof feature, and (b) work for a NON-grasp domain (motion
planning, lower-is-better metric) so the parser is not grasp-overfit.
"""
import os
from benchmarks.extraction.tei_tables import records_from_tei_rows
from benchmarks.extraction.locate import TableLocation
from benchmarks.normalize.registries import load_config, MethodResolver

CFG_DIR = os.path.join(os.path.dirname(__file__), '..', 'config')
GRASP = load_config(os.path.join(CFG_DIR, 'grasp_planning.json'))
MOTION = load_config(os.path.join(CFG_DIR, 'motion_planning.json'))


def _grasp_loc():
    return TableLocation(
        paper_id="anygrasp", table_index=0,
        caption="Table 2: Success rate on pile scenes (%)",
        section_label="Quantitative Comparisons", is_results_section=True,
        is_ablation_section=False, has_rows=True,
        rows=[["Method", "Success Rate"], ["Ours", "86.9"], ["GPD", "70.1"], ["w/o refine", "60.0"]])


def test_grasp_records_carry_canonical_ids_and_full_provenance():
    resolver = MethodResolver(["AnyGrasp", "Grasp Pose Detection (GPD)"],
                              alias_seeds={"gpd": "Grasp Pose Detection (GPD)", "ours": "AnyGrasp"})
    recs = records_from_tei_rows(_grasp_loc(), GRASP, resolver)
    by = {r.method_id: r for r in recs if r.method_id}
    assert by["AnyGrasp"].metric_id == "success_rate"
    assert by["AnyGrasp"].is_own_method is True
    assert by["AnyGrasp"].condition == "pile"               # inferred from caption
    assert by["AnyGrasp"].value == 86.9
    # PROVENANCE for the proof / view-source feature:
    assert by["AnyGrasp"].value_str == "86.9"               # exact printed cell text
    assert "Table 2" in by["AnyGrasp"].table_caption
    assert by["AnyGrasp"].section_label == "Quantitative Comparisons"
    assert by["AnyGrasp"].extractor == "tei_table"


def test_ablation_rows_flagged_not_dropped():
    resolver = MethodResolver(["AnyGrasp"], alias_seeds={"ours": "AnyGrasp"})
    recs = records_from_tei_rows(_grasp_loc(), GRASP, resolver)
    abl = [r for r in recs if r.is_ablation]
    assert abl, "ablation row is kept (flagged), not silently dropped"
    assert abl[0].metric_id == "success_rate"


def test_motion_table_parses_under_motion_config_lower_is_better():
    # motion-planning results table; NO grasp vocabulary; metric is lower-is-better
    loc = TableLocation(
        paper_id="bitstar", table_index=0,
        caption="Table 1: Planning time (s) in narrow passage",
        section_label="Experiments", is_results_section=True,
        is_ablation_section=False, has_rows=True,
        rows=[["Planner", "Planning Time"], ["Ours", "1.2"], ["RRT*", "4.5"]])
    resolver = MethodResolver(["BIT*", "RRT*"], alias_seeds={"ours": "BIT*"})
    recs = records_from_tei_rows(loc, MOTION, resolver)
    by = {r.method_id: r for r in recs if r.method_id}
    assert by["BIT*"].metric_id == "planning_time"
    assert by["BIT*"].higher_is_better is False
    assert by["BIT*"].condition == "narrow_passage"
    assert by["BIT*"].value == 1.2
    assert by["BIT*"].extractor == "tei_table"
