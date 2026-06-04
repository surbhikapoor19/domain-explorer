from benchmarks.types import ResultRecord

def load_records(payload):
    """Reconstruct ResultRecords from a result-records.json payload, dropping unknown keys."""
    fields = ResultRecord.__dataclass_fields__
    return [ResultRecord(**{k: v for k, v in rec.items() if k in fields})
            for rec in (payload or {}).get("records", [])]
