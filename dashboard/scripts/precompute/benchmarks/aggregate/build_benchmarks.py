import json, os, re
from collections import defaultdict
from statistics import median
from benchmarks.aggregate.confidence import (
    coefficient_of_variation, classify_consistency, evidence_grade)

CONF_BASE = {'A': 0.92, 'B': 0.78, 'C': 0.45}

def _confidence(grade, cv):
    """A single 0-1 confidence score used by the UI's min-confidence filter:
    grade sets the base, a high CV penalizes it. (A~0.9, B~0.78, C~0.45.)"""
    return round(CONF_BASE.get(grade, 0.45) * (1 - min(cv or 0.0, 1.0) * 0.3), 2)

def _time_scope(metric_raw):
    """For a condition-less generic-`latency` column, derive a scope from its raw
    label so different timing DEFINITIONS ("Latency (ms)" vs "Time" vs "Inference
    Time") don't share one unlabeled ranking."""
    s = re.sub(r'\(.*?\)', ' ', (metric_raw or '').lower())   # drop "(ms)"
    s = re.sub(r'[^a-z]+', ' ', s).strip()
    return re.sub(r'\s+', '-', s) or None

def _metric_label(cfg, metric_id):
    for m in cfg['metrics']:
        if m['id'] == metric_id:
            unit = f" ({m['unit']})" if m.get('unit') else ""
            return metric_id.replace('_', ' ').title() + unit
    return metric_id

# Bare directional words ("best", "fastest") attach to exactly ONE metric per
# direction — the primary success metric and the primary cost metric. If every
# same-direction metric carried them, a query like "fastest planner" would tie
# across all lower-is-better metrics and route by arbitrary config order. Specific
# queries still resolve via each metric's own aliases (e.g. "shortest path length"
# → path_length via its alias). Over-broad single tokens ("top", "most", "least")
# are omitted because they substring-match unrelated words.
_GENERIC_HIGH = ['best', 'highest', 'greatest', 'strongest', 'superior',
                 'most effective', 'state of the art', 'sota', 'how well']
_GENERIC_LOW = ['lowest', 'shortest', 'smallest', 'fastest', 'quickest',
                'cheapest', 'minimal', 'most efficient']
# Generic quality words that route to the domain's PRIMARY success metric.
_GENERIC_QUALITY = ['performance', 'accuracy', 'quality']

def _copilot_keywords(cfg):
    """Derive the copilot's query→leaderboard keyword maps from the domain's
    benchmark config — so natural-language ranking queries ("fastest planner in a
    narrow passage") resolve to the right metric+condition for ANY domain, with no
    hand-authored per-domain keyword list. Emitted into benchmark-comparisons.json
    and consumed by the frontend's benchmark-context.js."""
    metrics = cfg.get('metrics', []) or []
    conditions = cfg.get('conditions', []) or []
    # Primary success metric (gets best/highest/performance) = first higher-is-better
    # rate, else first higher-is-better. Primary cost metric (gets fastest/lowest) =
    # first lower-is-better time metric, else first lower-is-better. One metric per
    # direction owns the bare directional words, so there are no ties.
    higher = [m for m in metrics if m.get('higher_is_better') is True]
    lower = [m for m in metrics if m.get('higher_is_better') is False]
    primary_high = next((m['id'] for m in higher if m.get('type') == 'rate'),
                        higher[0]['id'] if higher else None)
    primary_low = next((m['id'] for m in lower if m.get('type') == 'time'),
                       lower[0]['id'] if lower else None)
    metric_keywords = {}
    for m in metrics:
        kws = {m['id'].replace('_', ' ')}
        kws.update(a.lower() for a in m.get('aliases', []))
        if m['id'] == primary_high:
            kws.update(_GENERIC_HIGH)
            kws.update(_GENERIC_QUALITY)
        if m['id'] == primary_low:
            kws.update(_GENERIC_LOW)
        metric_keywords[m['id']] = sorted(kws)
    condition_keywords = {}
    for c in conditions:
        kws = {c['id'].replace('_', ' ')}
        kws.update(a.lower() for a in c.get('aliases', []))
        condition_keywords[c['id']] = sorted(kws)
    return {'metric_keywords': metric_keywords, 'condition_keywords': condition_keywords}

def build_benchmark_json(records, cfg):
    cv_thr = cfg.get('consistency', {}).get('cv_thresholds')
    min_papers = cfg.get('consistency', {}).get('min_papers_for_validation', 2)
    metric_type = {m['id']: m.get('type', 'default') for m in cfg['metrics']}
    rate_pct = {m['id'] for m in cfg['metrics']
                if m.get('type') == 'rate' and m.get('unit') == '%' and m['id'] != 'average_precision'}

    # Merge near-duplicate condition labels (e.g. one paper prints "Total" and
    # another "Total Time" for the same latency column). Canonicalizing here —
    # before grouping — lets them cross-validate instead of fragmenting, and
    # keeps the leaderboard label + per-source provenance consistent.
    cond_aliases = cfg.get('condition_aliases') or {}
    for r in records:
        if cond_aliases and r.condition in cond_aliases:
            r.condition = cond_aliases[r.condition]
        # Fraction-scale repair: lift 0-1 rates to 0-100 so a percent board never
        # mixes scales (e.g. 0.93 reported where 93% is expected).
        if r.metric_id in rate_pct and r.value is not None and 0 < r.value < 1.0:
            r.value *= 100
        # Scope a condition-less generic latency cell by its raw label so
        # inference / planning / end-to-end times don't pool in one ranking.
        if not r.condition and r.metric_id == 'latency' and r.metric_raw:
            r.condition = _time_scope(r.metric_raw)

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
            valid = [r for r in recs if r.value is not None]
            if not valid:
                continue
            # n_reports = distinct PAPERS (independent corroboration), so several
            # cells of one table never inflate it. But the CV is taken over ALL
            # values, not a per-paper representative: a per-paper median was
            # hiding *within-paper* disagreement (one paper reporting both 2232
            # and 48 ms collapsed to a single value -> cv 0 -> grade B). Over all
            # values, agreeing duplicates still give cv~0 while a paper that
            # contradicts itself surfaces as high_variance -> grade C.
            vals = [r.value for r in valid]
            # value/median come from a PER-PAPER representative (median of each
            # paper's cells), so a paper that tabulates many ablation configs
            # can't have its single cherry-picked best promoted as the headline.
            # CV stays over ALL values so within-paper disagreement still surfaces.
            by_paper = defaultdict(list)
            for r in valid:
                by_paper[r.paper_id].append(r.value)
            paper_reps = [median(vs) for vs in by_paper.values()]
            n_papers = len(by_paper)
            best = max(paper_reps) if hib else min(paper_reps)
            med = sorted(paper_reps)[len(paper_reps) // 2]
            status = classify_consistency(vals, metric_type.get(metric_id, 'default'),
                                          same_condition=True, cv_thresholds=cv_thr) if len(vals) >= 2 else None
            grade = evidence_grade(n_papers, status,
                                   any(r.verified for r in valid),
                                   max((r.extraction_conf for r in valid), default='low'))
            cv_val = round(coefficient_of_variation(vals), 3)
            entries.append({'method': method, 'value': round(best, 2),
                            'median': round(med, 2), 'n_reports': n_papers,
                            'cv': cv_val, 'grade': grade,
                            'confidence': _confidence(grade, cv_val),
                            'source_papers': sorted({r.paper_id for r in valid}),
                            'sources': [{'paper': r.paper_id, 'value_str': r.value_str,
                                         'metric_raw': r.metric_raw, 'condition': r.condition,
                                         'table_caption': r.table_caption, 'page': r.page,
                                         'extractor': r.extractor, 'crop_image': r.crop_image}
                                        for r in recs]})
        if len(entries) >= 2:
            entries.sort(key=lambda e: e['value'], reverse=hib)
            leaderboards[key] = {
                'metric_id': metric_id, 'metric_label': _metric_label(cfg, metric_id),
                'dataset_id': dataset_id or None, 'condition': condition or None,
                'higher_is_better': hib, 'entries': entries}

    # Cross-validation is now CONDITION-AWARE: it only corroborates papers that
    # report the same (method, metric, condition). Condition-agnostic pooling was
    # mixing non-comparable measurements (e.g. inference-time vs end-to-end total
    # latency) into one meaningless mean, and disagreed with the condition-scoped
    # leaderboard grade for the same method+metric.
    cross = defaultdict(list)
    for r in publishable:
        cross[(r.method_id, r.metric_id, r.dataset_id, r.condition)].append(r)
    cross_validations = []
    for (method, metric_id, dataset_id, condition), recs in cross.items():
        # Count papers ONLY over value-bearing records. A paper whose every cell
        # parsed to None (e.g. a rejected multi-number cell) must not inflate
        # n_papers — otherwise a single real value masquerades as "2 papers agree"
        # (cv=0, grade A). This mirrors the leaderboard's value-is-not-None filter.
        valued = [r for r in recs if r.value is not None]
        papers = {r.paper_id for r in valued}
        if len(papers) < min_papers:
            continue
        vals = [r.value for r in valued]
        status = classify_consistency(vals, metric_type.get(metric_id, 'default'),
                                      same_condition=True, cv_thresholds=cv_thr)
        grade = evidence_grade(len(papers), status, any(r.verified for r in valued),
                               max((r.extraction_conf for r in valued), default='low'))
        cv_val = round(coefficient_of_variation(vals), 3)
        cross_validations.append({
            'method': method, 'metric_id': metric_id,
            'metric_label': _metric_label(cfg, metric_id), 'dataset_id': dataset_id,
            'condition': condition or None, 'n_papers': len(papers),
            'mean': round(sum(vals) / len(vals), 2) if vals else None,
            'cv': cv_val, 'status': status, 'grade': grade,
            'confidence': _confidence(grade, cv_val),
            'reports': [{'paper': r.paper_id, 'value': r.value, 'value_str': r.value_str,
                         'metric_raw': r.metric_raw, 'condition': r.condition,
                         'table_caption': r.table_caption,
                         'page': r.page, 'extractor': r.extractor,
                         'crop_image': r.crop_image} for r in valued]})
    cross_validations.sort(key=lambda v: v['n_papers'], reverse=True)

    comparisons, method_index = _comparisons_and_index(publishable, cross_validations, metric_type, cv_thr)

    # n_grade_a counts grade-A CROSS-VALIDATIONS, not comparisons. A comparison is a
    # single-paper pairwise win (evidence_grade is called with n_papers=1), so by
    # construction it can never reach grade A (A requires 2+ consistent papers).
    # Counting comparisons therefore always yielded 0 even when multiple papers
    # genuinely corroborate a result. Cross-validations ARE the multi-paper surface
    # where grade A is meaningful, so the headline "grade-A" tally is taken there.
    stats = {'n_comparisons': len(comparisons), 'n_leaderboards': len(leaderboards),
             'n_methods_indexed': len(method_index), 'n_cross_validations': len(cross_validations),
             'n_grade_a': sum(1 for v in cross_validations if v['grade'] == 'A'),
             'n_quarantined': len(quarantined)}
    q_reasons = defaultdict(int)
    for r in quarantined:
        q_reasons['unsalvageable_header' if not r.metric_id else 'unresolved_method'] += 1
    return {'leaderboards': leaderboards, 'cross_validations': cross_validations,
            'comparisons': comparisons, 'method_index': method_index,
            'copilot': _copilot_keywords(cfg),
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
                    'confidence': _confidence(grade, 0.0),
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
