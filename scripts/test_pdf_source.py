"""PDF-source link (``pdf_url``) + new-domain papers dir — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify.  Run:  python -m unittest scripts/test_pdf_source.py

Covers the admin-handoff additions to fetch_missing_pdfs.py:
  * a brand-new domain (no papers.zip yet) no longer aborts: the papers dir is created;
  * the YAML ``pdf_url`` (Drive folder / Drive file / Dropbox / direct link to a
    .zip or .pdf) is imported into the papers dir before the OA fetch runs.
No external network: a local stdlib HTTP server serves the fixtures.
"""
import http.server
import io
import os
import socketserver
import sys
import tempfile
import threading
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_missing_pdfs as f  # noqa: E402

PDF_BYTES = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class _Server:
    """Serve a temp directory on 127.0.0.1:<random port> for the duration of a test."""

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


def _make_zip(path, members):
    with zipfile.ZipFile(path, 'w') as z:
        for name, data in members.items():
            z.writestr(name, data)


class ClassifyPdfSource(unittest.TestCase):
    def test_drive_folder(self):
        kind, ref = f.classify_pdf_source(
            'https://drive.google.com/drive/folders/1AbC_def-GHIjklmnopqrstu?usp=sharing')
        self.assertEqual(kind, 'drive_folder')
        self.assertEqual(ref, '1AbC_def-GHIjklmnopqrstu')

    def test_drive_file_share_link_becomes_direct_download(self):
        kind, ref = f.classify_pdf_source(
            'https://drive.google.com/file/d/1XyZ_abcdefghijklmnopq/view?usp=sharing')
        self.assertEqual(kind, 'direct')
        self.assertIn('id=1XyZ_abcdefghijklmnopq', ref)
        self.assertTrue(ref.startswith('https://drive.usercontent.google.com/download'), ref)
        self.assertIn('confirm=t', ref)  # skip the large-file virus-scan interstitial

    def test_drive_open_id_form(self):
        kind, ref = f.classify_pdf_source('https://drive.google.com/open?id=1XyZ_abcdefghijklmnopq')
        self.assertEqual(kind, 'direct')
        self.assertIn('id=1XyZ_abcdefghijklmnopq', ref)

    def test_dropbox_forces_download(self):
        kind, ref = f.classify_pdf_source('https://www.dropbox.com/scl/fi/abc/papers.zip?rlkey=xyz&dl=0')
        self.assertEqual(kind, 'direct')
        self.assertIn('dl=1', ref)
        self.assertNotIn('dl=0', ref)
        self.assertIn('rlkey=xyz', ref)

    def test_plain_url_unchanged(self):
        self.assertEqual(f.classify_pdf_source('https://example.org/papers.zip'),
                         ('direct', 'https://example.org/papers.zip'))

    def test_empty(self):
        self.assertEqual(f.classify_pdf_source(''), (None, None))
        self.assertEqual(f.classify_pdf_source(None), (None, None))
        self.assertEqual(f.classify_pdf_source('not a url'), (None, None))


class DriveFolderListing(unittest.TestCase):
    HTML = '''
    <div class="flip-entries">
      <div class="flip-entry" id="entry-1AAAAAAAAAAAAAAAAAAAAAAAA">
        <a href="https://drive.google.com/file/d/1AAAAAAAAAAAAAAAAAAAAAAAA/view?usp=drive_web" target="_blank">
          <div class="flip-entry-thumb"><img src="x"></div>
          <div class="flip-entry-title">GraspGen.pdf</div></a></div>
      <div class="flip-entry" id="entry-1BBBBBBBBBBBBBBBBBBBBBBBB">
        <a href="https://drive.google.com/file/d/1BBBBBBBBBBBBBBBBBBBBBBBB/view?usp=drive_web" target="_blank">
          <div class="flip-entry-thumb"><img src="x"></div>
          <div class="flip-entry-title">methods_2026-09-01_10-00-00.csv</div></a></div>
      <div class="flip-entry" id="entry-1CCCCCCCCCCCCCCCCCCCCCCCC">
        <a href="https://drive.google.com/file/d/1CCCCCCCCCCCCCCCCCCCCCCCC/view?usp=drive_web" target="_blank">
          <div class="flip-entry-thumb"><img src="x"></div>
          <div class="flip-entry-title">AffordGen.PDF</div></a></div>
      <div class="flip-entry" id="entry-1AAAAAAAAAAAAAAAAAAAAAAAA">
        <a href="https://drive.google.com/file/d/1AAAAAAAAAAAAAAAAAAAAAAAA/view?usp=drive_web" target="_blank">
          <div class="flip-entry-title">GraspGen.pdf</div></a></div>
    </div>'''

    def test_lists_only_pdfs_deduped(self):
        got = f.parse_drive_folder_listing(self.HTML)
        self.assertEqual(sorted(got), [('1AAAAAAAAAAAAAAAAAAAAAAAA', 'GraspGen.pdf'),
                                       ('1CCCCCCCCCCCCCCCCCCCCCCCC', 'AffordGen.PDF')])

    def test_empty_html(self):
        self.assertEqual(f.parse_drive_folder_listing('<html></html>'), [])


class ExtractPdfsFromZip(unittest.TestCase):
    def test_flattens_normalises_skips_existing_and_junk(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            papers = td / 'papers'
            papers.mkdir()
            (papers / 'a.pdf').write_bytes(b'ORIGINAL')
            zp = td / 'bundle.zip'
            _make_zip(zp, {
                'MyPapers/a.pdf': PDF_BYTES,             # already present -> skipped, not overwritten
                'b.PDF': PDF_BYTES,                       # extension normalised to .pdf
                'nested/deep/c.pdf': PDF_BYTES,           # flattened
                '__MACOSX/MyPapers/._a.pdf': b'junk',     # macOS resource fork -> ignored
                'notes.txt': b'not a pdf',                # non-PDF -> ignored
                '../../evil.pdf': PDF_BYTES,              # zip-slip -> contained to papers dir
            })
            res = f.extract_pdfs_from_zip(zp, papers)
            self.assertEqual(sorted(res['added']), ['b.pdf', 'c.pdf', 'evil.pdf'])
            self.assertEqual(res['skipped'], ['a.pdf'])
            self.assertEqual((papers / 'a.pdf').read_bytes(), b'ORIGINAL')
            self.assertEqual(sorted(p.name for p in papers.iterdir()), ['a.pdf', 'b.pdf', 'c.pdf', 'evil.pdf'])
            self.assertFalse((td / 'evil.pdf').exists())
            self.assertFalse(Path(td.parent / 'evil.pdf').exists())


class ImportPdfSource(unittest.TestCase):
    def test_direct_zip_link(self):
        with tempfile.TemporaryDirectory() as srv, tempfile.TemporaryDirectory() as td:
            _make_zip(Path(srv) / 'papers.zip', {'papers/x.pdf': PDF_BYTES, 'y.pdf': PDF_BYTES})
            papers = Path(td) / 'papers'
            papers.mkdir()
            with _Server(srv) as s, redirect_stdout(io.StringIO()):
                res = f.import_pdf_source(s.url('papers.zip'), papers)
            self.assertIsNone(res.get('error'))
            self.assertEqual(sorted(res['added']), ['x.pdf', 'y.pdf'])
            self.assertTrue((papers / 'x.pdf').exists())

    def test_direct_single_pdf_link(self):
        with tempfile.TemporaryDirectory() as srv, tempfile.TemporaryDirectory() as td:
            (Path(srv) / 'graspgen.pdf').write_bytes(PDF_BYTES)
            papers = Path(td) / 'papers'
            papers.mkdir()
            with _Server(srv) as s, redirect_stdout(io.StringIO()):
                res = f.import_pdf_source(s.url('graspgen.pdf'), papers)
            self.assertEqual(res['added'], ['graspgen.pdf'])
            self.assertEqual((papers / 'graspgen.pdf').read_bytes(), PDF_BYTES)

    def test_html_page_is_a_clear_error_not_a_crash(self):
        with tempfile.TemporaryDirectory() as srv, tempfile.TemporaryDirectory() as td:
            (Path(srv) / 'share.html').write_text('<!DOCTYPE html><html>Sign in to continue</html>')
            papers = Path(td) / 'papers'
            papers.mkdir()
            out = io.StringIO()
            with _Server(srv) as s, redirect_stdout(out):
                res = f.import_pdf_source(s.url('share.html'), papers)
            self.assertTrue(res.get('error'))
            self.assertIn('public', (res['error'] + out.getvalue()).lower())  # tells the user to share it publicly
            self.assertEqual(res['added'], [])
            self.assertEqual(list(papers.iterdir()), [])

    def test_unreachable_is_non_fatal(self):
        with tempfile.TemporaryDirectory() as td, redirect_stdout(io.StringIO()):
            res = f.import_pdf_source('http://127.0.0.1:9/nothing.zip', Path(td))
        self.assertTrue(res.get('error'))
        self.assertEqual(res['added'], [])

    def test_dry_run_downloads_nothing(self):
        with tempfile.TemporaryDirectory() as srv, tempfile.TemporaryDirectory() as td:
            _make_zip(Path(srv) / 'papers.zip', {'x.pdf': PDF_BYTES})
            papers = Path(td) / 'papers'
            papers.mkdir()
            with _Server(srv) as s, redirect_stdout(io.StringIO()):
                res = f.import_pdf_source(s.url('papers.zip'), papers, dry_run=True)
            self.assertEqual(res['added'], [])
            self.assertEqual(list(papers.iterdir()), [])


class ProcessNewDomain(unittest.TestCase):
    """process() on a fresh domain: YAML + CSV committed, no papers dir, no zip."""

    def setUp(self):
        self._root = f.REPO_ROOT
        self.td = tempfile.TemporaryDirectory()
        root = Path(self.td.name)
        (root / 'domains').mkdir()
        (root / 'datasets' / 'x-dom').mkdir(parents=True)
        (root / 'datasets' / 'x-dom' / 'x.csv').write_text('Name,Citation,Link(s)\n')  # header only: no network
        self.root = root
        f.REPO_ROOT = root

    def tearDown(self):
        f.REPO_ROOT = self._root
        self.td.cleanup()

    def _yaml(self, extra=''):
        (self.root / 'domains' / 'x_dom.yaml').write_text(
            'domain: x_dom\ncsv_path: datasets/x-dom/x.csv\npapers_dir: datasets/x-dom/papers/\n' + extra)

    def test_missing_papers_dir_is_created_not_fatal(self):
        self._yaml()
        with redirect_stdout(io.StringIO()):
            rc = f.process('x_dom', dry_run=False)
        self.assertEqual(rc, 0)
        self.assertTrue((self.root / 'datasets' / 'x-dom' / 'papers').is_dir())

    def test_yaml_pdf_url_is_imported_before_oa_fetch(self):
        self._yaml('pdf_url: "https://example.org/bundle.zip"  # shared zip\n')
        self.assertEqual(f._yaml_pdf_url('x_dom'), 'https://example.org/bundle.zip')
        seen = []
        orig = f.import_pdf_source
        f.import_pdf_source = lambda url, papers_dir, dry_run=False: (
            seen.append((url, Path(papers_dir), dry_run)) or {'kind': 'direct', 'added': [], 'skipped': [], 'error': None})
        try:
            with redirect_stdout(io.StringIO()):
                rc = f.process('x_dom', dry_run=False)
        finally:
            f.import_pdf_source = orig
        self.assertEqual(rc, 0)
        self.assertEqual(seen, [('https://example.org/bundle.zip', self.root / 'datasets' / 'x-dom' / 'papers', False)])

    def test_no_pdf_url_no_import(self):
        self._yaml()
        self.assertIsNone(f._yaml_pdf_url('x_dom'))
        seen = []
        orig = f.import_pdf_source
        f.import_pdf_source = lambda *a, **k: seen.append(a) or {'added': [], 'skipped': [], 'error': None}
        try:
            with redirect_stdout(io.StringIO()):
                f.process('x_dom', dry_run=False)
        finally:
            f.import_pdf_source = orig
        self.assertEqual(seen, [])


if __name__ == '__main__':
    unittest.main()
