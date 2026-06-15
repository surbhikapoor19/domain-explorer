import statistics

DEFAULT_CV = {"rate": 0.10, "time": 0.20, "count": 0.15, "default": 0.15}

def coefficient_of_variation(values):
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return 0.0
    mean = statistics.mean(vals)
    if mean == 0:
        return 0.0
    return statistics.pstdev(vals) / abs(mean)

def classify_consistency(values, metric_type='default', same_condition=True,
                         cv_thresholds=None):
    """Returns 'consistent' | 'high_variance' | 'different_setup'."""
    if not same_condition:
        return 'different_setup'
    thr = (cv_thresholds or DEFAULT_CV).get(metric_type,
            (cv_thresholds or DEFAULT_CV).get('default', 0.15))
    return 'consistent' if coefficient_of_variation(values) <= thr else 'high_variance'

def evidence_grade(n_papers, status, verified, extraction_conf):
    """A = 2+ papers, consistent, verified; B = single verified consistent source;
    C = weak/unverified extraction OR any disagreement (within OR across papers).

    NOTE: 'high_variance' / 'different_setup' force C even for a single paper — a
    paper whose own cells for one metric+condition disagree (e.g. 2232 vs 48 ms)
    must not be passed off as a solid grade-B source."""
    if extraction_conf == 'low' or not verified:
        return 'C'
    if status in ('high_variance', 'different_setup'):
        return 'C'
    if n_papers >= 2 and status == 'consistent':
        return 'A'
    if n_papers == 1:
        return 'B'
    return 'C'
