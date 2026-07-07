from benchmarks.extraction.locate import TableLocation, is_ablation_table


def _grid_to_rows(grid):
    rows = []
    for row in (grid or []):
        rows.append([(getattr(c, 'text', '') or '') for c in row])
    return rows


def docling_tables_to_locations(doc, paper_id, cfg):
    """Map a DoclingDocument into TableLocation objects with page + top-left bbox + grid rows."""
    res_kw = [k.lower() for k in cfg.get('results_section_keywords', [])]
    abl_kw = [k.lower() for k in cfg.get('ablation_section_keywords', [])]
    pages = getattr(doc, 'pages', {}) or {}
    out = []
    for i, t in enumerate(getattr(doc, 'tables', []) or []):
        try:
            caption = t.caption_text(doc) or ''
        except Exception:
            caption = ''
        rows = _grid_to_rows(getattr(getattr(t, 'data', None), 'grid', None))
        page, bbox = None, None
        prov = getattr(t, 'prov', None) or []
        if prov:
            page = getattr(prov[0], 'page_no', None)
            bb = getattr(prov[0], 'bbox', None)
            if bb is not None and page in pages:
                ph = pages[page].size.height
                tl = bb.to_top_left_origin(ph)
                bbox = [tl.l, tl.t, tl.r, tl.b]
        cl = caption.lower()
        is_abl = is_ablation_table(caption, '', rows, abl_kw)
        is_res = (not is_abl) and any(k in cl for k in res_kw)
        out.append(TableLocation(
            paper_id=paper_id, table_index=i, caption=caption, section_label='',
            is_results_section=is_res, is_ablation_section=is_abl,
            has_rows=len(rows) > 0, rows=rows, page=page, bbox=bbox))
    return out


def convert_pdf(pdf_path, converter=None):
    """Run Docling on a PDF and return the DoclingDocument. docling is imported lazily here ONLY."""
    if converter is None:
        from docling.document_converter import DocumentConverter
        converter = DocumentConverter()
    return converter.convert(pdf_path).document
