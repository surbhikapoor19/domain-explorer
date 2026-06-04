from dataclasses import dataclass, field
from typing import Optional
from lxml import etree
import os

NS = {'tei': 'http://www.tei-c.org/ns/1.0'}

@dataclass
class TableLocation:
    paper_id: str
    table_index: int
    caption: str
    section_label: str
    is_results_section: bool
    is_ablation_section: bool
    has_rows: bool
    rows: list = field(default_factory=list)
    page: Optional[int] = None
    bbox: Optional[list] = None

def _text(e):
    return ''.join(e.itertext()).strip() if e is not None else ''

def locate_tables(tei_path, cfg):
    paper_id = os.path.basename(str(tei_path)).replace('.tei.xml', '')
    res_kw = [k.lower() for k in cfg.get('results_section_keywords', [])]
    abl_kw = [k.lower() for k in cfg.get('ablation_section_keywords', [])]
    tree = etree.parse(str(tei_path))
    locs = []
    for i, fig in enumerate(tree.findall('.//tei:figure[@type="table"]', NS)):
        head = fig.find('tei:head', NS)
        caption = _text(head)
        section = ''
        anc = fig.getparent()
        while anc is not None:
            h = anc.find('tei:head', NS)
            if h is not None and _text(h):
                section = _text(h)
                break
            anc = anc.getparent()
        sl = section.lower()
        cl = caption.lower()
        tab = fig.find('tei:table', NS)
        rows = []
        if tab is not None:
            for r in tab.findall('tei:row', NS):
                cells = [_text(c) for c in r.findall('tei:cell', NS)]
                if cells:
                    rows.append(cells)
        is_abl = any(k in sl or k in cl for k in abl_kw)
        is_res = (not is_abl) and any(k in sl or k in cl for k in res_kw)
        locs.append(TableLocation(paper_id, i, caption, section, is_res, is_abl,
                                  has_rows=len(rows) > 0, rows=rows))
    return locs
