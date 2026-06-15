import re

_NULLS = {'-', 'n/a', '—', '–', '/', '', 'none'}

def parse_value(value_str):
    """Return (value: float|None, std_dev: float|None, unit: str|None).

    A value cell must reduce to a SINGLE number (optionally ± a std-dev). Cells
    that hold several numbers — multi-stage timings ("7ms 30ms 66ms"), paired
    cells ("843/685"), etc. — cannot be faithfully reduced to one figure, so we
    REJECT them (None) and let them quarantine rather than silently keeping the
    first/min token (which once crowned a method "fastest" off a 6-stage cell).
    """
    s = (value_str or '').strip()
    if s.lower() in _NULLS:
        return (None, None, None)
    # Repair TEI decimal tokenization BEFORE counting numbers: "85 . 3" -> "85.3",
    # "1 . 9" -> "1.9". Otherwise the fractional digit is dropped and the cell
    # also looks like a (falsely) multi-number cell.
    s = re.sub(r'(\d)\s*\.\s*(\d)', r'\1.\2', s)
    unit = '%' if '%' in s else None
    std = None
    std_m = re.search(r'[±]\s*(\d+\.?\d*)', s)
    if std_m:
        std = float(std_m.group(1))
    head = re.split(r'[(±]', s, 1)[0]
    head_nums = re.findall(r'-?\d+\.?\d*', head)
    if len(head_nums) > 1:
        return (None, None, unit)            # ambiguous multi-number value cell
    nums = head_nums or re.findall(r'-?\d+\.?\d*', s)
    if not nums:
        return (None, None, unit)
    return (float(nums[0]), std, unit)
