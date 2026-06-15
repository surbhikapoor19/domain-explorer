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


def test_collapsing_subcolumns_disambiguated_by_leaf_label():
    """A 'Time Efficiency' super-header over Forward-passing/Processing/Total Time:
    all three leaf columns resolve to the SAME metric (`latency`) with no condition,
    so they would collapse into one bucket (n=3, meaningless CV). The parser must
    keep them distinct by disambiguating on the leaf label."""
    loc = TableLocation(
        paper_id="regnet", table_index=0, caption="Table I: Results",
        section_label="Experiments", is_results_section=True, is_ablation_section=False,
        has_rows=True,
        rows=[
            ["", "Time Efficiency", "Time Efficiency", "Time Efficiency"],
            ["Method", "Forward-passing Time", "Processing Time", "Total Time"],
            ["S4G", "22.23", "824.20", "846.43"],
        ])
    resolver = MethodResolver(["Single-Shot SE(3) Grasp Detection (S4G)"],
                              alias_seeds={"s4g": "Single-Shot SE(3) Grasp Detection (S4G)"})
    recs = [r for r in records_from_tei_rows(loc, GRASP, resolver) if r.metric_id == "latency"]
    assert len(recs) == 3, "all three time columns parsed"
    conds = {r.condition for r in recs}
    assert len(conds) == 3, f"3 distinct time columns must stay distinct, got conditions={conds}"
    # raw labels preserved per column (provenance: which column each value came from)
    raws = {r.metric_raw for r in recs}
    assert len(raws) == 3
    # the values land on the right columns (no cross-contamination)
    by_val = {r.value: r.condition for r in recs}
    assert set(by_val) == {22.23, 824.20, 846.43}


def test_distinct_metrics_not_spuriously_disambiguated():
    """Two columns that resolve to DIFFERENT metrics must NOT be touched by the
    disambiguator — only same-(metric,condition) collisions get split."""
    loc = TableLocation(
        paper_id="anygrasp", table_index=0,
        caption="Table 2: Pile scenes", section_label="Experiments",
        is_results_section=True, is_ablation_section=False, has_rows=True,
        rows=[["Method", "Success Rate", "Declutter Rate"],
              ["Ours", "86.9", "90.1"], ["GPD", "70.1", "75.0"]])
    resolver = MethodResolver(["AnyGrasp", "Grasp Pose Detection (GPD)"],
                              alias_seeds={"gpd": "Grasp Pose Detection (GPD)", "ours": "AnyGrasp"})
    recs = records_from_tei_rows(loc, GRASP, resolver)
    own = [r for r in recs if r.method_id == "AnyGrasp"]
    # different metrics, condition stays the caption-inferred 'pile' (NOT disambiguated)
    assert {r.metric_id for r in own} == {"success_rate", "declutter_rate"}
    assert all(r.condition == "pile" for r in own), [r.condition for r in own]
