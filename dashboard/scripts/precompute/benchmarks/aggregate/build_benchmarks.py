import json, os
from collections import defaultdict
from benchmarks.aggregate.confidence import (
    coefficient_of_variation, classify_consistency, evidence_grade)

def _metric_label(cfg, metric_id):
    for m in cfg['metrics']:
        if m['id'] == metric_id:
            unit = f" ({m['unit']})" if m.get('unit') else ""
            return metric_id.replace('_', ' ').title() + unit
    return metric_id

def build_benchmark_json(records, cfg):
    cv_thr = cfg.get('consistency', {}).get('cv_thresholds')
    min_papers = cfg.get('consistency', {}).get('min_papers_for_validation', 2)
    metric_type = {m['id']: m.get('type', 'default') for m in cfg['metrics']}

    publishable = [r for r in records if r.metric_id and r.method_id]
    quarantined = [r for r in records if not (r.metric_id and r.method_id)]

    groups = defaultdict(lambda: defaultdict(list))
    for r in publishable:
        key = f"{r.metric_id}|{r.dataset_id or ''}|{r.condition or ''}"
        groups[key][r.method_id].append(r)

    leaderboards = {}
    for key, methods in groups.items():
        metric_id, dataset_id, condition = key.split('|')
        hib = next((r.higher_is_better for ms in methods.values() for r in ms
                    if r.higher_is_better is not None), True)
        entries = []
        for method, recs in methods.items():
            vals = [r.value for r in recs if r.value is not None]
            if not vals:
                continue
            best = max(vals) if hib else min(vals)
            med = sorted(vals)[len(vals) // 2]
            status = classify_consistency(vals, metric_type.get(metric_id, 'default'),
                                          same_condition=True, cv_thresholds=cv_thr) if len(vals) >= 2 else None
            grade = evidence_grade(len({r.paper_id for r in recs}), status,
                                   any(r.verified for r in recs),
                                   max((r.extraction_conf for r in recs), default='low'))
            entries.append({'method': method, 'value': round(best, 2),
                            'median': round(med, 2), 'n_reports': len(vals),
                            'cv': round(coefficient_of_variation(vals), 3),
                            'grade': grade,
                            'source_papers': sorted({r.paper_id for r in recs}),
                            'sources': [{'paper': r.paper_id, 'value_str': r.value_str,
                                         'table_caption': r.table_caption, 'page': r.page,
                                         'extractor': r.extractor, 'crop_image': r.crop_image}
                                        for r in recs]})
        if len(entries) >= 2:
            entries.sort(key=lambda e: e['value'], reverse=hib)
            leaderboards[key] = {
                'metric_id': metric_id, 'metric_label': _metric_label(cfg, metric_id),
                'dataset_id': dataset_id or None, 'condition': condition or None,
                'higher_is_better': hib, 'entries': entries}

    cross = defaultdict(list)
    for r in publishable:
        cross[(r.method_id, r.metric_id, r.dataset_id)].append(r)
    cross_validations = []
    for (method, metric_id, dataset_id), recs in cross.items():
        papers = {r.paper_id for r in recs}
        if len(papers) < min_papers:
            continue
        conds = {r.condition for r in recs}
        vals = [r.value for r in recs if r.value is not None]
        same_condition = len(conds) == 1
        status = classify_consistency(vals, metric_type.get(metric_id, 'default'),
                                      same_condition=same_condition, cv_thresholds=cv_thr)
        grade = evidence_grade(len(papers), status, any(r.verified for r in recs),
                               max((r.extraction_conf for r in recs), default='low'))
        cross_validations.append({
            'method': method, 'metric_id': metric_id,
            'metric_label': _metric_label(cfg, metric_id), 'dataset_id': dataset_id,
            'n_papers': len(papers),
            'mean': round(sum(vals) / len(vals), 2) if vals else None,
            'cv': round(coefficient_of_variation(vals), 3), 'status': status, 'grade': grade,
            'reports': [{'paper': r.paper_id, 'value': r.value, 'value_str': r.value_str,
                         'condition': r.condition, 'table_caption': r.table_caption,
                         'page': r.page, 'extractor': r.extractor,
                         'crop_image': r.crop_image} for r in recs]})
    cross_validations.sort(key=lambda v: v['n_papers'], reverse=True)

    comparisons, method_index = _comparisons_and_index(publishable, cross_validations, metric_type, cv_thr)

    stats = {'n_comparisons': len(comparisons), 'n_leaderboards': len(leaderboards),
             'n_methods_indexed': len(method_index), 'n_cross_validations': len(cross_validations),
             'n_grade_a': sum(1 for c in comparisons if c['grade'] == 'A'),
             'n_quarantined': len(quarantined)}
    q_reasons = defaultdict(int)
    for r in quarantined:
        q_reasons['unsalvageable_header' if not r.metric_id else 'unresolved_method'] += 1
    return {'leaderboards': leaderboards, 'cross_validations': cross_validations,
            'comparisons': comparisons, 'method_index': method_index,
            'quarantine': {'n_records': len(quarantined), 'reasons': dict(q_reasons)},
            'stats': stats}

def _comparisons_and_index(records, cross_validations, metric_type, cv_thr):
    by_ctx = defaultdict(list)
    for r in records:
        by_ctx[(r.paper_id, r.metric_id, r.dataset_id, r.condition)].append(r)
    comparisons = []
    for (paper, metric_id, dataset_id, condition), recs in by_ctx.items():
        owners = [r for r in recs if r.is_own_method and r.value is not None]
        others = [r for r in recs if not r.is_own_method and r.value is not None]
        for own in owners:
            for oth in others:
                hib = own.higher_is_better if own.higher_is_better is not None else True
                win = (own.value > oth.value) if hib else (own.value < oth.value)
                if not win:
                    continue
                grade = evidence_grade(1, None, own.verified, own.extraction_conf)
                comparisons.append({
                    'winner': own.method_id, 'loser': oth.method_id, 'metric_id': metric_id,
                    'condition': condition, 'winner_value': own.value, 'loser_value': oth.value,
                    'margin': round(abs(own.value - oth.value), 2), 'grade': grade,
                    'paper': paper, 'table_caption': own.table_caption, 'extractor': own.extractor,
                    'winner_value_str': own.value_str, 'loser_value_str': oth.value_str,
                    'page': own.page, 'crop_image': own.crop_image})
    idx = defaultdict(lambda: {'wins': [], 'losses': [], 'validations': [], 'metrics': set()})
    for c in comparisons:
        idx[c['winner']]['wins'].append(c); idx[c['winner']]['metrics'].add(c['metric_id'])
        idx[c['loser']]['losses'].append(c); idx[c['loser']]['metrics'].add(c['metric_id'])
    for v in cross_validations:
        idx[v['method']]['validations'].append(
            {'metric_id': v['metric_id'], 'n_papers': v['n_papers'],
             'status': v['status'], 'cv': v['cv'], 'grade': v['grade']})
    method_index = {m: {'wins': d['wins'], 'losses': d['losses'], 'validations': d['validations'],
                        'metrics': sorted(x for x in d['metrics'] if x),
                        'n_wins': len(d['wins']), 'n_losses': len(d['losses'])}
                    for m, d in idx.items()}
    return comparisons, method_index
