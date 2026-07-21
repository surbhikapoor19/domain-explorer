"""Unit tests for the PURE new-vs-edited decision in sheet_diff.

Covers the trigger acceptance criteria T1-T4 (added -> new-paper; edit-only ->
precompute; removed -> new-paper; '🤖 ' emoji normalization), plus name-column
resolution from a domain YAML config and the committed-header fallback. No
network or YAML file is touched.
"""
import csv
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sheet_diff as sd  # noqa: E402


def _csv(rows, header=('Name', 'Description')):
    """Serialize (name, desc) tuples into CSV text with a header row."""
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(list(header))
    for r in rows:
        w.writerow(list(r))
    return out.getvalue()


class TriggerClassification(unittest.TestCase):
    def test_T1_added_row_is_new_paper(self):
        old = _csv([('A', 'a'), ('B', 'b')])
        new = _csv([('A', 'a'), ('B', 'b'), ('C', 'c')])
        res = sd.classify(old, new, 'Name')
        self.assertEqual(res['kind'], 'new-paper')
        self.assertEqual(res['added'], ['C'])
        self.assertEqual(res['removed'], [])

    def test_T2_edit_only_is_precompute(self):
        old = _csv([('A', 'a desc'), ('B', 'b desc')])
        new = _csv([('A', 'a NEW desc'), ('B', 'b desc')])
        res = sd.classify(old, new, 'Name')
        self.assertEqual(res['kind'], 'precompute')
        self.assertEqual(res['added'], [])
        self.assertEqual(res['removed'], [])

    def test_T3_removed_row_is_new_paper(self):
        old = _csv([('A', 'a'), ('B', 'b')])
        new = _csv([('A', 'a')])
        res = sd.classify(old, new, 'Name')
        self.assertEqual(res['removed'], ['B'])
        self.assertEqual(res['kind'], 'new-paper')
        self.assertEqual(res['added'], [])

    def test_T4_emoji_prefixed_rename_is_not_a_new_paper(self):
        # '🤖 C' normalizes to 'C' before diffing -> no false add/remove.
        old = _csv([('A', 'a'), ('C', 'c')])
        new = _csv([('A', 'a'), ('🤖 C', 'c')])
        res = sd.classify(old, new, 'Name')
        self.assertEqual(res['kind'], 'precompute')
        self.assertEqual(res['added'], [])
        self.assertEqual(res['removed'], [])


class NameSet(unittest.TestCase):
    def test_emoji_and_whitespace_normalized(self):
        text = _csv([('🤖 Contact-GraspNet', 'x'), ('  UniGrasp  ', 'y')])
        self.assertEqual(
            sd.name_set(text, 'Name'),
            {'Contact-GraspNet', 'UniGrasp'},
        )

    def test_blank_names_ignored(self):
        text = _csv([('A', 'a'), ('', 'blank'), ('   ', 'ws')])
        self.assertEqual(sd.name_set(text, 'Name'), {'A'})

    def test_empty_text_is_empty_set(self):
        self.assertEqual(sd.name_set('', 'Name'), set())
        self.assertEqual(sd.name_set(None, 'Name'), set())


class ColumnResolution(unittest.TestCase):
    def test_name_col_from_config(self):
        cfg = {'columns': {
            'Name': {'role': 'identity.name', 'facet': 'identifier'},
            'Description': {'role': 'identity.description', 'facet': 'text'},
        }}
        self.assertEqual(sd.name_col_from_config(cfg), 'Name')

    def test_name_col_from_config_missing(self):
        self.assertIsNone(sd.name_col_from_config({'columns': {}}))
        self.assertIsNone(sd.name_col_from_config({}))
        self.assertIsNone(sd.name_col_from_config(None))

    def test_fallback_to_first_col_when_name_col_absent(self):
        # name_col not present in header -> fall back to committed first col.
        old = _csv([('A', 'a')], header=('Method', 'Description'))
        new = _csv([('A', 'a'), ('B', 'b')], header=('Method', 'Description'))
        res = sd.classify(old, new, name_col=None, first_col_fallback='Method')
        self.assertEqual(res['kind'], 'new-paper')
        self.assertEqual(res['added'], ['B'])

    def test_defaults_to_col_zero_when_nothing_resolves(self):
        old = _csv([('A', 'a')], header=('Method', 'Description'))
        new = _csv([('A', 'a'), ('B', 'b')], header=('Method', 'Description'))
        res = sd.classify(old, new, name_col=None, first_col_fallback=None)
        self.assertEqual(res['added'], ['B'])


if __name__ == '__main__':
    unittest.main()
