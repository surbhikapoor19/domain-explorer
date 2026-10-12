"""Pre-handoff hardening — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

Three independent defects found while preparing the handoff to the incoming
maintainer. Each class below pins one of them.

1. TEI was never actually committed. `.gitignore` carries `datasets/*/tei/`, and
   domain-build.yml staged it with a plain `git add` (no `-f`), so the add was a
   SILENT no-op — git ignores the pathspec and `|| true` swallows the warning.
   Consequence: the parsed corpus survived only in the `actions/cache` entry,
   which GitHub evicts after 7 days unused, so every cold build re-ran GROBID
   over every PDF (~139 min of a 208 min grasp build). ~6 MB of XML fixes it.
   The functional test here reproduces the exact no-op, so a future plain
   `git add` cannot regress it.

2. PDFs were one CLI invocation away from being published. `.vercelignore` told
   the next maintainer, in a comment, NOT to ignore `public/papers`, while the
   precompute step copied every PDF into that directory — so a local
   `vercel --prod` would have uploaded the whole corpus as public static assets.
   The viewer that consumed them never worked in production anyway (the SPA
   rewrite answers `/papers/<id>.pdf` with `text/html`), so the affordance goes
   and the directory becomes unpublishable.

3. The manual documented a subsystem that no longer exists. HGT / link
   prediction was removed (see test_hgt_removed.py), but dashboard-manual.html
   still described it as a live pipeline stage, a feature, a tech-stack row and
   three glossary entries. The incoming maintainer reads this file to build a
   domain, so it has to match the shipped pipeline.
"""
import importlib.util
import os
import re
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YML = os.path.join(REPO, '.github', 'workflows', 'domain-build.yml')
GITIGNORE = os.path.join(REPO, '.gitignore')
VERCELIGNORE = os.path.join(REPO, 'dashboard', '.vercelignore')
MANUAL = os.path.join(REPO, 'docs', 'dashboard-manual.html')
SERVED_MANUAL = os.path.join(REPO, 'dashboard', 'public', 'dashboard-manual.html')
WALKTHROUGH = os.path.join(REPO, 'dashboard', 'public', 'benchmark-walkthrough.html')
PAPERS_PY = os.path.join(REPO, 'dashboard', 'scripts', 'precompute', 'rag', 'papers.py')
SRC = os.path.join(REPO, 'dashboard', 'src')


def _read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def _git(args, cwd):
    return subprocess.run(['git'] + args, cwd=cwd, capture_output=True, text=True)


def _tei_add_line():
    """The single line in domain-build.yml that stages the TEI directory."""
    for raw in _read(YML).splitlines():
        s = raw.strip()
        if s.startswith('git add') and '/tei' in s:
            return s
    return None


def _src_files():
    for dp, dns, fns in os.walk(SRC):
        dns[:] = [d for d in dns if d not in ('node_modules', '__snapshots__')]
        for fn in fns:
            if fn.endswith(('.js', '.jsx')):
                yield os.path.join(dp, fn)


class TeiIsCommitted(unittest.TestCase):
    def test_tei_is_staged_at_all(self):
        self.assertIsNotNone(
            _tei_add_line(),
            "domain-build.yml must stage datasets/<slug>/tei/ in 'Commit results'")

    def test_tei_add_is_forced(self):
        line = _tei_add_line()
        self.assertRegex(
            line, r'^git add\s+-f\b',
            "the TEI add must use -f; .gitignore has datasets/*/tei/ so a plain "
            "`git add` is a silent no-op")

    def test_one_pathspec_per_git_add(self):
        # `git add A B` stages NOTHING when any pathspec matches no file. Every add
        # in this workflow therefore carries exactly one pathspec.
        line = re.sub(r'2>/dev/null.*$', '', _tei_add_line()).strip()
        paths = [t for t in line.split()[2:] if not t.startswith('-')]
        self.assertEqual(len(paths), 1, f"expected exactly one pathspec, got {paths}")

    def test_gitignore_still_ignores_tei_locally(self):
        # Local tei/ stays ignored (it is regenerated); only CI force-adds it. If this
        # line were deleted instead, every dev machine would show tei/ as untracked.
        self.assertIn('datasets/*/tei/', _read(GITIGNORE))

    def test_source_of_truth_checkout_does_not_reset_tei(self):
        # The "Keep git as source-of-truth" step resets TRACKED files to HEAD so a
        # restored cache cannot supply a stale committed JSON. TEI must stay out of
        # it: the cache legitimately holds NEWER TEI than HEAD, and resetting would
        # discard exactly the work this fix is meant to preserve.
        for raw in _read(YML).splitlines():
            s = raw.strip()
            if s.startswith('git checkout --') and '/tei' in s:
                self.fail(f"must not reset TEI to HEAD: {s}")

    def test_tei_actually_stages_under_the_real_gitignore(self):
        """Functional reproduction of the original silent no-op."""
        line = _tei_add_line()
        cmd = re.sub(r'2>/dev/null.*$', '', line).strip().replace('${SLUG}', 'foo')
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(_git(['init', '-q'], d).returncode, 0)
            _git(['config', 'user.email', 't@t.test'], d)
            _git(['config', 'user.name', 'test'], d)
            with open(os.path.join(d, '.gitignore'), 'w', encoding='utf-8') as f:
                f.write(_read(GITIGNORE))
            tei = os.path.join(d, 'datasets', 'foo', 'tei')
            os.makedirs(tei)
            with open(os.path.join(tei, 'x.tei.xml'), 'w', encoding='utf-8') as f:
                f.write('<TEI/>')
            r = subprocess.run(cmd, shell=True, cwd=d, capture_output=True, text=True)
            staged = _git(['diff', '--cached', '--name-only'], d).stdout
            self.assertIn(
                'datasets/foo/tei/x.tei.xml', staged,
                f"`{cmd}` staged nothing — TEI is still being silently dropped "
                f"(stderr: {r.stderr.strip()})")


class NoPdfsPublished(unittest.TestCase):
    def test_vercelignore_ignores_public_papers(self):
        body = _read(VERCELIGNORE)
        lines = [l.strip() for l in body.splitlines()
                 if l.strip() and not l.strip().startswith('#')]
        self.assertTrue(
            any(re.fullmatch(r'/?public/papers/?\*?', l) for l in lines),
            f"dashboard/.vercelignore must ignore public/papers so a local "
            f"`vercel --prod` can never publish the PDF corpus; rules: {lines}")

    def test_vercelignore_still_ships_public_data(self):
        # public/data-* IS the app's payload — ignoring it ships empty panels.
        lines = [l.strip() for l in _read(VERCELIGNORE).splitlines()
                 if l.strip() and not l.strip().startswith('#')]
        for l in lines:
            self.assertFalse(
                re.match(r'/?public/data', l),
                f"must NOT ignore public/data — that is the app's data payload: {l}")

    def test_vercelignore_no_longer_instructs_publishing_papers(self):
        body = _read(VERCELIGNORE).lower()
        self.assertNotIn(
            'do not ignore /public/data or /public/papers', body,
            "the comment telling the next maintainer to publish /public/papers must go")

    def test_export_papers_does_not_copy_pdfs(self):
        spec = importlib.util.spec_from_file_location('_papers_mod', PAPERS_PY)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, 'papers')
            out = os.path.join(d, 'out')
            dest = os.path.join(d, 'public_papers')
            os.makedirs(src)
            os.makedirs(out)
            with open(os.path.join(src, 'a.pdf'), 'wb') as f:
                f.write(b'%PDF-1.4 fake')
            # The destination parameter may legitimately be dropped once nothing is
            # copied, so adapt to whichever signature survives rather than forcing a
            # dead argument to stay.
            import inspect
            nargs = len([p for p in inspect.signature(mod.export_papers).parameters.values()
                         if p.default is inspect.Parameter.empty
                         and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)])
            mod.export_papers(*( (src, out, dest)[:nargs] ))
            self.assertTrue(
                os.path.exists(os.path.join(out, 'papers-index.json')),
                "papers-index.json must still be written")
            leaked = []
            for dp, _, fns in os.walk(dest):
                leaked += [f for f in fns if f.lower().endswith('.pdf')]
            self.assertFalse(
                leaked, f"export_papers must not copy PDFs into the web root: {leaked}")

    def test_no_remaining_pdf_copy_into_the_web_root(self):
        # The modern precompute path stopped copying, but dashboard/deploy.sh falls
        # back to the legacy dashboard/scripts/precompute.py, which copied every PDF
        # into dashboard/public/papers/ with shutil.copy2. .vercelignore now blocks
        # publication either way, but no build path may still stage PDFs in the web root.
        legacy = os.path.join(REPO, 'dashboard', 'scripts', 'precompute.py')
        if not os.path.exists(legacy):
            self.skipTest('legacy precompute.py no longer present')
        body = _read(legacy)
        self.assertFalse(
            re.search(r'shutil\.copy\w*\s*\([^)]*papers', body),
            "the legacy precompute path must not copy PDFs into dashboard/public/papers/")
        self.assertNotIn(
            "dashboard/public/papers/", body,
            "the legacy precompute docstring must stop advertising a PDF copy")

    def test_pdfviewer_component_deleted(self):
        self.assertFalse(
            os.path.exists(os.path.join(SRC, 'components', 'PdfViewer.js')),
            "PdfViewer.js must be deleted — it fetched /papers/<id>.pdf, which "
            "production answers with the SPA's HTML")

    def test_no_frontend_references_to_pdfviewer_or_pdf_urls(self):
        offenders = []
        for p in _src_files():
            body = _read(p)
            rel = os.path.relpath(p, REPO)
            if 'PdfViewer' in body:
                offenders.append(f'{rel} (PdfViewer)')
            # Only a WEB path counts: `/papers/...` opening a string literal. The admin
            # components legitimately describe the repo layout as
            # `datasets/<slug>/papers/`, which is not a fetchable URL.
            if re.search(r'''["'`]/papers/''', body):
                offenders.append(f'{rel} (/papers/ url)')
            if 'View PDF' in body:
                offenders.append(f'{rel} (View PDF button)')
        self.assertFalse(offenders, f"dead PDF-viewer code still present: {offenders}")


class ManualMatchesShippedPipeline(unittest.TestCase):
    # Everything removed with HGT. Each is a plain substring, matched case-insensitively,
    # except PyG which needs word boundaries.
    REMOVED = [
        'link prediction', 'link-prediction', 'predicted relationship',
        'predicted relationships', 'hgt', 'heterogeneous graph transformer',
        'graphsage', 'distmult', 'pytorch geometric', 'to_hetero',
        'torch-geometric', 'graph neural network',
    ]

    # Live surfaces the manual must still document — guards against over-deletion.
    # (Contradiction detection is deliberately absent: the manual has never covered
    # it, so it is a documentation gap, not something this pass may regress.)
    MUST_KEEP = [
        'knowledge graph', 'benchmark', 'copilot',
        'GROBID', 'RAG', 'precompute', 'Drive', 'Admin',
    ]

    def test_no_removed_feature_terms(self):
        body = _read(MANUAL).lower()
        hits = {t: body.count(t) for t in self.REMOVED if t in body}
        self.assertFalse(
            hits,
            f"dashboard-manual.html still documents the removed HGT/link-prediction "
            f"subsystem: {hits}")

    def test_no_bare_pyg_reference(self):
        self.assertIsNone(
            re.search(r'\bPyG\b', _read(MANUAL)),
            "the PyG glossary entry/references must be removed")

    def test_build_chain_strings_are_accurate(self):
        # Every arrow-chain describing the pipeline must name only shipped steps.
        body = _read(MANUAL)
        chains = re.findall(r'[^<>()]{0,80}(?:&rarr;|→)[^<>()]{0,120}', body)
        bad = [c.strip() for c in chains if re.search(r'link.?prediction|graph ml', c, re.I)]
        self.assertFalse(bad, f"these pipeline chains name removed steps: {bad}")

    def test_pipeline_sections_are_contiguously_numbered(self):
        # Deleting "4 · Graph link prediction" must renumber what follows, so the
        # architecture walkthrough doesn't jump 3 → 5.
        body = _read(MANUAL)
        nums = [int(n) for n in re.findall(r'(\d+)\s*·\s*(?:Extract|RAG|Knowledge graph|'
                                           r'Graph|Precompute|Benchmark)', body)]
        self.assertTrue(nums, "could not find the numbered pipeline sections")
        self.assertEqual(
            nums, list(range(1, len(nums) + 1)),
            f"pipeline step numbers must run 1..N with no gaps, got {nums}")

    def test_still_documents_live_surfaces(self):
        body = _read(MANUAL).lower()
        missing = [t for t in self.MUST_KEEP if t.lower() not in body]
        self.assertFalse(
            missing, f"the manual must still document these live features: {missing}")

    def test_served_manual_matches_the_docs_copy(self):
        """The copy the app actually serves must not drift from docs/.

        ManualButton.js opens /dashboard-manual.html, which is served from
        dashboard/public/ — and its comment claims the file is "copied from
        docs/dashboard-manual.html at build time". No such build step exists; the two
        are hand-synced, so editing only docs/ leaves the maintainer reading the stale
        one. Byte-equality is the cheapest way to make that drift impossible.
        """
        self.assertEqual(
            _read(SERVED_MANUAL), _read(MANUAL),
            "dashboard/public/dashboard-manual.html must be byte-identical to "
            "docs/dashboard-manual.html — the served copy is what the maintainer reads")

    def test_other_served_docs_have_no_removed_features(self):
        body = _read(WALKTHROUGH).lower()
        hits = {t: body.count(t) for t in ('hgt', 'predicted (hgt)', 'predicted link')
                if t in body}
        self.assertFalse(
            hits,
            f"dashboard/public/benchmark-walkthrough.html is a served page and still "
            f"describes the removed link-prediction feature: {hits}")


if __name__ == '__main__':
    unittest.main()
