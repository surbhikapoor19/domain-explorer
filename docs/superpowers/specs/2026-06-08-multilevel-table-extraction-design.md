# Multi-Level Header Table Extraction — Scoping & Design

- **Date:** 2026-06-08
- **Trigger:** The `Equivariant Volumetric Grasping` TABLE I (Packed/Pile × GSR/DR + Latency, 18 methods) renders almost empty in the Benchmarks "Source" view, and the page footer shows *3487 records withheld (2989 unsalvageable header, 498 unresolved method)*.
- **Status:** Approved-to-implement design (evidence-grounded by a 4-agent investigation that re-extracted this table with Docling).

## TL;DR
The rich table is **not** lost because we can't match methods or because Docling drops data. It's lost because the born-digital row parser (`records_from_tei_rows`) hard-codes a **single header row, one metric per column** model, and the method normalizer doesn't strip citation markers. We fix three things (all config-driven, domain-agnostic, test-owned): (1) parse multi-row headers into per-column **(condition, metric)** pairs; (2) harden method matching; (3) stop nulling slash-pair values.

## Root causes (with evidence)
1. **Single-header-row assumption.** Only `rows[0]` is the header; the real metric row (`rows[1]` = `GSR/DR`) is consumed by the `rows[1:]` data loop and silently dropped because its first cell is empty. *(tei_tables.py: `header=rows[0]`, `for row in rows[1:]: if not row[0].strip(): continue`.)*
2. **`cond → success_rate` override fuses GSR and DR.** When a column header resolves to a condition (Packed/Pile), the metric is forced to `success_rate`, clobbering the real DR label. *(tei_tables.py line 33: `mreg.resolve('success rate' if cond else h)`.)* On this table: **72 records tagged `success_rate`, 0 `declutter_rate`**, and `(method, success_rate, None, packed)` comparison-key collisions.
3. **`metric_raw` provenance lost** — stores the scene label (`Packed`), never `GSR (%)`/`DR (%)`.
4. **Normalizer too weak** — `_norm` only strips `()%`; it doesn't remove citation refs `[12]`, daggers/asterisks `†*`, `(N=k)` qualifiers, or unify hyphen/space/closed-compound variants. So `VGN [12]`, `OrbitGrasp*`, `EdgeGraspNet` (vs `Edge Grasp Network`) drop to LOW/unresolved.
5. **No `alias_seeds` in production** — `run_extraction.py` calls `MethodResolver(names)` with no aliases (aliases only exist in test fixtures); config has no `method_aliases` block.
6. **`units.parse_value` nulls slash pairs** — `'843/685' → 843` (second value dropped); `'/'` is in the NULL set.

## Design (config-driven, domain-agnostic, orchestrator-owns-tests)

### A. Multi-level header parsing (`tei_tables.py`)
- **Header-block detector:** greedily take leading rows where `row[0]` is blank or a NON_METRIC token **and** none of the non-first cells parse numeric (real data rows have numbers). Data starts after the block. Records `header_rows` count.
- **Per-column label collapse:** for each data column, gather the distinct non-empty labels across all header rows (Docling flattens spans by repetition, so `ROW0=[…Packed,Packed,Pile,Pile,Latency]`, `ROW1=[…GSR,DR,GSR,DR,Latency]` → col1={Packed,GSR}, col2={Packed,DR}, …). No need for Docling span objects — repetition already encodes the cross-product.
- Single-header tables (existing AnyGrasp/BIT* fixtures) → `header_rows=1`, identical output.

### B. Per-cell record model (`tei_tables.py`)
- Each data cell → **one** ResultRecord with **both** condition and metric, resolved **independently** from the column's label set: the label resolving to a condition fills `condition`; the label resolving to a metric fills `metric_id`. Remove the `cond→success_rate` override.
- `Packed+GSR(%)` → `condition=packed, metric=success_rate`; `Packed+DR(%)` → `packed, declutter_rate`; `Latency` → `metric=latency`. `metric_raw` = joined labels (`"Packed | DR (%)"`) for faithful provenance. → **5 distinct comparison keys per method, no collisions.**

### C. Method matching (`registries.py`, `run_extraction.py`, config)
- Strengthen `_norm`: strip citation refs `\[[\d,\s\-]+\]`, marks `[*†‡]`, `(N=k)` qualifiers, treat `-_/` as spaces, drop trailing `baselines?`.
- Add a **separator-insensitive exact key** (`nospace==nospace`, gated ≥5 chars) so `EdgeGraspNet`≡`Edge Grasp Network`, `ICGNet`≡`ICG-Net`, without fragile containment (and the ≥5 gate prevents `DexGraspNet2`→`DexGrasp Anything`).
- Wire `alias_seeds`: `MethodResolver(names, alias_seeds=cfg.get('method_aliases'))`; add `method_aliases` to `grasp_planning.json` (and an empty block to `motion_planning.json`). Seed only irreducible-but-real cases; **do NOT** seed genuinely-external baselines (GSNet, SE(3)-Dif, DexGraspNet2, IGD, GraspNet-1B Baselines).

### D. Units (`units.py`)
- Stop treating `/` as a null; keep `value = first number` of a slash pair (`'843/685' → 843.0`).

### Where it lives
`extraction/tei_tables.py` (A,B) · `extraction/docling_tables.py` + `extraction/locate.py` (optional span-flag passthrough, `TableLocation.header_rows` default 1) · `normalize/registries.py` (C) · `normalize/units.py` (D) · `config/{grasp_planning,motion_planning}.json` · `extraction/run_extraction.py` (pass alias_seeds). All tests authored by the orchestrator; must pass for **both** grasp and motion configs.

## Implementation tasks (ordered, TDD, orchestrator-owns-tests)
1. **`_norm` hardening** — strip refs/marks/(N=k), unify separators, drop `baselines`. *Test:* `resolve('VGN [12]')`/`resolve('OrbitGrasp*')` → canonical; `resolve('GSNet [14]')` → None.
2. **Separator-insensitive exact key** (nospace, ≥5). *Test:* `EdgeGraspNet`→`Edge Grasp Network`; `ICGNet`→`ICG-Net`; `DexGraspNet2`↛`DexGrasp Anything`.
3. **`method_aliases` in config + wire through `run_extraction`.** *Test:* grasp config resolves `OrbitGrasp`→`OrbitGrasp (EquiFormerV2)` high; motion domain-agnostic test still green.
4. **Header-block detector** in `tei_tables.py`. *Test:* 2-header-row loc → `header_rows=2`; single-row fixtures unchanged at 1, identical records.
5. **Per-column (condition,metric) split + remove override + `metric_raw`=joined.** *Test:* on Packed/Pile×GSR/DR table, VGN → exactly 5 records `{SR@packed, DR@packed, SR@pile, DR@pile, latency}`, no duplicate keys.
6. **Docling span-flag passthrough** (`column_header`/`col_span`) → `header_rows` hint. *Test:* faked two-row-header Docling table sets `loc.header_rows=2`; single-header fixture stays 1.
7. **`units.parse_value` slash-pair fix.** *Test:* `parse_value('843/685')==(843.0,None,None)`; `parse_value('/')==(None,None,None)`.

## Expected impact
- **This table:** 72 mislabeled `success_rate` / 0 `declutter_rate` / 18 latency → correct **36 success_rate + 36 declutter_rate + 18 latency** (5 typed records per method). Method resolution **4/18 → ~12/18** (recovers VGN, GIGA, GPD, 6DoF-GraspNet, EdgeGraspNet, VN-EdgeGraspNet, ICGNet, OrbitGrasp); the ~6 genuinely-external baselines correctly stay unresolved.
- **Corpus-wide:** every Packed/Pile-style table is affected; estimate several hundred records recovered/relabeled — **to be confirmed** by re-running extraction and diffing record counts by `metric_id` before/after.

## Decisions (defaults — flag if you disagree)
- **VN-EdgeGraspNet** kept as a **distinct** method (not merged into Edge Grasp Network) — it's a separate variant; safer not to collapse.
- **Dual-value latency** (`843/685`): keep the **first** value (minimal fix); a fuller fix would need a label for the 2nd value the table doesn't provide.
- **VLM path** already emits one row per (condition, metric) via its schema, so it needs no multi-header logic — only the born-digital/Docling-grid path changes.

## Open items
- Regenerate the corpus record dump (`run_extraction.py --output`) to measure a real before/after (the prior `/tmp` dump was cleared).
- Latency-column condition: keep `col_cond or caption_condition`, but guard against a `"pile scenes"` caption wrongly tagging a global-latency column.

## Implementation log (2026-06-08)
Executed under the test-ownership protocol (orchestrator authors every test; subagents only make them pass; dual-domain green throughout).

- **Tasks 1+2 — method-matching hardening** (`registries.py`): `_norm` now strips citation refs `[12]`, `(N=k)`, markers `*†‡`, unifies `-_/`, drops `baseline(s)`; added a separator-insensitive nospace exact key (≥5 chars). Test: `test_registries_markers.py`. ✅ 67 passed.
- **Task 3 — config `method_aliases` + production wiring**: 17 verified-real-CSV aliases in `grasp_planning.json`, empty block in `motion_planning.json`, `run_extraction` passes `alias_seeds=cfg.get('method_aliases')`. Test: `test_method_aliases.py`. ✅ 71 passed.
- **Tasks 4+5 — multi-level header → per-cell (condition, metric)** (`tei_tables.py`): header-block detector (`_count_header_rows`/`_is_header_row`) + per-column label collapse; removed the `cond→success_rate` override; `metric_raw` now the joined labels. Test: `test_multilevel_tables.py`. ✅ 75 passed.
- **Task 7 — slash-pair latency**: NO-OP. `parse_value('843/685')` already returns `843.0` (the NULL check is exact-membership); only bare `/` is nulled. Verified, no change needed.
- **Task 6 — Docling explicit `column_header` flags → `header_rows`**: DEFERRED (optional hardening). The `_count_header_rows` heuristic already detects the real Docling grid (row0=scene spans, row1=metrics with blank first cell); tests + the live single-table validation confirm it.

**Single-table validation (Equivariant Volumetric Grasping TABLE I, re-extracted live):** 95 resolved records — **41 success_rate + 41 declutter_rate + 13 latency** (was 72 fused success_rate / 0 declutter), split across **packed/pile/real** conditions, with **13 methods resolved** (VGN, GIGA, GPD, Edge Grasp Network, ICG-Net, OrbitGrasp, 6-DoF GraspNet, PointNetGPD, Dex-Net 1.0/2.0/4.0, 3DAPNet, 7DGCG) vs ~4 before. VGN fully decomposed into {SR@packed, DR@packed, SR@pile, DR@pile, latency}.

**Corpus-wide before/after (full Docling re-extraction, 2026-06-08, no-VLM):**

| metric | LIVE (old) | NEW (multi-header fix) |
|---|---|---|
| comparisons | 300 | **488** |
| leaderboards | 6 | **9** |
| methods indexed | 7 | **11** |
| cross-validations | 9 | **17** |
| metric families | mostly fused `success_rate` | `success_rate`×4 + `declutter_rate`×4 + `latency` (each split by packed/pile/real) |
| resolved records | ~222 | **328** (of 4110 extracted) |

Adversarially verified before swap: condition×metric split real corpus-wide, 0 missing crop files (92 entries), comparisons carry grade+provenance, no junk metric leaked → **VERDICT PASS**. Swapped into local `public/data-grasp-planning/benchmark-comparisons.json` (old backed up to `benchmark-comparisons.pre-multilevel.json`); dev server on :3002 serves it. **Prod redeploy pending user confirmation.** (Minor: the `/tmp` runner's final pretty-print line crashed sorting a set containing `None` — cosmetic, after the build was already written.)
