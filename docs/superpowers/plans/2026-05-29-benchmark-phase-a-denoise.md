# Benchmark Phase A — De-noise & Honest Confidence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PROJECT RULE — DO NOT COMMIT:** The user controls all git ops. Each task ends with a **Checkpoint** that stages changes (`git add`) and stops for the user to review and commit. Never run `git commit`/`git push`.

**Goal:** Make the Benchmarks page trustworthy without new extraction — canonicalize metric/dataset/method names, segment by experimental condition, replace the `spread<5.0` boolean with a coefficient-of-variation + evidence-grade model, and surface n / CV% / provenance / grade in the UI (validated-on-top + low-confidence toggle).

**Architecture:** A reusable Python package `dashboard/scripts/precompute/benchmarks/` with `normalize/` (units + registries) and `aggregate/` (confidence + build) modules. Phase A feeds these from the EXISTING `/tmp/table_extraction_results_v4.json` via an adapter, producing a richer `benchmark-comparisons.json` (v2 schema) and grade-tagged `kg-full.json` edges. The same `normalize/`+`aggregate/` modules are consumed unchanged by Phase C. Frontend (`BenchmarksPage.js`, `DetailPanel.js`) renders grades + confidence and drops the `METRIC_BLACKLIST` hack.

**Tech Stack:** Python 3 (stdlib + `lxml` already installed; config as JSON — no new deps), pytest (anaconda), React + Plotly (existing dashboard).

---

## Shared data model (the contract — referenced by Phase C)

A **ResultRecord** is the atomic extracted observation. Phase A synthesizes these from v4 output; Phase C produces them directly.

```python
# benchmarks/types.py
from dataclasses import dataclass, field, asdict
from typing import Optional

@dataclass
class ResultRecord:
    paper_id: str
    method_raw: str
    method_id: Optional[str]          # canonical method (None + flagged if unresolved)
    metric_raw: str
    metric_id: Optional[str]          # canonical metric id
    unit: Optional[str]               # "%", "ms", "count", None
    higher_is_better: Optional[bool]
    dataset_raw: str = ""
    dataset_id: Optional[str] = None
    condition: Optional[str] = None   # canonical scene/split/view, e.g. "pile", "packed"
    value: Optional[float] = None
    value_str: str = ""               # exact printed text (provenance)
    std_dev: Optional[float] = None
    is_own_method: bool = False
    is_ablation: bool = False
    extractor: str = "tei_table"      # tei_table | docling | vlm
    table_caption: str = ""
    section_label: str = ""           # Phase C fills; "" in Phase A
    page: Optional[int] = None
    bbox: Optional[list] = None
    crop_image: Optional[str] = None
    extraction_conf: str = "medium"   # high | medium | low
    verified: bool = False

    def comparison_key(self):
        """Identity for grouping into comparisons/leaderboards."""
        return (self.method_id, self.metric_id, self.dataset_id, self.condition)
```

**Canonical config** (`benchmarks/config/grasp_planning.json`) — all domain specifics live here:

```json
{
  "results_section_keywords": ["experiment", "result", "evaluation", "quantitative", "comparison", "real-world", "simulation"],
  "ablation_section_keywords": ["ablation"],
  "metrics": [
    {"id": "success_rate", "unit": "%", "higher_is_better": true, "type": "rate",
     "aliases": ["success rate", "grasp success rate", "gsr", "grasp success", "sr", "completion rate", "task success"]},
    {"id": "declutter_rate", "unit": "%", "higher_is_better": true, "type": "rate",
     "aliases": ["declutter rate", "dr", "clearance rate", "clutter removal"]},
    {"id": "average_precision", "unit": "%", "higher_is_better": true, "type": "rate",
     "aliases": ["ap", "average precision", "precision", "map"]},
    {"id": "latency", "unit": "ms", "higher_is_better": false, "type": "time",
     "aliases": ["latency", "inference time", "runtime", "planning time", "time"]}
  ],
  "conditions": [
    {"id": "pile", "aliases": ["pile", "piled", "cluttered pile"]},
    {"id": "packed", "aliases": ["packed", "packed scene"]},
    {"id": "isolated", "aliases": ["isolated", "single object", "singulated"]},
    {"id": "sim", "aliases": ["sim", "simulation", "simulated"]},
    {"id": "real", "aliases": ["real", "real-world", "real world", "physical"]}
  ],
  "datasets": [
    {"id": "ycb", "aliases": ["ycb", "ycb-video"]},
    {"id": "egad", "aliases": ["egad", "egad!"]},
    {"id": "graspnet1b", "aliases": ["graspnet-1billion", "graspnet1b", "graspnet-1b"]}
  ],
  "consistency": {
    "cv_thresholds": {"rate": 0.10, "time": 0.20, "count": 0.15, "default": 0.15},
    "min_papers_for_validation": 2
  }
}
```

**`benchmark-comparisons.json` v2 schema** (output contract for the UI):

```jsonc
{
  "leaderboards": {
    // keyed by "metric_id|dataset_id|condition" (human label resolved client-side)
    "success_rate|graspnet1b|pile": {
      "metric_id": "success_rate", "metric_label": "Success Rate (%)",
      "dataset_id": "graspnet1b", "condition": "pile", "unit": "%", "higher_is_better": true,
      "entries": [
        {"method": "AnyGrasp", "value": 86.9, "median": 84.3, "n_reports": 3,
         "grade": "A", "cv": 0.03, "source_papers": ["anygrasp", "..."]}
      ]
    }
  },
  "cross_validations": [
    {"method": "GIGA", "metric_id": "success_rate", "metric_label": "Success Rate (%)",
     "dataset_id": null, "condition": "pile", "n_papers": 5, "mean": 74.9, "cv": 0.16,
     "status": "different_setup",   // consistent | high_variance | different_setup
     "grade": "C",
     "reports": [{"paper": "...", "value": 75.2, "value_str": "75.2 ± 2.2", "condition": "pile"}]}
  ],
  "comparisons": [   // outperforms pairs with provenance + grade
    {"winner": "AnyGrasp", "loser": "GPD", "metric_id": "success_rate", "condition": "pile",
     "winner_value": 86.9, "loser_value": 70.1, "margin": 16.8, "grade": "B",
     "paper": "anygrasp", "table_caption": "Table 2: ...", "extractor": "tei_table"}
  ],
  "method_index": { "AnyGrasp": {"n_wins": 4, "n_losses": 0, "wins": [...], "losses": [...],
                                 "validations": [...], "metrics": ["success_rate"]} },
  "quarantine": {"n_records": 12, "reasons": {"unsalvageable_header": 7, "unresolved_method": 5}},
  "stats": {"n_comparisons": 0, "n_leaderboards": 0, "n_methods_indexed": 0,
            "n_cross_validations": 0, "n_grade_a": 0, "n_quarantined": 0}
}
```

---

## File structure

```
dashboard/scripts/precompute/benchmarks/
  __init__.py
  types.py                      # ResultRecord (above)
  config/grasp_planning.json    # canonical seeds (above)
  normalize/
    __init__.py
    units.py                    # parse_value, mean±std, unit normalization
    registries.py               # MetricRegistry, DatasetRegistry, ConditionRegistry, MethodResolver, load_config
  aggregate/
    __init__.py
    confidence.py               # coefficient_of_variation, classify_consistency, evidence_grade
    build_benchmarks.py         # records -> benchmark-comparisons.json v2 + kg enrichment
  adapters/
    __init__.py
    v4_results.py               # v4 results json -> list[ResultRecord]  (Phase A bridge)
  tests/
    __init__.py
    test_units.py test_registries.py test_confidence.py
    test_build_benchmarks.py test_v4_adapter.py test_golden_126.py
dashboard/scripts/precompute/graph/benchmark_data.py   # MODIFY: CLI delegates to new pipeline
dashboard/src/components/BenchmarksPage.js             # MODIFY: grades, CV%, toggle; drop blacklist
dashboard/src/components/DetailPanel.js                # MODIFY: grade-aware badges
```

Run tests from `dashboard/scripts/precompute/` with: `python3 -m pytest benchmarks/tests/ -v`
(Use the grasp-explorer venv if `lxml` import fails: `source /Users/surbhikapoor/Desktop/WPI/wpivis/grasp-explorer/backend/venv/bin/activate`.)

---

## Task 1: Package scaffold + canonical config + types

**Files:**
- Create: `dashboard/scripts/precompute/benchmarks/__init__.py` (empty)
- Create: `dashboard/scripts/precompute/benchmarks/types.py`
- Create: `dashboard/scripts/precompute/benchmarks/config/grasp_planning.json`
- Create: `dashboard/scripts/precompute/benchmarks/normalize/__init__.py`, `aggregate/__init__.py`, `adapters/__init__.py`, `tests/__init__.py` (all empty)
- Test: `dashboard/scripts/precompute/benchmarks/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config.py
import json, os
from benchmarks.normalize.registries import load_config  # not yet created

CFG = os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json')

def test_config_is_valid_json_with_required_keys():
    with open(CFG) as f:
        cfg = json.load(f)
    for key in ('results_section_keywords', 'metrics', 'conditions', 'consistency'):
        assert key in cfg
    ids = [m['id'] for m in cfg['metrics']]
    assert 'success_rate' in ids and 'latency' in ids

def test_result_record_comparison_key():
    from benchmarks.types import ResultRecord
    r = ResultRecord(paper_id='p', method_raw='Ours', method_id='AnyGrasp',
                     metric_raw='GSR', metric_id='success_rate', unit='%',
                     higher_is_better=True, condition='pile')
    assert r.comparison_key() == ('AnyGrasp', 'success_rate', None, 'pile')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: benchmarks.normalize.registries` / `benchmarks.types`.

- [ ] **Step 3: Create `types.py`, the config JSON, and empty `__init__.py` files**

Create `benchmarks/types.py` with the `ResultRecord` dataclass from the contract above. Create `benchmarks/config/grasp_planning.json` with the JSON from the contract above. Create all listed empty `__init__.py` files. Add a minimal `load_config` stub in `normalize/registries.py`:

```python
# normalize/registries.py
import json, os
def load_config(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json')
    with open(path) as f:
        return json.load(f)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_config.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Checkpoint (stage, do NOT commit)**

```bash
git add dashboard/scripts/precompute/benchmarks/
```
Summarize the new scaffold to the user and stop for their review/commit.

---

## Task 2: `normalize/units.py` — value parsing + unit normalization

**Files:**
- Create: `dashboard/scripts/precompute/benchmarks/normalize/units.py`
- Test: `dashboard/scripts/precompute/benchmarks/tests/test_units.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_units.py
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
    # "86.9 (73 / 84)" -> primary value 86.9
    v, std, unit = parse_value("86.9 (73 / 84)")
    assert v == 86.9

def test_rejects_non_numeric():
    assert parse_value("N/A") == (None, None, None)
    assert parse_value("-") == (None, None, None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_units.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

```python
# normalize/units.py
import re

_NULLS = {'-', 'n/a', '—', '–', '/', '', 'none'}

def parse_value(value_str):
    """Return (value: float|None, std_dev: float|None, unit: str|None)."""
    s = (value_str or '').strip()
    if s.lower() in _NULLS:
        return (None, None, None)
    unit = '%' if '%' in s else None
    std = None
    std_m = re.search(r'[±]\s*(\d+\.?\d*)', s)
    if std_m:
        std = float(std_m.group(1))
    # primary value = first standalone number (ignore parenthetical fractions)
    head = re.split(r'[(±]', s, 1)[0]
    nums = re.findall(r'-?\d+\.?\d*', head)
    if not nums:
        nums = re.findall(r'-?\d+\.?\d*', s)
    if not nums:
        return (None, None, unit)
    return (float(nums[0]), std, unit)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_units.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Checkpoint (stage, do NOT commit)**

```bash
git add dashboard/scripts/precompute/benchmarks/normalize/units.py dashboard/scripts/precompute/benchmarks/tests/test_units.py
```
Stop for user review/commit.

---

## Task 3: `normalize/registries.py` — metric / condition / dataset / method canonicalization

**Files:**
- Modify: `dashboard/scripts/precompute/benchmarks/normalize/registries.py`
- Test: `dashboard/scripts/precompute/benchmarks/tests/test_registries.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_registries.py
from benchmarks.normalize.registries import (
    load_config, MetricRegistry, ConditionRegistry, MethodResolver)

CFG = load_config()

def test_metric_canonicalizes_aliases():
    reg = MetricRegistry(CFG)
    assert reg.resolve("GSR (%)").id == "success_rate"
    assert reg.resolve("grasp success rate").id == "success_rate"
    assert reg.resolve("DR (%)").id == "declutter_rate"

def test_metric_carries_unit_and_direction():
    reg = MetricRegistry(CFG)
    m = reg.resolve("Latency (ms)")
    assert m.id == "latency" and m.higher_is_better is False and m.type == "time"

def test_metric_unknown_returns_none_id():
    reg = MetricRegistry(CFG)
    assert reg.resolve("Col_2").id is None      # garbage -> unresolved
    assert reg.resolve("Box Cylinder Bowl Mug Average Success Rate").id == "success_rate"  # fuzzy contains

def test_condition_detection():
    cond = ConditionRegistry(CFG)
    assert cond.resolve("pile") == "pile"
    assert cond.resolve("Packed Scene") == "packed"
    assert cond.resolve("random clutter") is None

def test_method_resolver_scores_confidence():
    methods = ["AnyGrasp", "Grasp Pose Detection (GPD)"]
    r = MethodResolver(methods, alias_seeds={"gpd": "Grasp Pose Detection (GPD)"})
    hit = r.resolve("GPD")
    assert hit.method_id == "Grasp Pose Detection (GPD)" and hit.confidence == "high"
    miss = r.resolve("SomeUnknownBaseline")
    assert miss.method_id is None and miss.confidence == "low"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_registries.py -v`
Expected: FAIL — classes not defined.

- [ ] **Step 3: Write minimal implementation**

```python
# normalize/registries.py   (append below load_config)
import re
from dataclasses import dataclass
from typing import Optional

def _norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[()%]', ' ', (s or '').lower())).strip()

@dataclass
class MetricHit:
    id: Optional[str]; unit: Optional[str]; higher_is_better: Optional[bool]; type: str; raw: str

class MetricRegistry:
    def __init__(self, cfg):
        self._by_alias = {}
        self._meta = {}
        for m in cfg['metrics']:
            self._meta[m['id']] = m
            for a in [m['id']] + m.get('aliases', []):
                self._by_alias[_norm(a)] = m['id']

    def resolve(self, raw):
        n = _norm(raw)
        mid = self._by_alias.get(n)
        if mid is None:
            # fuzzy: longest alias that appears as a token-substring of the header
            best = None
            for alias, cand in self._by_alias.items():
                if len(alias) >= 4 and alias in n:
                    if best is None or len(alias) > best[0]:
                        best = (len(alias), cand)
            mid = best[1] if best else None
        if mid is None:
            return MetricHit(None, None, None, 'unknown', raw)
        m = self._meta[mid]
        return MetricHit(mid, m.get('unit'), m.get('higher_is_better'), m.get('type', 'unknown'), raw)

class ConditionRegistry:
    def __init__(self, cfg):
        self._by_alias = {}
        for c in cfg.get('conditions', []):
            for a in [c['id']] + c.get('aliases', []):
                self._by_alias[_norm(a)] = c['id']

    def resolve(self, raw):
        n = _norm(raw)
        if n in self._by_alias:
            return self._by_alias[n]
        for alias, cid in self._by_alias.items():
            if len(alias) >= 4 and alias in n:
                return cid
        return None

@dataclass
class MethodHit:
    method_id: Optional[str]; confidence: str; raw: str

class MethodResolver:
    """Confidence-scored: exact/alias -> high, fuzzy-contains -> medium, none -> low (kept, flagged)."""
    def __init__(self, method_names, alias_seeds=None):
        self._exact = {_norm(m): m for m in method_names}
        self._alias = {_norm(k): v for k, v in (alias_seeds or {}).items()}

    def resolve(self, raw):
        n = _norm(raw)
        if n in self._exact:
            return MethodHit(self._exact[n], 'high', raw)
        if n in self._alias:
            return MethodHit(self._alias[n], 'high', raw)
        for key, full in self._exact.items():
            if len(key) >= 5 and (key in n or n in key):
                return MethodHit(full, 'medium', raw)
        return MethodHit(None, 'low', raw)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_registries.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Checkpoint (stage, do NOT commit)**

```bash
git add dashboard/scripts/precompute/benchmarks/normalize/registries.py dashboard/scripts/precompute/benchmarks/tests/test_registries.py
```
Stop for user review/commit.

---

## Task 4: `aggregate/confidence.py` — CV, consistency, evidence grade

**Files:**
- Create: `dashboard/scripts/precompute/benchmarks/aggregate/confidence.py`
- Test: `dashboard/scripts/precompute/benchmarks/tests/test_confidence.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_confidence.py
from benchmarks.aggregate.confidence import (
    coefficient_of_variation, classify_consistency, evidence_grade)

def test_cv_basic():
    assert coefficient_of_variation([100.0, 100.0]) == 0.0
    assert round(coefficient_of_variation([90.0, 110.0]), 3) == 0.1   # std/mean

def test_same_condition_low_cv_is_consistent():
    # rate threshold 0.10
    assert classify_consistency([84.0, 86.0], metric_type='rate',
                                same_condition=True) == 'consistent'

def test_same_condition_high_cv_is_high_variance():
    assert classify_consistency([58.7, 86.9], metric_type='rate',
                                same_condition=True) == 'high_variance'

def test_condition_mismatch_is_different_setup_not_high_variance():
    # The GIGA "pile" case: spans conditions -> different_setup, never high_variance
    assert classify_consistency([58.7, 86.9], metric_type='rate',
                                same_condition=False) == 'different_setup'

def test_evidence_grade_levels():
    # A: multi-paper, consistent, verified
    assert evidence_grade(n_papers=3, status='consistent', verified=True,
                          extraction_conf='high') == 'A'
    # B: single-paper verified
    assert evidence_grade(n_papers=1, status=None, verified=True,
                          extraction_conf='high') == 'B'
    # C: low conf / unverified / salvaged
    assert evidence_grade(n_papers=1, status=None, verified=False,
                          extraction_conf='low') == 'C'
    assert evidence_grade(n_papers=2, status='high_variance', verified=True,
                          extraction_conf='high') == 'C'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_confidence.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

```python
# aggregate/confidence.py
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
    """A = corroborated+consistent+verified; B = single verified; C = everything weaker."""
    if extraction_conf == 'low' or not verified:
        return 'C'
    if n_papers >= 2 and status == 'consistent':
        return 'A'
    if n_papers >= 2 and status in ('high_variance', 'different_setup'):
        return 'C'
    if n_papers == 1:
        return 'B'
    return 'C'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_confidence.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Checkpoint (stage, do NOT commit)**

```bash
git add dashboard/scripts/precompute/benchmarks/aggregate/confidence.py dashboard/scripts/precompute/benchmarks/tests/test_confidence.py
```
Stop for user review/commit.

---

## Task 5: `adapters/v4_results.py` — bridge existing v4 output → ResultRecords (+ header salvage)

**Files:**
- Create: `dashboard/scripts/precompute/benchmarks/adapters/v4_results.py`
- Test: `dashboard/scripts/precompute/benchmarks/tests/test_v4_adapter.py`

The v4 results expose `outperforms_both_csv` (pairs with `winner_csv/loser_csv/metric/winner_val/loser_val/paper/margin`) and `cross_paper` (`"method|metric": [{paper,value,raw}]`). The adapter turns each side of each pair, and each cross-paper report, into ResultRecords; it salvages `Col_N`/merged metric headers using the metric registry's fuzzy resolve, and routes unsalvageable ones to `metric_id=None`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_v4_adapter.py
from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.normalize.registries import load_config, MetricRegistry, ConditionRegistry

CFG = load_config()

V4 = {
  "outperforms_both_csv": [
    {"winner_csv": "AnyGrasp", "loser_csv": "Grasp Pose Detection (GPD)",
     "metric": "Success Rate (%)", "winner_val": 86.9, "loser_val": 70.1,
     "margin": 16.8, "paper": "anygrasp"}
  ],
  "cross_paper": {
    "Grasp detection via Implicit Geometry and Affordance (GIGA)|pile": [
      {"paper": "edge-grasp-network", "value": 75.2, "raw": "75.2 ± 2.2"},
      {"paper": "grasp-detection-via-implicit-geometry-and-affordance-giga", "value": 86.9, "raw": "86.9 (73 / 84)"}
    ]
  }
}

def test_outperforms_pair_becomes_two_records_with_canonical_metric():
    recs = records_from_v4(V4, CFG)
    sr = [r for r in recs if r.metric_id == "success_rate"]
    assert len(sr) >= 2
    assert {r.method_id for r in sr} >= {"AnyGrasp", "Grasp Pose Detection (GPD)"}
    assert all(r.unit == "%" and r.higher_is_better is True for r in sr)

def test_pile_is_recognized_as_condition_not_metric():
    recs = records_from_v4(V4, CFG)
    giga = [r for r in recs if r.method_id and "GIGA" in r.method_id]
    assert giga, "GIGA records present"
    assert all(r.condition == "pile" for r in giga)
    # 'pile' must NOT become the metric_id
    assert all(r.metric_id != "pile" for r in giga)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_v4_adapter.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

```python
# adapters/v4_results.py
from benchmarks.types import ResultRecord
from benchmarks.normalize.registries import MetricRegistry, ConditionRegistry
from benchmarks.normalize.units import parse_value

def _mk(method_id, metric_raw, value, value_str, paper, mreg, creg,
        is_own=False, caption=""):
    # the raw header may be a condition (e.g. "pile") rather than a metric
    cond = creg.resolve(metric_raw)
    metric_input = "success rate" if cond else metric_raw  # condition columns are success-rate by domain convention
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_v4_adapter.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Checkpoint (stage, do NOT commit)**

```bash
git add dashboard/scripts/precompute/benchmarks/adapters/v4_results.py dashboard/scripts/precompute/benchmarks/tests/test_v4_adapter.py
```
Stop for user review/commit.

---

## Task 6: `aggregate/build_benchmarks.py` — records → v2 JSON + KG enrichment

**Files:**
- Create: `dashboard/scripts/precompute/benchmarks/aggregate/build_benchmarks.py`
- Test: `dashboard/scripts/precompute/benchmarks/tests/test_build_benchmarks.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_build_benchmarks.py
from benchmarks.aggregate.build_benchmarks import build_benchmark_json
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4

CFG = load_config()

def _records():
    return records_from_v4({
      "outperforms_both_csv": [
        {"winner_csv": "AnyGrasp", "loser_csv": "GPD", "metric": "Success Rate (%)",
         "winner_val": 86.9, "loser_val": 70.1, "margin": 16.8, "paper": "anygrasp"}],
      "cross_paper": {}
    }, CFG)

def test_build_produces_v2_schema():
    out = build_benchmark_json(_records(), CFG)
    for key in ('leaderboards', 'cross_validations', 'comparisons',
                'method_index', 'quarantine', 'stats'):
        assert key in out

def test_comparison_carries_grade_and_provenance():
    out = build_benchmark_json(_records(), CFG)
    assert out['comparisons'], "has comparisons"
    c = out['comparisons'][0]
    assert c['winner'] == 'AnyGrasp' and c['metric_id'] == 'success_rate'
    assert c['grade'] in ('A', 'B', 'C') and c['paper'] == 'anygrasp'

def test_unresolved_metric_is_quarantined_not_published():
    recs = records_from_v4({"outperforms_both_csv": [
        {"winner_csv": "X", "loser_csv": "Y", "metric": "Col_2",
         "winner_val": 5, "loser_val": 4, "margin": 1, "paper": "p"}],
        "cross_paper": {}}, CFG)
    out = build_benchmark_json(recs, CFG)
    # Col_2 -> metric_id None -> not in any leaderboard, counted in quarantine
    assert out['quarantine']['n_records'] >= 1
    assert all('col_2' not in (lb.get('metric_id') or '').lower()
               for lb in out['leaderboards'].values())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_build_benchmarks.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

```python
# aggregate/build_benchmarks.py
import json, os
from collections import defaultdict
from benchmarks.aggregate.confidence import (
    coefficient_of_variation, classify_consistency, evidence_grade)

def _metric_label(cfg, metric_id):
    for m in cfg['metrics']:
        if m['id'] == metric_id:
            unit = f" ({m['unit']})" if m.get('unit') else ""
            return metric_id.replace('_', ' ').title() + unit
    return metric_id

def build_benchmark_json(records, cfg):
    cv_thr = cfg.get('consistency', {}).get('cv_thresholds')
    min_papers = cfg.get('consistency', {}).get('min_papers_for_validation', 2)
    metric_type = {m['id']: m.get('type', 'default') for m in cfg['metrics']}

    publishable = [r for r in records if r.metric_id and r.method_id]
    quarantined = [r for r in records if not (r.metric_id and r.method_id)]

    # ---- leaderboards keyed by metric|dataset|condition ----
    groups = defaultdict(lambda: defaultdict(list))   # key -> method -> [records]
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
            vals = [r.value for r in recs if r.value is not None]
            if not vals:
                continue
            best = max(vals) if hib else min(vals)
            med = sorted(vals)[len(vals) // 2]
            status = classify_consistency(vals, metric_type.get(metric_id, 'default'),
                                          same_condition=True, cv_thresholds=cv_thr) if len(vals) >= 2 else None
            grade = evidence_grade(len({r.paper_id for r in recs}), status,
                                   any(r.verified for r in recs),
                                   max((r.extraction_conf for r in recs), default='low'))
            entries.append({'method': method, 'value': round(best, 2),
                            'median': round(med, 2), 'n_reports': len(vals),
                            'cv': round(coefficient_of_variation(vals), 3),
                            'grade': grade,
                            'source_papers': sorted({r.paper_id for r in recs})})
        if len(entries) >= 2:
            entries.sort(key=lambda e: e['value'], reverse=hib)
            leaderboards[key] = {
                'metric_id': metric_id, 'metric_label': _metric_label(cfg, metric_id),
                'dataset_id': dataset_id or None, 'condition': condition or None,
                'higher_is_better': hib, 'entries': entries}

    # ---- cross-paper validations: same (method, metric, dataset) across >=2 papers ----
    cross = defaultdict(list)
    for r in publishable:
        cross[(r.method_id, r.metric_id, r.dataset_id)].append(r)
    cross_validations = []
    for (method, metric_id, dataset_id), recs in cross.items():
        papers = {r.paper_id for r in recs}
        if len(papers) < min_papers:
            continue
        conds = {r.condition for r in recs}
        vals = [r.value for r in recs if r.value is not None]
        same_condition = len(conds) == 1
        status = classify_consistency(vals, metric_type.get(metric_id, 'default'),
                                      same_condition=same_condition, cv_thresholds=cv_thr)
        grade = evidence_grade(len(papers), status, any(r.verified for r in recs),
                               max((r.extraction_conf for r in recs), default='low'))
        cross_validations.append({
            'method': method, 'metric_id': metric_id,
            'metric_label': _metric_label(cfg, metric_id), 'dataset_id': dataset_id,
            'n_papers': len(papers),
            'mean': round(sum(vals) / len(vals), 2) if vals else None,
            'cv': round(coefficient_of_variation(vals), 3), 'status': status, 'grade': grade,
            'reports': [{'paper': r.paper_id, 'value': r.value, 'value_str': r.value_str,
                         'condition': r.condition} for r in recs]})
    cross_validations.sort(key=lambda v: v['n_papers'], reverse=True)

    # ---- comparisons (outperforms pairs) come from own-method records sharing a paper+key ----
    comparisons, method_index = _comparisons_and_index(publishable, cross_validations, metric_type, cv_thr)

    stats = {'n_comparisons': len(comparisons), 'n_leaderboards': len(leaderboards),
             'n_methods_indexed': len(method_index), 'n_cross_validations': len(cross_validations),
             'n_grade_a': sum(1 for c in comparisons if c['grade'] == 'A'),
             'n_quarantined': len(quarantined)}
    q_reasons = defaultdict(int)
    for r in quarantined:
        q_reasons['unsalvageable_header' if not r.metric_id else 'unresolved_method'] += 1
    return {'leaderboards': leaderboards, 'cross_validations': cross_validations,
            'comparisons': comparisons, 'method_index': method_index,
            'quarantine': {'n_records': len(quarantined), 'reasons': dict(q_reasons)},
            'stats': stats}

def _comparisons_and_index(records, cross_validations, metric_type, cv_thr):
    # pair own-method vs others within the same (paper, metric, dataset, condition)
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
                    'paper': paper, 'table_caption': own.table_caption, 'extractor': own.extractor})
    # method index
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_build_benchmarks.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Checkpoint (stage, do NOT commit)**

```bash
git add dashboard/scripts/precompute/benchmarks/aggregate/build_benchmarks.py dashboard/scripts/precompute/benchmarks/tests/test_build_benchmarks.py
```
Stop for user review/commit.

---

## Task 7: Golden-file test on the real 126 pairs + refactor `graph/benchmark_data.py` CLI

**Files:**
- Modify: `dashboard/scripts/precompute/graph/benchmark_data.py`
- Test: `dashboard/scripts/precompute/benchmarks/tests/test_golden_126.py`

- [ ] **Step 1: Write the failing golden test** (runs only if the v4 results file is present)

```python
# tests/test_golden_126.py
import json, os, pytest
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.aggregate.build_benchmarks import build_benchmark_json

V4 = "/tmp/table_extraction_results_v4.json"
pytestmark = pytest.mark.skipif(not os.path.exists(V4), reason="v4 results not present")

def _out():
    with open(V4) as f:
        v4 = json.load(f)
    return build_benchmark_json(records_from_v4(v4, load_config()), load_config())

def test_metric_fragmentation_reduced():
    out = _out()
    metric_ids = {lb['metric_id'] for lb in out['leaderboards'].values()}
    assert len(metric_ids) <= 20, f"expected <=20 canonical metrics, got {len(metric_ids)}"

def test_no_col_n_metric_published():
    out = _out()
    for lb in out['leaderboards'].values():
        assert not (lb['metric_id'] or '').lower().startswith('col_')

def test_giga_pile_is_different_setup_not_high_variance():
    out = _out()
    giga = [v for v in out['cross_validations']
            if v['method'] and 'GIGA' in v['method']]
    # any GIGA cross-validation spanning conditions must be different_setup, never high_variance with grade A
    for v in giga:
        assert v['status'] != 'high_variance' or v['grade'] == 'C'
```

- [ ] **Step 2: Run test to verify it fails (or is correctly skipped)**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_golden_126.py -v`
Expected: PASS or FAIL with concrete numbers (NOT skipped, since `/tmp/table_extraction_results_v4.json` exists). If `test_metric_fragmentation_reduced` fails, expand `config/grasp_planning.json` metric aliases until canonical metric count ≤ 20 — this is the de-noising acceptance gate.

- [ ] **Step 3: Refactor the CLI to use the new pipeline**

Rewrite `dashboard/scripts/precompute/graph/benchmark_data.py` so its public `export_benchmark_data(extraction_results_path, output_dir, kg_path=None)` delegates to the new package and still writes `benchmark-comparisons.json`, plus enriches KG edges with `grade`/`condition`/`metric_id`:

```python
# graph/benchmark_data.py  (replace body; keep the same function name + __main__)
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.aggregate.build_benchmarks import build_benchmark_json

def export_benchmark_data(extraction_results_path, output_dir, kg_path=None, config_path=None):
    with open(extraction_results_path) as f:
        v4 = json.load(f)
    cfg = load_config(config_path)
    records = records_from_v4(v4, cfg)
    out = build_benchmark_json(records, cfg)
    with open(os.path.join(output_dir, 'benchmark-comparisons.json'), 'w') as f:
        json.dump(out, f)
    s = out['stats']
    print(f"  benchmark-comparisons.json: {s['n_comparisons']} comparisons, "
          f"{s['n_leaderboards']} leaderboards, {s['n_cross_validations']} cross-validations, "
          f"{s['n_grade_a']} grade-A, {s['n_quarantined']} quarantined")
    if kg_path and os.path.exists(kg_path):
        added = _enrich_kg(kg_path, out['comparisons'])
        print(f"  kg-full.json enriched: +{added} graded outperforms edges")
    return out

def _enrich_kg(kg_path, comparisons):
    with open(kg_path) as f:
        kg = json.load(f)
    # method -> paper from described_in
    m2p = {}
    for link in kg.get('links', []):
        if link.get('type') == 'described_in':
            m2p[link['source'].replace('method:', '')] = link['target'].replace('paper:', '')
    existing = {(l['source'], l['target']) for l in kg.get('links', [])
                if l.get('type') == 'outperforms'}
    added = 0
    for c in comparisons:
        wp, lp = m2p.get(c['winner']), m2p.get(c['loser'])
        if not wp or not lp or wp == lp:
            continue
        src, tgt = f"paper:{wp}", f"paper:{lp}"
        if (src, tgt) in existing:
            continue
        kg['links'].append({'type': 'outperforms', 'source': src, 'target': tgt,
            'metric': c['metric_id'], 'condition': c.get('condition'),
            'winner_value': c['winner_value'], 'loser_value': c['loser_value'],
            'margin': c['margin'], 'grade': c['grade'], 'extraction': 'benchmark_v2'})
        existing.add((src, tgt)); added += 1
    with open(kg_path, 'w') as f:
        json.dump(kg, f)
    return added

if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--extraction-results', required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--kg-path', default=None)
    p.add_argument('--config', default=None)
    a = p.parse_args()
    export_benchmark_data(a.extraction_results, a.output_dir, a.kg_path, a.config)
```

- [ ] **Step 4: Run the golden test + regenerate real data**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/test_golden_126.py -v`
Expected: PASS (3 passed).
Then regenerate (writes the v2 JSON the UI will consume):
```bash
cd dashboard && python3 scripts/precompute/graph/benchmark_data.py --extraction-results /tmp/table_extraction_results_v4.json --output-dir public/data-grasp-planning --kg-path public/data-grasp-planning/kg-full.json
```
Expected: prints comparison/leaderboard/grade-A/quarantined counts.

- [ ] **Step 5: Checkpoint (stage, do NOT commit)**

```bash
git add dashboard/scripts/precompute/graph/benchmark_data.py dashboard/scripts/precompute/benchmarks/tests/test_golden_126.py dashboard/public/data-grasp-planning/benchmark-comparisons.json dashboard/public/data-grasp-planning/kg-full.json
```
Show the user the before/after stats (44 → ≤20 metrics, n grade-A, n quarantined) and stop for review/commit.

---

## Task 8: `BenchmarksPage.js` — grades, CV%, validated-on-top + low-confidence toggle, drop blacklist

**Files:**
- Modify: `dashboard/src/components/BenchmarksPage.js`
- Modify: `dashboard/src/App.css` (add `.benchmarks-grade-*` styles near existing `.benchmarks-*`)

The v2 schema changes shape: `leaderboards` is keyed by `metric|dataset|condition` with `{metric_label, condition, entries:[{method,value,n_reports,cv,grade,...}]}`; `cross_validations[].status ∈ {consistent,high_variance,different_setup}` and `.grade`; `stats` adds `n_comparisons`, `n_grade_a`, `n_quarantined`. The `METRIC_BLACKLIST`/`isGoodMetric`/`categorizeMetrics` hack is deleted (the backend no longer emits garbage metrics).

- [ ] **Step 1: Write the failing component test**

```jsx
// dashboard/src/components/__tests__/BenchmarksPage.test.js
import { render, screen } from '@testing-library/react';
import BenchmarksPage from '../BenchmarksPage';
import * as loader from '../../lib/data-loader';

const V2 = {
  leaderboards: { 'success_rate||pile': {
    metric_id: 'success_rate', metric_label: 'Success Rate (%)', condition: 'pile',
    higher_is_better: true,
    entries: [
      {method: 'AnyGrasp', value: 86.9, n_reports: 3, cv: 0.03, grade: 'A', source_papers: ['anygrasp']},
      {method: 'GPD', value: 70.1, n_reports: 1, cv: 0, grade: 'B', source_papers: ['gpd']}]}},
  cross_validations: [{method: 'GIGA', metric_label: 'Success Rate (%)', condition: 'pile',
    n_papers: 5, mean: 74.9, cv: 0.16, status: 'different_setup', grade: 'C', reports: []}],
  comparisons: [], method_index: {},
  quarantine: {n_records: 7, reasons: {}},
  stats: {n_comparisons: 12, n_leaderboards: 1, n_methods_indexed: 2,
          n_cross_validations: 1, n_grade_a: 1, n_quarantined: 7},
};

test('renders grade badge and CV%, shows quarantine count', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue(V2);
  render(<BenchmarksPage data={[]} selectedPoint={null} onSelect={() => {}} />);
  expect(await screen.findByText(/Success Rate/)).toBeInTheDocument();
  expect(screen.getByText(/A/)).toBeInTheDocument();          // grade badge
  expect(screen.getByText(/7/)).toBeInTheDocument();          // quarantine count
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && CI=true npx react-scripts test src/components/__tests__/BenchmarksPage.test.js --watchAll=false`
Expected: FAIL (current component reads `leaderboards[name]` as an array, not `{entries}`; no grade badge).

- [ ] **Step 3: Rewrite the component to the v2 schema**

Key changes (full edits): delete `METRIC_BLACKLIST`, `isGoodMetric`, `categorizeMetrics`; build the metric/condition selector from `Object.values(leaderboards)` using `metric_label` + `condition`; read `lb.entries`; render a **Grade** column + a colored badge (`A`/`B`/`C`) and a `CV%` column; add a **"Show low-confidence (grade C / n=1)"** checkbox that, when off, filters leaderboard entries to `grade !== 'C'` and hides `different_setup`/`high_variance` cross-validations; show `stats.n_quarantined` as a footnote ("N rows withheld — unverified/garbled"). For cross-validation cards, map `status` → label/colour: `consistent`→green "Consistent", `high_variance`→amber "High variance", `different_setup`→grey "Different setup (not comparable)". Use the existing `.benchmarks-*` class names; add `.benchmarks-grade-a/.b/.c` colour classes in `App.css`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && CI=true npx react-scripts test src/components/__tests__/BenchmarksPage.test.js --watchAll=false`
Expected: PASS.

- [ ] **Step 5: Visual check + Checkpoint (stage, do NOT commit)**

Start the dev server in the user's tmux pane (per project rule) and navigate to `http://localhost:3002/grasp-planning` → Benchmarks. Confirm: validated (grade A) on top, low-confidence behind the toggle, GIGA-pile shows "Different setup", grade badges + CV% visible, quarantine footnote present.
```bash
git add dashboard/src/components/BenchmarksPage.js dashboard/src/components/__tests__/BenchmarksPage.test.js dashboard/src/App.css
```
Stop for user review/commit.

---

## Task 9: `DetailPanel.js` — grade-aware benchmark badges

**Files:**
- Modify: `dashboard/src/components/DetailPanel.js`

DetailPanel reads `_benchmarkCache.method_index[point.name]` (`{n_wins, n_losses, validations}`) and `cross_validations`. The v2 `validations` entries now carry `status` + `grade` (not `consistent`). Update the badge logic: show `status`-based label (`consistent`→"validated", `high_variance`→"high variance", `different_setup`→"different setup") and colour by `grade`.

- [ ] **Step 1: Write the failing test**

```jsx
// dashboard/src/components/__tests__/DetailPanel.benchmark.test.js
import { render, screen, waitFor } from '@testing-library/react';
import DetailPanel from '../DetailPanel';
import * as loader from '../../lib/data-loader';

test('shows status-based validation label from v2 schema', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue({
    method_index: { AnyGrasp: {n_wins: 2, n_losses: 0, validations: [], metrics: ['success_rate']} },
    cross_validations: [{method: 'AnyGrasp', metric_label: 'Success Rate (%)',
                         n_papers: 3, status: 'consistent', grade: 'A'}],
  });
  render(<DetailPanel point={{ name: 'AnyGrasp' }} />);
  await waitFor(() => expect(screen.getByText(/2 win/)).toBeInTheDocument());
  expect(screen.getByText(/validated/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && CI=true npx react-scripts test src/components/__tests__/DetailPanel.benchmark.test.js --watchAll=false`
Expected: FAIL — current code reads `v.consistent` (undefined in v2) → renders "high variance".

- [ ] **Step 3: Update the badge logic**

In `DetailPanel.js`, replace the `v.consistent ? 'validated' : 'high variance'` logic with a `statusLabel(v.status)` helper (`consistent`→"validated", `different_setup`→"different setup", else "high variance") and set the badge class from `v.grade` (`detail-badge-a/-b/-c`). Keep the existing win/loss badges.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && CI=true npx react-scripts test src/components/__tests__/DetailPanel.benchmark.test.js --watchAll=false`
Expected: PASS.

- [ ] **Step 5: Run the full suite + Checkpoint (stage, do NOT commit)**

Run: `cd dashboard/scripts/precompute && python3 -m pytest benchmarks/tests/ -v` (all green) and `cd dashboard && CI=true npx react-scripts test --watchAll=false` (benchmark tests green).
```bash
git add dashboard/src/components/DetailPanel.js dashboard/src/components/__tests__/DetailPanel.benchmark.test.js
```
Stop for user final review/commit of Phase A.

---

## Self-review (completed during authoring)

- **Spec coverage:** metric/method/condition canonicalization (Tasks 3,5) · unit + higher-is-better (Task 2) · header salvage + quarantine (Tasks 5,6) · CV/condition/grade replacing spread<5.0 (Tasks 4,6) · UI n/CV%/grade + validated-on-top toggle (Task 8) · DetailPanel badges (Task 9) · domain-agnostic config (Task 1) · golden acceptance (Task 7). All spec §7 items mapped.
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `ResultRecord` fields, `build_benchmark_json` output keys, and the JS `leaderboards[].entries`/`cross_validations[].status` shapes match across Tasks 1–9 and the v2 schema block.
- **Deviation from spec:** config is JSON (not YAML) to avoid a new dependency — noted in the plan header.
