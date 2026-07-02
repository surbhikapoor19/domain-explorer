import json, os, re
from collections import defaultdict
from statistics import median
from benchmarks.aggregate.confidence import (
    coefficient_of_variation, classify_consistency, evidence_grade)
from benchmarks.normalize.protocol import enrich_condition, is_caption_copied

CONF_BASE = {'A': 0.92, 'B': 0.78, 'C': 0.45}

# ── Result-cleanup (validation) for the full `results` set ────────────────────
# The uncomparable results recovered from quarantine include noise (partly why they
# were quarantined): citation-marked method names, values leaked into headers,
# conditions parsed as metrics, bare abbreviations, dataset-size stats. These
# helpers clean the presentable ones and DROP the junk — domain-agnostic (signal-
# based, no hardcoded method/metric names).
_UNIT_RE = re.compile(r'[(\[]\s*(?:%|ms|s|cm|mm|m|km|g|kg|mg|fps|hz|khz|db|bits?|px|rad|deg|°|j|w|n)\b', re.I)
_METRIC_WORD_RE = re.compile(
    r'\b(rate|success|precision|recall|accuracy|acc|time|latency|error|err|depth|'
    r'penetration|entropy|cost|score|iou|map|ap|f1|coverage|quality|distance|dist|'
    r'throughput|speed|mae|rmse|mse|psnr|ssim|auc|ugr|completion|declutter|clearance|'
    r'reward|return|epe|chamfer|collision|smoothness|jerk|energy|torque|force|'
    r'displacement|deviation|margin|ratio|percentage|number|count|steps?)\b', re.I)
_CONDITION_WORDS = {'pile', 'piled', 'packed', 'isolated', 'singulated', 'sim',
                    'simulation', 'simulated', 'real', 'cluttered', 'clutter'}

def clean_method_name(m):
    m = re.sub(r'\s*\[\d+(?:\s*[,;]\s*\d+)*\]', '', str(m or ''))   # citation markers [4], [3;5]
    m = re.sub(r'\bet\s+al\.?\b', '', m, flags=re.I)
    m = re.sub(r'[\*†‡]', '', m)                          # footnote daggers/asterisks
    return re.sub(r'\s{2,}', ' ', m).strip(' ,;:·-')

def clean_metric_label(l):
    l = re.sub(r'[↑↓∆∇]', '', str(l or ''))     # ↑ ↓ ∆ ∇
    return re.sub(r'\s{2,}', ' ', l).strip(' ,;:|-')

def is_valid_metric_label(label, metric_id):
    """A recognized metric is always valid. An unrecognized one is kept only if it
    LOOKS like a metric (has a unit or a metric keyword) and isn't a value, a bare
    condition, or 1-2 chars of noise — so junk headers don't become filter options."""
    if metric_id:
        return True
    l = (label or '').strip()
    if len(l) <= 2:
        return False
    if re.fullmatch(r'[\d.,%±()\s/+\-]+', l):        # a value leaked into the header
        return False
    if l.lower() in _CONDITION_WORDS:                # a condition, not a metric
        return False
    return bool(_UNIT_RE.search(l) or _METRIC_WORD_RE.search(l))

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

def _suspected_copy(valued):
    """True when >=2 distinct papers report a byte-identical value AND stddev — a
    baseline number quoted verbatim (citation copy), not independent corroboration.
    Such 'agreement' yields cv=0 and would otherwise earn a false grade A."""
    papers = {r.paper_id for r in valued}
    sigs = {(r.value, r.std_dev) for r in valued}
    return len(papers) >= 2 and len(sigs) == 1 and next(iter(sigs))[1] is not None


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
    # Protocol-aware cell keying (#1): fold the experimental protocol parsed from
    # the column header + caption (sim vs real, fixed vs random camera view, gamma
    # vs Gaussian noise, EGAD object set, OOD no-retrain) into the condition token
    # list, so incomparable protocols never pool into one ranked column. ON by
    # default; the migration runs it OFF once to prove faithful reconstruction.
    protocol_on = cfg.get('protocol_aware_conditions', True)
    copied_on = cfg.get('caption_copied_detection', True)   # #3; gated for the migration's faithfulness pass
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
        # Append the parsed protocol tokens LAST (after aliasing + time-scoping),
        # so an unparseable protocol leaves the existing condition untouched.
        if protocol_on:
            r.condition = enrich_condition(r.condition, r.metric_raw, r.table_caption)

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
            med = median(paper_reps)  # true median (the manual [n//2] index was wrong for even n)
            status = classify_consistency(vals, metric_type.get(metric_id, 'default'),
                                          same_condition=True, cv_thresholds=cv_thr) if len(vals) >= 2 else None
            grade = evidence_grade(n_papers, status,
                                   any(r.verified for r in valid),
                                   max((r.extraction_conf for r in valid), default='low'))
            entry_copied = _suspected_copy(valid)
            # #3 caption-based copied baseline: a number whose own caption admits
            # it was re-quoted from another paper ("results ... are from [N]") is
            # not an independent measurement, so it cannot earn grade-A
            # corroboration even when the values are not byte-identical.
            entry_caption_copied = copied_on and any(is_caption_copied(method, r.table_caption) for r in valid)
            if (entry_copied or entry_caption_copied) and grade == 'A':
                grade = 'B'  # citation copy, not corroboration
            cv_val = round(coefficient_of_variation(vals), 3)
            # HEADLINE = the per-paper MEDIAN (honest central estimate), not the
            # cherry-picked best run. The optimistic max is kept as `best` so it is
            # not lost, just demoted. This makes leaderboards rank by median (the
            # sort key is `value`), fixing the "ranks #1 on its best run while its
            # median is mid-pack" dishonesty.
            entries.append({'method': method, 'value': round(med, 2),
                            'best': round(best, 2),
                            'median': round(med, 2), 'n_reports': n_papers,
                            'cv': cv_val, 'grade': grade,
                            'confidence': _confidence(grade, cv_val),
                            'corroboration': ('identical_values_suspected_copy' if entry_copied
                                              else 'caption_copied_baseline' if entry_caption_copied
                                              else 'independent'),
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
        cv_copied = _suspected_copy(valued)
        # #3 caption-based copied baseline (see leaderboard loop): re-quoted numbers
        # are not independent corroboration even when not byte-identical.
        cv_caption_copied = copied_on and any(is_caption_copied(method, r.table_caption) for r in valued)
        if (cv_copied or cv_caption_copied) and grade == 'A':
            grade = 'B'  # citation copy, not corroboration
        cross_validations.append({
            'method': method, 'metric_id': metric_id,
            'metric_label': _metric_label(cfg, metric_id), 'dataset_id': dataset_id,
            'condition': condition or None, 'n_papers': len(papers),
            'mean': round(sum(vals) / len(vals), 2) if vals else None,
            'cv': cv_val, 'status': status, 'grade': grade,
            'confidence': _confidence(grade, cv_val),
            'corroboration': 'identical_values_suspected_copy' if cv_copied else 'independent',
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
    # n_methods_indexed = distinct methods with ANY published number (a leaderboard
    # entry, a cross-validation, or a comparison) — not just those that reached a
    # pairwise comparison. len(method_index) undercounted (the index is the
    # comparison/cv surface), reading "11 methods" when 25 actually have data.
    indexed_methods = {e['method'] for lb in leaderboards.values() for e in lb['entries']}
    indexed_methods.update(v['method'] for v in cross_validations)
    for c in comparisons:
        indexed_methods.add(c['winner']); indexed_methods.add(c['loser'])
    stats = {'n_comparisons': len(comparisons), 'n_leaderboards': len(leaderboards),
             'n_methods_indexed': len(indexed_methods), 'n_cross_validations': len(cross_validations),
             'n_grade_a': sum(1 for v in cross_validations if v['grade'] == 'A'),
             'n_quarantined': len(quarantined)}
    q_reasons = defaultdict(int)
    unresolved_headers = defaultdict(int)   # column text we could not map to a metric
    unresolved_methods = defaultdict(int)   # method names we could not resolve
    for r in quarantined:
        if not r.metric_id:
            q_reasons['unsalvageable_header'] += 1
            h = (r.metric_raw or '').strip()
            if h:
                unresolved_headers[h] += 1
        else:
            q_reasons['unresolved_method'] += 1
            mname = (r.method_raw or '').strip()
            if mname:
                unresolved_methods[mname] += 1
    # Lumi-style diagnosable failure: instead of an opaque count, surface the
    # DISTINCT raw headers/methods that were dropped (top 50 by frequency) so the
    # quarantine can be audited — is a dropped "header" actually an unmapped metric
    # that just needs a registry alias, or genuinely a non-metric column? Without
    # this the 3k+ quarantined records are an unexaminable black box.
    def _top(counter, n=50):
        return [{'raw': k, 'count': v}
                for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]

    # ── FULL RESULT SET ───────────────────────────────────────────────────────
    # The Benchmarks page is a FILTERABLE TABLE of every extracted number, not a
    # leaderboard — so emit ONE record per value-bearing extraction, INCLUDING the
    # results whose metric or method isn't in the comparable registry (previously
    # quarantined and lost). Each carries a human-readable metric label + its
    # protocol/condition, so nothing is silently dropped. `leaderboards` and
    # `cross_validations` remain the DERIVED comparable-subset views; `results` is
    # the complete data the page filters over.
    results = []
    n_dropped_noise = 0
    for r in records:
        if r.value is None:
            continue
        # Clean + validate (drops citation-marked junk, values-as-headers, bare
        # abbreviations, condition-as-metric — see helpers above).
        method_name = r.method_id or clean_method_name(r.method_raw)
        if not (method_name and len(str(method_name).strip()) > 1):
            n_dropped_noise += 1
            continue
        raw_label = _metric_label(cfg, r.metric_id) if r.metric_id else (r.metric_raw or '')
        metric_label = clean_metric_label(raw_label)
        if not is_valid_metric_label(metric_label, r.metric_id):
            n_dropped_noise += 1
            continue
        results.append({
            'method': method_name,
            'method_resolved': bool(r.method_id),
            'metric_id': r.metric_id,                 # None when uncomparable
            'metric_label': metric_label,             # always human-readable
            'metric_raw': r.metric_raw,
            'value': round(r.value, 4),
            'value_str': r.value_str,
            'unit': r.unit,
            'higher_is_better': r.higher_is_better,
            'dataset_id': r.dataset_id,
            'dataset_raw': r.dataset_raw,
            'condition': r.condition or None,
            # comparable = sits in a leaderboard-eligible (known metric+method) bucket
            'comparable': bool(r.metric_id and r.method_id),
            # a lone extracted number graded by its own extraction confidence only
            # (multi-paper corroboration lives in cross_validations, never claimed here)
            'grade': evidence_grade(1, None, r.verified, r.extraction_conf or 'low'),
            'is_own_method': r.is_own_method,
            'paper_id': r.paper_id,
            'table_caption': r.table_caption,
            'page': r.page,
            'extractor': r.extractor,
            'crop_image': r.crop_image,
            'section_label': r.section_label,
        })
    results.sort(key=lambda x: (str(x['method']).lower(), str(x['metric_label']).lower()))
    stats['n_results'] = len(results)
    stats['n_results_dropped_noise'] = n_dropped_noise

    return {'leaderboards': leaderboards, 'cross_validations': cross_validations,
            'comparisons': comparisons, 'method_index': method_index,
            'results': results,
            'copilot': _copilot_keywords(cfg),
            'quarantine': {'n_records': len(quarantined), 'reasons': dict(q_reasons),
                           'unresolved_headers': _top(unresolved_headers),
                           'unresolved_methods': _top(unresolved_methods)},
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
                if own.method_id == oth.method_id:
                    continue  # a method never "beats" itself — ablation rows are not head-to-head wins
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
