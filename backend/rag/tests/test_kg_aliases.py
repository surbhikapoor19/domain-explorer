"""KG entity-normalization config override — AUTHORED BY ORCHESTRATOR.

build_knowledge_graph(domain_config=...) lets a domain supply its own
technique/hardware/problem alias tables (via the YAML `kg_aliases`) so the KG
normalizes that domain's planners/robots/problems instead of grasp's. A domain
that omits a category keeps the built-in grasp defaults.

networkx is only used INSIDE knowledge_graph functions, never at import time, so
we stub it to exercise the pure alias logic without the heavy KG dependency."""
import os
import sys
import types

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


class _FakeNx(types.ModuleType):
    """Answer any attribute (e.g. nx.DiGraph used in a return annotation evaluated
    at import time) with a harmless dummy, so the module imports without networkx."""
    def __getattr__(self, name):
        return object


if 'networkx' not in sys.modules:
    sys.modules['networkx'] = _FakeNx('networkx')

from backend.rag import knowledge_graph as kg   # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_module():
    """Reload so each test starts from the built-in (grasp) defaults."""
    import importlib
    importlib.reload(kg)
    yield


def test_domain_config_overrides_technique_aliases():
    kg._apply_domain_aliases({'kg_aliases': {
        'technique': {'rrt': 'RRT', 'rrt-connect': 'RRT-Connect', 'chomp': 'CHOMP'}}})
    assert kg._normalize_technique('RRT') == 'RRT'
    assert kg._normalize_technique('rrt connect') == 'RRT-Connect'   # separator-insensitive
    assert kg._normalize_technique('CHOMP') == 'CHOMP'
    # grasp-specific default ('pointnet' -> 'PointNet') is REPLACED, not merged
    assert kg._normalize_technique('pointnet') != 'PointNet'


def test_omitted_category_keeps_grasp_defaults():
    kg._apply_domain_aliases({'kg_aliases': {'technique': {'rrt': 'RRT'}}})  # no hardware/problem
    # hardware table untouched -> built-in grasp alias still resolves
    assert kg._normalize_hardware('franka arm') == 'Franka Emika Panda'


def test_hardware_and_problem_overrides():
    kg._apply_domain_aliases({'kg_aliases': {
        'hardware': {'kuka': 'KUKA LBR iiwa'},
        'problem': {'narrow passage': 'narrow-passage planning'}}})
    assert kg._normalize_hardware('the kuka robot') == 'KUKA LBR iiwa'
    assert kg._normalize_problem('planning through a narrow passage') == 'narrow-passage planning'


def test_none_config_is_noop():
    before = dict(kg.TECHNIQUE_ALIASES)
    kg._apply_domain_aliases(None)
    kg._apply_domain_aliases({})
    assert kg.TECHNIQUE_ALIASES == before
