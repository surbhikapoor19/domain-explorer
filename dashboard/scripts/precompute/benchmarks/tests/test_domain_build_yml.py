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
