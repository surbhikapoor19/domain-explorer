#!/usr/bin/env python3
"""Nightly Google Drive PDF sync.

Each domain's Google Drive folder (``drive_folder``, or a separate Drive-folder
``pdf_url``) holds the paper PDFs (top level or one subfolder deep) alongside
the sheet's CSV exports. This script counts them, stores the count in the
GitHub Actions repo variable ``DRIVE_STATUS_<DOMAIN>`` (the same JSON shape the
admin's "Check now" writes — see dashboard/lib/admin-drive.js), and reports
which domains' PDF set changed so the caller (.github/workflows/sheet-poll.yml)
can dispatch a ``new-paper`` build for them.

Run standalone (as the workflow does):
    GH_PAT=... GITHUB_REPOSITORY=owner/repo python3 scripts/drive_sync.py

May use PyYAML — the sheet-poll workflow installs it before this runs.
"""
import copy
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fetch_missing_pdfs as fmp  # noqa: E402

try:
    import yaml
except ImportError:  # pragma: no cover - the workflow installs pyyaml
    yaml = None

ERROR_STATUSES = {'not_public', 'not_found', 'unreachable', 'invalid'}

MESSAGES = {
    'not_found': "Folder not found — check the link and that it's shared 'Anyone with the link'.",
    'not_public': "The folder isn't public — in Drive: Share → General access → Anyone with the link (Viewer).",
    'unreachable': "Couldn't reach Google Drive — try again.",
    'invalid': 'Only Google Drive folder links can be tested here.',
}


def _now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _drive_folder_id(url):
    if not url or not isinstance(url, str):
        return None
    m = re.match(r'^https?://drive\.google\.com/drive/(?:u/\d+/)?folders/([\w-]+)', url)
    return m.group(1) if m else None


def _parse_listing(html):
    """Mirror of dashboard/lib/admin-drive.js::parseDriveListing:
    ``{public, title, entries:[{id,name,kind,modified}]}``, parsed PER ENTRY
    (never a window that could pair one entry's id with another's title)."""
    html = html or ''
    public = 'class="flip-entries"' in html
    title_m = re.search(r'<title>([^<]*)</title>', html, re.IGNORECASE)
    title = title_m.group(1).strip() if title_m else ''

    starts = [(m.start(), m.group(1)) for m in
              re.finditer(r'<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"', html)]
    entries = []
    for i, (start, entry_id) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(html)
        block = html[start:end]
        kind = 'folder' if '/drive/folders/' in block else 'file'
        name_m = re.search(r'flip-entry-title[^>]*>([^<]*)<', block)
        name = name_m.group(1).strip() if name_m else ''
        if not name:
            continue
        mod_m = re.search(r'flip-entry-last-modified"[^>]*>\s*<div>([^<]*)</div>', block)
        entries.append({'id': entry_id, 'name': name, 'kind': kind,
                        'modified': mod_m.group(1).strip() if mod_m else None})
    return {'public': public, 'title': title, 'entries': entries}


def _csv_sort_key(name):
    m = re.search(r'(\d{4}-\d{2}-\d{2}[ _]\d{2}-\d{2}-\d{2})', name or '')
    return m.group(1).replace(' ', '_') if m else None


def _pick_newest_csv(entries):
    newest = None
    for e in entries:
        if newest is None:
            newest = e
            continue
        a, b = _csv_sort_key(e['name']), _csv_sort_key(newest['name'])
        if a and b:
            if a > b:
                newest = e
        elif a and not b:
            newest = e
        elif not a and not b:
            if e['name'] > newest['name']:
                newest = e
    return newest


def _gather_folder_contents(entries, fetch_html):
    """Top level (``entries``) + one subfolder level (<=10), deduped by id.
    Collects BOTH .pdf and .csv entries from the SAME listings (reused, never
    fetched twice) — a CSV kept next to the PDFs (e.g. inside a "papers/"
    subfolder) is still found and counted. Returns (files, subfolder_names,
    csv_entries)."""
    files = {}
    csv_by_id = {}

    def collect(items):
        for e in items:
            if e['kind'] != 'file':
                continue
            name_lower = e['name'].lower()
            if name_lower.endswith('.pdf'):
                files.setdefault(e['id'], e['name'])
            elif name_lower.endswith('.csv'):
                csv_by_id.setdefault(e['id'], e)

    collect(entries)
    subfolders = [e for e in entries if e['kind'] == 'folder'][:10]
    for sub in subfolders:
        try:
            status, html = fetch_html(sub['id'])
        except Exception:
            continue
        if status != 200:
            continue
        collect(_parse_listing(html)['entries'])
    return files, [s['name'] for s in subfolders], list(csv_by_id.values())


def _empty_pdf(status, source_url):
    return {'source_url': source_url, 'status': status, 'count': 0,
            'files': [], 'subfolders': [], 'fingerprint': fmp.pdf_fingerprint([])}


def _check_folder(url, fetch_html, pdf_url=None):
    """Live check of one Drive folder -> ``(folder, csv, pdf)``, the three
    stored-status sub-objects (mirrors dashboard/lib/admin-drive.js's
    checkDriveFolder)."""
    folder_id = _drive_folder_id(url)
    if not folder_id:
        folder = {'url': url, 'id': None, 'status': 'invalid', 'title': None, 'message': MESSAGES['invalid']}
        return folder, {'count': 0, 'newest': None, 'newest_modified': None}, _empty_pdf('invalid', pdf_url or url)

    try:
        status, html = fetch_html(folder_id)
    except Exception:
        folder = {'url': url, 'id': folder_id, 'status': 'unreachable', 'title': None, 'message': MESSAGES['unreachable']}
        return folder, {'count': 0, 'newest': None, 'newest_modified': None}, _empty_pdf('unreachable', pdf_url or url)

    if status == 404:
        folder = {'url': url, 'id': folder_id, 'status': 'not_found', 'title': None, 'message': MESSAGES['not_found']}
        return folder, {'count': 0, 'newest': None, 'newest_modified': None}, _empty_pdf('not_found', pdf_url or url)

    parsed = _parse_listing(html)
    if not parsed['public']:
        folder = {'url': url, 'id': folder_id, 'status': 'not_public', 'title': parsed['title'] or None, 'message': MESSAGES['not_public']}
        return folder, {'count': 0, 'newest': None, 'newest_modified': None}, _empty_pdf('not_public', pdf_url or url)

    main_files, main_subfolders, csv_entries = _gather_folder_contents(parsed['entries'], fetch_html)
    newest = _pick_newest_csv(csv_entries)

    pdf_folder_id = _drive_folder_id(pdf_url) if pdf_url else None
    if pdf_folder_id and pdf_folder_id != folder_id:
        try:
            pstatus, phtml = fetch_html(pdf_folder_id)
            pdf_entries = _parse_listing(phtml)['entries'] if pstatus == 200 else []
        except Exception:
            pdf_entries = []
        files, subfolders, _pdf_folder_csvs = _gather_folder_contents(pdf_entries, fetch_html)
    else:
        files, subfolders = main_files, main_subfolders

    status_val = 'ok' if (csv_entries or files) else 'empty'
    folder = {'url': url, 'id': folder_id, 'status': status_val, 'title': parsed['title'] or None, 'message': None}
    csv = {'count': len(csv_entries), 'newest': newest['name'] if newest else None,
           'newest_modified': newest['modified'] if newest else None}
    file_pairs = list(files.items())
    pdf = {
        'source_url': pdf_url or url,
        'status': status_val,
        'count': len(file_pairs),
        'files': [{'id': fid, 'name': name} for fid, name in file_pairs],
        'subfolders': subfolders,
        'fingerprint': fmp.pdf_fingerprint(file_pairs),
    }
    return folder, csv, pdf


def build_status(cfg, fetch_html=None):
    """Live-check a domain's Drive folder(s) -> the stored-status dict
    (``checked_by: "nightly"``), or None when the domain has no Drive folder
    (neither ``drive_folder`` nor a Drive-folder ``pdf_url``)."""
    fetch_html = fetch_html or fmp._drive_fetch_html
    drive_folder = cfg.get('drive_folder')
    pdf_url_cfg = cfg.get('pdf_url')
    pdf_url_folder_id = _drive_folder_id(pdf_url_cfg) if pdf_url_cfg else None

    if not drive_folder and not pdf_url_folder_id:
        return None

    folder_url = drive_folder or pdf_url_cfg
    separate_pdf_folder = pdf_url_cfg if (drive_folder and pdf_url_folder_id) else None
    pdf_is_link_only = bool(drive_folder and pdf_url_cfg and not pdf_url_folder_id)

    if pdf_is_link_only:
        folder, csv, _pdf = _check_folder(drive_folder, fetch_html)
        pdf = {'source_url': pdf_url_cfg, 'status': 'link', 'count': None,
               'files': [], 'subfolders': [], 'fingerprint': None}
    else:
        folder, csv, pdf = _check_folder(folder_url, fetch_html, pdf_url=separate_pdf_folder)

    return {
        'checked_at': _now_iso(),
        'checked_by': 'nightly',
        'folder': folder,
        'csv': csv,
        'pdf': pdf,
    }


def plan(prev, cur):
    """Decide whether the PDF set changed enough to dispatch a ``new-paper``
    build, and what gets written to the repo variable this run.

    ``pdf.fingerprint`` is the latest listing, from whoever counted last (the
    nightly job or an admin "Check now"). ``pdf.synced_fingerprint`` is the
    PDF set a build was last STARTED for — comparing against it (rather than
    against prev's raw fingerprint) means an admin re-count in between nightly
    runs can't make the nightly job think a new PDF was already handled.

    cur.pdf.status in ERROR_STATUSES -> never dispatch (can't compare); the
    stored PDF listing/count/fingerprint/synced_fingerprint carry over from
    prev (status stays the error, so the dashboard still shows what's
    currently wrong).
    """
    prev_pdf = (prev or {}).get('pdf', {})
    has_synced_key = isinstance(prev, dict) and 'synced_fingerprint' in prev_pdf
    base = prev_pdf.get('synced_fingerprint') if has_synced_key else prev_pdf.get('fingerprint')

    if cur.get('pdf', {}).get('status') in ERROR_STATUSES:
        store = copy.deepcopy(cur)
        if prev:
            store['pdf']['files'] = prev_pdf.get('files', [])
            store['pdf']['count'] = prev_pdf.get('count', 0)
            store['pdf']['fingerprint'] = prev_pdf.get('fingerprint')
        store['pdf']['synced_fingerprint'] = base
        return {'dispatch': False, 'added': [], 'removed': [], 'store': store}

    cur_names = {x['name'] for x in cur.get('pdf', {}).get('files', [])}
    prev_names = {x['name'] for x in prev_pdf.get('files', [])} if prev is not None else set()
    added = sorted(cur_names - prev_names)
    removed = sorted(prev_names - cur_names)

    if prev is None or base is None:
        dispatch = bool((cur.get('pdf') or {}).get('count') or 0)
    else:
        dispatch = cur.get('pdf', {}).get('fingerprint') != base

    store = cur
    store['pdf']['synced_fingerprint'] = store['pdf'].get('fingerprint') if dispatch else base
    return {'dispatch': dispatch, 'added': added, 'removed': removed, 'store': store}


def _variable_name(domain):
    return 'DRIVE_STATUS_' + re.sub(r'[^A-Z0-9]+', '_', str(domain or '').upper())


def run(domains_dir, fetch_html=None, read_var=None, write_var=None):
    """Check every domain's Drive folder, write the stored status, and report
    the domains whose PDF set changed. Returns a list of
    ``{domain, pages:'new-paper', added, removed}``."""
    fetch_html = fetch_html or fmp._drive_fetch_html
    domains_dir = Path(domains_dir)
    changes = []
    for yaml_path in sorted(domains_dir.glob('*.yaml')):
        cfg = (yaml.safe_load(yaml_path.read_text()) if yaml else None) or {}
        slug = cfg.get('domain') or yaml_path.stem

        cur = build_status(cfg, fetch_html=fetch_html)
        if cur is None:
            print(f'{slug}: no Drive folder configured; skipping')
            continue

        var_name = _variable_name(slug)
        prev_raw = read_var(var_name) if read_var else None
        prev = None
        if prev_raw:
            try:
                prev = json.loads(prev_raw)
            except (TypeError, ValueError):
                prev = None

        p = plan(prev, cur)
        if write_var:
            write_var(var_name, json.dumps(p['store']))

        if p['dispatch']:
            changes.append({'domain': slug, 'pages': 'new-paper', 'added': p['added'], 'removed': p['removed']})
            print(f"{slug}: PDF set changed (+{len(p['added'])}/-{len(p['removed'])}) -> dispatch new-paper")
        else:
            pdf = cur.get('pdf') or {}
            print(f"{slug}: no PDF change ({pdf.get('status')}, {pdf.get('count')} files)")
    return changes


def _gh_headers(token):
    return {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'}


def _make_read_var(owner, repo, token):
    def read_var(name):
        url = f'https://api.github.com/repos/{owner}/{repo}/actions/variables/{name}'
        req = urllib.request.Request(url, headers=_gh_headers(token))
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                return data.get('value')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise
    return read_var


def _make_write_var(owner, repo, token):
    def write_var(name, value):
        base = f'https://api.github.com/repos/{owner}/{repo}/actions/variables'
        headers = _gh_headers(token)
        exists = True
        try:
            urllib.request.urlopen(urllib.request.Request(f'{base}/{name}', headers=headers), timeout=30)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            exists = False
        body = json.dumps({'name': name, 'value': value}).encode()
        if exists:
            req = urllib.request.Request(f'{base}/{name}', data=body, headers=headers, method='PATCH')
        else:
            req = urllib.request.Request(base, data=body, headers=headers, method='POST')
        urllib.request.urlopen(req, timeout=30)
    return write_var


def main():
    """GH_PAT + GITHUB_REPOSITORY from env. Without GH_PAT, we can't read or
    write DRIVE_STATUS_* variables (no way to compare against last night), so
    print a warning and dispatch nothing. Always appends
    ``pdf_changed=<json>`` to $GITHUB_OUTPUT (``[]`` when there's nothing to
    report) and never exits non-zero — a Drive hiccup must not fail the
    nightly sheet-poll job."""
    gh_pat = os.environ.get('GH_PAT', '').strip()
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    changes = []
    try:
        if not gh_pat:
            print('WARNING: GH_PAT not set — cannot read/write DRIVE_STATUS_* variables; skipping Drive PDF check.')
        else:
            owner, _, repo = repository.partition('/')
            if not owner or not repo:
                print(f'WARNING: GITHUB_REPOSITORY not set or malformed ({repository!r}); skipping Drive PDF check.')
            else:
                domains_dir = fmp.REPO_ROOT / 'domains'
                changes = run(domains_dir,
                              read_var=_make_read_var(owner, repo, gh_pat),
                              write_var=_make_write_var(owner, repo, gh_pat))
    except Exception as e:  # never fail the nightly job over a Drive hiccup
        print(f'WARNING: drive_sync failed non-fatally: {e}')
        changes = []

    gh_output = os.environ.get('GITHUB_OUTPUT')
    if gh_output:
        with open(gh_output, 'a') as fh:
            fh.write(f'pdf_changed={json.dumps(changes)}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
