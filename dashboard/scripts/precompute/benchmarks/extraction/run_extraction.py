import json, os, sys
from benchmarks.extraction.locate import locate_tables
from benchmarks.extraction.tei_tables import records_from_tei_rows
from benchmarks.extraction.vlm_extract import parse_vlm_rows, verify_records, call_vlm
from benchmarks.extraction.render import find_caption_page, render_page_crop
from benchmarks.extraction.merge import merge_records


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
                          render_fn=None, crop_saver=None, vlm_client=None):
    """Docling localizes tables (bbox->crop) and supplies cell text as ground truth.
    If vlm_client is given, the VLM reads the crop for semantics and is verified against
    Docling's cells; otherwise the born-digital row parser is used."""
    from benchmarks.extraction.docling_tables import convert_pdf, docling_tables_to_locations
    rf = render_fn or render_page_crop
    doc = convert_pdf(pdf_path, converter=converter)
    locs = docling_tables_to_locations(doc, paper_id, cfg)
    merged = []
    for loc in locs:
        if loc.is_ablation_section or not loc.has_rows:
            continue
        png = None
        if (crop_saver or vlm_client) and loc.page is not None and loc.bbox is not None:
            # docling page_no is 1-based; PyMuPDF load_page is 0-based
            png = rf(pdf_path, loc.page - 1, loc.bbox)
        if vlm_client and png is not None:
            cell_text = " ".join((c or "") for row in loc.rows for c in row)
            recs = merge_records([], verify_records(
                parse_vlm_rows(vlm_client(png), loc, cfg, resolver), cell_text))
        else:
            recs = merge_records(records_from_tei_rows(loc, cfg, resolver), [])
        crop_url = crop_saver(loc.paper_id, loc.table_index, png) if (crop_saver and png is not None) else None
        for r in recs:
            if r.page is None:
                r.page = loc.page
            if crop_url and not r.crop_image:
                r.crop_image = crop_url
            if r.is_own_method and r.method_id is None:
                r.method_id = resolver.resolve(paper_id).method_id
        merged.extend(recs)
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


def run_docling(pdf_dir, cfg, resolver, *, converter=None, vlm_client=None, crop_saver=None):
    """Iterate *.pdf in pdf_dir through ONE shared DocumentConverter -> ResultRecords.
    Mirrors run() but uses the Docling path (no TEI needed)."""
    if converter is None:
        converter = _default_converter()
    records, unknown = [], []
    for fn in sorted(os.listdir(pdf_dir)):
        if not fn.endswith('.pdf'):
            continue
        slug = fn[:-4]
        recs = extract_paper_docling(os.path.join(pdf_dir, fn), slug, cfg, resolver,
                                     converter=converter, crop_saver=crop_saver, vlm_client=vlm_client)
        records.extend(recs)
        unknown += [r.metric_raw for r in recs if r.metric_id is None]
    return records, unknown


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
        # Anthropic when its key exists; else Groq vision (same JSON contract) so CI
        # can run the VLM path with the GROQ_API_KEY it already has.
        try:
            if os.environ.get('ANTHROPIC_API_KEY'):
                client = _default_client()
                vlm_client = lambda png: call_vlm(png, client)
            elif os.environ.get('GROQ_API_KEY'):
                from benchmarks.extraction.vlm_extract import call_vlm_groq
                groq_key = os.environ['GROQ_API_KEY']
                vlm_client = lambda png: call_vlm_groq(png, groq_key)
                print("  VLM: using Groq vision fallback")
            else:
                print("  WARNING: no VLM key (ANTHROPIC_API_KEY or GROQ_API_KEY); born-digital only")
        except Exception as e:
            print(f"  WARNING: VLM client unavailable ({e}); born-digital only")
    if a.engine == 'docling':
        try:
            records, unknown = run_docling(pdf_dir, cfg, resolver, vlm_client=vlm_client, crop_saver=crop_saver)
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


if __name__ == '__main__':
    main()
