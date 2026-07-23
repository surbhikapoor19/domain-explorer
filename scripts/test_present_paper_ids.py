"""Regression test for the present_ids slug/identity fix: a paper is 'present' if it
has a PDF (the canonical paper_id == PDF stem) OR a CSV Name entry, so a Name that
slugifies differently from its PDF stem never wrongly prunes a paper with benchmark
data (the pointnet-plus-gpd vs 'PointNetGPD' drop caught on the first grasp test build)."""
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))
import ingest_domain  # noqa: E402


def test_pdf_stem_kept_when_csv_name_diverges(tmp_path):
    pd = tmp_path / 'papers'
    pd.mkdir()
    (pd / 'pointnet-plus-gpd.pdf').write_bytes(b'%PDF')
    (pd / 'pointnetgpd.pdf').write_bytes(b'%PDF')
    csv = tmp_path / 'm.csv'
    csv.write_text('Name\nPointNetGPD\n')
    ids = ingest_domain._present_paper_ids(str(csv), str(pd))
    # both the divergent-name PDF stem AND the CSV slug are present -> neither pruned
    assert 'pointnet-plus-gpd' in ids
    assert 'pointnetgpd' in ids


def test_csv_names_still_included_without_papers_dir(tmp_path):
    csv = tmp_path / 'm.csv'
    csv.write_text('Name\n\U0001f916 AnyGrasp\n')
    ids = ingest_domain._present_paper_ids(str(csv), None)
    assert 'anygrasp' in ids


def test_csv_failure_does_not_discard_pdf_stems(tmp_path):
    pd = tmp_path / 'papers'
    pd.mkdir()
    (pd / 'catgrasp.pdf').write_bytes(b'%PDF')
    ids = ingest_domain._present_paper_ids(str(tmp_path / 'missing.csv'), str(pd))
    assert 'catgrasp' in ids  # unreadable CSV must not wipe the on-disk stems
