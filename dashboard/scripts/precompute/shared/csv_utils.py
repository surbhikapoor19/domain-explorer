"""CSV cell parsing — splits multi-value fields the way the legacy backend did."""
import csv
import io
import numpy as np


def smart_split(value):
    if not value or (isinstance(value, float) and np.isnan(value)):
        return []
    s = str(value).strip()
    if not s:
        return []
    reader = csv.reader(io.StringIO(s), skipinitialspace=True)
    parts = next(reader)
    return [p.strip() for p in parts if p.strip()]


def normalize_multi_value(val):
    parts = smart_split(val)
    return ', '.join(sorted(parts)) if parts else ''
