import json, os, pytest
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.aggregate.build_benchmarks import build_benchmark_json

V4 = "/tmp/table_extraction_results_v4.json"
pytestmark = pytest.mark.skipif(not os.path.exists(V4), reason="v4 results not present")

def _out():
    with open(V4) as f:
        v4 = json.load(f)
    return build_benchmark_json(records_from_v4(v4, load_config()), load_config())

def test_metric_fragmentation_reduced():
    out = _out()
    metric_ids = {lb['metric_id'] for lb in out['leaderboards'].values()}
    assert len(metric_ids) <= 20, f"expected <=20 canonical metrics, got {len(metric_ids)}"

def test_no_col_n_metric_published():
    out = _out()
    for lb in out['leaderboards'].values():
        assert not (lb['metric_id'] or '').lower().startswith('col_')

def test_giga_pile_is_different_setup_not_high_variance():
    out = _out()
    giga = [v for v in out['cross_validations'] if v['method'] and 'GIGA' in v['method']]
    for v in giga:
        assert v['status'] != 'high_variance' or v['grade'] == 'C'
