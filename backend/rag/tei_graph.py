"""TEI-aware graph extraction.

Replaces fuzzy string matching in citation_resolver with precise biblStruct-based
resolution, and adds first-class support for:

  - Cross-corpus citations with in-text sentiment (builds_on / differs_from / neutral)
  - External reference nodes (cited works not in our corpus)
  - Paper authors
  - Institutions / affiliations
  - Structured table cells (2D array on table nodes)
  - Equation / formula nodes
  - Section-type metadata (intro, method, experiments, limitations, ...)

Reads TEI-XML files from ``<chroma_db>/tei/<paper_id>.tei.xml`` produced by
``grobid_parser.parse_pdf_grobid``.
"""

from __future__ import annotations

import glob
import os
import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

import networkx as nx


TEI_NS = {'tei': 'http://www.tei-c.org/ns/1.0'}

POSITIVE_CITATION_CUES = [
    r'\bbuilds?\s+on\b', r'\bextends?\b', r'\binspired\s+by\b', r'\bfollowing\b',
    r'\bfollows\b', r'\bsimilar\s+to\b', r'\bbased\s+on\b', r'\badopt(?:s|ed)?\b',
    r'\buse(?:s|d)?\b', r'\bleverage(?:s|d)?\b',
]
NEGATIVE_CITATION_CUES = [
    r'\boutperform(?:s|ed)?\b', r'\bimprove(?:s|d|ment)?\b',
    r'\bcompared?\s+to\b', r'\bunlike\b', r'\bhowever\b',
    r'\bin\s+contrast\b', r'\bdiffer(?:s|ent)?\b', r'\bbetter\s+than\b',
    r'\bsurpass(?:es|ed)?\b',
]


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _text(elem, strip=True) -> str:
    if elem is None:
        return ""
    parts = [t for t in elem.itertext() if t]
    s = " ".join(parts)
    s = re.sub(r'\s+', ' ', s)
    return s.strip() if strip else s


def _normalize(s: str) -> str:
    """Lowercase, strip accents, collapse whitespace, remove punctuation."""
    if not s:
        return ""
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')
    s = re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()
    return re.sub(r'\s+', ' ', s)


def _load_tei(paper_id: str, tei_dir: str) -> Optional[ET.Element]:
    path = os.path.join(tei_dir, f"{paper_id}.tei.xml")
    if not os.path.exists(path):
        return None
    try:
        return ET.parse(path).getroot()
    except ET.ParseError:
        return None


# ---------------------------------------------------------------------------
# Authors + affiliations
# ---------------------------------------------------------------------------

@dataclass
class TEIAuthor:
    full_name: str
    first_name: str = ""
    last_name: str = ""
    affiliation: str = ""
    institution: str = ""


def extract_authors(root: ET.Element) -> list:
    """Pull structured author records from the TEI header."""
    authors = []
    for a in root.findall('.//tei:teiHeader//tei:fileDesc//tei:sourceDesc//tei:biblStruct//tei:author', TEI_NS):
        persname = a.find('tei:persName', TEI_NS)
        if persname is None:
            continue
        first = _text(persname.find('tei:forename', TEI_NS)) or ""
        last = _text(persname.find('tei:surname', TEI_NS)) or ""
        if not last and not first:
            continue
        full = (first + " " + last).strip()
        # Affiliation — take first one
        aff_elem = a.find('tei:affiliation', TEI_NS)
        aff_name = ""
        inst_name = ""
        if aff_elem is not None:
            orgs = aff_elem.findall('tei:orgName', TEI_NS)
            parts = [_text(o) for o in orgs if _text(o)]
            aff_name = ", ".join(parts)
            # Institution = the first orgName with type="institution" or first of any type
            for o in orgs:
                if o.get('type') == 'institution':
                    inst_name = _text(o)
                    break
            if not inst_name and orgs:
                inst_name = _text(orgs[0])
        authors.append(TEIAuthor(
            full_name=full,
            first_name=first,
            last_name=last,
            affiliation=aff_name,
            institution=inst_name,
        ))
    # De-duplicate by full name (preserve order)
    seen = set()
    unique = []
    for a in authors:
        key = _normalize(a.full_name)
        if not key or key in seen:
            continue
        # Sanity filter: GROBID sometimes misclassifies affiliations / acknowledgements
        # as authors, producing hundreds of fake "authors". Drop obvious garbage.
        name = a.full_name.strip()
        if len(name) < 3 or len(name) > 60:
            continue
        if not re.search(r'[A-Za-z]', name):
            continue
        # Too many digits = probably address/date fragment, not a person
        digit_ratio = sum(c.isdigit() for c in name) / max(len(name), 1)
        if digit_ratio > 0.15:
            continue
        seen.add(key)
        unique.append(a)
    # Safety cap — real grasping papers rarely exceed ~20 authors.
    # If GROBID produced more, it's almost certainly a parse error.
    MAX_AUTHORS_PER_PAPER = 30
    if len(unique) > MAX_AUTHORS_PER_PAPER:
        return unique[:MAX_AUTHORS_PER_PAPER]
    return unique


# ---------------------------------------------------------------------------
# Bibliography + citations
# ---------------------------------------------------------------------------

@dataclass
class TEIBibEntry:
    xml_id: str          # e.g. "b23"
    title: str = ""
    year: str = ""
    authors: list = field(default_factory=list)  # list of "Last, F." strings
    first_author_last: str = ""
    doi: str = ""
    arxiv_id: str = ""
    venue: str = ""
    raw: str = ""


def _parse_bib_entry(bibl: ET.Element) -> TEIBibEntry:
    xml_id = bibl.get('{http://www.w3.org/XML/1998/namespace}id', '')
    title_el = bibl.find('.//tei:title[@type="main"]', TEI_NS) or bibl.find('.//tei:title', TEI_NS)
    title = _text(title_el)
    authors = []
    first_last = ""
    for a in bibl.findall('.//tei:author', TEI_NS):
        persname = a.find('tei:persName', TEI_NS)
        if persname is None:
            continue
        first = _text(persname.find('tei:forename', TEI_NS))
        last = _text(persname.find('tei:surname', TEI_NS))
        if last:
            authors.append(f"{last}, {first[:1] + '.' if first else ''}".strip())
            if not first_last:
                first_last = last
    year = ""
    date_el = bibl.find('.//tei:date', TEI_NS)
    if date_el is not None:
        when = date_el.get('when') or _text(date_el)
        m = re.search(r'(19|20)\d{2}', when or '')
        if m:
            year = m.group(0)
    doi = ""
    arxiv = ""
    for idno in bibl.findall('.//tei:idno', TEI_NS):
        t = (idno.get('type') or '').lower()
        val = _text(idno)
        if t == 'doi' and not doi:
            doi = val
        elif t in ('arxiv', 'arxivid') and not arxiv:
            arxiv = val
    venue_el = bibl.find('.//tei:title[@level="j"]', TEI_NS) or bibl.find('.//tei:title[@level="m"]', TEI_NS)
    venue = _text(venue_el)
    return TEIBibEntry(
        xml_id=xml_id, title=title, year=year, authors=authors,
        first_author_last=first_last, doi=doi, arxiv_id=arxiv, venue=venue,
        raw=_text(bibl)[:400],
    )


def extract_bibliography(root: ET.Element) -> list:
    """All <biblStruct> in the paper's reference list."""
    entries = []
    for bibl in root.findall('.//tei:listBibl/tei:biblStruct', TEI_NS):
        entries.append(_parse_bib_entry(bibl))
    return entries


def build_corpus_title_index(paper_titles: dict) -> dict:
    """{normalized_title: paper_id} — for matching TEI bib entries to corpus papers."""
    idx = {}
    for pid, title in paper_titles.items():
        key = _normalize(title)
        if key and len(key) > 5:
            idx[key] = pid
            # Also store a short-token signature (first 40 chars) to catch truncation
            short = key[:60]
            if short and short not in idx:
                idx[short] = pid
    return idx


def match_bib_to_corpus(bib_entries: list, title_index: dict) -> dict:
    """{xml_id: corpus_paper_id or None}."""
    out = {}
    for b in bib_entries:
        key = _normalize(b.title)
        match = None
        if key in title_index:
            match = title_index[key]
        elif key and len(key) > 10:
            # Fallback: any title_index key contained in or containing ours
            for idx_key, pid in title_index.items():
                if idx_key in key or (len(key) > 20 and key in idx_key):
                    match = pid
                    break
        out[b.xml_id] = match
    return out


def _citation_sentiment(context: str) -> str:
    """Classify citation sentiment from a ±140-char window.

    Uses a score margin rather than boolean AND so contexts containing
    *both* positive and negative cues still land on the stronger signal
    (academic prose frequently has both in one sentence).
    """
    ctx = context.lower()
    pos_score = sum(1 for p in POSITIVE_CITATION_CUES if re.search(p, ctx))
    neg_score = sum(1 for p in NEGATIVE_CITATION_CUES if re.search(p, ctx))
    if pos_score == 0 and neg_score == 0:
        return 'neutral'
    margin = pos_score - neg_score
    if margin >= 1:
        return 'builds_on'
    if margin <= -1:
        return 'differs_from'
    # Tie: lean slightly to the rarer class to avoid washing everything out
    return 'builds_on' if pos_score > 0 else 'differs_from'


def extract_in_text_citations(root: ET.Element, bib_to_corpus: dict) -> list:
    """Find every <ref type='bibr' target='#b23'> and record (source_bib_id, context, sentiment).

    Returns: [{target_bib: 'b23', context: str, sentiment: str}, ...]
    """
    out = []
    for body in root.findall('.//tei:body', TEI_NS):
        for p in body.iter('{http://www.tei-c.org/ns/1.0}p'):
            # Get the full paragraph text with refs as markers
            p_text = _text(p)
            if not p_text:
                continue
            for ref in p.findall('.//tei:ref[@type="bibr"]', TEI_NS):
                target = (ref.get('target') or '').lstrip('#')
                if not target:
                    continue
                # Window around this ref's text in the paragraph
                ref_txt = _text(ref)
                if ref_txt:
                    idx = p_text.find(ref_txt)
                else:
                    idx = -1
                if idx >= 0:
                    start = max(0, idx - 200)
                    end = min(len(p_text), idx + len(ref_txt) + 200)
                    context = p_text[start:end]
                else:
                    start = 0
                    context = p_text[:400]
                # Snap the START to a clean sentence. A +/-200-char window almost
                # always begins mid-word; the citation sits near the window's MIDDLE,
                # so the first sentence boundary in the first half is before the ref and
                # safe to drop. If there is none, drop the leading partial word so the
                # quote never begins mid-word ("raining" -> "training").
                if start > 0:
                    m = re.search(r'[.?!]\s+', context)
                    if m and m.end() < len(context) * 0.5:
                        context = context[m.end():]
                    else:
                        sp = context.find(' ')
                        if 0 < sp < 20:
                            context = context[sp + 1:]
                last_end = max(context.rfind('. '), context.rfind('? '), context.rfind('! '))
                if last_end > len(context) * 0.5:
                    context = context[:last_end + 1]
                # Mark THIS citation's own reference marker inside the context (CJK
                # brackets, which won't collide with English text) so the UI can BOLD
                # which bracket is the cited paper; the others in the sentence are
                # co-cited and stay plain.
                marked = context
                if ref_txt and ref_txt in context:
                    marked = context.replace(ref_txt, '【' + ref_txt + '】', 1)
                out.append({
                    'target_bib': target,
                    'corpus_target': bib_to_corpus.get(target),
                    'context': marked,
                    'sentiment': _citation_sentiment(context),
                })
    return out


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------

@dataclass
class TEITable:
    table_index: int
    caption: str
    header: list = field(default_factory=list)
    rows: list = field(default_factory=list)   # list[list[str]]
    raw_text: str = ""


def extract_tables(root: ET.Element) -> list:
    tables = []
    for i, fig in enumerate(root.findall('.//tei:figure', TEI_NS)):
        if fig.get('type') != 'table':
            continue
        head = fig.find('tei:head', TEI_NS)
        desc = fig.find('tei:figDesc', TEI_NS)
        caption_parts = [p for p in (_text(head), _text(desc)) if p]
        caption = " - ".join(caption_parts)
        t = fig.find('tei:table', TEI_NS)
        rows = []
        header = []
        if t is not None:
            for j, row in enumerate(t.findall('tei:row', TEI_NS)):
                cells = [_text(c) for c in row.findall('tei:cell', TEI_NS)]
                if any(cells):
                    if j == 0:
                        header = cells
                    else:
                        rows.append(cells)
        if rows or header:
            tables.append(TEITable(
                table_index=i + 1,
                caption=caption[:300],
                header=header,
                rows=rows,
                raw_text=_text(fig)[:800],
            ))
    return tables


# ---------------------------------------------------------------------------
# Formulas
# ---------------------------------------------------------------------------

@dataclass
class TEIFormula:
    index: int
    latex: str


def extract_formulas(root: ET.Element) -> list:
    """Every <formula> element as latex (best-effort; GROBID returns LaTeX when present)."""
    out = []
    for i, f in enumerate(root.findall('.//tei:formula', TEI_NS)):
        latex = _text(f)
        if latex and len(latex) > 3:
            out.append(TEIFormula(index=i + 1, latex=latex[:400]))
    return out


# ---------------------------------------------------------------------------
# Figures (structured captions)
# ---------------------------------------------------------------------------

@dataclass
class TEIFigure:
    index: int
    caption: str
    head: str = ""


def extract_figures(root: ET.Element) -> list:
    out = []
    for i, fig in enumerate(root.findall('.//tei:figure', TEI_NS)):
        if fig.get('type') == 'table':
            continue
        head = _text(fig.find('tei:head', TEI_NS))
        desc = _text(fig.find('tei:figDesc', TEI_NS))
        caption = " ".join(p for p in (head, desc) if p)
        if caption:
            out.append(TEIFigure(index=i + 1, caption=caption[:400], head=head[:120]))
    return out


# ---------------------------------------------------------------------------
# Graph enrichment entry point
# ---------------------------------------------------------------------------

@dataclass
class TEIStats:
    papers_processed: int = 0
    authors: int = 0
    institutions: int = 0
    internal_citations: int = 0
    external_refs: int = 0
    tables: int = 0
    figures: int = 0
    formulas: int = 0
    co_authored: int = 0
    colleagues: int = 0
    co_cited: int = 0
    shared_bibliography: int = 0
    author_works_on: int = 0
    datasets: int = 0
    uses_dataset: int = 0


def _slug(s: str, prefix: str = "") -> str:
    slug = _normalize(s).replace(' ', '-')[:80]
    return f"{prefix}{slug}" if slug else ""


def enrich_graph_from_tei(
    G: nx.DiGraph,
    tei_dir: str,
    paper_titles: dict,
    paper_texts: dict = None,
) -> TEIStats:
    """Walk through TEI files for each paper and add author/institution/citation/
    table/formula nodes + edges to the existing NetworkX graph.

    ``paper_titles`` = {paper_id: title_str} for matching bibliography to corpus.
    ``paper_texts`` = optional {paper_id: full_text} for chunk-based dataset mining.
    """
    stats = TEIStats()
    title_index = build_corpus_title_index(paper_titles)

    # Per-paper bookkeeping for post-loop derived relationships
    paper_authors = {}       # {paper_node: [author_node]}
    paper_institutions = {}  # {paper_node: [institution_node]}
    paper_ext_refs = {}      # {paper_node: set(reference_node)}
    paper_tables = {}        # {paper_node: [TEITable]}

    for paper_id in paper_titles:
        root = _load_tei(paper_id, tei_dir)
        if root is None:
            continue
        stats.papers_processed += 1
        paper_node = f"paper:{paper_id}"
        if paper_node not in G:
            continue

        # --- Authors + institutions ---
        paper_authors[paper_node] = []
        paper_institutions[paper_node] = []
        authors = extract_authors(root)
        for a in authors:
            aid = _slug(a.full_name, 'author:')
            if not aid:
                continue
            if aid not in G:
                G.add_node(aid, type='author', label=a.full_name,
                           affiliation=a.affiliation, institution=a.institution)
                stats.authors += 1
            if not G.has_edge(paper_node, aid):
                G.add_edge(paper_node, aid, type='authored_by')
            paper_authors[paper_node].append(aid)
            if a.institution:
                iid = _slug(a.institution, 'institution:')
                if iid and iid not in G:
                    G.add_node(iid, type='institution', label=a.institution[:120])
                    stats.institutions += 1
                if iid and not G.has_edge(aid, iid):
                    G.add_edge(aid, iid, type='affiliated_with')
                # Also link paper → institution for quick queries
                if iid and not G.has_edge(paper_node, iid):
                    G.add_edge(paper_node, iid, type='published_from')
                if iid and iid not in paper_institutions[paper_node]:
                    paper_institutions[paper_node].append(iid)

        # --- Bibliography + citations ---
        bib_entries = extract_bibliography(root)
        bib_to_corpus = match_bib_to_corpus(bib_entries, title_index)
        # External reference nodes for bib entries NOT matched to corpus
        for b in bib_entries:
            if bib_to_corpus.get(b.xml_id):
                continue
            # External work
            ref_key_src = b.doi or b.arxiv_id or (b.title + b.year)
            if not ref_key_src:
                continue
            rid = _slug(ref_key_src, 'reference:')
            if not rid:
                continue
            if rid not in G:
                label = b.title[:120] if b.title else (b.first_author_last + ' ' + b.year).strip() or 'Unknown reference'
                G.add_node(rid, type='reference', label=label,
                           year=b.year, authors=b.authors[:6], venue=b.venue[:80],
                           doi=b.doi, arxiv=b.arxiv_id)
                stats.external_refs += 1
            if not G.has_edge(paper_node, rid):
                G.add_edge(paper_node, rid, type='cites_external')
            paper_ext_refs.setdefault(paper_node, set()).add(rid)

        # In-text citations with sentiment
        in_text = extract_in_text_citations(root, bib_to_corpus)
        # Aggregate per target (mentions count + merge sentiment majority)
        agg = {}
        for ct in in_text:
            target = ct['corpus_target']
            if not target:
                continue
            key = target
            d = agg.setdefault(key, {'mentions': 0, 'contexts': [], 'sentiments': []})
            d['mentions'] += 1
            if len(d['contexts']) < 3:
                ctx = ct['context']
                if len(ctx) > 400:
                    cut = max(ctx.rfind('. ', 0, 400), ctx.rfind('? ', 0, 400), ctx.rfind('! ', 0, 400))
                    ctx = ctx[:cut + 1] if cut > len(ctx) * 0.5 else ctx[:400]
                d['contexts'].append(ctx)
            d['sentiments'].append(ct['sentiment'])
        for tgt_pid, data in agg.items():
            tgt_node = f"paper:{tgt_pid}"
            if tgt_node not in G or tgt_node == paper_node:
                continue
            # Majority sentiment
            if data['sentiments']:
                from collections import Counter
                maj = Counter(data['sentiments']).most_common(1)[0][0]
            else:
                maj = 'neutral'
            if not G.has_edge(paper_node, tgt_node):
                G.add_edge(paper_node, tgt_node, type='cites',
                           mentions=data['mentions'], contexts=data['contexts'],
                           sentiment=maj, source='tei')
                stats.internal_citations += 1

        # --- Tables ---
        tables = extract_tables(root)
        paper_tables[paper_node] = tables
        for tbl in tables:
            tid = f"table:{paper_id}_{tbl.table_index}"
            label = f"Table {tbl.table_index}"
            if tbl.caption:
                label = f"Table {tbl.table_index}: {tbl.caption[:80]}"
            # Persist structured cells as JSON-serializable lists
            cells = [tbl.header] + tbl.rows if tbl.header else tbl.rows
            if tid not in G:
                G.add_node(
                    tid, type='table', label=label, paper_id=paper_id,
                    caption=tbl.caption[:300],
                    cells=cells,
                    value=tbl.raw_text[:1200],  # back-compat for old renderer
                )
                stats.tables += 1
            if not G.has_edge(paper_node, tid):
                G.add_edge(paper_node, tid, type='has_table')

        # --- Figures (TEI-derived captions; overrides any earlier figure node for clarity) ---
        figures = extract_figures(root)
        for fig in figures:
            fid = f"figure:{paper_id}_{fig.index}"
            label = fig.head[:80] if fig.head else fig.caption[:80]
            if fid not in G:
                G.add_node(fid, type='figure', label=label, paper_id=paper_id,
                           caption=fig.caption[:400], value=fig.caption[:400])
                stats.figures += 1
            if not G.has_edge(paper_node, fid):
                G.add_edge(paper_node, fid, type='has_figure')

        # --- Formulas ---
        formulas = extract_formulas(root)
        for f in formulas[:40]:  # cap per paper to avoid flooding
            fid = f"equation:{paper_id}_{f.index}"
            if fid not in G:
                G.add_node(fid, type='equation', label=f"Eq {f.index}", paper_id=paper_id,
                           latex=f.latex, value=f.latex)
                stats.formulas += 1
            if not G.has_edge(paper_node, fid):
                G.add_edge(paper_node, fid, type='has_equation')

    # ========================================================================
    # Derived relationships (computed after all papers parsed)
    # ========================================================================
    _add_coauthorship(G, paper_authors, stats)
    _add_institution_collaboration(G, paper_institutions, stats)
    _add_cocitation_and_coupling(G, paper_ext_refs, stats)
    _add_author_works_on(G, paper_authors, stats)
    _add_dataset_edges(G, paper_tables, stats, paper_texts=paper_texts)

    return stats


# ---------------------------------------------------------------------------
# Derived relationship builders
# ---------------------------------------------------------------------------

def _add_coauthorship(G, paper_authors, stats):
    """author ↔ author edge when they appear on the same paper.

    Edge weight = number of shared papers. Directed graph → store as two
    symmetric edges with identical metadata so downstream queries work either way.
    """
    from collections import Counter
    pair_counts = Counter()
    for authors in paper_authors.values():
        uniq = sorted(set(authors))
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                pair_counts[(uniq[i], uniq[j])] += 1
    for (a, b), w in pair_counts.items():
        if not G.has_edge(a, b):
            G.add_edge(a, b, type='co_authored_with', weight=w, source='tei_derived')
            stats.co_authored += 1
        if not G.has_edge(b, a):
            G.add_edge(b, a, type='co_authored_with', weight=w, source='tei_derived')


def _add_institution_collaboration(G, paper_institutions, stats):
    """institution ↔ institution edge when both appear on the same paper."""
    from collections import Counter
    pair_counts = Counter()
    for insts in paper_institutions.values():
        uniq = sorted(set(insts))
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                pair_counts[(uniq[i], uniq[j])] += 1
    for (a, b), w in pair_counts.items():
        if not G.has_edge(a, b):
            G.add_edge(a, b, type='colleagues_with', weight=w, source='tei_derived')
            stats.colleagues += 1
        if not G.has_edge(b, a):
            G.add_edge(b, a, type='colleagues_with', weight=w, source='tei_derived')


def _add_cocitation_and_coupling(G, paper_ext_refs, stats,
                                  cocitation_min=3, coupling_min_jaccard=0.08):
    """Two corpus papers are 'co-cited' (use `co_cited_with`) if they cite ≥N
    shared external works. They 'share_bibliography' (use `shares_bibliography`)
    if their bibliographies have Jaccard similarity above a threshold.

    cocitation_min: absolute overlap required for co_cited_with
    coupling_min_jaccard: |A∩B| / |A∪B| threshold for shares_bibliography
    """
    papers = list(paper_ext_refs.keys())
    for i in range(len(papers)):
        a = papers[i]
        refs_a = paper_ext_refs[a]
        if not refs_a:
            continue
        for j in range(i + 1, len(papers)):
            b = papers[j]
            refs_b = paper_ext_refs[b]
            if not refs_b:
                continue
            shared = refs_a & refs_b
            if not shared:
                continue
            jaccard = len(shared) / len(refs_a | refs_b)
            # co_cited_with (raw overlap ≥ threshold)
            if len(shared) >= cocitation_min and not G.has_edge(a, b):
                G.add_edge(a, b, type='co_cited_with',
                           weight=len(shared), source='tei_derived')
                G.add_edge(b, a, type='co_cited_with',
                           weight=len(shared), source='tei_derived')
                stats.co_cited += 1
            # shares_bibliography (proportional overlap)
            if jaccard >= coupling_min_jaccard:
                if not G.has_edge(a, b) or G[a][b].get('type') != 'shares_bibliography':
                    # Add as separate edge type only if co_cited edge doesn't
                    # already cover this pair — otherwise skip the duplicate
                    if not (G.has_edge(a, b) and G[a][b].get('type') == 'co_cited_with'):
                        G.add_edge(a, b, type='shares_bibliography',
                                   jaccard=round(jaccard, 3), shared=len(shared),
                                   source='tei_derived')
                        G.add_edge(b, a, type='shares_bibliography',
                                   jaccard=round(jaccard, 3), shared=len(shared),
                                   source='tei_derived')
                        stats.shared_bibliography += 1


def _add_author_works_on(G, paper_authors, stats):
    """Transitive: author → technique/backbone/method via their papers.

    Walks: author ← authored_by ← paper → uses_technique/uses_backbone → concept.
    Resulting edge: author → concept (author_works_on) with weight = paper count.
    """
    from collections import defaultdict
    # Build paper→[concept] for concept-typed neighbors we care about
    CONCEPT_EDGES = {'uses_technique', 'uses_backbone', 'uses_loss', 'uses_architecture'}
    paper_concepts = defaultdict(set)
    for pnode in paper_authors:
        for _, nbr, ed in G.out_edges(pnode, data=True):
            if ed.get('type') in CONCEPT_EDGES:
                paper_concepts[pnode].add(nbr)
    # For each author, aggregate concepts across their papers
    author_concept_count = defaultdict(lambda: defaultdict(int))
    for pnode, authors in paper_authors.items():
        for aid in authors:
            for concept in paper_concepts.get(pnode, ()):
                author_concept_count[aid][concept] += 1
    for aid, concepts in author_concept_count.items():
        for concept, w in concepts.items():
            if not G.has_edge(aid, concept):
                G.add_edge(aid, concept, type='author_works_on',
                           weight=w, source='tei_derived')
                stats.author_works_on += 1


def _add_dataset_edges(G, paper_tables, stats, paper_texts=None):
    """Emit paper → dataset edges from TEI table headers and (optionally) chunk text.

    Only creates edges to datasets that ALREADY exist in the graph (added via
    CSV explosion in feature_engineering.py). Never creates orphan dataset
    nodes — if a match candidate isn't in the existing vocabulary, it's skipped.

    Approach:
      1. Vocabulary = all existing `dataset`-typed nodes in the graph
      2. Scan each paper's TEI table cells (header row + first column)
      3. If paper_texts is provided, also scan full paper text for dataset mentions
    """
    import re
    # Vocabulary: existing dataset nodes only (from CSV explosion)
    known = {}  # normalized_name → graph node id
    for nid, nd in G.nodes(data=True):
        if nd.get('type') != 'dataset':
            continue
        label = (nd.get('label') or '').strip()
        if not label:
            continue
        key = re.sub(r'[^a-z0-9]+', '', label.lower())
        if key:
            known[key] = nid

    if not known:
        # CSV didn't produce any dataset nodes — nothing to link to.
        return

    def _norm(s):
        return re.sub(r'[^a-z0-9]+', '', (s or '').lower())

    # Build a compiled regex that matches any known dataset as a whole word
    # (case-insensitive). Sort long-to-short so "GraspNet-1B" matches before "GraspNet".
    dataset_labels = sorted(
        [(nd.get('label'), nid) for nid, nd in G.nodes(data=True) if nd.get('type') == 'dataset' and nd.get('label')],
        key=lambda x: -len(x[0])
    )
    alternation = '|'.join(re.escape(lbl) for lbl, _ in dataset_labels)
    text_pattern = re.compile(r'\b(' + alternation + r')\b', re.IGNORECASE) if alternation else None

    for paper_node, tables in paper_tables.items():
        seen = set()
        # --- Table-based: headers + first column of each row ---
        for tbl in tables:
            cells_to_scan = []
            if tbl.header:
                cells_to_scan.extend(tbl.header)
            for row in tbl.rows[:40]:
                if row:
                    cells_to_scan.append(row[0])
            for cell in cells_to_scan:
                if not cell or len(cell) > 40:
                    continue
                key = _norm(cell)
                if key in known and key not in seen:
                    did = known[key]
                    if not G.has_edge(paper_node, did):
                        G.add_edge(paper_node, did, type='uses_dataset', source='tei_table_mining')
                        stats.uses_dataset += 1
                    seen.add(key)

        # --- Text-based: scan full paper text for dataset mentions ---
        if paper_texts and text_pattern:
            pid = paper_node.replace('paper:', '')
            txt = paper_texts.get(pid, '')
            if txt:
                for m in text_pattern.finditer(txt):
                    matched = m.group(1)
                    key = _norm(matched)
                    if key in known and key not in seen:
                        did = known[key]
                        if not G.has_edge(paper_node, did):
                            G.add_edge(paper_node, did, type='uses_dataset', source='tei_text_mining')
                            stats.uses_dataset += 1
                        seen.add(key)


def available(tei_dir: str) -> bool:
    return os.path.isdir(tei_dir) and bool(glob.glob(os.path.join(tei_dir, '*.tei.xml')))
