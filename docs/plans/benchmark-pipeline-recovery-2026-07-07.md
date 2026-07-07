# Benchmark pipeline recovery plan — 2026-07-07

Saved in-repo at the owner's request so this survives session loss. Companion memory:
`project-ablation-misattribution-fix`, `project-fable-audit-2026-07-07` (Claude memory dir).

## 1. The bug being fixed (Dex-Net misattribution)

`equivariant-volumetric-grasping` Table IV is an ablation table whose col 0 is a row
index (`1,2,3…`). The extractor took col 0 as the method name and the resolver
fuzzy-matched bare `"1"` into `"dex net 1 0 mv cnns"`, crowning ablation rows onto
Dex-Net 1.0/2.0/4.0, 3DAPNet, 6-DoF GraspNet, 7DGCG. ~20 phantom rows are in the
currently served `results` (e.g. Dex-Net 1.0 success_rate=84.8 — actually Tri-UNet's
ablation row).

## 2. The four defenses (commit 0dec472) — verified sound

Spec/regression tests: `dashboard/scripts/precompute/benchmarks/tests/test_ablation_misattribution.py`
(orchestrator-authored, 8 tests, all pass; implementers must not modify).

- **F1** `is_ablation_table(caption, section, rows, abl_kw)` in `extraction/locate.py` —
  stems keywords (`ablation`→`ablat`), checks caption + section + header cells
  (catches "Ablated models" when GROBID drops the caption). Consumed by BOTH engines:
  `locate_tables` (TEI) and `docling_tables_to_locations`; `run_extraction.py` skips
  any `loc.is_ablation_section` table entirely.
- **F2** method-COLUMN detection in `extraction/tei_tables.py` — method col = first
  column whose collapsed header is not an index token ({no, #, rank, id, idx, index, ''});
  engine-shared via `records_from_tei_rows`. NOTE: the VLM parse path
  (`parse_vlm_rows`, used in CI via Groq vision) bypasses F2 — covered by F1+F3+F4.
- **F3** `MethodResolver.resolve` in `normalize/registries.py` — a candidate with no
  alphabetic char can never take the fuzzy branch. Exact/alias/no-space matches above
  it keep legit short names (S4G, GPD) working.
- **F4** build backstop in `aggregate/build_benchmarks.py` — any record whose
  non-empty RAW label fails `is_valid_method_name(clean_method_name(raw))` is dropped,
  even if it already laundered into a real method_id.

Invariant: a numeric / letter-free cell is never attributed to a named method.

## 3. Why the first CI attempt (run 28857742075) changed nothing

The run went green in 4.5 min but the log shows:

```
WARNING: Docling extraction unavailable (HTTP Error 403: Forbidden); writing empty benchmark output
result-records.json: {'n_records': 0, ...}
REFUSING overwrite ... new build is empty but the existing file has 131 comparisons. Keeping existing data.
```

- Docling's model fetch 403'd (HF throttles anonymous GitHub-runner traffic; the
  workflow only passes `HF_API_TOKEN`, whose secret is unset, and huggingface_hub
  reads `HF_TOKEN` anyway).
- `run_extraction.py` swallowed the exception and "succeeded" with 0 records.
- The comparisons overwrite-guard saved the served data (phantoms and all), but the
  workflow's `git add -f` committed the EMPTY `result-records.json` (82f0a4b).
- Git history check: no non-empty result-records.json was EVER committed for either
  domain — the fast `--from-records` regen path has no data to run from. A real
  Docling re-extraction is the only route to clean data.

## 4. Fixes (this change set)

1. `benchmarks/extraction/run_extraction.py`: extraction-unavailable is now FATAL
   (non-zero exit). A failed extraction must fail the build, not ship empty output
   under a green check.
2. `scripts/ingest_domain.py` (`step_benchmark`): never overwrite a non-empty
   persisted `result-records.json` with an empty one (mirror of the comparisons guard).
3. `.github/workflows/domain-build.yml`: export `HF_TOKEN: ${{ secrets.HF_TOKEN }}`
   for the ingestion step; secret set from the owner's token.

## 5. Execution checklist

- [x] F1–F4 implemented + 8 regression tests pass (commit 0dec472, pushed)
- [ ] Fixes in §4 implemented, pipeline tests pass locally
- [ ] `HF_TOKEN` Actions secret set
- [ ] Commit + push §4, dispatch `domain-build` (grasp-planning, pages=benchmark, force)
- [ ] Run does a REAL extraction (~50 min, watch for the 403 gone)
- [ ] Verify new data: 0 letter-free raws, 0 Dex-Net rows from the equivariant paper,
      count < 1295, legit rows (AnyGrasp etc.) survive, non-empty result-records.json committed
- [ ] `git pull`, verify on local dev server (:3002)
- [ ] Then: same rebuild for motion-planning if its data shows the same class of bug

## 6. Related but separate (do NOT bundle)

- Frontend overhaul from the 2026-07-07 Fable audit: copilot pipeline (done, 209 tests),
  BenchmarksPage truthfulness (done, 20+18 tests), app UX (partial — App.js untouched),
  manual (not started). Integrate + full `craco test` + `npm run build` before any commit.
- Uncommitted extractor upgrades for the verified-triples pipeline
  (`backend/rag/ingest/*.py`, `verified_triples.json`) belong to the stalled extraction
  effort — keep out of benchmark commits.
- Audit items deferred (need design/another CI pass): alias-resolution of unresolved
  method names at emit time; grade-join so grade A stays earnable in the results path.
