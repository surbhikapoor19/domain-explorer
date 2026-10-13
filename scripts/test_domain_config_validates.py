"""Every shipped domain YAML must actually load — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify.  Run:  python -m unittest scripts/test_domain_config_validates.py

Found while adding the per-row paper-link source: `domains/hardware_designs.yaml`
(written by the admin wizard) and `domains/motion_planning.yaml` BOTH failed
`backend/rag/role_schema.load_domain_config`, whose own error text instructs you to
add the role to ROLE_VOCABULARY.

Scope, measured rather than assumed: that validator is NOT on the build path today.
Its only consumer is `dashboard/scripts/precompute/shared/domain.py`, which calls it at
module scope with no try/except — and nothing imports that module. The build actually
loads domains through `shared/config.py:DomainConfig.from_yaml`, which `yaml.safe_load`s
and reads keys directly, validating nothing. So these two YAMLs built fine, and an
unknown role or a typo'd role is silently ignored at build time instead of reported.

That makes the failures below latent rather than fatal: harmless while the validator is
unused, and a build-stopper the moment anyone wires it in — `shared/domain.py` would
raise at import, i.e. after GROBID/RAG/KG have already run. Wiring the validator into
`from_yaml` is the real fix and is deliberately NOT attempted here; these tests keep the
schema honest in the meantime, so the two lists can't drift further apart.

Two distinct root causes, both guarded below:

  1. **Vocabulary drift.** `method.middleware` and `method.ik_controller` are offered by
     the wizard's mapper (`propose-yaml.js`), listed in the admin role dropdown
     (`ConfigEditor.js`) and consumed by precompute — but were absent from
     `ROLE_VOCABULARY`, the thing that validates them. Any domain using them was
     unbuildable. The three lists must agree.

  2. **The wizard emits `llm.domain_subject: ""`** when the model has nothing to put
     there, and the validator rejected an empty string. An optional field left blank
     must behave as absent, not as a build-stopping error.
"""
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOMAINS = REPO / 'domains'
PRECOMPUTE = REPO / 'dashboard' / 'scripts' / 'precompute'
PROPOSE = REPO / 'dashboard' / 'api' / 'admin' / 'propose-yaml.js'
CONFIG_EDITOR = REPO / 'dashboard' / 'src' / 'components' / 'admin' / 'ConfigEditor.js'


def _vocabulary():
    sys.path.insert(0, str(REPO / 'backend'))
    from rag.role_schema import ROLE_VOCABULARY
    return set(ROLE_VOCABULARY)


def _roles_in(text):
    """Every `namespace.role` token that looks like a role string."""
    return set(re.findall(r"\b(identity|method|input|output|train|eval|hardware|env|meta)"
                          r"\.([a-z_]+)\b", text)) if text else set()


def _role_strings(text):
    return {f'{a}.{b}' for a, b in _roles_in(text)}


class EveryDomainYamlLoads(unittest.TestCase):
    """Every shipped domain must satisfy the declared validator.

    Not currently what the build runs — see the module docstring. This is the contract
    the schema advertises, and the one that bites if it is ever enforced.
    """

    def test_domains_dir_exists(self):
        self.assertTrue(DOMAINS.is_dir(), f'{DOMAINS} must exist')
        self.assertTrue(list(DOMAINS.glob('*.yaml')), 'no domain YAMLs found')

    def test_each_domain_passes_the_declared_validator(self):
        # shared.domain caches active_domain at import time, so each domain needs its
        # own interpreter. This is the import that would run if the validator were
        # wired into the build; today it is the cheapest way to exercise it per domain.
        broken = {}
        for yml in sorted(DOMAINS.glob('*.yaml')):
            rel = f'domains/{yml.name}'
            env = dict(os.environ, DOMAIN_CONFIG=rel)
            r = subprocess.run(
                [sys.executable, '-c',
                 'import shared.domain as s; print(s.active_domain.domain)'],
                cwd=str(PRECOMPUTE), env=env, capture_output=True, text=True)
            if r.returncode != 0:
                last = [l for l in r.stderr.strip().splitlines() if l.strip()]
                broken[yml.name] = last[-1][:200] if last else 'unknown error'
        self.assertFalse(
            broken,
            'these domain YAMLs fail the declared role_schema validator — harmless '
            'only while nothing enforces it, and an import-time crash for anyone who '
            'wires it in:\n' +
            '\n'.join(f'  {k}: {v}' for k, v in broken.items()))


class VocabularyCoversWhatTheUiOffers(unittest.TestCase):
    """A role the admin UI can assign but the validator rejects is a build trap."""

    def test_wizard_roles_are_all_in_the_vocabulary(self):
        offered = _role_strings(PROPOSE.read_text(encoding='utf-8'))
        missing = sorted(offered - _vocabulary())
        self.assertFalse(
            missing,
            f'propose-yaml.js offers roles the validator will reject: {missing}')

    def test_admin_dropdown_roles_are_all_in_the_vocabulary(self):
        offered = _role_strings(CONFIG_EDITOR.read_text(encoding='utf-8'))
        missing = sorted(offered - _vocabulary())
        self.assertFalse(
            missing,
            f'ConfigEditor.js lets a maintainer pick roles the validator rejects: '
            f'{missing}')

    def test_paper_url_role_is_offered_by_both_surfaces(self):
        # The new per-row link role is useless if the UI can't assign it.
        for path in (PROPOSE, CONFIG_EDITOR):
            with self.subTest(file=path.name):
                self.assertIn('identity.paper_url', path.read_text(encoding='utf-8'))

    def test_roles_used_by_shipped_domains_are_in_the_vocabulary(self):
        vocab = _vocabulary()
        bad = {}
        for yml in sorted(DOMAINS.glob('*.yaml')):
            used = set()
            for line in yml.read_text(encoding='utf-8').splitlines():
                m = re.search(r'\brole:\s*["\']?([a-z]+\.[a-z_]+)', line)
                if m:
                    used.add(m.group(1))
            unknown = sorted(used - vocab)
            if unknown:
                bad[yml.name] = unknown
        self.assertFalse(bad, f'domains reference unknown roles: {bad}')


class OptionalLlmFieldsMayBeBlank(unittest.TestCase):
    """The wizard writes `domain_subject: ""` when it has nothing to say."""

    def _load(self, yaml_text):
        sys.path.insert(0, str(REPO / 'backend'))
        from rag.role_schema import load_domain_config
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'x.yaml'
            p.write_text(yaml_text, encoding='utf-8')
            return load_domain_config(str(p), repo_root=str(REPO))

    BASE = (
        'domain: t\n'
        'display_name: "T"\n'
        'display_subject: "things"\n'
        'csv_path: datasets/t/t.csv\n'
        'papers_dir: datasets/t/papers/\n'
        'columns:\n'
        '  Name: { role: identity.name, facet: identifier }\n'
        '  Year: { role: identity.year, facet: numeric }\n'
    )

    def test_empty_domain_subject_is_accepted(self):
        cfg = self._load(self.BASE + 'llm:\n  domain_subject: ""\n')
        self.assertTrue(cfg.domain, 'an empty optional llm field must not fail the build')

    def test_whitespace_domain_subject_is_accepted(self):
        cfg = self._load(self.BASE + 'llm:\n  domain_subject: "   "\n')
        self.assertTrue(cfg.domain)

    def test_populated_domain_subject_still_works(self):
        cfg = self._load(self.BASE + 'llm:\n  domain_subject: "robot grasping"\n')
        self.assertTrue(cfg.domain)

    def test_a_genuinely_bad_llm_block_is_still_rejected(self):
        # Tolerating blank must not become tolerating anything.
        sys.path.insert(0, str(REPO / 'backend'))
        from rag.role_schema import ConfigError
        with self.assertRaises(ConfigError):
            self._load(self.BASE + 'llm: "not a mapping"\n')


if __name__ == '__main__':
    unittest.main()
