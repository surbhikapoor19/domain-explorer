import json, os
from benchmarks.normalize.registries import load_config

CFG = os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json')

def test_config_is_valid_json_with_required_keys():
    with open(CFG) as f:
        cfg = json.load(f)
    for key in ('results_section_keywords', 'metrics', 'conditions', 'consistency'):
        assert key in cfg
    ids = [m['id'] for m in cfg['metrics']]
    assert 'success_rate' in ids and 'latency' in ids

def test_result_record_comparison_key():
    from benchmarks.types import ResultRecord
    r = ResultRecord(paper_id='p', method_raw='Ours', method_id='AnyGrasp',
                     metric_raw='GSR', metric_id='success_rate', unit='%',
                     higher_is_better=True, condition='pile')
    assert r.comparison_key() == ('AnyGrasp', 'success_rate', None, 'pile')
