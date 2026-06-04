"""Tests for extraction.run_extraction — AUTHORED BY ORCHESTRATOR. Implementers must NOT modify.

Drives extract_paper fully offline (render/page-find/crop-save/VLM all injected) against the
mini fixture, which has: an image table (no rows) in a Results section, a born-digital table in
a Results section, and an Ablation table. Asserts provenance (page + crop) is attached, the image
table is recovered via the (mocked) VLM and verified, and the ablation table is excluded.
"""
import os
import json
from benchmarks.extraction.run_extraction import extract_paper
from benchmarks.normalize.registries import load_config, MethodResolver

CFG = load_config(os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json'))
FX = os.path.join(os.path.dirname(__file__), 'fixtures', 'mini.tei.xml')


def _resolver():
    return MethodResolver(["ZeroGrasp", "AnyGrasp", "Grasp Pose Detection (GPD)"],
                          alias_seeds={"gpd": "Grasp Pose Detection (GPD)", "ours": "ZeroGrasp"})


def _fake_vlm(png):
    return json.dumps({"rows": [
        {"method": "ZeroGrasp", "metric": "Success Rate", "condition": "pile",
         "value": 88.0, "value_str": "88.0", "is_own": True}]})


def _kw():
    # all I/O injected so the test never touches a real PDF
    return dict(
        vlm_client=_fake_vlm,
        render_fn=lambda pdf, page, bbox=None: b'PNGDATA',
        crop_text_fn=lambda pdf, page: "ZeroGrasp 88.0 pile success rate",
        crop_saver=lambda paper_id, idx, png: f"/data/crops/{paper_id}_{idx}.png",
        find_page_fn=lambda pdf, caption: 0,
    )


def test_born_digital_records_get_page_and_crop_provenance():
    recs = extract_paper(FX, pdf_path="x.pdf", cfg=CFG, resolver=_resolver(), **_kw())
    born = [r for r in recs if r.extractor == "tei_table" and r.method_id]
    assert born, "born-digital records produced from the Quantitative Comparisons table"
    assert all(r.crop_image and r.crop_image.startswith("/data/crops/") for r in born)
    assert all(r.page is not None for r in born)


def test_image_table_recovered_via_vlm_and_verified():
    recs = extract_paper(FX, pdf_path="x.pdf", cfg=CFG, resolver=_resolver(), **_kw())
    zg = [r for r in recs if r.method_id == "ZeroGrasp" and r.extractor == "vlm"]
    assert zg, "the image table (no TEI rows) is recovered via the VLM path"
    assert zg[0].verified is True            # found-in-crop verification passed
    assert zg[0].crop_image                  # crop attached as proof
    assert zg[0].metric_id == "success_rate"


def test_ablation_table_is_excluded():
    recs = extract_paper(FX, pdf_path="x.pdf", cfg=CFG, resolver=_resolver(), **_kw())
    # nothing published should come from the Ablation section
    assert all((r.section_label or "").lower().find("ablation") == -1 for r in recs)
