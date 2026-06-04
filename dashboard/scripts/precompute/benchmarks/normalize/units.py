import re

_NULLS = {'-', 'n/a', '—', '–', '/', '', 'none'}

def parse_value(value_str):
    """Return (value: float|None, std_dev: float|None, unit: str|None)."""
    s = (value_str or '').strip()
    if s.lower() in _NULLS:
        return (None, None, None)
    unit = '%' if '%' in s else None
    std = None
    std_m = re.search(r'[±]\s*(\d+\.?\d*)', s)
    if std_m:
        std = float(std_m.group(1))
    head = re.split(r'[(±]', s, 1)[0]
    nums = re.findall(r'-?\d+\.?\d*', head)
    if not nums:
        nums = re.findall(r'-?\d+\.?\d*', s)
    if not nums:
        return (None, None, unit)
    return (float(nums[0]), std, unit)
