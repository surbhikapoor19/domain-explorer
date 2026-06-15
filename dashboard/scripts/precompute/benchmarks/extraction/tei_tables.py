import re
from collections import defaultdict
from benchmarks.types import ResultRecord
from benchmarks.normalize.registries import MetricRegistry, ConditionRegistry
from benchmarks.normalize.units import parse_value


def _slug(s):
    s = re.sub(r'[^a-z0-9]+', '-', (s or '').lower()).strip('-')
    return s or 'col'

NON_METRIC_HEADERS = {'method', 'model', 'approach', 'algorithm', 'name', 'type', 'input',
    'backbone', 'training', 'param', 'publication', 'year', 'dataset', 'object',
    'category', 'planner', '#'}
ABLATION_PREFIXES = ('no ', 'w/o ', 'without ', 'w/ ', 'with ', '+ ', '- ')

def _clean_method(raw):
    name = re.sub(r'\s*\[[\d,\s\-]+\]', '', raw).strip()
    name = re.sub(r'[\*†‡✓✗]+$', '', name).strip()
    is_own = bool(re.search(r'\bours?\b', name, re.IGNORECASE))
    return name, is_own

def _is_ablation(name):
    return name.lower().strip().startswith(ABLATION_PREFIXES)

def _is_header_row(row):
    """A header row: first cell blank or a NON_METRIC token, AND no non-first cell is numeric."""
    first = (row[0] if row else '').strip().lower()
    if not (first == '' or any(k in first for k in NON_METRIC_HEADERS)):
        return False
    for c in row[1:]:
        v, _, _ = parse_value(c)
        if v is not None:
            return False
    return True


def _count_header_rows(rows):
    k = 0
    for row in rows:
        if _is_header_row(row):
            k += 1
        else:
            break
    return max(k, 1)  # always at least one header row


def records_from_tei_rows(loc, cfg, resolver):
    mreg, creg = MetricRegistry(cfg), ConditionRegistry(cfg)
    rows = loc.rows
    if len(rows) < 2:
        return []
    hk = getattr(loc, 'header_rows', None) or _count_header_rows(rows)
    hk = min(hk, len(rows) - 1)               # leave at least one data row
    header_rows = rows[:hk]
    data_rows = rows[hk:]
    caption_condition = creg.resolve(loc.caption)
    ncols = max(len(r) for r in rows)

    # Build per-data-column (metric, condition) by collapsing the stacked header labels.
    cols = []
    for i in range(1, ncols):
        labels = []
        for hr in header_rows:
            if i < len(hr):
                lab = hr[i].strip()
                if lab and lab not in labels:
                    labels.append(lab)
        if not labels:
            continue
        col_cond, mh = None, None
        for lab in labels:
            c = creg.resolve(lab)
            if c and col_cond is None:
                col_cond = c
            m = mreg.resolve(lab)
            if m.id and (mh is None or mh.id is None):
                mh = m
        if mh is None:
            mh = mreg.resolve(labels[-1])     # may have id=None -> quarantined downstream
        cols.append((i, mh, col_cond, ' | '.join(labels), labels[-1]))

    # Disambiguate columns that resolve to the SAME (metric, condition). Without
    # this they collapse into one leaderboard bucket and their cells are miscounted
    # as independent reports with a meaningless CV — e.g. a "Time Efficiency"
    # super-header over Forward-passing / Processing / Total Time (all -> latency),
    # or success-rate columns split by object-set whose headers aren't conditions.
    # We key them apart by their most-specific (leaf) header.
    buckets = defaultdict(list)
    for idx, (ci, mh, col_cond, raw_label, leaf) in enumerate(cols):
        buckets[((mh.id if mh else None), col_cond)].append(idx)
    for (mid, _cond), idxs in buckets.items():
        if mid is None or len(idxs) < 2:
            continue
        for idx in idxs:
            ci, mh, col_cond, raw_label, leaf = cols[idx]
            disamb = _slug(leaf)
            cols[idx] = (ci, mh, (f"{col_cond}:{disamb}" if col_cond else disamb),
                         raw_label, leaf)

    recs = []
    for row in data_rows:
        if not row or not row[0].strip():
            continue
        name, is_own = _clean_method(row[0])
        if name.lower() in {'method', 'model', 'approach', 'total', 'average', 'mean', 'all', 'baseline'}:
            continue
        hit = resolver.resolve(name if not is_own else (name or 'ours'))
        method_id = hit.method_id
        if method_id is None and is_own:
            method_id = resolver.resolve('ours').method_id
        for ci, mh, col_cond, raw_label, leaf in cols:
            if ci >= len(row):
                continue
            v, std, unit = parse_value(row[ci])
            if v is None:
                continue
            recs.append(ResultRecord(
                paper_id=loc.paper_id, method_raw=row[0], method_id=method_id,
                metric_raw=raw_label, metric_id=(mh.id if mh else None),
                unit=(mh.unit if mh else None) or unit,
                higher_is_better=(mh.higher_is_better if mh else None),
                condition=col_cond or caption_condition,
                value=v, value_str=row[ci].strip(), std_dev=std,
                is_own_method=is_own, is_ablation=_is_ablation(name),
                extractor='tei_table', table_caption=loc.caption,
                section_label=loc.section_label,
                extraction_conf=('low' if hit.confidence == 'low' else 'high'),
                verified=True))
    return recs
