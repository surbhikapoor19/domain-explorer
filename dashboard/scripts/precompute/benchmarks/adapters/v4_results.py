from benchmarks.types import ResultRecord
from benchmarks.normalize.registries import MetricRegistry, ConditionRegistry
from benchmarks.normalize.units import parse_value


def _mk(method_id, metric_raw, value, value_str, paper, mreg, creg,
        is_own=False, caption=""):
    cond = creg.resolve(metric_raw)
    metric_input = "success rate" if cond else metric_raw
    mh = mreg.resolve(metric_input)
    v, std, unit = parse_value(value_str if value_str else str(value))
    return ResultRecord(
        paper_id=paper, method_raw=method_id, method_id=method_id,
        metric_raw=metric_raw, metric_id=mh.id, unit=mh.unit or unit,
        higher_is_better=mh.higher_is_better, condition=cond,
        value=value if value is not None else v, value_str=value_str or str(value),
        std_dev=std, is_own_method=is_own, extractor="tei_table",
        table_caption=caption, extraction_conf="medium", verified=True)


def records_from_v4(v4, cfg):
    mreg, creg = MetricRegistry(cfg), ConditionRegistry(cfg)
    recs = []
    for p in v4.get("outperforms_both_csv", []):
        recs.append(_mk(p["winner_csv"], p.get("metric", ""), p.get("winner_val"),
                        "", p.get("paper", ""), mreg, creg, is_own=True))
        recs.append(_mk(p["loser_csv"], p.get("metric", ""), p.get("loser_val"),
                        "", p.get("paper", ""), mreg, creg))
    for key, reports in v4.get("cross_paper", {}).items():
        method_id, _, metric_raw = key.rpartition("|")
        for r in reports:
            recs.append(_mk(method_id, metric_raw, r.get("value"),
                            r.get("raw", ""), r.get("paper", ""), mreg, creg))
    return recs
