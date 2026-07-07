"""Regression: a truncated / invalid VLM JSON must NOT crash extraction — AUTHORED BY
ORCHESTRATOR. Implementers must NOT modify.

Proven root cause of the empty benchmark builds: the Groq vision model truncates a
large table's JSON at max_tokens (finish_reason='length'), and parse_vlm_rows ran an
unguarded json.loads on it. The exception propagated uncaught through
extract_paper_docling and killed all 55 papers (runs 28864909050 / 28866914953:
"Expecting ',' delimiter: line 299 column 6"). parse_vlm_rows must MISS rows, never raise.
"""
import os
from benchmarks.extraction.vlm_extract import parse_vlm_rows
from benchmarks.normalize.registries import load_config
from benchmarks.extraction.locate import TableLocation

CFG = load_config(os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json'))


class _R:  # minimal resolver stub
    def resolve(self, name):
        class H: method_id = None
        return H()


def _loc():
    return TableLocation('p', 0, 'Table 1: success rate (%)', 'Results',
                         True, False, has_rows=True, rows=[['Method', 'SR']])


def test_truncated_json_returns_empty_not_raise():
    truncated = '{"rows": [{"method":"A","value":1},{"method":"B","value":2}'  # cut off
    assert parse_vlm_rows(truncated, _loc(), CFG, _R()) == []


def test_garbage_text_returns_empty():
    assert parse_vlm_rows('sorry, I could not read the table', _loc(), CFG, _R()) == []


def test_valid_json_still_parses():
    good = '{"rows": [{"method":"AnyGrasp","metric":"success rate","value_str":"90%","value":90}]}'
    recs = parse_vlm_rows(good, _loc(), CFG, _R())
    assert len(recs) == 1 and recs[0].value == 90
