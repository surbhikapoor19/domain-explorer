# Docling Benchmark Step in the Admin Domain-Build Pipeline — Scoping & Design

- **Date:** 2026-06-09
- **Goal:** Make the Admin-triggered domain build produce `benchmark-comparisons.json` + crops for *any* domain (motion planning first), using the **Docling** extraction tier (empirically best: 488 comparisons + 223 crops on grasp vs born-digital GROBID-TEI's 2 comparisons / failed crops).
- **Status:** Scoping for approval. No implementation until signed off.

## Why this gap exists (traced)
**Admin chain:** `trigger-build.js` → GitHub `domain-build` dispatch → `domain-build.yml` → `python scripts/ingest_domain.py --domain X --steps "grobid,rag,kg,hgt,precompute"`.

- That step list has **no `benchmark` step** (`ingest_domain.py` `ALL_STEPS` line 38 + if-chain ~385-399), so **no domain** gets benchmark data from a build.
- The only committed extraction entry point — `run()` in `run_extraction.py:89` — is the **TEI path** (`*.tei.xml` → `extract_paper()`). Motion's GROBID never produced TEI (`tei_dir: ""`, no `*.tei.xml`), so even invoking it would iterate zero tables.
- `extract_paper_docling()` (which needs **no TEI** and could run on motion's 11 PDFs today) is tested but has **no `main()`/CLI** calling it — it only ever ran via the ad-hoc `/tmp` script.

→ Motion got a graph from grobid→rag→kg→precompute; benchmarks need a step that path never had **plus** a committed Docling entry point.

## Design

### 1. Docling CLI entry (`run_extraction.py`)
- Add `run_docling(pdf_dir, cfg, resolver, *, converter=None, vlm_client=None, crop_saver=None)`: construct **one** `DocumentConverter` before the loop, iterate sorted `*.pdf`, call the existing `extract_paper_docling(pdf, stem, cfg, resolver, converter=…, crop_saver=…, vlm_client=…)`, accumulate `(records, unknown)` exactly like `run()`.
- Add `--engine {tei,docling}` (default `docling`) to `main()`; resolve `pdf_dir/methods_csv/crops_dir/crops_url` from args-or-`cfg['corpus']`; build `MethodResolver` from the CSV `Name` column; write `{records, coldstart, stats}` to `--output` (`result-records.json`).
- New args: `--pdf-dir --config --crops-dir --crops-url --no-vlm --engine --output`.
- Then `export_from_records()` (`benchmark_data.py:50`) turns `result-records.json` → `benchmark-comparisons.json`.

### 2. Where it slots (`ingest_domain.py` + `domain-build.yml`)
- `ingest_domain.py`: add `'benchmark'` to `ALL_STEPS`; define `step_benchmark(paths, domain)` (after `step_hgt`); add `elif step == 'benchmark': step_benchmark(...)` to the if-chain (**after precompute**). It resolves `crops_dir = output/'crops'`, `crops_url = /data-<slug>/crops`, `config = benchmarks/config/<domain>.json`, `pdf_dir = paths['papers']`, `methods_csv = dataset/<domain>.csv`, subprocess-invokes the Docling CLI, then exports to `output/benchmark-comparisons.json`. Skip-guard unless `--force`.
- `domain-build.yml`: add `elif [ "$PAGES" = "benchmark" ]; then STEPS="benchmark"`; append `,benchmark` to the `all` default (gated — see open questions); `pip install docling`; set `HF_HOME` cache + `ANTHROPIC_API_KEY` secret; `git add` the new outputs.

### 3. Domain-agnostic (remove 3 grasp-hardcodes)
1. `run_extraction.py` `--crops-url` default `/data-grasp-planning/crops` → default `None`, passed explicitly per domain.
2. `registries.py` default config path → only used on `load_config(None)`; `step_benchmark` always passes `--config`.
3. Add a `corpus` block to `grasp_planning.json` (currently missing) mirroring motion's, so grasp resolves the same way.
Everything downstream (metrics/conditions/aliases/confidence/aggregation) is already config-driven (`test_domain_agnostic.py`).

### 4. Crops & commit
- `_make_crop_saver(crops_dir, url_prefix)` → `dashboard/public/data-<slug>/crops/<paper>_t<idx>.png`, served at `/data-<slug>/crops/…`.
- Committed as **normal git files** (not LFS — only `datasets/*/papers.zip` is LFS today). Recommend **one representative crop per resolved table** to bound commit size; revisit LFS only if a domain's crops exceed tens of MB.

### 5. VLM = opt-in
- Gated on the `ANTHROPIC_API_KEY` CI secret. With it, the VLM reads each crop and is verified against Docling's own cell text; without it, falls back to born-digital `records_from_tei_rows` over Docling's cells. Wrap the `docling` import + `_default_client()` in try/except so a missing secret or failed install **degrades to a warning + clean output**, never fails the build.

### 6. Admin UI
- Reuse the existing build-status poll (no API change — `build-status.js` already returns per-step status). Add a **"Build benchmarks"** button posting `pages='benchmark'` (benchmark-only rebuild) alongside the existing all/explorer triggers; optionally a post-build link to the domain's Benchmarks page.

### Motion-planning (first test domain)
- PDFs exist (`datasets/motion-planning/papers/`, 11 files); config has metrics (planning_time/path_length/…) + corpus block; **Docling needs no TEI**, so it can run today. CSV has only `Name` (fine — resolver uses Name).

## Ordered TDD tasks
1. Add `corpus` block to `grasp_planning.json`; assert in `test_domain_agnostic`.
2. `run_docling()` (shared converter). *Test:* injected fake converter + 2 stub PDFs → merged records, converter constructed exactly once.
3. `--engine docling` in `main()` + arg/corpus path resolution; `--crops-url` default `None`. *Test:* invoke with motion config → valid `result-records.json`, no `/data-grasp-planning` reference.
4. Optional `docling`/VLM imports with graceful warnings. *Test:* `--no-vlm` → born-digital; simulated docling ImportError → warning + empty payload, no raise.
5. Export wiring (`export_from_records` thin CLI/call). *Test:* fixture `result-records.json` → `benchmark-comparisons.json` with expected key set.
6. `step_benchmark()` in `ingest_domain.py`. *Test:* monkeypatch `subprocess.run` → argv has `--engine docling --pdf-dir=papers --crops-url=/data-<slug>/crops --config=<domain>`; skips when output exists & not forced.
7. `domain-build.yml`: docling install, HF cache, `pages=benchmark` branch, git add. *Test:* yaml-lint + STEPS resolves correctly; first real motion run commits a `benchmark-comparisons.json`.
8. Admin "Build benchmarks" trigger. *Test:* click → `trigger-build` body `{domain, pages:'benchmark'}`; status poller renders the step.

## CI considerations
- **Model cache:** Docling model (~1–2 GB) downloads on first `DocumentConverter()`; set `HF_HOME`/`TORCH_HOME` + `actions/cache` so repeat builds skip it.
- **Memory:** ubuntu-latest ~7 GB + GROBID Docker already running → run benchmark **last/separately**; for `pages=benchmark`, skip GROBID entirely.
- **Timeout:** 60 min; Docling ~2–5 s/page CPU; 11 motion PDFs + model download ≈ 10–20 min — within budget; `locate` already filters ablation/non-results tables.
- **Deps:** pin `docling` version in the pip line.
- **Don't fail the job** on VLM/docling errors — degrade to a warning.

## Resolved decisions (2026-06-09)
1. **Trigger = explicit opt-in only.** Benchmark runs only via a `pages='benchmark'` trigger (Admin "Build benchmarks" button). Do **not** append `benchmark` to the `all` default — a normal full build stays fast and writes no crops it didn't before.
2. **Docling-only first.** Ship without the `ANTHROPIC_API_KEY` secret; VLM wiring is present but disabled (graceful born-digital fallback). Enable VLM later by adding the secret + funded credits.
3. **One crop per table** — already the behavior of `_make_crop_saver` (one PNG per `paper_t<idx>`). No change needed; bounded commit size.
4. **`result-records.json` is build-only / not committed** — ephemeral artifact; only `benchmark-comparisons.json` + `crops/` get committed.

(These simplify the plan: skip the `all`-default append in Task 7; keep VLM behind the absent secret in Task 4.)

## Risks
- Motion's optimization-paper tables may yield **fewer parseable tables** than grasp → a thin first benchmark (acceptable baseline, manage expectations).
- Model-download flakiness/size could blow the 60-min timeout if HF caching isn't wired first.
- Crop PNG + JSON commits **bloat git history** over rebuilds without a cap/LFS plan.
- The 27 MB CRISP PDF + Docling + GROBID could **OOM** the shared runner → run benchmark separately.
- **Grasp regression:** adding a corpus block + changing `--crops-url` default could alter grasp output → pin/verify grasp's `benchmark-comparisons.json` unchanged before/after.
- Born-digital fallback runs `records_from_tei_rows` over Docling's grid — header/condition-split could mis-resolve until validated on real motion tables.
