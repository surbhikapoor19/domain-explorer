"""Overwrite protection for precompute artifacts — AUTHORED BY ORCHESTRATOR.

A partial or failed rebuild (no chroma, crashed extractor, empty KG) must NEVER
clobber a committed, non-empty artifact with an empty/stub build."""
import json
import os
import tempfile

from _safe_write import safe_write_json, item_count   # precompute is on sys.path


def _tmp(content=None):
    p = os.path.join(tempfile.mkdtemp(), 'x.json')
    if content is not None:
        with open(p, 'w') as f:
            json.dump(content, f)
    return p


def test_refuses_empty_over_nonempty_list():
    p = _tmp([{'id': 1}, {'id': 2}])
    assert safe_write_json(p, []) is False
    assert json.load(open(p)) == [{'id': 1}, {'id': 2}]      # existing kept


def test_writes_nonempty_over_anything():
    p = _tmp([])
    assert safe_write_json(p, [{'id': 1}]) is True
    assert len(json.load(open(p))) == 1


def test_writes_empty_when_existing_also_empty():
    p = _tmp([])
    assert safe_write_json(p, []) is True                    # nothing to protect


def test_writes_when_no_existing_file():
    p = _tmp(None)
    assert safe_write_json(p, []) is True
    assert os.path.exists(p)


def test_predictions_success_flag_does_not_mask_empty():
    # {'success': True, 'nodes': [], 'links': []} must count as EMPTY
    p = _tmp({'success': True, 'nodes': [{'id': 1}], 'links': []})
    assert safe_write_json(p, {'success': True, 'nodes': [], 'links': []}) is False
    assert len(json.load(open(p))['nodes']) == 1             # kept


def test_landing_totalnodes_stub_refused():
    p = _tmp({'totalNodes': 56, 'temporal': {'2020': 3}})
    assert safe_write_json(p, {}) is False
    assert json.load(open(p))['totalNodes'] == 56


def test_dump_kwargs_passthrough():
    p = _tmp(None)
    assert safe_write_json(p, [{'a': 1}], dump_kwargs={'indent': 2}) is True
    assert '\n' in open(p).read()                            # indent applied


def test_item_count_semantics():
    assert item_count([]) == 0
    assert item_count([1, 2]) == 2
    assert item_count({'success': True, 'nodes': [], 'links': []}) == 0
    assert item_count({'nodes': [1], 'links': [2, 3]}) == 3
    assert item_count({'totalNodes': 5}) == 5
    assert item_count({}) == 0
    assert item_count({'data': [1, 2, 3]}) == 3              # umap-style
