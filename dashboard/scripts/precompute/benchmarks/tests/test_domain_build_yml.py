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
    assert 'STEPS="grobid,rag,kg,hgt,precompute"' in t
    assert 'grobid,rag,kg,hgt,precompute,benchmark' not in t
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
    # order is grobid,rag,kg,hgt,precompute,benchmark.
    t = _text()
    assert 'STEPS="grobid,rag,kg,hgt,precompute"' in t          # base steps unchanged
    assert 'elif [ "$PAGES" = "new-paper" ]; then' in t         # new-paper branch present
    assert 'STEPS="${STEPS},benchmark"' in t                    # benchmark appended last


def test_new_paper_forbidden_joined_literal_still_absent():
    # W2: the joined literal must NEVER appear (constructed via ${STEPS},benchmark).
    assert 'grobid,rag,kg,hgt,precompute,benchmark' not in _text()


def test_docling_installed_for_benchmark_and_new_paper():
    # W3: Docling (heavy install + model cache) is gated to pages in {benchmark, new-paper}.
    t = _text()
    assert "github.event.client_payload.pages == 'benchmark'" in t
    assert "github.event.client_payload.pages == 'new-paper'" in t
