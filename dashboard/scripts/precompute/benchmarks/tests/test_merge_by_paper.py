"""Acceptance M1/M2 for extraction.merge.merge_by_paper — the per-paper union that
keeps the hand-curated vision baseline byte-identical while appending only NEW
papers' fresh Docling rows. AUTHORED BY ORCHESTRATOR track (implementer-owned tests).
"""
from benchmarks.extraction.merge import merge_by_paper
from benchmarks.types import ResultRecord


def _rec(paper_id, method="M", value=1.0, metric="success_rate", condition="pile"):
    return ResultRecord(paper_id=paper_id, method_raw=method, method_id=method,
                        metric_raw=metric, metric_id=metric, unit="%",
                        higher_is_better=True, condition=condition, value=value,
                        value_str=str(value), extractor="vlm", verified=True)


def _baseline_46():
    # 46 vision paper_ids, ~2 rows each (a stand-in for the 2114-row build).
    return [_rec(f"p{i}", method=f"M{i}", value=float(i), condition=c)
            for i in range(46) for c in ("pile", "packed")]


def test_M1_new_paper_appended_baseline_object_identical():
    baseline = _baseline_46()
    fresh = [_rec("p46", method="New", value=99.0, condition="pile"),
             _rec("p46", method="New", value=98.0, condition="packed")]
    out = merge_by_paper(baseline, fresh)  # present_ids=None -> pure monotonic union

    # every baseline record survives as the SAME object (byte-identical, frozen)
    for b in baseline:
        assert any(o is b for o in out), "baseline record was mutated/dropped"
    # all fresh P47 rows appended
    assert all(any(o is f for o in out) for f in fresh)
    # exactly baseline + the two new rows, no duplication
    assert len(out) == len(baseline) + len(fresh)
    assert {r.paper_id for r in out} == {f"p{i}" for i in range(47)}
    assert sum(1 for r in out if r.paper_id == "p46") == 2


def test_M2_baseline_wins_no_fresh_rows_for_existing_paper():
    baseline = _baseline_46()  # contains p10
    # fresh re-reports p10 (a paper already in the baseline) plus a genuinely new p46
    fresh = [_rec("p10", method="ReDocling", value=12.3, condition="pile"),
             _rec("p10", method="ReDocling", value=45.6, condition="packed"),
             _rec("p46", method="New", value=99.0)]
    out = merge_by_paper(baseline, fresh)

    # ZERO fresh p10 rows survive — baseline wins per paper_id
    assert not any(r.method_id == "ReDocling" for r in out)
    # baseline p10 rows are all still present, unchanged
    base_p10 = [r for r in baseline if r.paper_id == "p10"]
    out_p10 = [r for r in out if r.paper_id == "p10"]
    assert len(out_p10) == len(base_p10)
    assert all(any(o is b for o in out_p10) for b in base_p10)
    # only the genuinely new paper contributed fresh rows
    assert sum(1 for r in out if r.paper_id == "p46") == 1


def test_present_ids_prunes_removed_paper_from_union():
    baseline = _baseline_46()
    present = {f"p{i}" for i in range(46)} - {"p3"}  # p3 removed from the CSV
    out = merge_by_paper(baseline, [], present_ids=present)
    assert "p3" not in {r.paper_id for r in out}
    assert {r.paper_id for r in out} == present
