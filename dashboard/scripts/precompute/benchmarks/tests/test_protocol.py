"""Tests for protocol parsing (the #1 protocol-aware cell-keying core).

A grasp number is only comparable to another under the SAME experimental
protocol. The protocol is STATED in the column header (metric_raw) and the table
caption, so we parse it from those two fields ONLY and fold it into the cell's
condition token list. Honesty rule: an axis we cannot determine emits NO token
(it groups with other unknowns; never assumed, never merged into a known one).

Captions/headers below are verbatim from the live grasp corpus.
"""

from benchmarks.normalize.protocol import (
    parse_protocol, protocol_tokens, append_protocol,
    caption_copy_status, is_caption_copied, PROTOCOL_AXIS_ORDER,
)


# ── parse_protocol: the real captions ────────────────────────────────────────

def test_fixed_camera_gamma_noise_caption():
    p = parse_protocol(
        "GSR (%)",
        "TABLE I: Clutter removal performance under single-view, fixed camera "
        "pose, and gamma noise conditions. We report the mean and standard "
        "deviation of GSR and DR.")
    assert p['view'] == 'fixed_view'
    assert p['noise'] == 'gamma_noise'
    assert p['sim_real'] is None      # not stated -> unknown, never assumed
    assert p['object_set'] is None
    assert p['retrain'] is None


def test_random_camera_gaussian_noise_caption():
    p = parse_protocol(
        "GSR (%)",
        "TABLE II: Clutter removal performance under single-view, random camera "
        "pose, and Gaussian noise conditions.")
    assert p['view'] == 'random_view'
    assert p['noise'] == 'gauss_noise'


def test_real_world_caption():
    p = parse_protocol(
        "GSR (%)",
        "TABLE V: Grasping performance in real-world scenes over 12 scene "
        "decluttering rounds")
    assert p['sim_real'] == 'real'


def test_egad_no_retrain_caption_is_ood():
    p = parse_protocol(
        "GSR (%)",
        "TABLE III: Grasping performance in simulated Pile scenes with objects "
        "from the EGAD [43] dataset. The networks are not re-trained but "
        "directly tested on EGAD objects of different complexities (5 seeds)")
    assert p['sim_real'] == 'sim'
    assert p['object_set'] == 'egad'
    assert p['retrain'] == 'no_retrain'   # OOD / zero-shot transfer flag


def test_view_parsed_from_metric_raw_column_header():
    # The column header alone carries the view; the caption need not repeat it.
    p = parse_protocol("Packed scenes (Random View) | GSR (%)", "")
    assert p['view'] == 'random_view'


def test_partnet_random_view_caption():
    p = parse_protocol(
        "GSR (%)",
        "TABLE IV: Grasping & affordance prediction performance in random-view "
        "scenes with PartNet objects [19] (5 seeds)")
    assert p['view'] == 'random_view'
    assert p['object_set'] == 'partnet'


def test_non_protocol_caption_yields_nothing():
    # A plain caption with no protocol words must add NO tokens -> existing cells
    # do not churn, do not falsely split.
    p = parse_protocol("Success Rate", "Table 2: SR on pile (%)")
    assert p == {'sim_real': None, 'view': None, 'noise': None,
                 'object_set': None, 'retrain': None}


def test_empty_and_none_inputs_safe():
    assert parse_protocol(None, None) == {
        'sim_real': None, 'view': None, 'noise': None,
        'object_set': None, 'retrain': None}
    assert parse_protocol("", "") == {
        'sim_real': None, 'view': None, 'noise': None,
        'object_set': None, 'retrain': None}


# ── protocol_tokens: deterministic, ordered, skips unknown axes ───────────────

def test_protocol_tokens_ordered_and_skips_unknown():
    p = {'sim_real': 'sim', 'view': 'random_view', 'noise': None,
         'object_set': 'egad', 'retrain': 'no_retrain'}
    toks = protocol_tokens(p)
    assert toks == ['sim', 'randomview', 'egad', 'noretrain']  # canonical axis order, noise skipped


def test_protocol_tokens_empty_when_all_unknown():
    assert protocol_tokens(parse_protocol("x", "y")) == []


def test_axis_order_constant_is_stable():
    assert PROTOCOL_AXIS_ORDER == ['sim_real', 'view', 'noise', 'object_set', 'retrain']


# ── append_protocol: tokens are APPENDED, existing condition preserved ────────

def test_append_protocol_to_existing_condition():
    assert append_protocol("packed:gsr", ['real', 'randomview']) == "packed:gsr:real:randomview"


def test_append_protocol_to_empty_condition():
    assert append_protocol(None, ['real']) == "real"
    assert append_protocol("", ['sim', 'egad']) == "sim:egad"


def test_append_protocol_no_tokens_is_noop():
    assert append_protocol("packed", []) == "packed"
    assert append_protocol(None, []) is None
    assert append_protocol("", []) in (None, "")


def test_append_protocol_does_not_duplicate_existing_token():
    # If the scene/condition already names a token the protocol also produced,
    # it must not appear twice (idempotent on the token set).
    assert append_protocol("real", ['real']) == "real"


# ── caption_copy_status / is_caption_copied (#3 caption-based copied baseline) ─

def test_caption_except_clause_marks_others_copied():
    cap = ("TABLE II: Clutter removal performance under single-view, random "
           "camera pose, and Gaussian noise conditions. The results except "
           "EquiGIGA and EquiIGD are from [20] and [6] since we use the same "
           "experiment settings.")
    mode, names = caption_copy_status(cap)
    assert mode == 'except'
    # the two named methods are the paper's OWN (NOT copied); everything else is
    assert is_caption_copied("EquiGIGA", cap) is False
    assert is_caption_copied("EquiIGD", cap) is False
    assert is_caption_copied("VGN", cap) is True
    assert is_caption_copied("GIGA", cap) is True


def test_caption_starred_results_are_ambiguous_not_blanket():
    # '*' marks copied rows per-row; markers are stripped at extraction so we
    # CANNOT attribute -> ambiguous (do NOT blanket-flag; value-identical detector
    # still catches byte-identical copies).
    cap = ("TABLE I: Clutter removal performance under single-view, fixed camera "
           "pose, and gamma noise conditions. '*' denotes the results are from "
           "[2] since we use the same experiment settings.")
    mode, _ = caption_copy_status(cap)
    assert mode == 'ambiguous'
    assert is_caption_copied("VGN", cap) is False   # cannot attribute -> not flagged


def test_caption_blanket_results_are_from_ref():
    cap = "Table X: The results are from [9]."
    mode, _ = caption_copy_status(cap)
    assert mode == 'all'
    assert is_caption_copied("anything", cap) is True


def test_plain_benchmark_citation_is_not_a_copy():
    # A benchmark/dataset citation like "[5]" is NOT a copied-results admission.
    cap = "TABLE I: Comparative results of NeuGraspNet vs. baselines on Pile and Packed scenes [5] (5 seeds)"
    mode, _ = caption_copy_status(cap)
    assert mode is None
    assert is_caption_copied("VGN", cap) is False


def test_caption_copy_status_safe_on_empty():
    assert caption_copy_status("") == (None, None)
    assert caption_copy_status(None) == (None, None)
    assert is_caption_copied("M", None) is False
