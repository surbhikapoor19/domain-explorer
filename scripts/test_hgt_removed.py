"""HGT is fully removed and CI deps are pinned — AUTHORED BY ORCHESTRATOR.

Context: the Sep-3 build failed installing torch-scatter/torch-sparse from
data.pyg.org (DNS down -> source build -> "No module named 'torch'"). Those PyG
deps exist ONLY for the HGT graph-training pipeline, which is no longer used. This
removes HGT entirely (package + wrappers + the step + the dead KG-inference block +
the fragile PyG install) and pins the remaining CI deps so a surprise upstream
release can't break the build again. File-existence + source-text checks so no
heavy deps are needed. Implementers must NOT modify this file.
"""
import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Everything that existed only to serve HGT / PyG graph training.
DELETED = [
    'hgt/__init__.py', 'hgt/run.py', 'hgt/train.py', 'hgt/model.py', 'hgt/schema.py',
    'hgt/predict.py', 'hgt/evaluate.py', 'hgt/config.py', 'hgt/augment.py',
    'backend/rag/graph_schema.py', 'backend/rag/graph_model.py',
    'backend/rag/graph_predictor.py', 'backend/rag/graph_train.py',
    'backend/rag/specter2_embed.py', 'backend/rag/scicite_kg_integrator.py',
    'backend/rebuild_kg.py',
]

# Source trees whose .py files must no longer reference HGT.
SRC_DIRS = ['scripts', 'backend/rag']

HGT_IMPORT_RE = re.compile(
    r'\b(import\s+hgt|from\s+hgt|from\s+\.?graph_(schema|model|predictor|train)|'
    r'import\s+graph_(schema|model|predictor|train)|specter2_embed|scicite_kg_integrator)\b')


def _pyfiles(d):
    root = os.path.join(REPO, d)
    for dp, _, fns in os.walk(root):
        if 'venv' in dp or 'node_modules' in dp or '__pycache__' in dp:
            continue
        for fn in fns:
            if fn.endswith('.py'):
                yield os.path.join(dp, fn)


class HgtFilesDeleted(unittest.TestCase):
    def test_hgt_package_and_helpers_deleted(self):
        still = [p for p in DELETED if os.path.exists(os.path.join(REPO, p))]
        self.assertFalse(still, f"these HGT-only files must be deleted: {still}")

    def test_hgt_dir_gone(self):
        self.assertFalse(os.path.isdir(os.path.join(REPO, 'hgt')),
                         "the hgt/ package directory must be removed")


class NoLingeringHgtImports(unittest.TestCase):
    def test_no_source_imports_hgt(self):
        offenders = []
        for d in SRC_DIRS:
            for p in _pyfiles(d):
                if p.endswith('test_hgt_removed.py'):
                    continue
                if HGT_IMPORT_RE.search(open(p, encoding='utf-8').read()):
                    offenders.append(os.path.relpath(p, REPO))
        self.assertFalse(offenders, f"these files still import HGT modules: {offenders}")


class IngestDomainHasNoHgtStep(unittest.TestCase):
    def setUp(self):
        import sys
        sys.path.insert(0, os.path.join(REPO, 'scripts'))
        import ingest_domain
        self.ing = ingest_domain

    def test_all_steps_has_no_hgt(self):
        self.assertNotIn('hgt', self.ing.ALL_STEPS)
        self.assertEqual(self.ing.ALL_STEPS, ['grobid', 'rag', 'kg', 'precompute', 'benchmark'])

    def test_no_step_hgt_function(self):
        self.assertFalse(hasattr(self.ing, 'step_hgt'), "step_hgt must be removed")


class KnowledgeGraphHgtBlockRemoved(unittest.TestCase):
    def test_no_hgt_text_in_knowledge_graph(self):
        src = open(os.path.join(REPO, 'backend/rag/knowledge_graph.py'), encoding='utf-8').read()
        self.assertNotIn('hgt', src.lower(),
                         "the dead HGT link-prediction block must be removed from knowledge_graph.py")


class DepsPinned(unittest.TestCase):
    REQ = os.path.join(REPO, 'requirements-ci.txt')

    def test_requirements_file_exists(self):
        self.assertTrue(os.path.exists(self.REQ), "requirements-ci.txt (pinned CI deps) must exist")

    def test_core_deps_are_pinned(self):
        body = open(self.REQ, encoding='utf-8').read()
        for pkg in ('pandas', 'scikit-learn', 'sentence-transformers', 'numpy',
                    'chromadb', 'hdbscan', 'umap-learn'):
            self.assertRegex(body, rf'(?mi)^{re.escape(pkg)}==\d',
                             f"{pkg} must be pinned with == in requirements-ci.txt")

    def test_no_pyg_in_requirements(self):
        body = open(self.REQ, encoding='utf-8').read().lower()
        for bad in ('torch-geometric', 'torch-scatter', 'torch-sparse', 'data.pyg.org'):
            self.assertNotIn(bad, body, f"{bad} must not be in requirements (HGT removed)")


if __name__ == '__main__':
    unittest.main()
