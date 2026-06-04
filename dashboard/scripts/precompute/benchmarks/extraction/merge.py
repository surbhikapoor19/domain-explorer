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
