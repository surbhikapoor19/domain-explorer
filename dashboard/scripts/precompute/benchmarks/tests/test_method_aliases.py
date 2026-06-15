"""Config method_aliases + production wiring — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

Production (run_extraction) must pass cfg['method_aliases'] into MethodResolver so abbreviation
variants (Net vs Network) that aren't pure separator differences resolve to canonical CSV names.
Stays domain-agnostic: motion config carries its own (possibly empty) method_aliases block.
"""
import os
import csv
from benchmarks.normalize.registries import load_config, MethodResolver

CFG_DIR = os.path.join(os.path.dirname(__file__), '..', 'config')
CSV_PATH = "/Users/surbhikapoor/Desktop/WPI/wpivis/domain-explorer/datasets/csv-gp-combined.csv"


def _csv_names():
    names = []
    with open(CSV_PATH) as f:
        for row in csv.DictReader(f):
            n = (row.get('Name') or '').replace('\U0001f916 ', '').strip()
            if n:
                names.append(n)
    return names


def test_grasp_config_has_method_aliases_block():
    cfg = load_config(os.path.join(CFG_DIR, 'grasp_planning.json'))
    assert isinstance(cfg.get('method_aliases'), dict)
    assert cfg['method_aliases'], "grasp method_aliases should seed irreducible real cases"


def test_seeded_aliases_resolve_to_canonical_csv_names():
    cfg = load_config(os.path.join(CFG_DIR, 'grasp_planning.json'))
    r = MethodResolver(_csv_names(), alias_seeds=cfg.get('method_aliases'))
    assert r.resolve("EdgeGraspNet").method_id == "Edge Grasp Network"
    assert r.resolve("OrbitGrasp").method_id == "OrbitGrasp (EquiFormerV2)"
    # citation/marker stripping composes with aliasing
    assert r.resolve("EdgeGraspNet†").method_id == "Edge Grasp Network"


def test_alias_values_are_real_csv_names():
    cfg = load_config(os.path.join(CFG_DIR, 'grasp_planning.json'))
    names = set(_csv_names())
    for raw, canonical in cfg['method_aliases'].items():
        assert canonical in names, f"alias target {canonical!r} must be a real CSV Name"


def test_motion_config_has_method_aliases_key_and_resolver_builds():
    cfg = load_config(os.path.join(CFG_DIR, 'motion_planning.json'))
    assert 'method_aliases' in cfg  # present (may be empty), keeps the pipeline domain-agnostic
    r = MethodResolver(["BIT*", "RRT*"], alias_seeds=cfg.get('method_aliases'))
    assert r.resolve("RRT*").method_id == "RRT*"
