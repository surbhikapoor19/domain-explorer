from benchmarks.aggregate.confidence import (
    coefficient_of_variation, classify_consistency, evidence_grade)

def test_cv_basic():
    assert coefficient_of_variation([100.0, 100.0]) == 0.0
    assert round(coefficient_of_variation([90.0, 110.0]), 3) == 0.1

def test_same_condition_low_cv_is_consistent():
    assert classify_consistency([84.0, 86.0], metric_type='rate',
                                same_condition=True) == 'consistent'

def test_same_condition_high_cv_is_high_variance():
    assert classify_consistency([58.7, 86.9], metric_type='rate',
                                same_condition=True) == 'high_variance'

def test_condition_mismatch_is_different_setup_not_high_variance():
    assert classify_consistency([58.7, 86.9], metric_type='rate',
                                same_condition=False) == 'different_setup'

def test_evidence_grade_levels():
    assert evidence_grade(n_papers=3, status='consistent', verified=True,
                          extraction_conf='high') == 'A'
    assert evidence_grade(n_papers=1, status=None, verified=True,
                          extraction_conf='high') == 'B'
    assert evidence_grade(n_papers=1, status=None, verified=False,
                          extraction_conf='low') == 'C'
    assert evidence_grade(n_papers=2, status='high_variance', verified=True,
                          extraction_conf='high') == 'C'
