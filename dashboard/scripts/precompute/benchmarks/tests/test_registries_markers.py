"""Method-matching hardening (citation refs / marks / separators) — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. Recovers real methods printed with [refs], daggers, asterisks,
(N=k) qualifiers, and closed-vs-spaced separator variants, WITHOUT collapsing distinct methods.
(Abbreviation aliases like EdgeGraspNet -> "Edge Grasp Network" are covered by the Task-3 alias test.)
"""
from benchmarks.normalize.registries import MethodResolver

# Canonical Names as they appear in datasets/csv-gp-combined.csv
CSV = [
    "Volumetric Grasping Network (VGN)",
    "Grasp detection via Implicit Geometry and Affordance (GIGA)",
    "Grasp Pose Detection (GPD)",
    "6-DoF GraspNet",
    "Edge Grasp Network",
    "ICG-Net",
    "OrbitGrasp (EquiFormerV2)",
    "DexGrasp Anything",
]


def _r(seeds=None):
    return MethodResolver(CSV, alias_seeds=seeds)


def test_strips_citation_refs():
    r = _r()
    assert r.resolve("VGN [12]").method_id == "Volumetric Grasping Network (VGN)"
    assert r.resolve("GPD [3]").method_id == "Grasp Pose Detection (GPD)"
    assert r.resolve("GIGA [13]").method_id == "Grasp detection via Implicit Geometry and Affordance (GIGA)"


def test_strips_daggers_and_asterisks():
    r = _r()
    assert r.resolve("OrbitGrasp*").method_id == "OrbitGrasp (EquiFormerV2)"
    assert r.resolve("GIGA†").method_id == "Grasp detection via Implicit Geometry and Affordance (GIGA)"


def test_separator_insensitive_exact_match():
    r = _r()
    # closed-compound vs hyphenated, same tokens -> must unify
    assert r.resolve("ICGNet").method_id == "ICG-Net"
    # already-canonical-with-separators still resolves
    assert r.resolve("6-DoF GraspNet").method_id == "6-DoF GraspNet"


def test_does_not_collapse_distinct_methods():
    r = _r()
    # >=5-char nospace gate must NOT fuse these two different methods
    assert r.resolve("DexGraspNet2").method_id != "DexGrasp Anything"


def test_genuinely_external_methods_stay_unresolved():
    r = _r()
    # not in our CSV -> must remain None (never force-matched)
    assert r.resolve("GSNet [14]").method_id is None
    assert r.resolve("SE(3)-Dif [15]").method_id is None


def test_empty_normalizing_cells_never_crown_a_method():
    """A cell that normalizes to NOTHING (markers, citation-only, "baselines",
    "(n=5)", bare whitespace, a stray "%") must resolve to None — never the first
    registry method. The fuzzy `n in key` branch treated '' as a substring of every
    name, silently attributing junk first-column cells to one real method."""
    r = _r()
    for junk in ['baselines', 'baseline', '[1, 2]', '✓', '✗', '(n=5)', '*†', '   ', '%']:
        assert r.resolve(junk).method_id is None, f"{junk!r} must NOT crown a method"
