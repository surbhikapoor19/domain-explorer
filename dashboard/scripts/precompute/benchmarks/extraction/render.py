import fitz  # PyMuPDF

def find_caption_page(pdf_path, caption_snippet, max_chars=40):
    """Return 0-based page index whose text contains the caption snippet, else None."""
    snippet = (caption_snippet or '')[:max_chars].strip()
    if not snippet:
        return None
    doc = fitz.open(pdf_path)
    try:
        for i in range(doc.page_count):
            if snippet.lower() in doc.load_page(i).get_text().lower():
                return i
    finally:
        doc.close()
    return None

def render_page_crop(pdf_path, page, bbox=None, dpi=250):
    """Render a page (or bbox region) to PNG bytes. bbox = [x0,y0,x1,y1] in PDF points."""
    doc = fitz.open(pdf_path)
    try:
        pg = doc.load_page(page)
        clip = fitz.Rect(*bbox) if bbox else None
        pix = pg.get_pixmap(dpi=dpi, clip=clip)
        return pix.tobytes("png")
    finally:
        doc.close()
