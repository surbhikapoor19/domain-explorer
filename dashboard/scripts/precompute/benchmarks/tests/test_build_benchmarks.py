from benchmarks.aggregate.build_benchmarks import build_benchmark_json
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.types import ResultRecord

CFG = load_config()


def _prov_records():
    """Records WITH full provenance (page, crop image, exact cell text) for the proof feature."""
    return [
        ResultRecord(paper_id="anygrasp", method_raw="Ours", method_id="AnyGrasp",
            metric_raw="Success Rate", metric_id="success_rate", unit="%", higher_is_better=True,
            condition="pile", value=86.9, value_str="86.9 ± 1.2", std_dev=1.2, is_own_method=True,
            extractor="vlm", table_caption="Table 2: SR on pile (%)", section_label="Experiments",
            page=4, bbox=[10, 20, 300, 200], crop_image="crops/anygrasp_t2.png",
            extraction_conf="high", verified=True),
        ResultRecord(paper_id="anygrasp", method_raw="GPD", method_id="Grasp Pose Detection (GPD)",
            metric_raw="Success Rate", metric_id="success_rate", unit="%", higher_is_better=True,
            condition="pile", value=70.1, value_str="70.1", extractor="vlm",
            table_caption="Table 2: SR on pile (%)", section_label="Experiments",
            page=4, crop_image="crops/anygrasp_t2.png", extraction_conf="high", verified=True),
    ]

def _records():
    return records_from_v4({
      "outperforms_both_csv": [
        {"winner_csv": "AnyGrasp", "loser_csv": "GPD", "metric": "Success Rate (%)",
         "winner_val": 86.9, "loser_val": 70.1, "margin": 16.8, "paper": "anygrasp"}],
      "cross_paper": {}
    }, CFG)

def test_build_produces_v2_schema():
    out = build_benchmark_json(_records(), CFG)
    for key in ('leaderboards', 'cross_validations', 'comparisons',
                'method_index', 'quarantine', 'stats'):
        assert key in out

def test_comparison_carries_grade_and_provenance():
    out = build_benchmark_json(_records(), CFG)
    assert out['comparisons'], "has comparisons"
    c = out['comparisons'][0]
    assert c['winner'] == 'AnyGrasp' and c['metric_id'] == 'success_rate'
    assert c['grade'] in ('A', 'B', 'C') and c['paper'] == 'anygrasp'

def test_unresolved_metric_is_quarantined_not_published():
    recs = records_from_v4({"outperforms_both_csv": [
        {"winner_csv": "X", "loser_csv": "Y", "metric": "Col_2",
         "winner_val": 5, "loser_val": 4, "margin": 1, "paper": "p"}],
        "cross_paper": {}}, CFG)
    out = build_benchmark_json(recs, CFG)
    assert out['quarantine']['n_records'] >= 1
    assert all('col_2' not in (lb.get('metric_id') or '').lower()
               for lb in out['leaderboards'].values())


def test_leaderboard_entries_carry_source_provenance():
    out = build_benchmark_json(_prov_records(), CFG)
    lb = next(iter(out['leaderboards'].values()))
    top = lb['entries'][0]
    assert 'sources' in top and top['sources'], "each leaderboard entry carries source provenance"
    s = top['sources'][0]
    for k in ('paper', 'value_str', 'table_caption', 'page', 'extractor', 'crop_image'):
        assert k in s, f"provenance field '{k}' present on leaderboard source"
    assert s['value_str'] == "86.9 ± 1.2"
    assert s['crop_image'] == "crops/anygrasp_t2.png"


def test_comparison_carries_value_str_and_crop():
    out = build_benchmark_json(_prov_records(), CFG)
    c = out['comparisons'][0]
    assert c['winner'] == "AnyGrasp"
    for k in ('winner_value_str', 'loser_value_str', 'page', 'crop_image', 'table_caption'):
        assert k in c, f"provenance field '{k}' present on comparison"
    assert c['winner_value_str'] == "86.9 ± 1.2"


def test_cross_validation_reports_carry_provenance():
    recs = _prov_records()
    recs.append(ResultRecord(paper_id="edge-grasp", method_raw="GPD",
        method_id="Grasp Pose Detection (GPD)", metric_raw="Success Rate", metric_id="success_rate",
        unit="%", higher_is_better=True, condition="pile", value=72.0, value_str="72.0",
        extractor="tei_table", table_caption="Table 3", section_label="Results", page=5,
        crop_image="crops/edge_t3.png", extraction_conf="high", verified=True))
    out = build_benchmark_json(recs, CFG)
    cvs = [v for v in out['cross_validations'] if v['method'] == "Grasp Pose Detection (GPD)"]
    assert cvs, "GPD validated across 2 papers"
    r = cvs[0]['reports'][0]
    for k in ('paper', 'value_str', 'table_caption', 'page', 'extractor', 'crop_image'):
        assert k in r, f"provenance field '{k}' present on cross-validation report"
