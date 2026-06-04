"""Domain-agnostic tests — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

Runs the PERMANENT modules (registries, confidence, build_benchmarks, locate) against
BOTH grasp_planning and motion_planning configs so any grasp-specific hardcoding fails a
test immediately. Motion planning has a different metric set (planning_time/path_length,
lower-is-better) and a different CSV schema, so this catches overfitting from the start.
"""
import os
import pytest
from benchmarks.normalize.registries import load_config, MetricRegistry, ConditionRegistry
from benchmarks.aggregate.build_benchmarks import build_benchmark_json
from benchmarks.types import ResultRecord

CFG_DIR = os.path.join(os.path.dirname(__file__), '..', 'config')
GRASP = load_config(os.path.join(CFG_DIR, 'grasp_planning.json'))
MOTION = load_config(os.path.join(CFG_DIR, 'motion_planning.json'))


@pytest.mark.parametrize('cfg', [GRASP, MOTION], ids=['grasp', 'motion'])
def test_both_configs_have_required_shape(cfg):
    for k in ('metrics', 'conditions', 'consistency'):
        assert k in cfg
    assert cfg['metrics']
    assert all('id' in m and 'aliases' in m for m in cfg['metrics'])


def test_motion_metrics_resolve_under_motion_config():
    reg = MetricRegistry(MOTION)
    assert reg.resolve('Planning Time (s)').id == 'planning_time'
    assert reg.resolve('path length').id == 'path_length'
    # direction must be domain-correct: planning time is lower-is-better
    assert reg.resolve('planning time').higher_is_better is False


def test_no_cross_domain_metric_leakage():
    motion = MetricRegistry(MOTION)
    # a purely-grasp metric must NOT resolve under the motion config
    assert motion.resolve('declutter rate').id is None
    grasp = MetricRegistry(GRASP)
    # a purely-motion metric must NOT resolve under the grasp config
    assert grasp.resolve('path length').id is None


def test_motion_conditions_resolve_under_motion_config():
    cond = ConditionRegistry(MOTION)
    assert cond.resolve('narrow passage') == 'narrow_passage'
    assert cond.resolve('bookshelf') == 'shelf'
    # a grasp-only scene must not resolve under motion
    assert cond.resolve('pile') is None


@pytest.mark.parametrize('cfg,metric_id,hib,expected_top', [
    (GRASP, 'success_rate', True, 86.9),     # higher-is-better -> larger value ranks first
    (MOTION, 'planning_time', False, 1.2),   # lower-is-better  -> smaller value ranks first
], ids=['grasp-higher-better', 'motion-lower-better'])
def test_build_benchmarks_respects_direction_in_any_domain(cfg, metric_id, hib, expected_top):
    recs = [
        ResultRecord(paper_id='p1', method_raw='A', method_id='A', metric_raw='x',
                     metric_id=metric_id, unit=None, higher_is_better=hib, condition='c',
                     value=86.9 if hib else 1.2, value_str=str(86.9 if hib else 1.2),
                     is_own_method=True, verified=True, extraction_conf='high'),
        ResultRecord(paper_id='p1', method_raw='B', method_id='B', metric_raw='x',
                     metric_id=metric_id, unit=None, higher_is_better=hib, condition='c',
                     value=70.1 if hib else 9.9, value_str=str(70.1 if hib else 9.9),
                     verified=True, extraction_conf='high'),
    ]
    out = build_benchmark_json(recs, cfg)
    assert out['leaderboards'], 'aggregate must produce a leaderboard regardless of domain'
    lb = next(iter(out['leaderboards'].values()))
    assert lb['entries'][0]['value'] == expected_top, 'ranking must honor higher_is_better per domain'
    # the winning comparison must point the right way too
    assert out['comparisons'][0]['winner'] == 'A'
