"""_resolve_method_references — AUTHORED BY ORCHESTRATOR. Comparison claims must
link EVERY named method, tolerant of hyphens/acronyms, most-specific-wins (the
old resolver turned 102 claims into 7 edges)."""
from rag.knowledge_graph import _resolve_method_references, _method_aliases

METHODS = [
    'GraspNet', 'Contact-GraspNet', 'Grasp Pose Detection (GPD)',
    'Dex-Net 2.0 (GQ-CNN)', 'AnyGrasp',
]

def test_multi_target_and_hyphen_tolerance():
    refs = _resolve_method_references(
        'outperforms Contact-GraspNet and GPD by 5.2% on GraspNet-1B', METHODS)
    assert 'Contact-GraspNet' in refs
    assert 'Grasp Pose Detection (GPD)' in refs

def test_most_specific_method_owns_the_span():
    # "Contact-GraspNet" must NOT also resolve plain "GraspNet"
    refs = _resolve_method_references('5% better than ContactGraspNet', METHODS)
    assert refs == ['Contact-GraspNet']

def test_acronym_requires_word_boundary():
    assert _resolve_method_references('the gpddata pipeline', METHODS) == []
    assert _resolve_method_references('improves on GPD baselines', METHODS) == \
        ['Grasp Pose Detection (GPD)']

def test_aliases_include_parenthetical_acronym_and_bare_name():
    aliases = _method_aliases('Grasp Pose Detection (GPD)')
    assert 'gpd' in aliases and 'grasp pose detection' in aliases
