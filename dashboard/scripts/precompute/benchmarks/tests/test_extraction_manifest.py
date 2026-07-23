"""Pure-logic tests for the Docling-decision AUDIT MANIFEST row assembly.

Network-free and I/O-free: exercises build_manifest_rows only (no PDFs, no Docling,
no cache files). Given run_docling's per-paper decisions
``{paper_id: (status, pdf_sha256, n_records)}`` and a pdf-sources provenance map, the
produced rows must carry the correct source_ref (fetched provenance source vs the
'committed' default), the 12-char short hash, and the status.
"""
from benchmarks.extraction.run_extraction import build_manifest_rows


def test_fetched_source_vs_committed_default():
    decisions = {
        "anygrasp": ("extracted", "a" * 64, 12),   # fetched + re-run through Docling
        "gpd": ("cached", "b" * 64, 0),             # committed in-repo, served from cache
    }
    pdf_sources = {
        "anygrasp": {"source": "arxiv:2507.18847",
                     "url": "https://arxiv.org/pdf/2507.18847.pdf",
                     "resolved_via": "arxiv", "similarity": 0.97},
    }
    rows = build_manifest_rows(decisions, pdf_sources)
    by = {r["paper_id"]: r for r in rows}

    # Fetched paper -> provenance source, extracted, full + 12-char short hash.
    assert by["anygrasp"]["source_ref"] == "arxiv:2507.18847"
    assert by["anygrasp"]["status"] == "extracted"
    assert by["anygrasp"]["pdf_sha256"] == "a" * 64
    assert by["anygrasp"]["pdf_sha256_short"] == "a" * 12
    assert by["anygrasp"]["n_records"] == 12

    # Not-fetched paper -> 'committed'; a [] record count is a valid cached hit.
    assert by["gpd"]["source_ref"] == "committed"
    assert by["gpd"]["status"] == "cached"
    assert by["gpd"]["pdf_sha256_short"] == "b" * 12
    assert by["gpd"]["n_records"] == 0


def test_rows_sorted_and_all_committed_when_no_provenance():
    decisions = {
        "zeta": ("extracted", "c" * 64, 1),
        "alpha": ("cached", "d" * 64, 2),
    }
    rows = build_manifest_rows(decisions, {})
    assert [r["paper_id"] for r in rows] == ["alpha", "zeta"]   # stable, sorted
    assert all(r["source_ref"] == "committed" for r in rows)    # empty map -> committed


def test_bare_string_provenance_and_none_map_and_empty():
    # A bare string provenance value is accepted (used verbatim as the source_ref).
    rows = build_manifest_rows({"p1": ("extracted", "e" * 64, 3)},
                               {"p1": "openalex"})
    assert rows[0]["source_ref"] == "openalex"
    # None provenance map -> every paper 'committed'; empty decisions -> no rows.
    assert build_manifest_rows({"p2": ("cached", "f" * 64, 0)}, None)[0]["source_ref"] == "committed"
    assert build_manifest_rows({}, {}) == []
