"""ingest_domain must resolve ONE authoritative CSV per domain — AUTHORED BY ORCHESTRATOR.

Every CSV consumer in the pipeline (KG method-paper map, precompute freshness check,
benchmark step) must read the CSV named by the domain YAML's ``csv_path``, not a
stale per-domain glob. For grasp_planning the authoritative file is the 60-row
``datasets/csv-gp-combined.csv``; the orphaned 56-row
``datasets/grasp-planning/grasp_planning.csv`` must never be selected.

Cheap to import (ingest_domain's heavy deps are imported lazily inside functions);
no network, no build. Implementers must NOT modify this file.
"""
import os
import re
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, 'scripts'))

import ingest_domain as ing  # noqa: E402


def _yaml_csv_path(domain_us):
    path = os.path.join(REPO, 'domains', domain_us + '.yaml')
    with open(path) as fh:
        for line in fh:
            m = re.match(r'\s*csv_path:\s*(.+?)\s*$', line)
            if m:
                return m.group(1).strip().strip('"\'')
    return None


class ResolveDomainCSV(unittest.TestCase):
    def test_resolve_domain_paths_exposes_csv_key(self):
        paths = ing.resolve_domain_paths('grasp_planning')
        self.assertIn('csv', paths, "resolve_domain_paths must expose a 'csv' key")

    def test_grasp_csv_is_yaml_combined_not_glob(self):
        expected = _yaml_csv_path('grasp_planning')
        self.assertTrue(expected and expected.endswith('csv-gp-combined.csv'))
        got = ing.resolve_domain_paths('grasp_planning')['csv']
        self.assertIsNotNone(got)
        self.assertEqual(os.path.basename(str(got)), 'csv-gp-combined.csv',
                         f"KG/benchmark/precompute must read the YAML csv_path, got {got}")

    def test_accepts_dashed_slug(self):
        got = ing.resolve_domain_paths('grasp-planning')['csv']
        self.assertEqual(os.path.basename(str(got)), 'csv-gp-combined.csv')

    def test_motion_stays_consistent_with_yaml(self):
        got = ing.resolve_domain_paths('motion_planning')['csv']
        self.assertEqual(os.path.basename(str(got)), 'motion_planning.csv')

    def test_resolved_csv_actually_exists(self):
        got = ing.resolve_domain_paths('grasp_planning')['csv']
        self.assertTrue(got and os.path.exists(str(got)),
                        f"resolved authoritative CSV must exist on disk: {got}")


if __name__ == '__main__':
    unittest.main()
