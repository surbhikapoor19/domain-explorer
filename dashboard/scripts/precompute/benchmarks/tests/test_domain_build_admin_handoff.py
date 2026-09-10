"""domain-build.yml admin-handoff pins — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.
Raw-text assertions (no PyYAML dependency).
"""
import re
from pathlib import Path

YML = Path(__file__).resolve().parents[5] / '.github' / 'workflows' / 'domain-build.yml'


def _text():
    return YML.read_text()


def test_run_name_identifies_domain_and_scope():
    t = _text()
    m = re.search(r'^run-name:\s*(.+)$', t, re.M)
    assert m, 'top-level run-name: missing (the admin Activity feed parses it)'
    line = m.group(1)
    assert 'client_payload.domain' in line
    assert 'client_payload.pages' in line
    assert "'all'" in line                      # default scope label when pages is omitted
    assert 'Build {0} ({1}' in line             # parsed by api/admin/build-status.js
    assert 'Switch domain: {0}' in line         # domain-switch runs are labelled too
    assert 'forced' in line


def test_unzip_accepts_any_zip_layout():
    t = _text()
    i = t.index('name: Unzip PDFs if needed')
    step = t[i:t.index('- name:', i + 10)]
    assert "-iname '*.pdf'" in step or '-iname "*.pdf"' in step   # PDFs found at any depth
    assert '__MACOSX' in step                                     # macOS junk ignored
    assert 'mkdir -p "datasets/${SLUG}/papers"' in step
