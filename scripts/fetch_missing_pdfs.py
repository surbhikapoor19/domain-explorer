#!/usr/bin/env python3
"""Fill in missing paper PDFs from PUBLIC open-access sources.

For a domain, this finds every methods-CSV row whose expected PDF is missing,
parses the paper title (and first author) from the row's ``Citation`` column,
resolves an open-access PDF URL from public APIs, VERIFIES the match (title
similarity + first-author surname) so a wrong paper is never downloaded, and
saves the PDF into the domain's papers dir using the EXACT same slug the rest
of the pipeline expects.

Usage:
    python scripts/fetch_missing_pdfs.py --domain grasp_planning
    python scripts/fetch_missing_pdfs.py --domain grasp-planning --dry-run

Resolution order (first verified hit wins):
    1. arXiv title-search  (export.arxiv.org/api/query?search_query=ti:"<title>")
    2. OpenAlex            (api.openalex.org/works?search=<title>)
    3. Semantic Scholar    (api.semanticscholar.org/graph/v1/paper/search)
    4. Scrape the row's Link(s) project pages for an arxiv.org/abs|pdf link

Only Python stdlib is used (urllib for HTTP). Closed-access papers with no OA
PDF are expected to stay unresolved; the script still exits 0.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from csv import DictReader
from difflib import SequenceMatcher
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Politeness: identify ourselves with a contact mailto per each API's etiquette.
MAILTO = 'skapoor@quaxar.com'
USER_AGENT = f'wpivis-fetch-missing-pdfs/1.0 (mailto:{MAILTO})'
HTTP_TIMEOUT = 30          # seconds per request
DOWNLOAD_TIMEOUT = 90      # seconds for a PDF body
REQUEST_DELAY = 1.0        # polite pause between network requests
TITLE_SIM_THRESHOLD = 0.85 # normalized token-set ratio required to accept

ARXIV_API = 'http://export.arxiv.org/api/query'
ATOM_NS = {'a': 'http://www.w3.org/2005/Atom'}


# --------------------------------------------------------------------------- #
# Pure helpers (unit-tested; no network)                                       #
# --------------------------------------------------------------------------- #
def slugify(name: str) -> str:
    """Method name -> PDF slug.

    Verbatim mirror of ``_slugify`` in backend/rag/method_paper_map.py so the
    files we write are named EXACTLY the way build_method_paper_map matches
    them (strip the robot emoji, lowercase, collapse non-alphanumerics to '-').
    """
    name = name.replace('🤖 ', '').strip()
    slug = name.lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug


# Straight and curly (smart) double-quote characters used to delimit titles.
_DQUOTES = '"“”„‟″'
_SQUOTES = "'‘’‚‛′"


def parse_title(citation: str):
    """Extract the paper title from a citation string (the quoted span).

    Handles straight quotes ("...") and curly/smart quotes ("...") and strips
    the trailing citation punctuation that sits inside the closing quote
    (e.g. ``"Title,"`` or ``"Title."``). Returns None when no quoted span.
    """
    if not citation:
        return None
    text = str(citation)
    # First quoted span bounded by any double-quote variant.
    m = re.search(r'[%s]([^%s]+?)[%s]' % (_DQUOTES, _DQUOTES, _DQUOTES), text)
    if not m:
        # Fall back to single/curly-single quotes for the rare style.
        m = re.search(r'[%s]([^%s]+?)[%s]' % (_SQUOTES, _SQUOTES, _SQUOTES), text)
    if not m:
        return None
    title = _clean_title(m.group(1))
    return title or None


def _clean_title(title: str) -> str:
    title = title.strip()
    # Drop trailing citation punctuation kept inside the quotes.
    title = title.rstrip(' \t.,;:')
    return title.strip()


def first_author_surname(citation: str):
    """Best-effort first-author surname from a citation string.

    Works for both surname-first styles ("Shao, Lin, ..." -> "Shao") and
    initials-first styles ("P. Ni, W. Zhang, ..." -> "Ni"). Returns None when
    nothing usable is found.
    """
    if not citation:
        return None
    head = str(citation).split(',', 1)[0].strip()
    if not head:
        return None
    tokens = [t for t in re.split(r'\s+', head) if t]
    if not tokens:
        return None
    # Drop initials such as "P.", "P", or hyphenated "J.-B." — the surname is
    # the remaining (non-initial) token.
    non_initials = [t for t in tokens
                    if not re.fullmatch(r'[A-Za-z]\.?(?:-[A-Za-z]\.?)*', t)]
    chosen = non_initials[-1] if non_initials else tokens[-1]
    return chosen.strip(" .,;:'’").strip() or None


def _norm_tokens(s: str):
    s = (s or '').lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return [t for t in s.split() if t]


def _ratio(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def token_set_ratio(a: str, b: str) -> float:
    """fuzzywuzzy-style token-set ratio in [0, 1] using stdlib difflib.

    Order- and duplicate-insensitive: compares the shared tokens against each
    string's shared+remainder recombination, robust to reordered/extra words
    (e.g. subtitle differences, casing, punctuation).
    """
    t1, t2 = set(_norm_tokens(a)), set(_norm_tokens(b))
    if not t1 or not t2:
        return 0.0
    inter = sorted(t1 & t2)
    diff1 = sorted(t1 - t2)
    diff2 = sorted(t2 - t1)
    sorted_inter = ' '.join(inter)
    combined1 = (sorted_inter + ' ' + ' '.join(diff1)).strip()
    combined2 = (sorted_inter + ' ' + ' '.join(diff2)).strip()
    return max(
        _ratio(sorted_inter, combined1),
        _ratio(sorted_inter, combined2),
        _ratio(combined1, combined2),
    )


def author_match(surname, authors) -> bool:
    """True if the first-author surname appears as a whole token among the
    candidate authors. Vacuously True when we have no surname or no authors."""
    if not surname or not authors:
        return True
    target = surname.lower()
    tokens = set()
    for a in authors:
        tokens.update(_norm_tokens(a))
    return target in tokens


def verify_match(cand_title, cand_authors, query_title, query_surname):
    """Return (accepted, score). Requires title similarity >= threshold AND,
    when candidate authors are known, the first-author surname to appear."""
    if not query_title or not cand_title:
        return False, 0.0
    score = token_set_ratio(query_title, cand_title)
    if score < TITLE_SIM_THRESHOLD:
        return False, score
    if cand_authors and not author_match(query_surname, cand_authors):
        return False, score
    return True, score


# --------------------------------------------------------------------------- #
# Network helpers                                                              #
# --------------------------------------------------------------------------- #
def _http_get(url, timeout=HTTP_TIMEOUT, accept=None):
    headers = {'User-Agent': USER_AGENT}
    if accept:
        headers['Accept'] = accept
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _sleep():
    time.sleep(REQUEST_DELAY)


def _split_links(links: str):
    return re.findall(r'https?://\S+', links or '')


def _parse_arxiv_atom(data: bytes):
    """Parse an arXiv Atom feed into candidate dicts."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    out = []
    for ent in root.findall('a:entry', ATOM_NS):
        t = ent.find('a:title', ATOM_NS)
        title = ' '.join((t.text or '').split()) if t is not None else ''
        authors = []
        for a in ent.findall('a:author', ATOM_NS):
            n = a.find('a:name', ATOM_NS)
            if n is not None and n.text:
                authors.append(n.text.strip())
        pdf_url = None
        for l in ent.findall('a:link', ATOM_NS):
            if l.get('title') == 'pdf' and l.get('href'):
                pdf_url = l.get('href')
                break
        if not pdf_url:
            idel = ent.find('a:id', ATOM_NS)
            if idel is not None and idel.text and '/abs/' in idel.text:
                pdf_url = idel.text.replace('/abs/', '/pdf/')
        if title and pdf_url:
            out.append({'title': title, 'authors': authors, 'pdf_url': pdf_url})
    return out


def _arxiv_lookup_by_id(arxiv_id, ua_query_delay=True):
    url = f'{ARXIV_API}?id_list={urllib.parse.quote(arxiv_id)}&max_results=1'
    try:
        data = _http_get(url)
    except (urllib.error.URLError, OSError):
        return None
    if ua_query_delay:
        _sleep()
    entries = _parse_arxiv_atom(data)
    return entries[0] if entries else None


# --------------------------------------------------------------------------- #
# Resolvers — each returns a candidate dict or None                           #
#   {source, matched_title, score, authors, urls: [pdf_url, ...]}             #
# --------------------------------------------------------------------------- #
def resolve_arxiv(title, surname, links):
    if not title:
        return None
    q = urllib.parse.quote(f'ti:"{title}"')
    url = f'{ARXIV_API}?search_query={q}&start=0&max_results=5'
    try:
        data = _http_get(url)
    except (urllib.error.URLError, OSError):
        return None
    _sleep()
    for c in _parse_arxiv_atom(data):
        ok, score = verify_match(c['title'], c['authors'], title, surname)
        if ok:
            return {'source': 'arxiv', 'matched_title': c['title'],
                    'score': score, 'authors': c['authors'],
                    'urls': [c['pdf_url']]}
    return None


def resolve_openalex(title, surname, links):
    if not title:
        return None
    q = urllib.parse.quote(title)
    url = (f'https://api.openalex.org/works?search={q}'
           f'&per_page=5&mailto={urllib.parse.quote(MAILTO)}')
    try:
        data = _http_get(url, accept='application/json')
    except (urllib.error.URLError, OSError):
        return None
    _sleep()
    try:
        j = json.loads(data)
    except (ValueError, TypeError):
        return None
    for w in j.get('results', []) or []:
        ct = w.get('title') or w.get('display_name') or ''
        authors = [((a.get('author') or {}).get('display_name') or '')
                   for a in (w.get('authorships') or [])]
        ok, score = verify_match(ct, authors, title, surname)
        if not ok:
            continue
        oa_url = (w.get('open_access') or {}).get('oa_url')
        pdf_url = (w.get('primary_location') or {}).get('pdf_url')
        # Prefer a direct pdf_url, fall back to the OA landing/host URL.
        urls = [u for u in (pdf_url, oa_url) if u]
        if urls:
            return {'source': 'openalex', 'matched_title': ct,
                    'score': score, 'authors': authors, 'urls': urls}
    return None


def resolve_semanticscholar(title, surname, links):
    if not title:
        return None
    q = urllib.parse.quote(title)
    url = (f'https://api.semanticscholar.org/graph/v1/paper/search?query={q}'
           f'&limit=5&fields=title,openAccessPdf,authors')
    try:
        data = _http_get(url, accept='application/json')
    except (urllib.error.URLError, OSError):
        return None
    _sleep()
    try:
        j = json.loads(data)
    except (ValueError, TypeError):
        return None
    for p in j.get('data', []) or []:
        ct = p.get('title') or ''
        authors = [(a.get('name') or '') for a in (p.get('authors') or [])]
        ok, score = verify_match(ct, authors, title, surname)
        if not ok:
            continue
        oap = p.get('openAccessPdf') or {}
        pdf_url = oap.get('url')
        if pdf_url:
            return {'source': 'semanticscholar', 'matched_title': ct,
                    'score': score, 'authors': authors, 'urls': [pdf_url]}
    return None


def resolve_scrape_links(title, surname, links):
    """Scrape the row's project pages for an arxiv.org/abs|pdf id, then verify
    it through the arXiv API before trusting it."""
    if not title:
        return None
    for page in _split_links(links):
        try:
            html = _http_get(page).decode('utf-8', 'replace')
        except (urllib.error.URLError, OSError, ValueError):
            continue
        _sleep()
        ids = []
        for m in re.finditer(r'arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})',
                             html, re.IGNORECASE):
            if m.group(1) not in ids:
                ids.append(m.group(1))
        for aid in ids:
            meta = _arxiv_lookup_by_id(aid)
            if not meta:
                continue
            ok, score = verify_match(meta['title'], meta['authors'], title, surname)
            if ok:
                return {'source': 'scrape+arxiv', 'matched_title': meta['title'],
                        'score': score, 'authors': meta['authors'],
                        'urls': [f'https://arxiv.org/pdf/{aid}.pdf']}
    return None


RESOLVERS = (resolve_arxiv, resolve_openalex, resolve_semanticscholar,
             resolve_scrape_links)


def _looks_like_pdf(data: bytes) -> bool:
    return bool(data) and b'%PDF-' in data[:1024]


def _download_pdf(url, dest: Path) -> bool:
    try:
        data = _http_get(url, timeout=DOWNLOAD_TIMEOUT, accept='application/pdf')
    except (urllib.error.URLError, OSError):
        return False
    if not _looks_like_pdf(data):
        return False
    dest.write_bytes(data)
    return True


# --------------------------------------------------------------------------- #
# Domain resolution + CSV reading                                             #
# --------------------------------------------------------------------------- #
def resolve_domain_paths(domain_slug):
    slug_dashed = domain_slug.replace('_', '-')
    dataset_dir = REPO_ROOT / 'datasets' / slug_dashed
    papers_dir = dataset_dir / 'papers'
    csv_path = next(dataset_dir.glob('*.csv'), None)
    return {'dataset': dataset_dir, 'papers': papers_dir,
            'csv': csv_path, 'slug_dashed': slug_dashed}


def _col(row_keys):
    """Map stripped-lowercased header -> actual DictReader key."""
    return {(k or '').strip().lower(): k for k in row_keys}


def read_rows(csv_path):
    with open(csv_path, encoding='utf-8') as f:
        reader = DictReader(f)
        rows = list(reader)
        keymap = _col(reader.fieldnames or [])
    out = []
    for r in rows:
        name = str(r.get(keymap.get('name', 'Name'), '') or '').strip()
        if not name:
            continue
        citation = r.get(keymap.get('citation', 'Citation'), '') or ''
        links = r.get(keymap.get('link(s)', 'Link(s)'), '') or ''
        out.append({'name': name, 'citation': citation, 'links': links})
    return out


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
def process(domain, dry_run=False):
    paths = resolve_domain_paths(domain)
    dataset_dir = paths['dataset']
    papers_dir = paths['papers']
    csv_path = paths['csv']

    print(f"=== fetch_missing_pdfs: {domain} ===")
    print(f"  dataset : {dataset_dir}")
    print(f"  papers  : {papers_dir}")
    print(f"  csv     : {csv_path}")
    print(f"  mode    : {'DRY-RUN (no downloads)' if dry_run else 'download'}")
    print()

    if not dataset_dir.is_dir():
        print(f"ERROR: dataset dir not found: {dataset_dir}")
        return 2
    if csv_path is None:
        print(f"ERROR: no methods CSV (*.csv) in {dataset_dir}")
        return 2
    if not papers_dir.is_dir():
        print(f"ERROR: papers dir not found: {papers_dir}")
        return 2

    rows = read_rows(csv_path)
    existing = {p.name for p in papers_dir.glob('*.pdf')}

    downloaded, present, unresolved = [], [], []

    for row in rows:
        name = row['name']
        slug = slugify(name)
        fname = f'{slug}.pdf'
        if fname in existing:
            present.append(name)
            continue

        # Missing PDF: resolve from OA sources.
        title = parse_title(row['citation'])
        surname = first_author_surname(row['citation'])
        print(f"[missing] {slug}")
        print(f"    name    : {name}")
        print(f"    title   : {title!r}")
        print(f"    author1 : {surname!r}")

        candidate = None
        for resolver in RESOLVERS:
            try:
                candidate = resolver(title, surname, row['links'])
            except Exception as e:  # never let one flaky source abort the run
                print(f"    ! {resolver.__name__} error: {e}")
                candidate = None
            if candidate:
                break

        if not candidate:
            print("    -> UNRESOLVED (no verified OA PDF)")
            print()
            unresolved.append(name)
            continue

        print(f"    match   : {candidate['source']} "
              f"(score={candidate['score']:.3f}) "
              f"\"{candidate['matched_title']}\"")

        if dry_run:
            print(f"    -> would download: {candidate['urls'][0]}")
            print()
            downloaded.append((name, candidate['source'], candidate['urls'][0]))
            continue

        dest = papers_dir / fname
        saved_url = None
        for url in candidate['urls']:
            if _download_pdf(url, dest):
                saved_url = url
                break
            _sleep()
        if saved_url:
            print(f"    -> saved {dest.name} <- {saved_url}")
            print()
            existing.add(fname)
            downloaded.append((name, candidate['source'], saved_url))
        else:
            print("    -> UNRESOLVED (candidate URL(s) were not a downloadable PDF)")
            print()
            unresolved.append(name)

    # -------- Final tally --------
    verb = 'would-download' if dry_run else 'downloaded'
    print("=== Summary ===")
    print(f"  {verb:>14}: {len(downloaded)}")
    for name, source, url in downloaded:
        print(f"      + {name}  ({source})")
    print(f"  already-present: {len(present)}")
    print(f"  unresolved     : {len(unresolved)}")
    for name in unresolved:
        print(f"      - {name}")
    print()
    print(f"  total CSV rows : {len(rows)}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Fetch missing paper PDFs from public open-access sources.')
    parser.add_argument('--domain', required=True,
                        help='Domain slug, e.g. grasp_planning or grasp-planning')
    parser.add_argument('--dry-run', action='store_true',
                        help='Resolve + report without downloading anything')
    args = parser.parse_args(argv)
    return process(args.domain, dry_run=args.dry_run)


if __name__ == '__main__':
    sys.exit(main())
