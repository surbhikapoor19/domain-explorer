from benchmarks.types import ResultRecord
from benchmarks.normalize.units import clean_value_str

def records_from_comparisons(payload):
    """Reconstruct one ResultRecord per row in a benchmark-comparisons.json
    ``results`` list, so the hand-curated vision build (2114 rows / 46 papers) can
    seed the durable result-records union without re-running extraction.

    GRADE INVERSION — the reconstructed record must make build_benchmark_json
    re-derive the SAME lone-row grade. build grades a single extraction with
    ``evidence_grade(1, None, verified, extraction_conf)``, which returns B iff
    ``verified and extraction_conf != 'low'`` else C. So we set
    ``verified = grade in ('A','B')`` and ``extraction_conf = 'medium'`` — a lone
    B row round-trips to B, a lone C row to C. Grade-A / multi-report rows regrade
    via the cross-validation join at build time (2+ verified consistent papers),
    which is preserved because the union keeps every vision record.

    One-time fidelity note: ``std_dev`` is not carried on the comparisons rows, so
    it is reconstructed as None. The value-based ``_suspected_copy`` demotion
    (which needs a std_dev) therefore cannot fire on seeded rows; caption-based
    copy detection is unaffected. Because std_dev is always None, the round-trip is
    still idempotent on 2nd+ runs."""
    out = []
    for row in (payload or {}).get("results", []):
        method = row.get("method")
        resolved = bool(row.get("method_resolved"))
        r = ResultRecord(
            paper_id=row.get("paper_id"),
            method_raw=method,
            method_id=method if resolved else None,
            metric_raw=row.get("metric_raw") or "",
            metric_id=row.get("metric_id"),
            unit=row.get("unit"),
            higher_is_better=row.get("higher_is_better"),
            dataset_raw=row.get("dataset_raw") or "",
            dataset_id=row.get("dataset_id"),
            condition=row.get("condition"),
            value=row.get("value"),
            value_str=row.get("value_str") or "",
            std_dev=None,
            is_own_method=bool(row.get("is_own_method")),
            is_ablation=False,
            extractor=row.get("extractor") or "tei_table",
            table_caption=row.get("table_caption") or "",
            section_label=row.get("section_label") or "",
            page=row.get("page"),
            bbox=None,
            crop_image=row.get("crop_image"),
            extraction_conf="medium",
            verified=(row.get("grade") in ("A", "B")),
        )
        out.append(r)
    return out


def load_records(payload):
    """Reconstruct ResultRecords from a result-records.json payload, dropping unknown
    keys. value_str is OCR-cleaned so the displayed provenance string matches the
    parsed number ("17 . 7" -> "17.7")."""
    fields = ResultRecord.__dataclass_fields__
    out = []
    for rec in (payload or {}).get("records", []):
        r = ResultRecord(**{k: v for k, v in rec.items() if k in fields})
        r.value_str = clean_value_str(r.value_str)
        out.append(r)
    return out
