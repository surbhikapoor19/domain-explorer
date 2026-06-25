from benchmarks.normalize.units import parse_value, clean_value_str

def test_parses_plain_number():
    assert parse_value("84.3") == (84.3, None, None)

def test_clean_value_str_collapses_ocr_decimal_spaces():
    # OCR/TEI tokenization inserts spaces around the decimal point; cleaning makes
    # the displayed provenance string match the parsed number, without altering it.
    assert clean_value_str("17 . 7 ± 2 . 3") == "17.7 ± 2.3"
    assert clean_value_str("80 . 2") == "80.2"
    assert clean_value_str("100") == "100"            # nothing to clean
    assert clean_value_str(None) is None              # falsy passthrough
    assert clean_value_str("7ms 30ms") == "7ms 30ms"  # no decimal-space artifact

def test_parses_mean_std():
    v, std, unit = parse_value("75.2 ± 2.2")
    assert v == 75.2 and std == 2.2

def test_parses_percent_unit():
    v, std, unit = parse_value("92.3%")
    assert v == 92.3 and unit == "%"

def test_parses_value_with_fraction_suffix():
    v, std, unit = parse_value("86.9 (73 / 84)")
    assert v == 86.9

def test_rejects_non_numeric():
    assert parse_value("N/A") == (None, None, None)
    assert parse_value("-") == (None, None, None)


def test_repairs_tei_decimal_spacing():
    # TEI tokenization writes "85 . 3 ± 1 . 9"; the fractional digit must survive
    v, std, unit = parse_value("85 . 3 ± 1 . 9")
    assert v == 85.3 and std == 1.9


def test_rejects_multistage_timing_cell():
    # a single cell holding several per-stage latencies is NOT one value
    assert parse_value("7ms 30ms 66ms 34ms 306ms 138ms") == (None, None, None)


def test_rejects_paired_ratio_cell():
    assert parse_value("843/685") == (None, None, None)


def test_single_value_with_unit_still_parses():
    assert parse_value("846.43ms")[0] == 846.43
    assert parse_value("41.08")[0] == 41.08
