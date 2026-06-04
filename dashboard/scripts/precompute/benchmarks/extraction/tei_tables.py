import re
from benchmarks.types import ResultRecord
from benchmarks.normalize.registries import MetricRegistry, ConditionRegistry
from benchmarks.normalize.units import parse_value

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

def records_from_tei_rows(loc, cfg, resolver):
    mreg, creg = MetricRegistry(cfg), ConditionRegistry(cfg)
    rows = loc.rows
    if len(rows) < 2:
        return []
    header = rows[0]
    caption_condition = creg.resolve(loc.caption)
    metric_cols = []
    for i in range(1, len(header)):
        h = header[i].strip()
        if any(k in h.lower() for k in NON_METRIC_HEADERS):
            continue
        cond = creg.resolve(h)
        mh = mreg.resolve('success rate' if cond else h)
        metric_cols.append((i, mh, cond))
    recs = []
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        name, is_own = _clean_method(row[0])
        hit = resolver.resolve(name if not is_own else (name or 'ours'))
        method_id = hit.method_id
        if method_id is None and is_own:
            method_id = resolver.resolve('ours').method_id
        for ci, mh, col_cond in metric_cols:
            if ci >= len(row):
                continue
            v, std, unit = parse_value(row[ci])
            if v is None:
                continue
            recs.append(ResultRecord(
                paper_id=loc.paper_id, method_raw=row[0], method_id=method_id,
                metric_raw=header[ci], metric_id=mh.id, unit=mh.unit or unit,
                higher_is_better=mh.higher_is_better,
                condition=col_cond or caption_condition,
                value=v, value_str=row[ci].strip(), std_dev=std,
                is_own_method=is_own, is_ablation=_is_ablation(name),
                extractor='tei_table', table_caption=loc.caption,
                section_label=loc.section_label,
                extraction_conf=('low' if hit.confidence == 'low' else 'high'),
                verified=True))
    return recs
