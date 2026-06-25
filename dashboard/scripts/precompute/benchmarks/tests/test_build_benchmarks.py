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


def _same_table_inflation_records():
    """One paper, one method, one (metric,condition) — but 3 cells from the SAME table.
    A second method so the leaderboard bucket is emitted (>=2 methods)."""
    base = dict(metric_raw="Latency", metric_id="latency", unit="ms", higher_is_better=False,
                dataset_id=None, condition="forward", extractor="tei_table",
                table_caption="Table I", section_label="Experiments", page=5,
                crop_image="crops/regnet_t0.png", extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="regnet", method_raw="S4G", method_id="S4G",
                     value=v, value_str=f"{v}ms", is_own_method=True, **base)
        for v in (22.23, 824.20, 846.43)
    ]
    recs.append(ResultRecord(paper_id="regnet", method_raw="GPD", method_id="GPD",
                             value=10.0, value_str="10.0ms", **base))
    return recs


def test_n_reports_counts_distinct_papers_not_same_table_cells():
    out = build_benchmark_json(_same_table_inflation_records(), CFG)
    lb = next(lb for lb in out['leaderboards'].values() if lb['metric_id'] == 'latency')
    s4g = next(e for e in lb['entries'] if e['method'] == 'S4G')
    # n_reports stays = distinct papers (3 cells of one paper != 3 reports) ...
    assert s4g['n_reports'] == 1, f"cells of ONE paper = 1 report, got {s4g['n_reports']}"
    # ... but a paper whose own cells disagree 22 vs 846 must SURFACE (high cv -> C),
    # not hide behind a per-paper median.
    assert s4g['cv'] > 0.5, f"within-paper disagreement must surface, got cv={s4g['cv']}"
    assert s4g['grade'] == 'C', f"self-contradicting cells -> grade C, got {s4g['grade']}"


def test_n_reports_counts_genuine_multiple_papers():
    """Three DIFFERENT papers reporting the same (method,metric,condition) = 3 reports (legit)."""
    base = dict(method_raw="M", method_id="M", metric_raw="Latency", metric_id="latency",
                unit="ms", higher_is_better=False, condition="c", extractor="tei_table",
                extraction_conf="high", verified=True)
    recs = [ResultRecord(paper_id=p, value=v, value_str=str(v), **base)
            for p, v in (("p1", 20.0), ("p2", 22.0), ("p3", 24.0))]
    recs.append(ResultRecord(paper_id="p1", method_raw="N", method_id="N", metric_raw="Latency",
                             metric_id="latency", unit="ms", higher_is_better=False, condition="c",
                             value=99.0, value_str="99.0", extractor="tei_table",
                             extraction_conf="high", verified=True))
    out = build_benchmark_json(recs, CFG)
    lb = next(lb for lb in out['leaderboards'].values() if lb['metric_id'] == 'latency')
    m = next(e for e in lb['entries'] if e['method'] == 'M')
    assert m['n_reports'] == 3, f"3 distinct papers = 3 reports, got {m['n_reports']}"
    assert m['cv'] > 0, "genuine cross-paper spread is reported"


def test_leaderboard_sources_carry_metric_raw_and_condition():
    out = build_benchmark_json(_prov_records(), CFG)
    lb = next(iter(out['leaderboards'].values()))
    s = lb['entries'][0]['sources'][0]
    assert 'metric_raw' in s, "source carries which column the value came from"
    assert 'condition' in s, "source carries the condition"
    assert s['metric_raw'] == "Success Rate"


def test_condition_aliases_merge_near_duplicate_conditions():
    """config condition_aliases merges column-label variants (e.g. 'total' vs
    'total-time') so the same concept cross-validates across papers instead of
    fragmenting into separate near-duplicate buckets."""
    base = dict(metric_raw="Latency", metric_id="latency", unit="ms", higher_is_better=False,
                extractor="tei_table", extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="p1", method_raw="M", method_id="M", value=100.0, value_str="100",
                     condition="total", **base),
        ResultRecord(paper_id="p2", method_raw="M", method_id="M", value=110.0, value_str="110",
                     condition="total-time", **base),
        ResultRecord(paper_id="p1", method_raw="N", method_id="N", value=200.0, value_str="200",
                     condition="total", **base),
    ]
    out = build_benchmark_json(recs, CFG)  # grasp config has "total" -> "total-time"
    lat = [lb for lb in out['leaderboards'].values()
           if lb['metric_id'] == 'latency' and lb['condition'] == 'total-time']
    assert lat, "the two variants merged into a single 'total-time' bucket"
    m = next(e for e in lat[0]['entries'] if e['method'] == 'M')
    assert m['n_reports'] == 2, f"p1(total)+p2(total-time) must merge to 2 reports, got {m['n_reports']}"


def test_n_methods_indexed_counts_leaderboard_only_methods():
    """n_methods_indexed counts every method with a published number — including
    methods that appear ONLY in a leaderboard, never in a pairwise comparison or a
    multi-paper cross-validation. The old len(method_index) undercounted these
    (it read "11 methods" when 25 actually had data)."""
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%",
                higher_is_better=True, condition="pile", is_own_method=False,
                extractor="tei_table", extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="p1", method_raw="M", method_id="M", value=80.0, value_str="80", **base),
        ResultRecord(paper_id="p2", method_raw="N", method_id="N", value=70.0, value_str="70", **base),
    ]
    out = build_benchmark_json(recs, CFG)
    # Both methods are in the leaderboard; neither reaches a comparison/cross-validation.
    assert out['stats']['n_methods_indexed'] == 2
    assert len(out['method_index']) == 0  # the comparison index is empty here


def test_quarantine_surfaces_distinct_unresolved_headers_and_methods():
    """Quarantine is diagnosable, not an opaque count: the DISTINCT raw headers and
    method names that were dropped are surfaced with frequencies, so a maintainer can
    audit whether a dropped 'header' is really an unmapped metric (add an alias) or a
    genuine non-metric column. (Lumi: invert silent-drop into diagnosable failure.)"""
    base = dict(unit=None, higher_is_better=None, is_own_method=False,
                extractor="tei_table", extraction_conf="low", verified=False)
    recs = [
        # metric_id=None -> unsalvageable_header; carries the raw column text twice
        ResultRecord(paper_id="p1", method_raw="M", method_id="M", metric_raw="Backbone Params (M)",
                     metric_id=None, condition=None, value=12.0, value_str="12", **base),
        ResultRecord(paper_id="p2", method_raw="N", method_id="N", metric_raw="Backbone Params (M)",
                     metric_id=None, condition=None, value=24.0, value_str="24", **base),
        # method_id=None -> unresolved_method; carries the raw method text
        ResultRecord(paper_id="p3", method_raw="MysteryNet-X", method_id=None, metric_raw="Success Rate",
                     metric_id="success_rate", condition="pile", value=80.0, value_str="80", **base),
    ]
    out = build_benchmark_json(recs, CFG)
    q = out['quarantine']
    assert q['n_records'] == 3
    assert q['reasons']['unsalvageable_header'] == 2
    assert q['reasons']['unresolved_method'] == 1
    headers = {h['raw']: h['count'] for h in q['unresolved_headers']}
    assert headers.get('Backbone Params (M)') == 2          # the dropped header, surfaced with its count
    methods = {m['raw']: m['count'] for m in q['unresolved_methods']}
    assert methods.get('MysteryNet-X') == 1                 # the dropped method, surfaced


def test_no_self_comparison_a_method_never_beats_itself():
    """An ablation row where the SAME method is both the own-method and a 'baseline'
    must NOT produce a method-vs-method comparison — it would read as the method
    beating itself. The real winner-vs-other comparison still survives."""
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%",
                higher_is_better=True, condition="pile", extractor="tei_table",
                extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="p1", method_raw="VGN", method_id="VGN", value=90.0, value_str="90", is_own_method=True, **base),
        ResultRecord(paper_id="p1", method_raw="VGN (ablation)", method_id="VGN", value=70.0, value_str="70", is_own_method=False, **base),
        ResultRecord(paper_id="p1", method_raw="GPD", method_id="GPD", value=60.0, value_str="60", is_own_method=False, **base),
    ]
    out = build_benchmark_json(recs, CFG)
    pairs = {(c['winner'], c['loser']) for c in out['comparisons']}
    assert ('VGN', 'VGN') not in pairs   # a method never beats itself
    assert ('VGN', 'GPD') in pairs       # the genuine head-to-head survives


def test_leaderboard_median_is_true_median_for_even_paper_count():
    """With an EVEN number of papers the median must be the average of the two middle
    per-paper values, not the upper-middle index (the old sorted[n//2] bug, which
    would over-report 30 instead of the true 25 for 10/20/30/40)."""
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%",
                higher_is_better=True, condition="pile", is_own_method=False,
                extractor="tei_table", extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="p1", method_raw="M", method_id="M", value=10.0, value_str="10", **base),
        ResultRecord(paper_id="p2", method_raw="M", method_id="M", value=20.0, value_str="20", **base),
        ResultRecord(paper_id="p3", method_raw="M", method_id="M", value=30.0, value_str="30", **base),
        ResultRecord(paper_id="p4", method_raw="M", method_id="M", value=40.0, value_str="40", **base),
        ResultRecord(paper_id="p1", method_raw="N", method_id="N", value=5.0, value_str="5", **base),
    ]
    out = build_benchmark_json(recs, CFG)
    lb = next(lb for lb in out['leaderboards'].values() if lb['metric_id'] == 'success_rate')
    m = next(e for e in lb['entries'] if e['method'] == 'M')
    assert m['median'] == 25.0, f"true median of 10,20,30,40 is 25, got {m['median']}"


def test_leaderboard_headline_is_median_and_ranks_by_it_not_cherrypicked_max():
    """The headline `value` is the honest per-paper MEDIAN (max kept as `best`), and
    methods rank by median — so a method cannot rank #1 on a single best run while its
    median is mid-pack (the Edge Grasp Network 92.0-vs-median-73.4 problem)."""
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%",
                higher_is_better=True, condition="pile", is_own_method=False,
                extractor="tei_table", extraction_conf="high", verified=True)
    recs = [
        # A: two papers 70 & 90 -> median 80, best 90
        ResultRecord(paper_id="p1", method_raw="A", method_id="A", value=70.0, value_str="70", **base),
        ResultRecord(paper_id="p2", method_raw="A", method_id="A", value=90.0, value_str="90", **base),
        # B: steady 85 -> median 85; outranks A on median (85>80) despite A's higher best (90)
        ResultRecord(paper_id="p1", method_raw="B", method_id="B", value=85.0, value_str="85", **base),
        ResultRecord(paper_id="p2", method_raw="B", method_id="B", value=85.0, value_str="85", **base),
    ]
    out = build_benchmark_json(recs, CFG)
    lb = next(lb for lb in out['leaderboards'].values() if lb['metric_id'] == 'success_rate')
    a = next(e for e in lb['entries'] if e['method'] == 'A')
    assert a['value'] == 80.0 and a['best'] == 90.0   # headline=median, max preserved as best
    assert lb['entries'][0]['method'] == 'B'          # B (median 85) ranks above A (median 80)


def test_identical_value_and_stddev_across_papers_is_not_grade_a():
    """Two 'independent' papers quoting the SAME value AND stddev is citation copying
    (a baseline number reproduced verbatim), not corroboration — it must NOT earn
    grade A (it would otherwise get cv=0 -> max confidence on a copied number), and
    it is flagged with corroboration='identical_values_suspected_copy'."""
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%",
                higher_is_better=True, condition="pile", is_own_method=False,
                extractor="tei_table", extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="edge-grasp-network", method_raw="PointNetGPD", method_id="PointNetGPD",
                     value=79.3, value_str="79.3 ± 1.8", std_dev=1.8, **base),
        ResultRecord(paper_id="equivariant-volumetric-grasping", method_raw="PointNetGPD", method_id="PointNetGPD",
                     value=79.3, value_str="79.3 ± 1.8", std_dev=1.8, **base),
    ]
    out = build_benchmark_json(recs, CFG)
    cv = next(c for c in out['cross_validations'] if c['method'] == 'PointNetGPD')
    assert cv['corroboration'] == 'identical_values_suspected_copy'
    assert cv['grade'] != 'A', f"copied baseline must not be grade A, got {cv['grade']}"

    # Genuinely independent papers (different values) stay 'independent' and can be A.
    recs2 = [
        ResultRecord(paper_id="p1", method_raw="VGN", method_id="VGN", value=86.0, value_str="86", std_dev=1.0, **base),
        ResultRecord(paper_id="p2", method_raw="VGN", method_id="VGN", value=85.0, value_str="85", std_dev=1.2, **base),
    ]
    out2 = build_benchmark_json(recs2, CFG)
    cv2 = next(c for c in out2['cross_validations'] if c['method'] == 'VGN')
    assert cv2['corroboration'] == 'independent'


def test_per_paper_median_surfaces_outliers_not_hidden_by_best():
    """A paper reporting an outlier (2232) next to a small value (48) must NOT have
    the outlier hidden by taking the best (min). The per-paper MEDIAN surfaces it so
    the CV is honest and the entry is not falsely graded A. (The 6-DoF GraspNet bug.)"""
    base = dict(metric_raw="Latency", metric_id="latency", unit="ms", higher_is_better=False,
                condition=None, extractor="tei_table", extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="pA", method_raw="6DoF", method_id="6DoF", value=41.08, value_str="41.08", **base),
        ResultRecord(paper_id="pB", method_raw="6DoF", method_id="6DoF", value=2232.0, value_str="2232", **base),
        ResultRecord(paper_id="pB", method_raw="6DoF", method_id="6DoF", value=48.0, value_str="48", **base),
        ResultRecord(paper_id="pA", method_raw="X", method_id="X", value=10.0, value_str="10", **base),
    ]
    out = build_benchmark_json(recs, CFG)
    lat = next(lb for lb in out['leaderboards'].values() if lb['metric_id'] == 'latency')
    e = next(x for x in lat['entries'] if x['method'] == '6DoF')
    assert e['n_reports'] == 2, "two distinct papers"
    assert e['cv'] > 0.5, f"the 2232 outlier must NOT be hidden — CV should be high, got {e['cv']}"
    assert e['grade'] != 'A', f"papers that disagree must not be grade A, got {e['grade']}"


def test_cross_validation_ignores_none_value_papers():
    """A paper whose cells ALL parsed to None must not inflate cross-validation
    n_papers into a fake 'two papers agree' (cv=0, grade A) from a single value."""
    base = dict(metric_id="success_rate", unit="%", higher_is_better=True, condition="pile",
                dataset_id=None, extractor="tei_table", extraction_conf="high", verified=True)
    recs = [
        ResultRecord(paper_id="rgbd", method_raw="EVG", method_id="EVG", metric_raw="GSR",
                     value=91.67, value_str="91.67", **base),
        ResultRecord(paper_id="unigrasp", method_raw="EVG", method_id="EVG", metric_raw="GSR",
                     value=None, value_str="78.4 86.6 89.9 91.2", **base),  # all-None paper
    ]
    out = build_benchmark_json(recs, CFG)
    cvs = [v for v in out['cross_validations'] if v['method'] == 'EVG']
    assert not cvs, "one value-bearing paper is NOT a cross-paper validation"


def test_confidence_field_present_and_threshold_semantics():
    from benchmarks.aggregate.build_benchmarks import _confidence
    out = build_benchmark_json(_prov_records(), CFG)
    e = next(iter(out['leaderboards'].values()))['entries'][0]
    assert 'confidence' in e and 0.0 <= e['confidence'] <= 1.0
    assert _confidence('C', 0.0) < 0.70, "grade C scores below the 0.70 cutoff"
    assert _confidence('A', 0.05) >= 0.70, "grade A scores at/above 0.70"


def test_fraction_scale_rates_lifted_to_percent():
    base = dict(metric_raw="Success Rate", metric_id="success_rate", unit="%", higher_is_better=True,
                condition="k", extractor="tei_table", extraction_conf="high", verified=True)
    recs = [ResultRecord(paper_id="p1", method_raw="A", method_id="A", value=0.93, value_str="0.93", **base),
            ResultRecord(paper_id="p1", method_raw="B", method_id="B", value=0.57, value_str="0.57", **base)]
    out = build_benchmark_json(recs, CFG)
    lb = next(lb for lb in out['leaderboards'].values() if lb['metric_id'] == 'success_rate')
    assert sorted(e['value'] for e in lb['entries']) == [57.0, 93.0], "0-1 fractions lifted to percent"


def test_cross_validation_is_condition_aware():
    base = dict(metric_id="latency", unit="ms", higher_is_better=False, extractor="tei_table",
                extraction_conf="high", verified=True)
    recs = [ResultRecord(paper_id="p1", method_raw="M", method_id="M", metric_raw="Inference Time",
                         value=5.0, value_str="5", condition="inference-time", **base),
            ResultRecord(paper_id="p2", method_raw="M", method_id="M", metric_raw="Total Time",
                         value=5000.0, value_str="5000", condition="total-time", **base)]
    out = build_benchmark_json(recs, CFG)
    assert not [v for v in out['cross_validations'] if v['method'] == 'M'], \
        "different conditions (inference vs total time) must not cross-validate"


def test_latency_scope_separates_time_from_latency():
    base = dict(metric_id="latency", unit="ms", higher_is_better=False, condition=None,
                extractor="tei_table", extraction_conf="high", verified=True)
    recs = [ResultRecord(paper_id="p1", method_raw="A", method_id="A", metric_raw="Latency (ms)", value=9.0, value_str="9", **base),
            ResultRecord(paper_id="p1", method_raw="B", method_id="B", metric_raw="Latency (ms)", value=24.0, value_str="24", **base),
            ResultRecord(paper_id="p2", method_raw="C", method_id="C", metric_raw="Time", value=150.0, value_str="150", **base),
            ResultRecord(paper_id="p2", method_raw="D", method_id="D", metric_raw="Time", value=25.0, value_str="25", **base)]
    out = build_benchmark_json(recs, CFG)
    conds = {lb['condition'] for lb in out['leaderboards'].values() if lb['metric_id'] == 'latency'}
    assert 'latency' in conds and 'time' in conds, f"Latency and Time separated into distinct boards, got {conds}"
