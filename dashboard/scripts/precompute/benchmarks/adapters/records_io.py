from benchmarks.types import ResultRecord
from benchmarks.normalize.units import clean_value_str

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
