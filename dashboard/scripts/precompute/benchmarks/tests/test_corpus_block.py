"""Both domain configs must carry a corpus block — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

The benchmark step resolves PDFs + methods CSV per domain; for local runs it reads cfg['corpus'].
Both grasp and motion must expose corpus.pdf_dir + corpus.methods_csv so the pipeline is uniform
and domain-agnostic (CI overrides these with repo-relative paths, but the keys must exist).
"""
import os
import re
import json
import pytest

CFG_DIR = os.path.join(os.path.dirname(__file__), '..', 'config')
# tests -> benchmarks -> precompute -> scripts -> dashboard -> REPO
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), *(['..'] * 5)))


def _yaml_csv_path(domain_us):
    """Minimal parse of `csv_path:` from domains/<domain>.yaml (no PyYAML dep)."""
    path = os.path.join(REPO, 'domains', f'{domain_us}.yaml')
    with open(path) as fh:
        for line in fh:
            m = re.match(r'\s*csv_path:\s*(.+?)\s*$', line)
            if m:
                return m.group(1).strip().strip('"\'')
    return None


@pytest.mark.parametrize('domain', ['grasp_planning', 'motion_planning'])
def test_config_has_corpus_with_pdf_dir_and_methods_csv(domain):
    cfg = json.load(open(os.path.join(CFG_DIR, f'{domain}.json')))
    corpus = cfg.get('corpus')
    assert isinstance(corpus, dict), f"{domain} must have a corpus block"
    assert corpus.get('pdf_dir'), f"{domain} corpus.pdf_dir must be non-empty"
    assert corpus.get('methods_csv'), f"{domain} corpus.methods_csv must be non-empty"
    # tei_dir key present (may be empty for domains without GROBID TEI, e.g. motion)
    assert 'tei_dir' in corpus, f"{domain} corpus must declare a tei_dir key"


@pytest.mark.parametrize('domain', ['grasp_planning', 'motion_planning'])
def test_methods_csv_matches_authoritative_yaml_csv_path(domain):
    """The benchmark step must read the SAME CSV as the rest of the pipeline: the
    domain YAML's ``csv_path``. Regression: grasp's benchmark config pointed at the
    stale ``datasets/grasp-planning/grasp_planning.csv`` (56 rows) while the YAML
    (and precompute) used ``datasets/csv-gp-combined.csv`` (60 rows), so new methods
    were silently absent from the benchmark."""
    cfg = json.load(open(os.path.join(CFG_DIR, f'{domain}.json')))
    methods_csv = cfg['corpus']['methods_csv']
    expected = _yaml_csv_path(domain)
    assert expected, f"{domain}.yaml must declare csv_path"
    assert os.path.basename(methods_csv) == os.path.basename(expected), (
        f"{domain} benchmark methods_csv ({methods_csv!r}) must match the "
        f"authoritative YAML csv_path ({expected!r})")
