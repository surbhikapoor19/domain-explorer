import json, os, sys
from benchmarks.extraction.locate import locate_tables
from benchmarks.extraction.tei_tables import records_from_tei_rows
from benchmarks.extraction.vlm_extract import parse_vlm_rows, verify_records, call_vlm
from benchmarks.extraction.render import find_caption_page, render_page_crop
from benchmarks.extraction.merge import merge_records
from benchmarks.extraction import cache as _cache
from benchmarks.adapters.records_io import load_records


def _page_text(pdf_path, page):
    import fitz
    doc = fitz.open(pdf_path)
    try:
        return doc.load_page(page).get_text()
    finally:
        doc.close()


def _default_client():
    import anthropic
    return anthropic.Anthropic()


def _default_converter():
    """Construct a Docling DocumentConverter for born-digital papers.

    OCR is disabled on purpose: the corpus is born-digital (selectable text), so
    OCR adds nothing but cost — and it pulls in RapidOCR, whose model/config
    packaging is fragile (a missing arch_config.yaml takes the whole converter
    down). Table-structure (TableFormer) stays on; that's what we actually need.
    Lazy imports so the module loads even when docling isn't installed.
    """
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    opts = PdfPipelineOptions()
    opts.do_ocr = False
    opts.do_table_structure = True
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})


def extract_paper(tei_path, pdf_path, cfg, resolver, *, vlm_client=None, render_fn=None,
                  crop_text_fn=None, crop_saver=None, find_page_fn=None):
    locs = locate_tables(tei_path, cfg)
    fp = find_page_fn or find_caption_page
    rf = render_fn or render_page_crop
    ct = crop_text_fn or _page_text
    merged = []
    for loc in locs:
        if loc.is_ablation_section or not (loc.is_results_section or loc.has_rows):
            continue
        page = fp(pdf_path, loc.caption) if pdf_path else None
        if loc.has_rows:
            recs = merge_records(records_from_tei_rows(loc, cfg, resolver), [])
        elif loc.is_results_section and pdf_path is not None:
            pg = page if page is not None else 0
            png = rf(pdf_path, pg, None)
            text = vlm_client(png) if vlm_client else call_vlm(png, _default_client())
            crop_text = ct(pdf_path, pg)
            recs = merge_records([], verify_records(parse_vlm_rows(text, loc, cfg, resolver), crop_text))
        else:
            continue
        crop_url = None
        if crop_saver and pdf_path is not None and page is not None:
            crop_url = crop_saver(loc.paper_id, loc.table_index, rf(pdf_path, page, loc.bbox))
        for r in recs:
            if r.page is None:
                r.page = page
            if crop_url and not r.crop_image:
                r.crop_image = crop_url
            # A paper's own rows are labeled "Ours"/"our method" (is_own_method) and
            # don't resolve by name — bind them to THIS paper's method (by paper_id),
            # so e.g. GraspVLA's "Ours" success rates are attributed to GraspVLA.
            # (The Docling path already did this; the TEI path — 51/55 papers — did not.)
            if r.is_own_method and r.method_id is None:
                r.method_id = resolver.resolve(loc.paper_id).method_id
        merged.extend(recs)
    return merged


def extract_paper_docling(pdf_path, paper_id, cfg, resolver, *, converter=None,
                          render_fn=None, crop_saver=None, vlm_client=None,
                          vlm_failed_out=None):
    """Docling localizes tables (bbox->crop) and supplies cell text as ground truth.
    If vlm_client is given, the VLM reads the crop for semantics and is verified against
    Docling's cells; otherwise the born-digital row parser is used.

    vlm_failed_out (optional): when a list is passed, any table whose VLM read failed
    because EVERY vision provider was exhausted (LLMUnavailable) AND that left the table
    with zero rows (an image table with no Docling text cells to recover) is appended as
    (paper_id, table_index). The caller uses a non-empty list to refuse caching this
    paper so it retries on the next build. Born-digital tables recovered from Docling's
    own cells are NOT flagged — their data is complete despite the VLM being down."""
    from benchmarks.extraction.docling_tables import convert_pdf, docling_tables_to_locations
    rf = render_fn or render_page_crop
    doc = convert_pdf(pdf_path, converter=converter)
    locs = docling_tables_to_locations(doc, paper_id, cfg)
    merged = []
    for loc in locs:
        if loc.is_ablation_section or not loc.has_rows:
            continue
        try:
            png = None
            if (crop_saver or vlm_client) and loc.page is not None and loc.bbox is not None:
                # docling page_no is 1-based; PyMuPDF load_page is 0-based
                png = rf(pdf_path, loc.page - 1, loc.bbox)
            recs = []
            vlm_errored = False
            if vlm_client and png is not None:
                cell_text = " ".join((c or "") for row in loc.rows for c in row)
                try:
                    recs = merge_records([], verify_records(
                        parse_vlm_rows(vlm_client(png), loc, cfg, resolver), cell_text))
                except Exception as ve:
                    # Every vision provider exhausted (quota/dead) -> don't sink the table:
                    # fall through to Docling's own cells below. A non-LLM error (bad crop,
                    # parser bug) is a genuine per-table fault -> re-raise to the outer
                    # handler so only THIS table is skipped.
                    if type(ve).__name__ != 'LLMUnavailable':
                        raise
                    vlm_errored = True
            # VLM produced nothing usable (truncated/invalid JSON, nothing that verified,
            # or every provider down) -> fall back to Docling's own extracted cells so a
            # single bad VLM read never drops the table or crashes the run.
            if not recs:
                recs = merge_records(records_from_tei_rows(loc, cfg, resolver), [])
            # A VLM outage that left an IMAGE table with zero rows (Docling has no text
            # cells to recover) is a real, recoverable loss -> flag it so the caller can
            # refuse to cache this paper and retry it next build. A born-digital table
            # recovered by Docling cells is NOT flagged (its data is complete).
            if vlm_errored and not recs and vlm_failed_out is not None:
                vlm_failed_out.append((loc.paper_id, loc.table_index))
            crop_url = crop_saver(loc.paper_id, loc.table_index, png) if (crop_saver and png is not None) else None
            for r in recs:
                if r.page is None:
                    r.page = loc.page
                if crop_url and not r.crop_image:
                    r.crop_image = crop_url
                if r.is_own_method and r.method_id is None:
                    r.method_id = resolver.resolve(paper_id).method_id
            merged.extend(recs)
        except Exception as e:
            # One bad table must never sink the whole paper/run.
            print(f"    WARNING: skipping table {loc.paper_id}#{loc.table_index} ({type(e).__name__}: {e})")
            continue
    return merged


def run(tei_dir, pdf_dir, cfg, resolver, *, vlm_client=None, crop_saver=None):
    records, unknown = [], []
    for fn in sorted(os.listdir(tei_dir)):
        if not fn.endswith('.tei.xml'):
            continue
        slug = fn.replace('.tei.xml', '')
        pdf = os.path.join(pdf_dir, slug + '.pdf')
        recs = extract_paper(os.path.join(tei_dir, fn),
                             pdf if os.path.exists(pdf) else None,
                             cfg, resolver, vlm_client=vlm_client, crop_saver=crop_saver)
        records.extend(recs)
        unknown += [r.metric_raw for r in recs if r.metric_id is None]
    return records, unknown


def _refresh_resolution(records, resolver):
    """Cheaply re-resolve method_id on CACHED records against the CURRENT resolver.

    The methods CSV is deliberately kept OUT of the cache salt (a weekly CSV change
    would else invalidate every entry), so a cached record whose method didn't
    resolve when it was stored gets a second chance here under today's names. A
    paper's own rows ("Ours") bind by paper_id; everything else by method_raw. A
    non-None method_id is NEVER overwritten."""
    for r in records:
        if r.method_id is not None:
            continue
        if r.is_own_method:
            r.method_id = resolver.resolve(r.paper_id).method_id
        else:
            r.method_id = resolver.resolve(r.method_raw).method_id


def run_docling(pdf_dir, cfg, resolver, *, converter=None, vlm_client=None, crop_saver=None,
                cache_path=None, cache_refresh=False, manifest_out=None):
    """Iterate *.pdf in pdf_dir through ONE shared DocumentConverter -> ResultRecords.
    Mirrors run() but uses the Docling path (no TEI needed).

    When cache_path is given, each paper is memoized by (paper_id, sha256(pdf), salt):
    an unchanged PDF is served straight from the cache (no Docling, no VLM), and the
    converter is built lazily on the FIRST miss only, so an all-cached run never loads
    Docling's models. cache_refresh ignores existing hits (re-extract all) but still
    rewrites the cache. The cache is saved after EACH extracted paper (crash-safe
    resume) and stale entries are pruned at the end. Default (cache_path=None) is
    byte-for-byte the pre-cache behavior.

    manifest_out (optional): when a mutable dict is passed, the per-paper Docling
    decision is threaded out into it as ``{paper_id: (status, pdf_sha256, n_records)}``
    with status in {'cached', 'extracted'} — an audit record of which papers were
    served from cache vs re-run through Docling. Default None keeps the return arity
    (records, unknown) unchanged so existing callers are unaffected."""
    use_cache = cache_path is not None
    want_manifest = manifest_out is not None
    cache = _cache.load_cache(cache_path) if use_cache else {'papers': {}}
    salt = (_cache.compute_salt(cfg, engine='docling', vlm_enabled=bool(vlm_client))
            if use_cache else None)
    records, unknown = [], []
    seen_ids = set()
    n_hit = n_extracted = n_vlm_failed = 0
    for fn in sorted(os.listdir(pdf_dir)):
        if not fn.endswith('.pdf'):
            continue
        slug = fn[:-4]
        seen_ids.add(slug)
        pdf_path = os.path.join(pdf_dir, fn)
        # Hash the PDF when the cache needs it OR the manifest wants to record it.
        pdf_sha = _cache.sha256_file(pdf_path) if (use_cache or want_manifest) else None
        hit = None
        if use_cache and not cache_refresh:
            hit = _cache.get_hit(cache, slug, pdf_sha, salt)
        vlm_failed = []
        if hit is not None:
            recs = load_records({'records': hit})
            _refresh_resolution(recs, resolver)
            n_hit += 1
        else:
            # Lazily build the (expensive) converter on the first miss only.
            if converter is None:
                converter = _default_converter()
            recs = extract_paper_docling(pdf_path, slug, cfg, resolver,
                                         converter=converter, crop_saver=crop_saver,
                                         vlm_client=vlm_client, vlm_failed_out=vlm_failed)
            n_extracted += 1
            if vlm_failed:
                # An image table got zero rows because every vision provider was down.
                # Do NOT cache: an empty cache entry would suppress the retry once quota
                # recovers. Leaving it uncached re-runs this paper on the next build.
                n_vlm_failed += 1
                print(f"    [cache] NOT caching {slug}: {len(vlm_failed)} table(s) lost to a "
                      f"VLM outage -> will retry next build")
            elif use_cache:
                # Save after each successful paper so a mid-run crash still leaves
                # completed papers cached (a failing paper is never cached).
                _cache.put_entry(cache, slug, pdf_sha, salt, recs)
                _cache.save_cache(cache_path, cache)
        if want_manifest:
            status = ('cached' if hit is not None
                      else 'vlm-failed' if vlm_failed else 'extracted')
            manifest_out[slug] = (status, pdf_sha, len(recs))
        records.extend(recs)
        unknown += [r.metric_raw for r in recs if r.metric_id is None]
    if use_cache:
        pruned = _cache.prune_missing(cache, seen_ids)
        _cache.save_cache(cache_path, cache)
        print(f"  [cache] {n_hit} hits, {n_extracted} extracted "
              f"({n_vlm_failed} not cached: VLM outage), {len(pruned)} pruned (salt={salt})")
    return records, unknown


def build_manifest_rows(decisions, pdf_sources=None):
    """Assemble the per-paper Docling-decision AUDIT MANIFEST rows (pure, network-free).

    decisions: ``{paper_id: (status, pdf_sha256, n_records)}`` as threaded out of
    run_docling (status in {'cached', 'extracted'}).
    pdf_sources: optional ``{paper_id: {'source': ...}}`` provenance map from
    fetch_missing_pdfs' pdf-sources.json (a bare string value is also accepted). A
    paper ABSENT from pdf_sources was shipped in-repo, so its source_ref is
    'committed'. Rows are sorted by paper_id for a stable, diffable manifest."""
    pdf_sources = pdf_sources or {}
    rows = []
    for paper_id in sorted(decisions):
        status, pdf_sha, n_records = decisions[paper_id]
        src = pdf_sources.get(paper_id)
        if isinstance(src, dict):
            source_ref = src.get('source') or 'committed'
        elif isinstance(src, str) and src:
            source_ref = src
        else:
            source_ref = 'committed'
        rows.append({
            'paper_id': paper_id,
            'pdf_sha256': pdf_sha,
            'pdf_sha256_short': (pdf_sha or '')[:12] or None,
            'source_ref': source_ref,
            'status': status,
            'n_records': n_records,
        })
    return rows


def _load_pdf_sources(explicit_path, manifest_path):
    """Load the pdf-sources.json provenance map: the explicit path if given, else a
    pdf-sources.json sitting NEXT TO the manifest. Returns {} on absent/unreadable
    (so the manifest simply labels every paper 'committed')."""
    path = explicit_path
    if not path and manifest_path:
        path = os.path.join(os.path.dirname(os.path.abspath(manifest_path)),
                            'pdf-sources.json')
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _make_crop_saver(crops_dir, url_prefix):
    os.makedirs(crops_dir, exist_ok=True)
    def saver(paper_id, idx, png):
        name = f"{paper_id}_t{idx}.png"
        with open(os.path.join(crops_dir, name), 'wb') as f:
            f.write(png)
        return f"{url_prefix}/{name}"
    return saver


def main():
    import argparse, csv
    from benchmarks.normalize.registries import load_config, MethodResolver
    p = argparse.ArgumentParser()
    p.add_argument('--config', default=None)
    p.add_argument('--tei-dir')
    p.add_argument('--pdf-dir')
    p.add_argument('--methods-csv')
    p.add_argument('--crops-dir', default=None)
    p.add_argument('--crops-url', default=None)
    p.add_argument('--engine', choices=['tei', 'docling'], default='docling')
    p.add_argument('--no-vlm', action='store_true', help='born-digital only; skip image-table VLM')
    p.add_argument('--cache', default=None,
                   help='per-PDF extraction cache JSON (docling engine only); unchanged PDFs are reused')
    p.add_argument('--cache-refresh', action='store_true',
                   help='ignore cache hits and re-extract every paper (still rewrites the cache)')
    p.add_argument('--manifest', default=None,
                   help='write a per-paper Docling-decision AUDIT MANIFEST JSON '
                        '(paper_id, sha256, source, cached/extracted, n_records)')
    p.add_argument('--pdf-sources', default=None,
                   help='pdf-sources.json provenance map (labels fetched vs committed '
                        'papers in the manifest); defaults to one next to --manifest')
    p.add_argument('--output', required=True)
    a = p.parse_args()
    cfg = load_config(a.config)
    corpus = cfg.get('corpus', {})
    tei_dir = a.tei_dir or corpus.get('tei_dir')
    pdf_dir = a.pdf_dir or corpus.get('pdf_dir')
    methods_csv = a.methods_csv or corpus.get('methods_csv')
    names = []
    with open(methods_csv) as f:
        for row in csv.DictReader(f):
            n = (row.get('Name') or '').replace('\U0001f916 ', '').strip()
            if n:
                names.append(n)
    resolver = MethodResolver(names, alias_seeds=cfg.get('method_aliases'))
    crop_saver = _make_crop_saver(a.crops_dir, a.crops_url) if a.crops_dir else None
    vlm_client = None
    if not a.no_vlm:
        # Docling stays the PRIMARY extractor; the VLM only reads image tables Docling
        # can't. Vision fallback = Gemini -> Gemini(key2) -> Anthropic, skipping any
        # provider whose key env is unset. Only build a client when at least one vision
        # key is present; otherwise stay born-digital (unchanged no-key behavior).
        vlm_key_envs = ('GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'ANTHROPIC_API_KEY')
        try:
            if any(os.environ.get(e) for e in vlm_key_envs):
                from benchmarks.extraction.vlm_extract import call_vlm_fallback
                vlm_client = lambda png: call_vlm_fallback(png)
                print("  VLM: multi-provider fallback (Gemini -> Gemini(key2) -> Anthropic)")
            else:
                print("  WARNING: no VLM key (GEMINI_API_KEY / GEMINI_API_KEY_2 / "
                      "ANTHROPIC_API_KEY); born-digital only")
        except Exception as e:
            print(f"  WARNING: VLM client unavailable ({e}); born-digital only")
    # When --manifest is set, collect the per-paper cache-HIT vs EXTRACTED decision
    # that run_docling already makes, so we can surface it as an auditable manifest.
    manifest_decisions = {} if a.manifest else None
    if a.engine == 'docling':
        try:
            records, unknown = run_docling(pdf_dir, cfg, resolver, vlm_client=vlm_client,
                                           crop_saver=crop_saver,
                                           cache_path=a.cache, cache_refresh=a.cache_refresh,
                                           manifest_out=manifest_decisions)
        except ImportError as e:
            # docling is an OPTIONAL dependency: a genuinely missing module must not
            # crash a whole domain build (grobid/rag/kg/hgt run in the same job).
            print(f"  WARNING: Docling not installed ({e}); writing empty benchmark output")
            records, unknown = [], []
        except Exception as e:
            # But a RUNTIME extraction failure (HF 403, network, parse error) must FAIL
            # the build. Shipping empty output under a green check silently preserved
            # stale served data and clobbered the records artifact (run 28857742075).
            print(f"  FATAL: Docling extraction failed ({e})")
            sys.exit(1)
    else:
        records, unknown = run(tei_dir, pdf_dir, cfg, resolver, vlm_client=vlm_client, crop_saver=crop_saver)
    payload = {'records': [r.__dict__ for r in records],
               'coldstart': {'metric_clusters': []},
               'stats': {'n_records': len(records),
                         'n_vlm': sum(1 for r in records if r.extractor == 'vlm'),
                         'n_unresolved_metric': len(unknown)}}
    with open(a.output, 'w') as f:
        json.dump(payload, f, indent=2, default=str)
    print(f"  result-records.json: {payload['stats']}")

    # AUDIT MANIFEST: surface each paper's cache-HIT vs EXTRACTED decision + its
    # PDF provenance so an admin can confirm which papers actually ran through
    # Docling and why. Only when --manifest is set (default: today's behavior).
    if a.manifest and manifest_decisions is not None:
        pdf_sources = _load_pdf_sources(a.pdf_sources, a.manifest)
        rows = build_manifest_rows(manifest_decisions, pdf_sources)
        with open(a.manifest, 'w') as f:
            json.dump(rows, f, indent=2, default=str)
        for row in rows:
            print("    [manifest] {pid:<28} {sha:<12} {src:<20} {st:<9} n={n}".format(
                pid=row['paper_id'], sha=row['pdf_sha256_short'] or '-',
                src=row['source_ref'], st=row['status'], n=row['n_records']))
        print(f"  extraction-manifest.json: {len(rows)} papers -> {a.manifest}")


if __name__ == '__main__':
    main()
