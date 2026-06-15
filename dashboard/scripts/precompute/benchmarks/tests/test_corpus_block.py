"""Both domain configs must carry a corpus block — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

The benchmark step resolves PDFs + methods CSV per domain; for local runs it reads cfg['corpus'].
Both grasp and motion must expose corpus.pdf_dir + corpus.methods_csv so the pipeline is uniform
and domain-agnostic (CI overrides these with repo-relative paths, but the keys must exist).
"""
import os
import json
import pytest

CFG_DIR = os.path.join(os.path.dirname(__file__), '..', 'config')


@pytest.mark.parametrize('domain', ['grasp_planning', 'motion_planning'])
def test_config_has_corpus_with_pdf_dir_and_methods_csv(domain):
    cfg = json.load(open(os.path.join(CFG_DIR, f'{domain}.json')))
    corpus = cfg.get('corpus')
    assert isinstance(corpus, dict), f"{domain} must have a corpus block"
    assert corpus.get('pdf_dir'), f"{domain} corpus.pdf_dir must be non-empty"
    assert corpus.get('methods_csv'), f"{domain} corpus.methods_csv must be non-empty"
    # tei_dir key present (may be empty for domains without GROBID TEI, e.g. motion)
    assert 'tei_dir' in corpus, f"{domain} corpus must declare a tei_dir key"
