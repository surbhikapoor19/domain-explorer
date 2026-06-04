# Benchmark Extraction & Evidence Pipeline — Redesign Spec

- **Date:** 2026-05-29
- **Status:** Approved design (pending spec review) → implementation plan next
- **Owner:** Surbhi
- **Working tree:** `domain-explorer/` (dashboard + precompute). Corpus (PDFs + TEI) lives in `grasp-explorer/` — see [Cross-tree logistics](#cross-tree-logistics).

## 1. Problem

The Benchmarks page reads as a "noisy database dump" rather than a decision tool. This is structural, not cosmetic. Measured evidence on the 55-paper grasp corpus (126 pairs, 44 metric names, 40 leaderboards, 11 cross-validations, 28 indexed methods):

| # | Root cause | Evidence | Severity |
|---|------------|----------|----------|
| 1 | Metric names never canonicalized (whitespace-only normalize) | 44 metric names for 126 pairs; `GSR (%)`/`Packed GSR (%)`/`DR (%)` separate; 7 `Col_N`; merged header `"Box Cylinder Bowl Mug Average Success Rate Success Rate"` | high |
| 2 | Tiny sample sizes make "consistency" meaningless | 48% of metrics appear in exactly 1 pair; 11 cross-validations total, 5 are n=2 | high |
| 3 | Consistency = hardcoded `spread < 5.0`, no scale/unit/condition awareness | GIGA on "pile" legitimately 58.7–86.9 across 5 papers (different scenes) flagged identically to a real error; same cutoff for `Latency (ms)` and percentages | high |
| 4 | GROBID drops/flattens table structure on a real slice of papers | 5/55 TEI files have a table region with **zero rows** (image tables); GROBID table F1 0.16–0.43 vs Docling 0.86–0.99 in 2024–26 benchmarks | high |
| 5 | Brittle method resolution (aggressive "Ours" stripping + 55-entry hand dict) | Only 28 methods indexed though ~43 appear; corpus has 56 | medium |
| 6 | Rich TEI signal unused for locating results | Section heads (`EXPERIMENTS`, `Ablation Study`) + captions parsed but never used to target tables or exclude ablations | medium |

9 of 11 "validations" are flagged high-variance largely from causes #1–#3; the recall ceiling is set by #4.

## 2. Goals / Non-goals

**Goals**
- Make every published number **trustworthy and auditable**: canonical metric/dataset/method, real confidence, per-cell provenance.
- **Recover image-based tables** GROBID cannot read (the recall ceiling).
- **Validate across papers** with statistically honest, condition-aware consistency.
- **Domain-agnostic**: grasp specifics live in config, not code; reusable for motion planning and future domains.
- Wire extraction into the existing build (GitHub Actions), removing the hand-run `/tmp` dependency.

**Non-goals (deferred, not in scope)**
- A full human-in-the-loop accept/reject curation UI (the "Option D" boundary). We design so a review queue can be added later, but do not build it now.
- Re-running GROBID itself / changing GROBID config beyond reading its existing TEI output.
- Extracting prose-only claims with no numeric table backing.

## 3. Decisions (locked)

1. **Phasing:** Phase A (de-noise existing data) then Phase C (GROBID-guided VLM-OCR hybrid).
2. **VLM access:** API key + small per-run budget is acceptable → use a vision model (Claude) for image/garbled tables.
3. **Display policy:** validated results on top; single-report / low-confidence behind a "show low-confidence" toggle, with explicit badges.
4. **Domain-agnostic from the start:** no hardcoded grasp aliases in code.

## 4. Canonical data model (the spine)

The atomic unit becomes a **ResultRecord** keyed on *resolved* identifiers, not raw strings:

```
ResultRecord {
  record_id
  paper_id                       // TEI/PDF slug
  method_raw, method_id          // resolved vs KG/CSV; null + flagged if unresolved (never silently dropped)
  dataset_raw, dataset_id
  metric_raw, metric_id          // canonical metric id
  unit, higher_is_better         // from metric registry
  condition                      // structured: scene ("pile"/"packed"), split, view, object set
  value (float), value_str       // value_str = exact printed text (provenance)
  is_own_method                  // "Ours" flag (kept, not stripped to empty)
  source {
    table_id, page, bbox, caption, section_label,
    extractor ∈ {tei_table, docling, vlm},
    crop_image                   // path to crop, for audit
  }
  confidence {
    extraction_conf ∈ {high, medium, low},
    verified (bool)              // found-in-crop check passed
  }
}
```

**Derived artifacts** (all carry provenance + grade):
- **Comparison (outperforms edge):** within ONE table, method A vs B on the **same `(metric_id, dataset_id, condition)`** → `{winner, loser, metric_id, dataset_id, condition, winner_value, loser_value, margin, source}`.
- **Leaderboard:** group by `(metric_id, dataset_id, condition)`; rank by best (and report median) with `n_reports` and grade. (No more cross-condition mixing.)
- **Cross-paper validation:** a `(method_id, metric_id, dataset_id, condition)` reported in ≥2 papers → consistency via CV% (see §5).

Keying on `condition` is the structural fix for root causes #1–#3.

## 5. Confidence & evidence grade (replaces `spread < 5.0`)

**Per-record `extraction_conf`** = f(extractor, section, verification):
- Born-digital TEI clean row → high.
- VLM extraction that passes found-in-crop verification → high; unverified → medium.
- Caption-salvaged header (`Col_N` recovered from caption) → low.
- Main-results section > ablation section (ablation down-weighted or excluded from leaderboards).

**Cross-paper consistency** (only for n≥2 same-condition reports):
- Use **coefficient of variation** `CV = std/mean` with **metric-type-aware thresholds** (rate/percent vs latency/time vs count) from the metric registry — not a single absolute number.
- **Condition mismatch → bucket as "different setup, not comparable"** — never "high variance."

**Published evidence grade** (drives the UI toggle):
- **A** — corroborated across ≥2 papers, consistent (low CV), verified.
- **B** — single-paper, verified.
- **C** — low-confidence / unverified / caption-salvaged.
- **Quarantine** — unsalvageable (e.g. `Col_N` with no recoverable caption, failed verification): logged, **not published**.

UI: Grade A on top; B/C behind "show low-confidence"; quarantine hidden (count surfaced for transparency, per "no silent caps").

## 6. Domain-agnostic config

All grasp-specifics move to `config/<domain>.yaml`:
- `results_section_keywords` — e.g. EXPERIMENTS, RESULTS, EVALUATION, QUANTITATIVE, COMPARISON.
- `ablation_section_keywords` — e.g. ABLATION.
- `metric_seeds` — canonical metric id → {aliases, unit, higher_is_better, type}.
- `dataset_seeds` — canonical dataset/condition → aliases.
- `method_alias_seeds` — seed aliases beyond KG node names.

Cold-start: metric/dataset strings not in the registry are auto-clustered (normalized string + embedding similarity) and proposed as new canonical ids, written back to the config for review. New domains start from KG node names + empty seeds.

## 7. Phase A — de-noise existing data (no new extraction)

**Input:** existing `/tmp/table_extraction_results_v4.json` (126 pairs) + TEI captions on disk.
**Builds the reusable normalization layer that Phase C also consumes.**

Components:
1. `normalize/registries.py` — metric / dataset / method canonicalization (config-driven; method-resolver fuzzy-but-confidence-scored; unresolved kept + flagged).
2. `normalize/units.py` — strip `%`, parse `mean±std`, normalize units, attach `higher_is_better`.
3. **Header salvage** — re-derive `Col_N`/merged headers from TEI table caption/figDesc; unsalvageable → quarantine.
4. `aggregate/confidence.py` — CV/condition/section-aware confidence + grade (replaces `spread<5.0`).
5. `aggregate/build_benchmarks.py` — refactor of `dashboard/scripts/precompute/graph/benchmark_data.py` to emit grade + provenance + `n` + CV% into `benchmark-comparisons.json` and `kg-full.json` edges.
6. **UI** — `BenchmarksPage.js` + `DetailPanel.js` + `data-loader.js`: show `n`, CV%, grade, provenance (paper + caption); validated-on-top + low-confidence expander; quarantine count footnote.

**Phase A acceptance:**
- Metric buckets drop from 44 → canonical set (target ≤ ~20 meaningful metrics), zero `Col_N`/merged headers published.
- GIGA-on-"pile" labeled "different setup", not "high variance".
- Every published row shows grade + n + provenance; n=1 rows are grade B/C and behind the toggle.

## 8. Phase C — GROBID-guided VLM-OCR hybrid

Domain-agnostic, CI-runnable pipeline. Born-digital tables stay cheap; VLM fires only where GROBID is weak/empty.

Stages:
1. **Locate** (`extraction/locate.py`) — TEI → section nodes; select results sections via `results_section_keywords`, exclude `ablation_section_keywords`; collect table captions + page locations; flag TEI tables with **zero rows** (image tables) for the vision path.
2. **Render + crop** (`extraction/render.py`) — render results-section pages at ~250 DPI (pymupdf, installed); crop table regions using TEI/pdffigures2 coords when present, else a layout detector (Docling RT-DETR/TableFormer, installed), else full-page fallback.
3. **Extract** —
   - `extraction/tei_tables.py` (refactor of v4): born-digital clean tables → ResultRecords, no VLM.
   - `extraction/vlm_extract.py`: image/garbled tables → Claude vision with a **strict flat JSON schema** (rows of `{method, dataset, metric, value, value_str, unit, higher_is_better?, condition, is_own, cell_bbox/text}`); model must copy exact printed cell text + location.
4. **Verify** (guardrail) — found-in-crop: every extracted numeric `value_str` must appear in the crop (OCR/text match or re-ask); failures → quarantine. Optional second independent VLM pass; agreement → high confidence.
5. **Merge/dedup** — reconcile TEI-table and VLM extractions for the same table (prefer verified; union rows).
6. **Canonicalize across papers** — all records flow through `normalize/registries.py`; cold-start clusters new metric/dataset strings.
7. **Aggregate + score** — `aggregate/build_benchmarks.py` produces comparisons/leaderboards/validations with the §5 model; emits `benchmark-comparisons.json` + enriched `kg-full.json`.
8. **Wire into build** — call from `dashboard/scripts/precompute/graph/build.py`; add a step to `.github/workflows/domain-build.yml`; remove the `/tmp` dependency (extraction output becomes a committed/build artifact).

**Phase C acceptance:**
- The 9 image-based-table papers contribute ResultRecords (recall recovers past the GROBID ceiling); target ≥ ~80% of 56 methods represented.
- 0 junk/garbage metrics published.
- A fixture of ~5 hand-labeled tables (incl. 2 image tables) meets a stated recall/precision bar; an injected hallucinated number is rejected by verification.
- Build runs end-to-end in CI with no `/tmp` input.

## 9. Module layout

```
extraction/   locate.py · render.py · tei_tables.py · vlm_extract.py
normalize/    registries.py · units.py            # shared by Phase A and C
aggregate/    confidence.py · build_benchmarks.py # refactor of benchmark_data.py
config/       <domain>.yaml                        # section keywords, metric/dataset/method seeds
frontend/     dashboard/src/components/BenchmarksPage.js · DetailPanel.js
              dashboard/src/lib/data-loader.js
tests/        fixtures + golden files (see §11)
```

Each unit has one purpose, a defined interface, and is independently testable. `normalize/` and `aggregate/` are shared across both phases so Phase A is not throwaway.

## 10. Cross-tree logistics

- **Corpus** (55 PDFs + 55 TEI) is under `grasp-explorer/papers/` and `grasp-explorer/chroma_db/tei/`, slug-aligned (`anygrasp.pdf` ↔ `anygrasp.tei.xml`).
- **Dashboard + precompute + benchmark data** is under `domain-explorer/`.
- The pipeline reads from the corpus path (configurable input dir) and writes into `domain-explorer/dashboard/public/data-<domain>/`. Input corpus path is a config/CLI argument, not hardcoded, so the two trees stay decoupled.

## 11. Testing

- **Phase A:** golden-file test on the 126 pairs → canonical metric count, zero `Col_N` published, hand-verified consistency labels (GIGA-pile = "different setup").
- **Phase C:** per-stage unit tests (locate/section selection, render/crop, tei row parse, VLM schema validation); fixture set of ~5 hand-labeled tables incl. 2 image tables for recall/precision; **negative test**: inject a hallucinated number → verification rejects it.
- **E2E:** full-corpus run asserts recall target + 0 junk metrics; CI smoke test that the build step produces valid `benchmark-comparisons.json` + `kg-full.json`.

## 12. Risks & mitigations

- **VLM hallucination on values** (documented trust bottleneck ~50–70% on score field) → found-in-crop verification + optional dual-pass agreement; unverified → grade C / quarantine, never grade A.
- **Cold-start over-merging metrics** → conservative clustering threshold; proposed merges written to config for human review, not auto-applied to grade-A output.
- **Cross-tree path drift** → input corpus path is explicit config/CLI, validated at start of run.
- **CI cost/latency of VLM** → gate VLM strictly behind GROBID (only zero-row/garbled tables); born-digital path stays free; cache extraction results as build artifacts.
- **Licensing** (if Marker is used) → prefer Docling (MIT) for layout; Marker optional and reviewed before adoption.

## 13. Deferred / future

- Human-in-the-loop accept/reject queue for grade-C records (the C→D boundary).
- HGT retraining on the enriched, higher-quality outperforms edges (separate plan: `hgt-training-overhaul-plan`).
- `mlscorecheck`-style feasibility gate on extracted scores.
