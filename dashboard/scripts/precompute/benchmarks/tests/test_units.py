from benchmarks.normalize.units import parse_value

def test_parses_plain_number():
    assert parse_value("84.3") == (84.3, None, None)

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
