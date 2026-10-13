"""Per-row paper links in the methods CSV — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify.  Run:  python -m unittest scripts/test_csv_paper_links.py

Third PDF source, alongside the two that already exist (a shared Drive folder or a
single ``pdf_url`` zip/PDF): a column in the methods CSV holding a per-row link to
the paper — e.g. an ``archive`` column of arXiv/DOI/publisher URLs. The maintainer
asserting "this row's paper is here" is stronger evidence than a title-similarity
match against an OA index, so a row link is tried FIRST and, unlike the OA
resolvers, is trusted without title verification.

Four units, each testable on its own:
  * ``paper_url_column(fieldnames, declared=None, rows=None)`` -> the CSV key to use
  * ``pdf_candidates_from_url(url)`` -> ordered direct-PDF candidates (pure, no network)
  * ``scrape_pdf_links(html, base_url)`` -> PDF URLs found in a landing page (pure)
  * ``fetch_pdf_from_link(url, dest)`` -> bool (network: candidates, then scrape)

No external network: a local stdlib HTTP server serves every fixture, the OA
resolvers are disabled, and the polite inter-request delay is zeroed.
"""
import http.server
import re
import json
import os
import socketserver
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_missing_pdfs as f  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
PDF_BYTES = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class _Server:
    """Serve a temp directory on 127.0.0.1:<random port> for one test."""

    def __init__(self, root):
        handler = lambda *a, **k: _Quiet(*a, directory=str(root), **k)  # noqa: E731
        self.httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
        self.port = self.httpd.server_address[1]
        self.t = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()

    def url(self, name):
        return f'http://127.0.0.1:{self.port}/{name}'


class _Offline:
    """Disable the OA resolvers and the polite delay for the duration of a test."""

    def setUp(self):
        self._resolvers, self._delay = f.RESOLVERS, f.REQUEST_DELAY
        f.RESOLVERS = ()
        f.REQUEST_DELAY = 0
        self._root = f.REPO_ROOT

    def tearDown(self):
        f.RESOLVERS, f.REQUEST_DELAY = self._resolvers, self._delay
        f.REPO_ROOT = self._root


# --------------------------------------------------------------------------- #
# 1. Which column holds the link                                              #
# --------------------------------------------------------------------------- #
class PaperUrlColumnDetection(unittest.TestCase):
    def test_declared_role_wins(self):
        # An explicit identity.paper_url mapping beats every header heuristic.
        col = f.paper_url_column(
            ['Name', 'archive', 'Paper Link'],
            declared='Paper Link')
        self.assertEqual(col, 'Paper Link')

    def test_declared_role_ignored_when_column_absent(self):
        # A YAML that names a column the CSV no longer has must not win.
        col = f.paper_url_column(['Name', 'archive'], declared='Paper Link')
        self.assertEqual(col, 'archive')

    def test_autodetects_archive_header(self):
        self.assertEqual(f.paper_url_column(['Name', 'archive', 'Year']), 'archive')

    def test_header_match_is_case_and_space_insensitive(self):
        for header in ('Archive', ' ARCHIVE ', 'PDF URL', 'pdf_url', 'Paper URL'):
            with self.subTest(header=header):
                self.assertEqual(f.paper_url_column(['Name', header]), header)

    def test_archive_outranks_arxiv_and_doi(self):
        # 'archive' is the maintainer's deliberate per-row PDF column; arXiv/DOI
        # columns are citation identifiers that may or may not resolve.
        col = f.paper_url_column(['Name', 'arXiv', 'DOI', 'archive'])
        self.assertEqual(col, 'archive')

    def test_falls_back_to_arxiv_column(self):
        self.assertEqual(f.paper_url_column(['Name', 'arXiv', 'Citation']), 'arXiv')

    def test_none_when_no_candidate(self):
        self.assertIsNone(f.paper_url_column(['Name', 'Description', 'Year']))

    def test_all_empty_column_does_not_shadow_a_populated_one(self):
        # A maintainer who adds an 'archive' column but has not filled it in yet
        # must not lose the arXiv links that do work.
        rows = [{'archive': '', 'arXiv': 'https://arxiv.org/abs/2403.05466'},
                {'archive': '   ', 'arXiv': 'https://arxiv.org/abs/2310.17274'}]
        col = f.paper_url_column(['Name', 'archive', 'arXiv'], rows=rows)
        self.assertEqual(col, 'arXiv')

    def test_declared_but_entirely_empty_column_does_not_shadow_a_populated_one(self):
        # The wizard now maps an `archive` column automatically, so a domain can carry
        # the identity.paper_url mapping while the column is still blank. The declared
        # column must lose to a populated candidate in that case, for the same reason
        # the heuristic path skips empty columns.
        rows = [{'archive': '', 'arXiv': 'https://arxiv.org/abs/2403.05466'},
                {'archive': '', 'arXiv': 'https://arxiv.org/abs/2310.17274'}]
        col = f.paper_url_column(['Name', 'archive', 'arXiv'],
                                 declared='archive', rows=rows)
        self.assertEqual(col, 'arXiv')

    def test_declared_column_wins_when_populated(self):
        rows = [{'archive': 'https://example.org/a.pdf',
                 'arXiv': 'https://arxiv.org/abs/2403.05466'}]
        self.assertEqual(
            f.paper_url_column(['Name', 'archive', 'arXiv'], declared='archive', rows=rows),
            'archive')

    def test_partially_filled_column_still_wins(self):
        rows = [{'archive': 'https://example.org/a.pdf', 'arXiv': ''},
                {'archive': '', 'arXiv': 'https://arxiv.org/abs/2403.05466'}]
        self.assertEqual(f.paper_url_column(['Name', 'archive', 'arXiv'], rows=rows),
                         'archive')


# --------------------------------------------------------------------------- #
# 2. URL -> candidate direct PDF URLs (pure)                                  #
# --------------------------------------------------------------------------- #
class PdfCandidatesFromUrl(unittest.TestCase):
    def test_direct_pdf_passthrough(self):
        u = 'https://example.org/papers/anygrasp.pdf'
        self.assertIn(u, f.pdf_candidates_from_url(u))

    def test_direct_pdf_with_query_string(self):
        u = 'https://example.org/get?file=x.pdf'
        self.assertTrue(f.pdf_candidates_from_url(u))

    def test_arxiv_abs_becomes_pdf(self):
        got = f.pdf_candidates_from_url('https://arxiv.org/abs/2403.05466')
        self.assertTrue(any('arxiv.org/pdf/2403.05466' in c for c in got), got)

    def test_arxiv_pdf_is_normalized(self):
        got = f.pdf_candidates_from_url('https://arxiv.org/pdf/2310.17274')
        self.assertTrue(any('arxiv.org/pdf/2310.17274' in c for c in got), got)

    def test_arxiv_versioned_id(self):
        got = f.pdf_candidates_from_url('https://arxiv.org/abs/2403.05466v2')
        self.assertTrue(any('2403.05466' in c for c in got), got)

    def test_drive_file_link_becomes_direct_download(self):
        got = f.pdf_candidates_from_url(
            'https://drive.google.com/file/d/1XyZ_abcdefghijklmnopq/view?usp=sharing')
        self.assertTrue(any('drive.usercontent.google.com/download' in c for c in got), got)
        self.assertTrue(any('id=1XyZ_abcdefghijklmnopq' in c for c in got), got)

    def test_dropbox_link_forces_download(self):
        got = f.pdf_candidates_from_url('https://www.dropbox.com/scl/fi/a/p.pdf?rlkey=k&dl=0')
        self.assertTrue(any('dl=1' in c for c in got), got)

    def test_doi_link_is_kept_for_scraping(self):
        u = 'https://doi.org/10.1109/LRA.2020.1234567'
        self.assertIn(u, f.pdf_candidates_from_url(u))

    def test_landing_page_is_kept_for_scraping(self):
        u = 'https://example.org/project/anygrasp'
        self.assertIn(u, f.pdf_candidates_from_url(u))

    def test_empty_and_non_url_yield_nothing(self):
        for bad in ('', None, '   ', 'not a url', 'see the paper', 'TBD'):
            with self.subTest(value=bad):
                self.assertEqual(f.pdf_candidates_from_url(bad), [])


# --------------------------------------------------------------------------- #
# 3. Landing page -> PDF links (pure)                                         #
# --------------------------------------------------------------------------- #
class ScrapePdfLinks(unittest.TestCase):
    BASE = 'https://example.org/project/x/'

    def test_citation_pdf_url_meta_is_preferred(self):
        html = ('<html><head>'
                '<meta name="citation_pdf_url" content="https://example.org/real.pdf">'
                '</head><body><a href="other.pdf">other</a></body></html>')
        got = f.scrape_pdf_links(html, self.BASE)
        self.assertEqual(got[0], 'https://example.org/real.pdf', got)

    def test_relative_anchor_is_resolved_against_base(self):
        got = f.scrape_pdf_links('<a href="paper.pdf">pdf</a>', self.BASE)
        self.assertIn('https://example.org/project/x/paper.pdf', got)

    def test_root_relative_anchor(self):
        got = f.scrape_pdf_links('<a href="/files/paper.pdf">pdf</a>', self.BASE)
        self.assertIn('https://example.org/files/paper.pdf', got)

    def test_absolute_anchor(self):
        got = f.scrape_pdf_links('<a href="https://cdn.example.net/p.pdf">x</a>', self.BASE)
        self.assertIn('https://cdn.example.net/p.pdf', got)

    def test_arxiv_link_on_the_page_is_found(self):
        got = f.scrape_pdf_links('<a href="https://arxiv.org/abs/2403.05466">paper</a>',
                                 self.BASE)
        self.assertTrue(any('2403.05466' in c for c in got), got)

    def test_no_pdf_link_yields_nothing(self):
        self.assertEqual(f.scrape_pdf_links('<html><body>no papers here</body></html>',
                                            self.BASE), [])

    def test_garbage_input_does_not_raise(self):
        for bad in ('', None, '\x00\x01binary', '<a href=>'):
            with self.subTest(value=bad):
                self.assertIsInstance(f.scrape_pdf_links(bad, self.BASE), list)


# --------------------------------------------------------------------------- #
# 4. fetch_pdf_from_link (network, against the local server)                  #
# --------------------------------------------------------------------------- #
class FetchPdfFromLink(_Offline, unittest.TestCase):
    def test_direct_pdf_is_saved(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'srv'
            root.mkdir()
            (root / 'paper.pdf').write_bytes(PDF_BYTES)
            dest = Path(d) / 'out.pdf'
            with _Server(root) as s, redirect_stdout(StringIO()):
                ok = f.fetch_pdf_from_link(s.url('paper.pdf'), dest)
            self.assertTrue(ok)
            self.assertEqual(dest.read_bytes(), PDF_BYTES)

    def test_landing_page_is_scraped_then_downloaded(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'srv'
            root.mkdir()
            (root / 'paper.pdf').write_bytes(PDF_BYTES)
            (root / 'index.html').write_text(
                '<html><body><h1>Project</h1>'
                '<a href="paper.pdf">Download the paper</a></body></html>')
            dest = Path(d) / 'out.pdf'
            with _Server(root) as s, redirect_stdout(StringIO()):
                ok = f.fetch_pdf_from_link(s.url('index.html'), dest)
            self.assertTrue(ok, 'a landing page linking a PDF must resolve')
            self.assertEqual(dest.read_bytes(), PDF_BYTES)

    def test_html_that_is_not_a_pdf_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'srv'
            root.mkdir()
            # Served with a .pdf name but HTML bytes — the %PDF- sniff must catch it.
            (root / 'fake.pdf').write_text('<html><body>not a pdf</body></html>')
            dest = Path(d) / 'out.pdf'
            with _Server(root) as s, redirect_stdout(StringIO()):
                ok = f.fetch_pdf_from_link(s.url('fake.pdf'), dest)
            self.assertFalse(ok)
            self.assertFalse(dest.exists(), 'must not leave a non-PDF on disk')

    def test_missing_url_is_handled(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'srv'
            root.mkdir()
            dest = Path(d) / 'out.pdf'
            with _Server(root) as s, redirect_stdout(StringIO()):
                ok = f.fetch_pdf_from_link(s.url('nope.pdf'), dest)
            self.assertFalse(ok)
            self.assertFalse(dest.exists())

    def test_unreachable_host_does_not_raise(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / 'out.pdf'
            with redirect_stdout(StringIO()):
                ok = f.fetch_pdf_from_link('http://127.0.0.1:1/x.pdf', dest)
            self.assertFalse(ok)


# --------------------------------------------------------------------------- #
# 5. End-to-end through process()                                             #
# --------------------------------------------------------------------------- #
def _write_domain(root: Path, domain: str, csv_text: str, extra_yaml: str = ''):
    """Build a minimal repo layout under `root` and point f.REPO_ROOT at it."""
    slug_dashed = domain.replace('_', '-')
    (root / 'domains').mkdir(parents=True, exist_ok=True)
    ds = root / 'datasets' / slug_dashed
    ds.mkdir(parents=True, exist_ok=True)
    (ds / f'{domain}.csv').write_text(csv_text, encoding='utf-8')
    (root / 'domains' / f'{domain}.yaml').write_text(
        f'domain: {domain}\n'
        f'csv_path: datasets/{slug_dashed}/{domain}.csv\n'
        f'papers_dir: datasets/{slug_dashed}/papers/\n'
        f'{extra_yaml}',
        encoding='utf-8')
    return ds


class EndToEndCsvArchiveColumn(_Offline, unittest.TestCase):
    def test_archive_column_pdfs_are_downloaded_with_provenance(self):
        with tempfile.TemporaryDirectory() as d:
            srv = Path(d) / 'srv'
            srv.mkdir()
            (srv / 'alpha.pdf').write_bytes(PDF_BYTES)
            (srv / 'beta.pdf').write_bytes(PDF_BYTES)
            root = Path(d) / 'repo'
            with _Server(srv) as s:
                ds = _write_domain(root, 'demo_links',
                                   'Name,Year,archive\n'
                                   f'Alpha Method,2024,{s.url("alpha.pdf")}\n'
                                   f'Beta Method,2023,{s.url("beta.pdf")}\n')
                f.REPO_ROOT = root
                out = StringIO()
                with redirect_stdout(out):
                    rc = f.process('demo_links')
            self.assertEqual(rc, 0, out.getvalue())
            papers = ds / 'papers'
            names = sorted(p.name for p in papers.glob('*.pdf'))
            self.assertEqual(names, ['alpha-method.pdf', 'beta-method.pdf'], names)
            self.assertEqual((papers / 'alpha-method.pdf').read_bytes(), PDF_BYTES)

            prov = json.loads((ds / 'chroma_db' / 'pdf-sources.json').read_text())
            self.assertIn('alpha-method', prov)
            entry = prov['alpha-method']
            self.assertTrue(str(entry.get('source', '')).startswith('csv:'),
                            f"source must name the CSV column, got {entry!r}")
            self.assertIn('archive', entry['source'])
            self.assertEqual(entry.get('resolved_via'), 'csv_column')
            self.assertTrue(entry.get('url', '').endswith('alpha.pdf'), entry)

    def test_row_with_a_dead_link_does_not_abort_the_run(self):
        with tempfile.TemporaryDirectory() as d:
            srv = Path(d) / 'srv'
            srv.mkdir()
            (srv / 'good.pdf').write_bytes(PDF_BYTES)
            root = Path(d) / 'repo'
            with _Server(srv) as s:
                ds = _write_domain(root, 'demo_links',
                                   'Name,Year,archive\n'
                                   f'Good One,2024,{s.url("good.pdf")}\n'
                                   f'Dead One,2024,{s.url("missing.pdf")}\n')
                f.REPO_ROOT = root
                out = StringIO()
                with redirect_stdout(out):
                    rc = f.process('demo_links')
            self.assertEqual(rc, 0, out.getvalue())
            got = sorted(p.name for p in (ds / 'papers').glob('*.pdf'))
            self.assertEqual(got, ['good-one.pdf'], got)

    def test_existing_pdf_is_not_refetched(self):
        with tempfile.TemporaryDirectory() as d:
            srv = Path(d) / 'srv'
            srv.mkdir()
            (srv / 'alpha.pdf').write_bytes(PDF_BYTES)
            root = Path(d) / 'repo'
            with _Server(srv) as s:
                ds = _write_domain(root, 'demo_links',
                                   'Name,Year,archive\n'
                                   f'Alpha Method,2024,{s.url("alpha.pdf")}\n')
                papers = ds / 'papers'
                papers.mkdir(parents=True)
                (papers / 'alpha-method.pdf').write_bytes(b'%PDF-1.4 ALREADY HERE\n')
                f.REPO_ROOT = root
                with redirect_stdout(StringIO()):
                    f.process('demo_links')
            self.assertEqual((papers / 'alpha-method.pdf').read_bytes(),
                             b'%PDF-1.4 ALREADY HERE\n',
                             'an existing PDF must never be overwritten')

    def test_dry_run_downloads_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            srv = Path(d) / 'srv'
            srv.mkdir()
            (srv / 'alpha.pdf').write_bytes(PDF_BYTES)
            root = Path(d) / 'repo'
            with _Server(srv) as s:
                ds = _write_domain(root, 'demo_links',
                                   'Name,Year,archive\n'
                                   f'Alpha Method,2024,{s.url("alpha.pdf")}\n')
                f.REPO_ROOT = root
                out = StringIO()
                with redirect_stdout(out):
                    rc = f.process('demo_links', dry_run=True)
            self.assertEqual(rc, 0)
            self.assertEqual(list((ds / 'papers').glob('*.pdf')), [])
            self.assertFalse((ds / 'chroma_db' / 'pdf-sources.json').exists())

    def test_domain_without_a_link_column_still_runs(self):
        # Regression guard: the two existing sources and the OA path must not
        # depend on a link column being present.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'repo'
            ds = _write_domain(root, 'demo_links',
                               'Name,Year,Description\nAlpha,2024,something\n')
            f.REPO_ROOT = root
            out = StringIO()
            with redirect_stdout(out):
                rc = f.process('demo_links')
            self.assertEqual(rc, 0, out.getvalue())
            self.assertEqual(list((ds / 'papers').glob('*.pdf')), [])

    def test_chosen_column_is_reported_in_the_log(self):
        # The build log is the maintainer's only window into why a PDF appeared.
        with tempfile.TemporaryDirectory() as d:
            srv = Path(d) / 'srv'
            srv.mkdir()
            (srv / 'alpha.pdf').write_bytes(PDF_BYTES)
            root = Path(d) / 'repo'
            with _Server(srv) as s:
                _write_domain(root, 'demo_links',
                              'Name,Year,archive\n'
                              f'Alpha Method,2024,{s.url("alpha.pdf")}\n')
                f.REPO_ROOT = root
                out = StringIO()
                with redirect_stdout(out):
                    f.process('demo_links')
            log = out.getvalue()
            self.assertIn('archive', log)
            self.assertRegex(log.lower(), r'(link column|paper link|csv link)')


# --------------------------------------------------------------------------- #
# 6. The role is declarable and documented                                    #
# --------------------------------------------------------------------------- #
class RoleSchemaAcceptsPaperUrl(unittest.TestCase):
    ROLE = 'identity.paper_url'

    def test_role_in_vocabulary(self):
        sys.path.insert(0, str(REPO / 'backend'))
        from rag.role_schema import ROLE_VOCABULARY
        self.assertIn(self.ROLE, ROLE_VOCABULARY)

    def test_role_is_documented(self):
        doc = REPO / 'docs' / 'role-schema.md'
        self.assertTrue(doc.exists(), f'{doc} must exist')
        self.assertIn(self.ROLE, doc.read_text(encoding='utf-8'),
                      'the role vocabulary comment requires documenting new roles here')

    def test_wizard_offers_the_role_to_the_mapper(self):
        # Otherwise a new domain's `archive` column gets mapped to something else
        # and the maintainer has to hand-edit YAML.
        src = (REPO / 'dashboard' / 'api' / 'admin' / 'propose-yaml.js').read_text(
            encoding='utf-8')
        self.assertIn(self.ROLE, src)


# --------------------------------------------------------------------------- #
# 7. The provenance survives the build                                        #
# --------------------------------------------------------------------------- #
class ProvenanceIsCommitted(unittest.TestCase):
    """`pdf-sources.json` is the only record of WHERE each PDF came from.

    `datasets/*/chroma_db/` is gitignored, so the commit step force-adds the handful
    of chroma files that must persist. pdf-sources.json was missing from that list, so
    every build wrote it and then threw it away — and
    `benchmarks/extraction/run_extraction.py` reads it to label a paper 'fetched' vs
    'committed' in the audit manifest, which silently degraded to unlabelled.
    """

    WORKFLOW = REPO / '.github' / 'workflows' / 'domain-build.yml'

    def test_commit_step_force_adds_pdf_sources(self):
        body = self.WORKFLOW.read_text(encoding='utf-8')
        self.assertRegex(
            body,
            r'git add -f "datasets/\$\{SLUG\}/chroma_db/pdf-sources\.json"',
            'the commit step must force-add chroma_db/pdf-sources.json (the dir is '
            'gitignored), otherwise the PDF provenance is discarded every build')

    def test_each_chroma_add_is_forced_and_single_pathspec(self):
        # Same trap as the TEI add: a plain `git add` silently no-ops on an ignored
        # path, and `git add A B` stages nothing when either pathspec misses.
        for line in self.WORKFLOW.read_text(encoding='utf-8').splitlines():
            s = line.strip()
            if s.startswith('git add') and 'chroma_db/' in s:
                with self.subTest(line=s):
                    self.assertRegex(s, r'^git add\s+-f\b')
                    paths = [t for t in re.sub(r'2>/dev/null.*$', '', s).split()[2:]
                             if not t.startswith('-')]
                    self.assertEqual(len(paths), 1, f'one pathspec per add, got {paths}')


# --------------------------------------------------------------------------- #
# 8. The two pre-existing sources are untouched                               #
# --------------------------------------------------------------------------- #
class ExistingSourcesStillWork(unittest.TestCase):
    def test_classify_drive_folder(self):
        self.assertEqual(
            f.classify_pdf_source('https://drive.google.com/drive/folders/1AbC_def'),
            ('drive_folder', '1AbC_def'))

    def test_classify_drive_file(self):
        kind, ref = f.classify_pdf_source(
            'https://drive.google.com/file/d/1XyZ_abc/view?usp=sharing')
        self.assertEqual(kind, 'direct')
        self.assertIn('confirm=t', ref)

    def test_classify_direct(self):
        self.assertEqual(f.classify_pdf_source('https://example.org/papers.zip'),
                         ('direct', 'https://example.org/papers.zip'))

    def test_classify_rejects_non_url(self):
        self.assertEqual(f.classify_pdf_source('nonsense'), (None, None))

    def test_resolvers_tuple_still_has_the_oa_chain(self):
        names = [r.__name__ for r in f.RESOLVERS]
        for expected in ('resolve_arxiv', 'resolve_openalex',
                         'resolve_semanticscholar', 'resolve_scrape_links'):
            self.assertIn(expected, names)


if __name__ == '__main__':
    unittest.main()
