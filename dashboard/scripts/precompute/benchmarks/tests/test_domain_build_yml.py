"""domain-build.yml wires the benchmark step (opt-in, Docling) — AUTHORED BY ORCHESTRATOR.
Implementers must NOT modify. Raw-text assertions (no PyYAML dependency) pinning the design decisions.
"""
from pathlib import Path

YML = Path(__file__).resolve().parents[5] / '.github' / 'workflows' / 'domain-build.yml'


def _text():
    return YML.read_text()


def test_yml_exists():
    assert YML.exists(), f"{YML} not found"


def test_benchmark_is_opt_in_not_appended_to_all_default():
    t = _text()
    # the default full-build steps stay exactly as-is (no benchmark) — opt-in only
    assert 'STEPS="grobid,rag,kg,precompute"' in t
    assert 'grobid,rag,kg,precompute,benchmark' not in t
    # pages=benchmark -> benchmark-only run
    assert 'STEPS="benchmark"' in t


def test_docling_installed_only_for_benchmark_builds():
    t = _text()
    assert 'docling' in t  # docling install present
    # gated so normal builds don't pay the heavy install
    assert "github.event.client_payload.pages == 'benchmark'" in t


def test_grobid_skipped_for_benchmark_only_builds():
    t = _text()
    # GROBID (heavy + only needed for TEI) must be skipped for a benchmark-only build
    assert "github.event.client_payload.pages != 'benchmark'" in t


def test_anthropic_key_env_present_for_optional_vlm():
    # the VLM upgrade reads ANTHROPIC_API_KEY (optional secret); must be wired into the env
    assert 'ANTHROPIC_API_KEY' in _text()


# --- 'new-paper' scope (added rows -> full pipeline + benchmark last) ---------

def test_new_paper_scope_appends_benchmark_last_via_var():
    # W1: pages='new-paper' runs the full pipeline THEN benchmark (benchmark last),
    # built as "${STEPS},benchmark" off the unchanged base steps -> the effective
    # order is grobid,rag,kg,precompute,benchmark.
    t = _text()
    assert 'STEPS="grobid,rag,kg,precompute"' in t          # base steps unchanged
    assert 'elif [ "$PAGES" = "new-paper" ]; then' in t         # new-paper branch present
    assert 'STEPS="${STEPS},benchmark"' in t                    # benchmark appended last


def test_new_paper_forbidden_joined_literal_still_absent():
    # W2: the joined literal must NEVER appear (constructed via ${STEPS},benchmark).
    assert 'grobid,rag,kg,precompute,benchmark' not in _text()


def test_docling_installed_for_benchmark_and_new_paper():
    # W3: Docling (heavy install + model cache) is gated to pages in {benchmark, new-paper}.
    t = _text()
    assert "github.event.client_payload.pages == 'benchmark'" in t
    assert "github.event.client_payload.pages == 'new-paper'" in t


# --- LFS bandwidth fix: papers.zip (~349MB grasp + ~56MB motion) must NOT be pulled
#     on every build. checkout lfs:true + a wildcard `git lfs pull datasets/*/papers.zip`
#     fetched ~405MB per run, blowing GitHub's monthly LFS bandwidth quota and eventually
#     failing checkout@v4 itself. Pull LFS explicitly, per-domain, and only for scopes
#     that actually need PDFs (skip the CSV-only precompute/explorer nightly path). ---

# CSV-only scopes need zero PDFs; the PDF steps must be gated off for them.
PDF_GATE = ("github.event.client_payload.pages != 'precompute' && "
            "github.event.client_payload.pages != 'explorer'")


def _step_block(name):
    """The YAML text of step '- name: <name>' up to the next '- name:' (for asserting
    that step's own `if:` gate)."""
    t = _text()
    marker = f'- name: {name}'
    i = t.find(marker)
    assert i != -1, f"step '{name}' not found in domain-build.yml"
    j = t.find('- name:', i + len(marker))
    return t[i:] if j == -1 else t[i:j]


def test_checkout_does_not_bulk_pull_lfs():
    # 'lfs: true' on actions/checkout pulls EVERY LFS object on every build.
    assert 'lfs: true' not in _text()


def test_lfs_pull_is_domain_scoped_not_wildcard():
    t = _text()
    assert 'datasets/*/papers.zip' not in t, "LFS pull must target one domain, not all"
    assert 'git lfs pull --include="datasets/${{ steps.domain.outputs.slug }}/papers.zip"' in t


def test_pdf_steps_skip_csv_only_scopes():
    # Pull LFS + unzip + fetch + re-zip must be gated so a precompute/explorer build
    # pulls ZERO PDFs (the common nightly case) — that's what saves the bandwidth.
    for step in ('Pull LFS files', 'Unzip PDFs if needed',
                 'Fetch missing PDFs (public OA sources)',
                 'Re-zip papers (persist fetched PDFs)'):
        assert PDF_GATE in _step_block(step), \
            f"step '{step}' must be gated with the PDF-scope condition"


def test_git_lfs_skip_smudge_prevents_implicit_fetches():
    # Belt-and-suspenders: even the commit step's `git checkout -- papers.zip` must not
    # smudge-fetch LFS on a CSV-only build. A job-level GIT_LFS_SKIP_SMUDGE guarantees
    # only the explicit gated `git lfs pull` ever fetches.
    assert 'GIT_LFS_SKIP_SMUDGE: 1' in _text()
