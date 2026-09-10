"""Nightly Google Drive PDF sync — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
Run:  python3 -m unittest scripts/test_drive_sync.py

Each domain's Google Drive folder (``drive_folder``, or a separate Drive-folder ``pdf_url``) holds the
paper PDFs (top level or one subfolder deep). The nightly job counts them, stores the count in the
GitHub repo variable DRIVE_STATUS_<DOMAIN> (same JSON the admin writes), and dispatches a
``new-paper`` build when the PDF set changed. Builds import PDFs from that folder.
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fetch_missing_pdfs as f  # noqa: E402
import drive_sync as ds  # noqa: E402

FP = '4301741e9bfd533b62f3c5738851eb83caf6076b'
FOLDER = 'https://drive.google.com/drive/folders/1TOPFOLDERXXXXXXXXXXXXXXX?usp=sharing'


def entry(fid, name, folder=False, modified='Sep 3'):
    href = f'https://drive.google.com/drive/folders/{fid}' if folder else f'https://drive.google.com/file/d/{fid}/view?usp=drive_web'
    return (f'<div class="flip-entry" id="entry-{fid}" tabindex="0" role="link"><div class="flip-entry-info">'
            f'<a href="{href}" target="_blank"><div class="flip-entry-thumb"><img src="x"/></div>'
            f'<div class="flip-entry-title">{name}</div></a></div>'
            f'<div class="flip-entry-last-modified"><div>{modified}</div></div></div>')


def listing(title, entries):
    return f'<html><head><title>{title}</title></head><body><div class="flip-entries">{"".join(entries)}</div></body></html>'


TOP = listing('Test Domain', [
    entry('1CSVAAAAAAAAAAAAAAAAAAAAA', 'Test Sheet_2026-09-01_10-00-00.csv'),
    entry('1CSVBBBBBBBBBBBBBBBBBBBBB', 'Test Sheet_2026-09-03_22-41-54.csv'),
    entry('1AAAAAAAAAAAAAAAAAAAAAAAA', 'GraspGen.pdf'),
    entry('1FOLDERPDFSSSSSSSSSSSSSSS', 'PDFs', folder=True),
])
SUB = listing('PDFs', [
    entry('1CCCCCCCCCCCCCCCCCCCCCCCC', 'AffordGen.pdf'),
    entry('1AAAAAAAAAAAAAAAAAAAAAAAA', 'GraspGen.pdf'),
    entry('1NOTESSSSSSSSSSSSSSSSSSSS', 'notes.txt'),
])


def fake_fetch(pages):
    """pages: folder_id -> (http_status, html) tuple, or an Exception to raise (network error)."""
    def fetch_html(folder_id):
        v = pages[folder_id]
        if isinstance(v, Exception):
            raise v
        return v
    return fetch_html


FETCH = fake_fetch({'1TOPFOLDERXXXXXXXXXXXXXXX': (200, TOP), '1FOLDERPDFSSSSSSSSSSSSSSS': (200, SUB)})


class DriveListingHelpers(unittest.TestCase):
    def test_subfolders(self):
        self.assertEqual(f.parse_drive_subfolders(TOP), [('1FOLDERPDFSSSSSSSSSSSSSSS', 'PDFs')])
        self.assertEqual(f.parse_drive_subfolders(SUB), [])

    def test_fingerprint_matches_js(self):
        self.assertEqual(f.pdf_fingerprint([('1CCCCCCCCCCCCCCCCCCCCCCCC', 'AffordGen.pdf'),
                                            ('1AAAAAAAAAAAAAAAAAAAAAAAA', 'GraspGen.pdf')]), FP)

    def test_list_drive_pdfs_one_level_deep_deduped(self):
        files, subfolders = f.list_drive_pdfs('1TOPFOLDERXXXXXXXXXXXXXXX', fetch_html=FETCH)
        self.assertEqual(sorted(files), [('1AAAAAAAAAAAAAAAAAAAAAAAA', 'GraspGen.pdf'),
                                         ('1CCCCCCCCCCCCCCCCCCCCCCCC', 'AffordGen.pdf')])
        self.assertEqual(subfolders, ['PDFs'])


class BuildStatus(unittest.TestCase):
    def test_same_schema_as_the_admin(self):
        st = ds.build_status({'domain': 'test_domain', 'drive_folder': FOLDER}, fetch_html=FETCH)
        self.assertEqual(st['checked_by'], 'nightly')
        self.assertTrue(st['checked_at'].endswith('Z'))
        self.assertEqual(st['folder']['status'], 'ok')
        self.assertEqual(st['folder']['title'], 'Test Domain')
        self.assertEqual(st['csv']['count'], 2)
        self.assertEqual(st['csv']['newest'], 'Test Sheet_2026-09-03_22-41-54.csv')
        self.assertEqual(st['pdf']['status'], 'ok')
        self.assertEqual(st['pdf']['count'], 2)
        self.assertEqual(st['pdf']['fingerprint'], FP)
        self.assertEqual(sorted(x['name'] for x in st['pdf']['files']), ['AffordGen.pdf', 'GraspGen.pdf'])

    def test_not_found_and_not_public(self):
        st = ds.build_status({'domain': 'x', 'drive_folder': FOLDER},
                             fetch_html=fake_fetch({'1TOPFOLDERXXXXXXXXXXXXXXX': (404, 'nope')}))
        self.assertEqual(st['folder']['status'], 'not_found')
        st = ds.build_status({'domain': 'x', 'drive_folder': FOLDER},
                             fetch_html=fake_fetch({'1TOPFOLDERXXXXXXXXXXXXXXX': (200, '<title>Sign in</title>')}))
        self.assertEqual(st['folder']['status'], 'not_public')

    def test_separate_drive_pdf_folder_wins_for_pdfs(self):
        pdf_only = listing('Only PDFs', [entry('1ZZZZZZZZZZZZZZZZZZZZZZZZ', 'x.pdf')])
        st = ds.build_status(
            {'domain': 'x', 'drive_folder': FOLDER, 'pdf_url': 'https://drive.google.com/drive/folders/1PDFONLYYYYYYYYYYYYYYYYYY'},
            fetch_html=fake_fetch({'1TOPFOLDERXXXXXXXXXXXXXXX': (200, TOP), '1FOLDERPDFSSSSSSSSSSSSSSS': (200, SUB),
                                   '1PDFONLYYYYYYYYYYYYYYYYYY': (200, pdf_only)}))
        self.assertEqual(st['csv']['count'], 2)          # sheet exports still from drive_folder
        self.assertEqual(st['pdf']['count'], 1)          # PDFs from the dedicated folder

    def test_no_folder_configured(self):
        self.assertIsNone(ds.build_status({'domain': 'x'}, fetch_html=FETCH))


class Plan(unittest.TestCase):
    def cur(self, names, status='ok'):
        files = [{'id': f'id-{n}', 'name': n} for n in names]
        return {'checked_at': '2026-09-11T06:00:00Z', 'checked_by': 'nightly', 'folder': {'status': status},
                'csv': {'count': 0}, 'pdf': {'status': status, 'count': len(files), 'files': files,
                                             'fingerprint': f.pdf_fingerprint([(x['id'], x['name']) for x in files])}}

    def test_first_seen_with_pdfs_dispatches(self):
        p = ds.plan(None, self.cur(['a.pdf', 'b.pdf']))
        self.assertTrue(p['dispatch'])
        self.assertEqual(sorted(p['added']), ['a.pdf', 'b.pdf'])

    def test_first_seen_empty_does_not(self):
        self.assertFalse(ds.plan(None, self.cur([], status='empty'))['dispatch'])

    def test_unchanged_does_not(self):
        c = self.cur(['a.pdf'])
        self.assertFalse(ds.plan(c, self.cur(['a.pdf']))['dispatch'])

    def test_added_and_removed(self):
        p = ds.plan(self.cur(['a.pdf', 'old.pdf']), self.cur(['a.pdf', 'new.pdf']))
        self.assertTrue(p['dispatch'])
        self.assertEqual(p['added'], ['new.pdf'])
        self.assertEqual(p['removed'], ['old.pdf'])

    def test_unreachable_keeps_last_good_listing_and_never_dispatches(self):
        prev = self.cur(['a.pdf', 'b.pdf'])
        cur = self.cur([], status='not_public')
        p = ds.plan(prev, cur)
        self.assertFalse(p['dispatch'])
        self.assertEqual(p['store']['pdf']['status'], 'not_public')
        self.assertEqual(p['store']['pdf']['fingerprint'], prev['pdf']['fingerprint'])
        self.assertEqual(p['store']['pdf']['count'], 2)


class SyncedFingerprint(unittest.TestCase):
    """An admin "Check now" re-counts (updates pdf.fingerprint) but must not swallow the nightly
    build: change detection compares against pdf.synced_fingerprint = the set last built."""

    def rec(self, names, synced=None, has_synced=True):
        files = [{'id': f'id-{n}', 'name': n} for n in names]
        fp = f.pdf_fingerprint([(x['id'], x['name']) for x in files])
        pdf = {'status': 'ok' if files else 'empty', 'count': len(files), 'files': files, 'fingerprint': fp}
        if has_synced:
            pdf['synced_fingerprint'] = synced
        return {'checked_at': 'x', 'checked_by': 'admin', 'folder': {'status': 'ok'}, 'csv': {'count': 0}, 'pdf': pdf}

    def fp(self, names):
        return f.pdf_fingerprint([(f'id-{n}', n) for n in names])

    def test_admin_recount_then_nightly_still_builds(self):
        prev = self.rec(['a.pdf', 'new.pdf'], synced=self.fp(['a.pdf']))   # admin counted the new PDF already
        cur = self.rec(['a.pdf', 'new.pdf'], has_synced=False)
        p = ds.plan(prev, cur)
        self.assertTrue(p['dispatch'])
        self.assertEqual(p['store']['pdf']['synced_fingerprint'], cur['pdf']['fingerprint'])

    def test_never_built_folder_builds_once(self):
        p = ds.plan(self.rec(['a.pdf'], synced=None), self.rec(['a.pdf'], has_synced=False))
        self.assertTrue(p['dispatch'])

    def test_in_sync_does_not_build_and_keeps_synced(self):
        prev = self.rec(['a.pdf'], synced=self.fp(['a.pdf']))
        p = ds.plan(prev, self.rec(['a.pdf'], has_synced=False))
        self.assertFalse(p['dispatch'])
        self.assertEqual(p['store']['pdf']['synced_fingerprint'], self.fp(['a.pdf']))

    def test_error_keeps_synced(self):
        prev = self.rec(['a.pdf'], synced=self.fp(['a.pdf']))
        cur = self.rec([], has_synced=False); cur['pdf']['status'] = 'not_public'
        p = ds.plan(prev, cur)
        self.assertFalse(p['dispatch'])
        self.assertEqual(p['store']['pdf']['synced_fingerprint'], self.fp(['a.pdf']))

    def test_dispatch_marks_synced(self):
        p = ds.plan(None, self.rec(['a.pdf'], has_synced=False))
        self.assertTrue(p['dispatch'])
        self.assertEqual(p['store']['pdf']['synced_fingerprint'], p['store']['pdf']['fingerprint'])


class Run(unittest.TestCase):
    def test_run_reads_prev_writes_status_and_reports_changes(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / 'test_domain.yaml').write_text(f'domain: test_domain\ndrive_folder: "{FOLDER}"\n')
            (d / 'grasp_planning.yaml').write_text('domain: grasp_planning\n')   # no folder -> skipped
            store = {}
            with redirect_stdout(io.StringIO()):
                changes = ds.run(d, fetch_html=FETCH, read_var=lambda n: store.get(n), write_var=store.__setitem__)
            self.assertEqual([c['domain'] for c in changes], ['test_domain'])
            self.assertEqual(changes[0]['pages'], 'new-paper')
            saved = json.loads(store['DRIVE_STATUS_TEST_DOMAIN'])
            self.assertEqual(saved['pdf']['fingerprint'], FP)
            with redirect_stdout(io.StringIO()):
                again = ds.run(d, fetch_html=FETCH, read_var=lambda n: store.get(n), write_var=store.__setitem__)
            self.assertEqual(again, [], 'second night, nothing new -> no build')


class ImportFromDomainFolder(unittest.TestCase):
    """Builds pull PDFs from drive_folder when no separate pdf_url is set."""

    def setUp(self):
        self._root = f.REPO_ROOT
        self.td = tempfile.TemporaryDirectory()
        root = Path(self.td.name)
        (root / 'domains').mkdir()
        (root / 'datasets' / 'x-dom').mkdir(parents=True)
        (root / 'datasets' / 'x-dom' / 'x.csv').write_text('Name,Citation,Link(s)\n')
        (root / 'domains' / 'x_dom.yaml').write_text(f'domain: x_dom\ncsv_path: datasets/x-dom/x.csv\ndrive_folder: "{FOLDER}"  # sheet + PDFs\n')
        self.root = root
        f.REPO_ROOT = root

    def tearDown(self):
        f.REPO_ROOT = self._root
        self.td.cleanup()

    def test_drive_folder_is_the_pdf_source(self):
        self.assertEqual(f._yaml_drive_folder('x_dom'), FOLDER)
        seen = []
        orig = f.import_pdf_source
        f.import_pdf_source = lambda url, papers_dir, dry_run=False: seen.append(url) or {'kind': 'drive_folder', 'added': [], 'skipped': [], 'error': None}
        try:
            with redirect_stdout(io.StringIO()):
                f.process('x_dom', dry_run=False)
        finally:
            f.import_pdf_source = orig
        self.assertEqual(seen, [FOLDER])


class WorkflowPins(unittest.TestCase):
    def test_sheet_poll_runs_drive_sync_and_dispatches_pdf_changes(self):
        t = (Path(HERE).parent / '.github' / 'workflows' / 'sheet-poll.yml').read_text()
        self.assertIn('scripts/drive_sync.py', t)
        self.assertIn('id: drive', t)
        self.assertIn('pdf_changed', t)
        self.assertIn('secrets.GH_PAT', t)


if __name__ == '__main__':
    unittest.main()
