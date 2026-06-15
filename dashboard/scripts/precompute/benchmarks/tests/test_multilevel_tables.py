"""Multi-level header parsing -> per-cell (condition, metric) records — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. Models the real Equivariant Volumetric Grasping TABLE I:
top header row {Packed, Pile} spanning two metric sub-columns {GSR (%), DR (%)} each, plus Latency.
Each data cell must become ONE record carrying BOTH the condition and the metric.
"""
import os
import csv
from benchmarks.extraction.tei_tables import records_from_tei_rows
from benchmarks.extraction.locate import TableLocation
from benchmarks.normalize.registries import load_config, MethodResolver

CFG = load_config(os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json'))
CSV_PATH = "/Users/surbhikapoor/Desktop/WPI/wpivis/domain-explorer/datasets/csv-gp-combined.csv"


def _names():
    out = []
    with open(CSV_PATH) as f:
        for row in csv.DictReader(f):
            n = (row.get('Name') or '').replace('\U0001f916 ', '').strip()
            if n:
                out.append(n)
    return out


RES = MethodResolver(_names(), alias_seeds=CFG.get('method_aliases'))


def _multi_loc():
    # Docling flattens spanning headers by repetition: ROW0 spans Packed/Pile, ROW1 has GSR/DR
    return TableLocation(
        paper_id="equivariant-volumetric-grasping", table_index=0,
        caption="TABLE I: Clutter removal performance under single-view, fixed camera pose.",
        section_label="Experiments", is_results_section=True, is_ablation_section=False, has_rows=True,
        rows=[
            ["Method", "Packed", "Packed", "Pile", "Pile", "Latency (ms)"],
            ["", "GSR (%)", "DR (%)", "GSR (%)", "DR (%)", "Latency (ms)"],
            ["VGN [1]", "72.5", "76.7", "59.3", "43.5", "9"],
            ["GPD [44]", "41.8", "34.1", "22.7", "9.0", "2138"],
        ])


def test_multilevel_header_splits_into_condition_x_metric():
    recs = records_from_tei_rows(_multi_loc(), CFG, RES)
    vgn = [r for r in recs if r.method_id == "Volumetric Grasping Network (VGN)"]
    assert len(vgn) == 5, f"expected 5 typed records, got {len(vgn)}"
    byk = {(r.metric_id, r.condition): r.value for r in vgn}
    assert byk[("success_rate", "packed")] == 72.5
    assert byk[("declutter_rate", "packed")] == 76.7
    assert byk[("success_rate", "pile")] == 59.3
    assert byk[("declutter_rate", "pile")] == 43.5
    assert byk[("latency", None)] == 9.0
    # no duplicate comparison_keys (the bug we are fixing)
    assert len({r.comparison_key() for r in vgn}) == 5


def test_metric_raw_keeps_both_labels():
    recs = records_from_tei_rows(_multi_loc(), CFG, RES)
    r = next(x for x in recs if x.method_id == "Volumetric Grasping Network (VGN)"
             and x.metric_id == "declutter_rate" and x.condition == "packed")
    assert "Packed" in r.metric_raw and "DR" in r.metric_raw


def test_second_method_also_fully_decomposed():
    recs = records_from_tei_rows(_multi_loc(), CFG, RES)
    gpd = [r for r in recs if r.method_id == "Grasp Pose Detection (GPD)"]
    assert {(r.metric_id, r.condition) for r in gpd} >= {
        ("success_rate", "packed"), ("declutter_rate", "pile")}


def test_single_header_table_unchanged():
    loc = TableLocation(
        paper_id="anygrasp", table_index=0, caption="Table 2: grasp success rate (%)",
        section_label="Experiments", is_results_section=True, is_ablation_section=False, has_rows=True,
        rows=[["Method", "Success Rate"], ["VGN [1]", "72.5"], ["GPD [44]", "41.8"]])
    recs = records_from_tei_rows(loc, CFG, RES)
    vgn = [r for r in recs if r.method_id == "Volumetric Grasping Network (VGN)"]
    assert len(vgn) == 1
    assert vgn[0].metric_id == "success_rate" and vgn[0].value == 72.5
