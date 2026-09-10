#!/usr/bin/env python3
"""Fill in missing paper PDFs from PUBLIC open-access sources, and (new) import a
domain's own ``pdf_url`` link (a shared Drive folder/file, Dropbox link, or a
direct zip/PDF URL) before that OA fetch runs.

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
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
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
MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB cap for a single pdf_url download

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
def _yaml_csv_path(domain_slug_us):
    """Read ``csv_path:`` from ``domains/<domain>.yaml`` via a minimal stdlib
    regex line-parse (this script must stay import-clean stdlib-only, so no
    PyYAML). Returns the repo-resolved Path, or None when the YAML is absent
    or declares no csv_path."""
    yaml_path = REPO_ROOT / 'domains' / f'{domain_slug_us}.yaml'
    if not yaml_path.exists():
        return None
    with open(yaml_path, encoding='utf-8') as fh:
        for line in fh:
            m = re.match(r'^\s*csv_path:\s*(.+?)\s*$', line)
            if m:
                value = m.group(1).strip('"\'')
                value = re.sub(r'\s+#.*$', '', value).strip()
                return REPO_ROOT / value if value else None
    return None


def _yaml_pdf_url(domain_slug_us):
    """Read ``pdf_url:`` from ``domains/<domain>.yaml`` (same minimal stdlib
    line-parse as ``_yaml_csv_path``). Returns the stripped URL string, or None
    when the YAML is absent or declares no pdf_url.

    Unlike ``_yaml_csv_path``, the trailing comment is stripped BEFORE the
    quotes so a quoted value followed by a ``# comment`` (e.g.
    ``pdf_url: "https://..."  # shared zip``) doesn't leave a stray quote."""
    yaml_path = REPO_ROOT / 'domains' / f'{domain_slug_us}.yaml'
    if not yaml_path.exists():
        return None
    with open(yaml_path, encoding='utf-8') as fh:
        for line in fh:
            m = re.match(r'^\s*pdf_url:\s*(.+?)\s*$', line)
            if m:
                value = re.sub(r'\s+#.*$', '', m.group(1)).strip()
                value = value.strip('"\'')
                return value or None
    return None


def resolve_domain_paths(domain_slug):
    slug_dashed = domain_slug.replace('_', '-')
    slug_us = domain_slug.replace('-', '_')
    dataset_dir = REPO_ROOT / 'datasets' / slug_dashed
    papers_dir = dataset_dir / 'papers'
    csv_path = _yaml_csv_path(slug_us) or next(dataset_dir.glob('*.csv'), None)
    return {'dataset': dataset_dir, 'papers': papers_dir,
            'csv': csv_path, 'chroma': dataset_dir / 'chroma_db',
            'slug_dashed': slug_dashed}


# --------------------------------------------------------------------------- #
# pdf_url import — a domain's own shared PDF source (Drive/Dropbox/direct link) #
# --------------------------------------------------------------------------- #
def classify_pdf_source(url):
    """Classify a ``pdf_url`` value.

    Returns ``('drive_folder', folder_id)`` | ``('direct', download_url)`` |
    ``(None, None)`` for an empty/non-URL value. A Drive FILE share link is
    turned into a direct download URL (skipping the virus-scan interstitial);
    a Dropbox link is forced to ``dl=1``; anything else is passed through.
    """
    if not url or not isinstance(url, str):
        return None, None
    url = url.strip()
    if not re.match(r'^https?://', url, re.IGNORECASE):
        return None, None

    m = re.search(r'drive\.google\.com/drive/folders/([\w-]+)', url)
    if m:
        return 'drive_folder', m.group(1)

    m = (re.search(r'drive\.google\.com/file/d/([\w-]+)', url) or
         re.search(r'drive\.google\.com/(?:open|uc)\?.*?\bid=([\w-]+)', url))
    if m:
        file_id = m.group(1)
        return 'direct', (f'https://drive.usercontent.google.com/download'
                          f'?id={file_id}&export=download&confirm=t')

    if 'dropbox.com' in url.lower():
        if re.search(r'[?&]dl=\d', url):
            url = re.sub(r'([?&]dl=)\d', r'\g<1>1', url)
        else:
            url = f"{url}{'&' if '?' in url else '?'}dl=1"
        return 'direct', url

    return 'direct', url


def parse_drive_folder_listing(html):
    """Parse Drive's ``embeddedfolderview`` HTML into deduped ``(file_id, name)``
    pairs for every ``.pdf`` entry (case-insensitive).

    Scoped per-entry (bounded by the NEXT ``/file/d/...`` occurrence) rather
    than a single windowed regex over the whole page: sheet-poll.yml's
    equivalent ``.csv`` regex (``/file/d/(<id>{20,})/[\\s\\S]{0,600}?
    flip-entry-title[^>]*>([^<]+?\\.csv)``) can otherwise pair one entry's id
    with a LATER entry's title when a non-matching entry (e.g. a .csv) sits
    within the 600-char window in between.
    """
    html = html or ''
    starts = [m.start() for m in re.finditer(r'/file/d/[A-Za-z0-9_-]{20,}/', html)]
    seen = {}
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(html)
        block = html[start:end]
        id_m = re.match(r'/file/d/([A-Za-z0-9_-]{20,})/', block)
        name_m = re.search(r'flip-entry-title[^>]*>([^<]+?\.pdf)', block, re.IGNORECASE)
        if id_m and name_m:
            seen.setdefault(id_m.group(1), name_m.group(1).strip())
    return list(seen.items())


def extract_pdfs_from_zip(zip_path, papers_dir):
    """Flatten every ``.pdf`` in a zip into ``papers_dir``.

    Basename only (zip-slip safe — a ``../../evil.pdf`` member can never
    escape papers_dir), skips ``__MACOSX/`` and ``._*`` junk, normalises the
    extension to lower-case ``.pdf`` (the pipeline globs ``*.pdf`` case-
    sensitively), and never overwrites an existing file. Returns
    ``{'added': [...], 'skipped': [...]}``."""
    papers_dir = Path(papers_dir)
    added, skipped = [], []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            if name.endswith('/'):
                continue  # directory entry
            if '__MACOSX' in name.split('/'):
                continue
            base = Path(name).name  # basename only -> zip-slip safe
            if not base or base.startswith('._'):
                continue
            if not base.lower().endswith('.pdf'):
                continue
            out_name = f'{base[:-4]}.pdf'  # normalise the extension's case
            dest = papers_dir / out_name
            if dest.exists():
                skipped.append(out_name)
                continue
            dest.write_bytes(z.read(info))
            added.append(out_name)
    return {'added': added, 'skipped': skipped}


def _download_to_file(url, dest_path, timeout=DOWNLOAD_TIMEOUT, max_bytes=MAX_DOWNLOAD_BYTES):
    """Stream a URL to disk, aborting once it exceeds max_bytes."""
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest_path, 'wb') as out:
        total = 0
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError(f'download exceeded the {max_bytes}-byte cap')
            out.write(chunk)


def _print_import_summary(url, dry_run, result):
    verb = 'would-import' if dry_run else 'imported'
    print(f"=== import_pdf_source: {url} ===")
    print(f"  kind    : {result['kind']}")
    print(f"  mode    : {'DRY-RUN (no downloads)' if dry_run else 'download'}")
    print(f"  {verb:>12}: {len(result['added'])}")
    for name in result['added']:
        print(f"      + {name}")
    if result['skipped']:
        print(f"  skipped     : {len(result['skipped'])}")
        for name in result['skipped']:
            print(f"      - {name}")
    if result['error']:
        print(f"  ERROR   : {result['error']}")
    print()


def import_pdf_source(url, papers_dir, dry_run=False):
    """Import PDFs from a domain's ``pdf_url`` into ``papers_dir``.

    NEVER raises: a bad/unreachable/non-public link is reported in the
    returned dict so it never aborts the whole fetch run. Returns
    ``{'kind', 'added', 'skipped', 'error'}``."""
    papers_dir = Path(papers_dir)
    kind, ref = classify_pdf_source(url)
    result = {'kind': kind, 'added': [], 'skipped': [], 'error': None}

    if kind is None:
        result['error'] = f'Could not understand pdf_url: {url!r}'
        _print_import_summary(url, dry_run, result)
        return result

    try:
        if kind == 'drive_folder':
            html = _http_get(f'https://drive.google.com/embeddedfolderview?id={ref}').decode('utf-8', 'replace')
            existing = {p.name for p in papers_dir.glob('*.pdf')} if papers_dir.is_dir() else set()
            for file_id, name in parse_drive_folder_listing(html):
                stem = name.rsplit('.', 1)[0] if '.' in name else name
                out_name = f'{stem}.pdf'
                if out_name in existing:
                    result['skipped'].append(out_name)
                    continue
                if dry_run:
                    result['added'].append(out_name)
                    continue
                dl_url = (f'https://drive.usercontent.google.com/download'
                          f'?id={file_id}&export=download&confirm=t')
                try:
                    data = _http_get(dl_url, timeout=DOWNLOAD_TIMEOUT, accept='application/pdf')
                except (urllib.error.URLError, OSError):
                    continue
                if not _looks_like_pdf(data):
                    continue
                papers_dir.mkdir(parents=True, exist_ok=True)
                (papers_dir / out_name).write_bytes(data)
                existing.add(out_name)
                result['added'].append(out_name)
        elif not dry_run:
            # direct: a zip or a single PDF — we don't know which without
            # downloading it, so dry-run has nothing honest to preview.
            with tempfile.TemporaryDirectory() as td:
                tmp_path = Path(td) / 'download.bin'
                _download_to_file(ref, tmp_path)
                with open(tmp_path, 'rb') as fh:
                    head = fh.read(4)
                if head.startswith(b'PK\x03\x04'):
                    papers_dir.mkdir(parents=True, exist_ok=True)
                    zres = extract_pdfs_from_zip(tmp_path, papers_dir)
                    result['added'] = zres['added']
                    result['skipped'] = zres['skipped']
                elif head.startswith(b'%PDF'):
                    name = Path(urllib.parse.urlparse(ref).path).name or 'linked.pdf'
                    name = f'{name[:-4]}.pdf' if name.lower().endswith('.pdf') else 'linked.pdf'
                    papers_dir.mkdir(parents=True, exist_ok=True)
                    dest = papers_dir / name
                    if dest.exists():
                        result['skipped'].append(name)
                    else:
                        dest.write_bytes(tmp_path.read_bytes())
                        result['added'].append(name)
                else:
                    result['error'] = ("PDF link did not return a zip or PDF — make sure it is "
                                        "shared publicly ('Anyone with the link')")
    except (urllib.error.URLError, OSError, ValueError) as e:
        result['error'] = f'Could not fetch {url}: {e}'

    _print_import_summary(url, dry_run, result)
    return result


# --------------------------------------------------------------------------- #
# PDF-source provenance manifest (feeds the Docling audit manifest downstream)  #
# --------------------------------------------------------------------------- #
def _arxiv_id_from_url(url):
    """Extract a bare arXiv id (e.g. 2507.18847) from a pdf/abs URL, else None."""
    m = re.search(r'arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})',
                  url or '', re.IGNORECASE)
    return m.group(1) if m else None


def _source_ref(candidate, saved_url):
    """Semantic provenance label recorded as ``source`` in pdf-sources.json: an
    ``arxiv:<id>`` ref when derivable (arXiv or scrape+arXiv resolvers), else the
    OA host name (``openalex`` / ``semantic_scholar``), else ``project_page``."""
    src = (candidate or {}).get('source', '') or ''
    aid = _arxiv_id_from_url(saved_url)
    if aid:
        return f'arxiv:{aid}'
    if src == 'openalex':
        return 'openalex'
    if src == 'semanticscholar':
        return 'semantic_scholar'
    if src.startswith('scrape'):
        return 'project_page'
    return src or 'unknown'


def _write_pdf_sources(chroma_dir, entries):
    """MERGE per-paper PDF provenance into ``<chroma_dir>/pdf-sources.json``,
    preserving entries for papers we did NOT fetch this run (freshly-fetched
    papers win). Returns the written path, or None on nothing-to-do / write error
    (never raises, so the caller's exit-0 contract is untouched)."""
    if not entries:
        return None
    path = Path(chroma_dir) / 'pdf-sources.json'
    existing = {}
    try:
        loaded = json.loads(path.read_text())
        if isinstance(loaded, dict):
            existing = loaded
    except (FileNotFoundError, ValueError, OSError):
        existing = {}
    existing.update(entries)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(existing, indent=2, sort_keys=True))
    except OSError as e:
        print(f"  WARNING: could not write {path} ({e})")
        return None
    return path


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

    # A brand-new domain has no papers dir yet (and no papers.zip) — create it
    # instead of aborting, so a pdf_url import (below) has somewhere to write.
    papers_dir.mkdir(parents=True, exist_ok=True)

    # Import the domain's own shared PDF source (Drive folder/file, Dropbox,
    # or a direct zip/PDF link), BEFORE scanning for what's already present,
    # so freshly-imported PDFs are counted and the OA fetch below skips them.
    pdf_url = _yaml_pdf_url(domain.replace('-', '_'))
    if pdf_url:
        print(f"  pdf_url : {pdf_url}")
        import_result = import_pdf_source(pdf_url, papers_dir, dry_run=dry_run)
        if import_result.get('error'):
            print(f"  WARNING: pdf_url import failed: {import_result['error']}")
        print()

    rows = read_rows(csv_path)
    existing = {p.name for p in papers_dir.glob('*.pdf')}

    downloaded, present, unresolved = [], [], []
    # Per-paper provenance for the PDFs we actually fetch this run (paper_id ==
    # PDF slug == the downstream Docling paper_id). Papers already present are
    # deliberately left out — they surface as 'committed' in the audit manifest.
    provenance = {}

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
            provenance[slug] = {
                'source': _source_ref(candidate, saved_url),
                'url': saved_url,
                'resolved_via': candidate['source'],
                'similarity': round(float(candidate['score']), 4),
            }
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

    # Record provenance for the PDFs we actually fetched (real downloads only —
    # dry-run stays side-effect-free). Merges into any existing pdf-sources.json.
    if not dry_run and provenance:
        written = _write_pdf_sources(paths['chroma'], provenance)
        if written:
            noun = 'entry' if len(provenance) == 1 else 'entries'
            print(f"  provenance     : wrote {len(provenance)} {noun} -> {written}")
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
