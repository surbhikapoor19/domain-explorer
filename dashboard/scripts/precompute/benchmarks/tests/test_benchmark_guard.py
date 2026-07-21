"""Acceptance G1-G4 for the per-paper superset guard in ingest_domain
(_benchmark_superset_guard), which replaces the old count-ratio no-downgrade guard.

A benchmark export is written only if it is a per-paper SUPERSET of the previous
comparisons: a paper still present in the CSV must not vanish and the total row
count must not regress. Papers intentionally removed from the CSV (no longer in
present_ids) are allowed to leave; FORCE_BENCHMARK_OVERWRITE overrides everything.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]  # .../domain-explorer
sys.path.insert(0, str(REPO / 'scripts'))
import ingest_domain  # noqa: E402

guard = ingest_domain._benchmark_superset_guard


def _results(pids, n_rows):
    """n_rows result dicts spread round-robin over the given paper_ids."""
    pids = list(pids)
    return [{"paper_id": pids[i % len(pids)]} for i in range(n_rows)]


def test_G1_superset_passes():
    old = _results([f"p{i}" for i in range(46)], 2114)
    new_pids = [f"p{i}" for i in range(47)]
    new = _results(new_pids, 2140)
    ok, dropped, regressed = guard(old, new, present_ids=set(new_pids))
    assert ok is True and not dropped and regressed is False


def test_G2_downgrade_dropping_vision_papers_refused():
    old = _results([f"p{i}" for i in range(46)], 2114)
    new = _results([f"p{i}" for i in range(12)], 119)      # Docling-only, 34 papers gone
    present = {f"p{i}" for i in range(46)}                  # nothing removed from CSV
    ok, dropped, regressed = guard(old, new, present_ids=present)
    assert ok is False
    assert dropped == {f"p{i}" for i in range(12, 46)}     # the 34 dropped vision papers


def test_G3_row_regression_refused_unless_forced():
    old = _results([f"p{i}" for i in range(46)], 2114)
    new = _results([f"p{i}" for i in range(40)], 1200)     # fewer rows AND papers dropped
    present = {f"p{i}" for i in range(46)}
    ok, dropped, regressed = guard(old, new, present_ids=present)
    assert ok is False and regressed is True and dropped
    ok_f, _, _ = guard(old, new, present_ids=present, force=True)
    assert ok_f is True                                    # FORCE overrides


def test_G4_empty_new_paper_build_passes_no_false_refuse():
    pids = [f"p{i}" for i in range(46)]
    old = _results(pids, 2114)
    new = _results(pids, 2114)                             # identical: empty Docling delta
    ok, dropped, regressed = guard(old, new, present_ids=set(pids))
    assert ok is True and not dropped and regressed is False


def test_intentional_removal_allowed_when_not_regressing():
    """A paper removed from the CSV (dropped from present_ids) may leave the export
    without tripping the guard, as long as total rows do not regress."""
    old_pids = [f"p{i}" for i in range(46)]
    old = _results(old_pids, 2114)
    # p3 removed from CSV; a new paper p46 added so total rows do not regress.
    new_pids = [f"p{i}" for i in range(46) if i != 3] + ["p46"]
    new = _results(new_pids, 2120)
    present = set(new_pids)                                 # p3 no longer present
    ok, dropped, regressed = guard(old, new, present_ids=present)
    assert ok is True and not dropped and regressed is False
