def _key(r):
    return (r.method_id, r.metric_id, r.dataset_id, r.condition, r.value)

_PRI = {"tei_table": 3, "vlm": 2, "docling": 1}

def merge_records(tei_records, vlm_records):
    """Union; on identical (method,metric,dataset,condition,value) keep the highest-priority
    verified record (verified beats unverified; tei_table beats vlm beats docling)."""
    best = {}
    for r in list(tei_records) + list(vlm_records):
        k = _key(r)
        score = (1 if r.verified else 0, _PRI.get(r.extractor, 0))
        cur = best.get(k)
        if cur is None or score > cur[0]:
            best[k] = (score, r)
    return [v[1] for v in best.values()]


def merge_by_paper(baseline, fresh, present_ids=None):
    """Per-PAPER union for the durable result-records baseline. The baseline (the
    hand-curated vision build) WINS per paper_id: its rows are kept byte-identical
    (same objects) and only paper_ids ABSENT from the baseline contribute their
    fresh Docling rows. The result is a superset of the baseline by construction.

    ``present_ids`` (the current CSV Name->slug set) drops removed papers: a
    baseline paper whose slug is no longer in the CSV is pruned from the union, so
    an intentional sheet removal propagates. When ``present_ids`` is None nothing is
    dropped (pure monotonic union)."""
    base_pids = {r.paper_id for r in baseline}
    kept_base = [r for r in baseline if present_ids is None or r.paper_id in present_ids]
    return kept_base + [r for r in fresh if r.paper_id not in base_pids]
