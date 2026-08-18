"""step_kg must rebuild the KG when its sources change — AUTHORED BY ORCHESTRATOR.

Regression this locks in: a nightly `new-paper` build runs WITHOUT --force. The old
guard was `if kg_path.exists() and not FORCE: skip`, a pure existence check, so the KG
never rebuilt on a normal build even after a new paper refreshed extracted_facts.json —
the new paper reached the table (precompute reads the CSV) but never the knowledge graph.

The fix adds a pure mtime-staleness helper `_kg_needs_rebuild(kg_path, source_paths,
force)` (mirrors step_precompute's freshness check) and uses it in step_kg. These tests
pin the decision logic (no ChromaDB / no heavy build) plus step_kg's early-return skip
path (which returns before any heavy import). Implementers must NOT modify this file.
"""
import os
import sys
import time
import tempfile
import unittest
from pathlib import Path

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, 'scripts'))

import ingest_domain as ing  # noqa: E402


def _touch(p: Path, mtime: float):
    """Create the file and stamp an EXACT mtime (deterministic, no timing races)."""
    p.write_text('{}')
    os.utime(p, (mtime, mtime))


class KgNeedsRebuild(unittest.TestCase):
    """Pure decision logic: rebuild iff forced, KG missing, or SOME existing source
    is strictly newer than the KG (equal mtime must NOT trigger a rebuild, else every
    build loops). No filesystem timing dependence — mtimes are stamped explicitly."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.dir = Path(self.td.name)
        self.kg = self.dir / 'knowledge_graph.json'
        self.facts = self.dir / 'extracted_facts.json'
        self.entities = self.dir / 'extracted_entities.json'
        self.triples = self.dir / 'verified_triples.json'

    def tearDown(self):
        self.td.cleanup()

    def test_force_always_rebuilds_even_if_kg_newer(self):
        _touch(self.facts, 1000)
        _touch(self.kg, 5000)  # KG much newer than sources
        self.assertTrue(ing._kg_needs_rebuild(self.kg, (self.facts,), force=True))

    def test_missing_kg_rebuilds(self):
        _touch(self.facts, 1000)
        # kg does not exist
        self.assertTrue(ing._kg_needs_rebuild(self.kg, (self.facts,), force=False))

    def test_missing_kg_rebuilds_even_with_no_sources(self):
        self.assertTrue(ing._kg_needs_rebuild(self.kg, (self.facts, self.entities), force=False))

    def test_source_newer_than_kg_rebuilds(self):
        _touch(self.kg, 1000)
        _touch(self.facts, 2000)  # facts newer -> a new-paper build refreshed them
        self.assertTrue(ing._kg_needs_rebuild(self.kg, (self.facts,), force=False))

    def test_all_sources_older_skips(self):
        _touch(self.facts, 1000)
        _touch(self.kg, 2000)
        self.assertFalse(ing._kg_needs_rebuild(self.kg, (self.facts,), force=False))

    def test_equal_mtime_does_not_rebuild(self):
        # Strict '>' boundary: source mtime == kg mtime must NOT rebuild (no loops).
        _touch(self.facts, 3000)
        _touch(self.kg, 3000)
        self.assertFalse(ing._kg_needs_rebuild(self.kg, (self.facts,), force=False))

    def test_any_one_of_several_sources_newer_rebuilds(self):
        _touch(self.kg, 2000)
        _touch(self.facts, 1000)      # older
        _touch(self.entities, 1500)   # older
        _touch(self.triples, 2500)    # NEWER -> rebuild
        self.assertTrue(
            ing._kg_needs_rebuild(self.kg, (self.facts, self.entities, self.triples), force=False))

    def test_missing_sources_are_ignored(self):
        # entities/triples absent; only facts present and older -> skip (no crash on missing).
        _touch(self.facts, 1000)
        _touch(self.kg, 2000)
        self.assertFalse(
            ing._kg_needs_rebuild(self.kg, (self.facts, self.entities, self.triples), force=False))

    def test_no_sources_exist_and_kg_present_skips(self):
        _touch(self.kg, 2000)
        self.assertFalse(ing._kg_needs_rebuild(self.kg, (self.facts, self.entities), force=False))


class StepKgSkipPath(unittest.TestCase):
    """step_kg must return early (no heavy import) when the KG is up-to-date. The skip
    branch returns before `from backend.rag.knowledge_graph import ...`, so this needs
    no ChromaDB. We assert it returns cleanly and does NOT reach the build."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.chroma = Path(self.td.name)
        self._prev_force = ing.FORCE
        ing.FORCE = False

    def tearDown(self):
        ing.FORCE = self._prev_force
        self.td.cleanup()

    def _paths(self):
        return {'chroma': self.chroma, 'papers': self.chroma / 'papers',
                'csv': None, 'dataset': self.chroma, 'slug_dashed': 'x'}

    def test_up_to_date_kg_skips_without_building(self):
        _touch(self.chroma / 'extracted_facts.json', 1000)
        _touch(self.chroma / 'knowledge_graph.json', 2000)  # newer than facts -> skip
        # If step_kg tried to build it would import backend.rag.knowledge_graph and touch
        # ChromaDB; guard-skip returns before that. A sentinel makes an accidental build loud.
        import builtins
        real_import = builtins.__import__

        def guard(name, *a, **k):
            if name.startswith('backend.rag.knowledge_graph'):
                raise AssertionError("step_kg reached the build path but should have skipped")
            return real_import(name, *a, **k)

        builtins.__import__ = guard
        try:
            ing.step_kg(self._paths())  # must return cleanly
        finally:
            builtins.__import__ = real_import

    def test_no_facts_skips(self):
        # Neither facts nor kg -> the earlier 'no extracted data' guard returns.
        ing.step_kg(self._paths())  # must not raise


if __name__ == '__main__':
    unittest.main()
