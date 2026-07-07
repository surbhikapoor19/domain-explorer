"""Regression tests for the ablation-table method-misattribution bug — AUTHORED BY
ORCHESTRATOR. Implementers must NOT modify this file.

THE BUG (equivariant-volumetric-grasping TABLE IV, an ablation table):
Its columns are  [No. | Ablated models | GSR (%) | DR (%) | GPU | Params | Latency].
The extractor took column 0 (the row INDEX "1","2",...) as the method name, and the
resolver's fuzzy branch matched the bare "1" as a substring of "dex net 1 0 mv cnns",
crowning row 1's numbers onto Dex-Net 1.0. Rows keyed by index 1/2/3/4/6/7 were stamped
onto six unrelated corpus methods. 30 phantom records reached the served data.

Four defenses, each independently sufficient to stop this class:
  F1  ablation TABLE is dropped (detect the cue in header cells, stem "ablat*")
  F2  method COLUMN is detected, not hardcoded to col 0 (skip index columns)
  F3  resolver never fuzzy-matches a letter-free / too-short candidate
  F4  build validates the RAW label, not just the laundered resolved id

The single invariant the whole thing protects:
  ** a numeric / letter-free cell must never be attributed to a named method. **
"""
import os
import re
import pytest

from benchmarks.extraction.tei_tables import records_from_tei_rows
from benchmarks.extraction.locate import TableLocation
from benchmarks.normalize.registries import load_config, MethodResolver
from benchmarks.aggregate.build_benchmarks import build_benchmark_json, is_valid_method_name
from benchmarks.types import ResultRecord

CFG_DIR = os.path.join(os.path.dirname(__file__), '..', 'config')
GRASP = load_config(os.path.join(CFG_DIR, 'grasp_planning.json'))

# The real corpus names that the digit rows collided with.
CORPUS = ['Dex-Net 1.0 (MV-CNNs)', 'Dex-Net 2.0 (GQ-CNN)', 'Dex-Net 4.0',
          '3DAPNet', '6-DoF GraspNet', '7DGCG', 'Tri-UNet', 'S4G',
          'Grasp Pose Detection (GPD)', 'AnyGrasp']
PHANTOMS = {'Dex-Net 1.0 (MV-CNNs)', 'Dex-Net 2.0 (GQ-CNN)', 'Dex-Net 4.0',
            '3DAPNet', '6-DoF GraspNet', '7DGCG'}

# The exact TABLE IV grid, as extracted from the paper's TEI.
EVG_TABLE_IV = [
    ['No.', 'Ablated models', 'GSR (%)', 'DR (%)', 'GPU Memory (M)', 'Params (M)', 'Latency (ms)'],
    ['1', 'Tri-UNet',                          '84.8±2.2', '85.1±2.5', '2165',  '0.60', '24'],
    ['2', '3D UNet',                           '87.1±1.7', '86.2±2.3', '20376', '1.13', '22'],
    ['3', 'Equi. 3D UNet',                     '79.6±2.4', '81.3±2.8', '17208', '0.46', '46'],
    ['4', 'XY-separated Tri-UNet',             '86.3±1.6', '86.5±2.0', '3320',  '1.10', '24'],
    ['5', 'Equi. Tri-UNet wo. S2TP',           '88.1±1.1', '86.3±1.2', '4828',  '0.86', '47'],
    ['6', '(5) + 3 layers Lifting Convs',      '89.4±2.1', '87.6±2.7', '5598',  '0.87', '48'],
    ['7', 'Equi. Tri-UNet',                    '93.1±2.2', '88.3±1.9', '4932',  '0.88', '47'],
    ['8', 'Equi. Tri-UNet + Side DCN',         '93.7±0.9', '88.8±1.1', '5056',  '1.03', '61'],
    ['9', 'Equi. Tri-UNet + Side DCN + DSCN',  '94.7±0.7', '88.3±1.2', '5142',  '1.04', '65'],
]


def _evg_loc():
    # GROBID dropped this table's caption to "TABLE IV :" — the only ablation cue
    # is the "Ablated models" header cell. section_label is empty too.
    return TableLocation(
        paper_id="equivariant-volumetric-grasping", table_index=3,
        caption="TABLE IV :", section_label="",
        is_results_section=True, is_ablation_section=False, has_rows=True,
        rows=EVG_TABLE_IV)


# ── THE CORE INVARIANT (the user's #1 requirement) ──────────────────────────────

def test_no_record_attributes_a_letterfree_label_to_a_method():
    """No attributed record may originate from a raw label lacking a letter.
    This is the whole point: a bare index number is never a method name."""
    resolver = MethodResolver(CORPUS)
    recs = records_from_tei_rows(_evg_loc(), GRASP, resolver)
    offenders = [(r.method_raw, r.method_id) for r in recs
                 if r.method_id and not re.search(r'[a-z]', (r.method_raw or '').lower())]
    assert offenders == [], f"letter-free labels crowned methods: {offenders}"


def test_evg_table_iv_produces_no_phantom_corpus_methods():
    """None of the six methods the index rows collided with may be attributed."""
    resolver = MethodResolver(CORPUS)
    recs = records_from_tei_rows(_evg_loc(), GRASP, resolver)
    resolved = {r.method_id for r in recs if r.method_id}
    leaked = resolved & PHANTOMS
    assert not leaked, f"ablation index rows still leaked onto real methods: {leaked}"


# ── F2 : method COLUMN detection (read the heading right) ────────────────────────

def test_method_column_detected_when_first_column_is_an_index():
    """A table whose col 0 is a 'No.' index must take the method from the name
    column, and the index digits must never become methods."""
    loc = TableLocation(
        paper_id="p", table_index=0, caption="Table 5: Comparison on pile (%)",
        section_label="Results", is_results_section=True, is_ablation_section=False,
        has_rows=True,
        rows=[['No.', 'Method', 'Success Rate'],
              ['1', 'AnyGrasp', '86.9'],
              ['2', 'Grasp Pose Detection (GPD)', '70.1']])
    resolver = MethodResolver(['AnyGrasp', 'Grasp Pose Detection (GPD)'],
                              alias_seeds={'gpd': 'Grasp Pose Detection (GPD)'})
    recs = records_from_tei_rows(loc, GRASP, resolver)
    by = {r.method_id: r for r in recs if r.method_id}
    assert set(by) == {'AnyGrasp', 'Grasp Pose Detection (GPD)'}
    assert by['AnyGrasp'].value == 86.9
    assert all(re.search(r'[a-z]', r.method_raw.lower()) for r in recs if r.method_id)


def test_plain_two_column_table_still_reads_method_from_col0():
    """Guard against over-correction: a normal [Method | Metric] table must keep
    column 0 as the method column."""
    loc = TableLocation(
        paper_id="p", table_index=0, caption="Table 1: Success rate on pile (%)",
        section_label="Results", is_results_section=True, is_ablation_section=False,
        has_rows=True,
        rows=[['Method', 'Success Rate'], ['AnyGrasp', '86.9'], ['GPD', '70.1']])
    resolver = MethodResolver(['AnyGrasp', 'Grasp Pose Detection (GPD)'],
                              alias_seeds={'gpd': 'Grasp Pose Detection (GPD)'})
    recs = records_from_tei_rows(loc, GRASP, resolver)
    assert {r.method_id for r in recs if r.method_id} == {'AnyGrasp', 'Grasp Pose Detection (GPD)'}
    assert next(r for r in recs if r.method_id == 'AnyGrasp').value == 86.9


# ── F3 : resolver never crowns a letter-free / tiny candidate ────────────────────

def test_resolver_rejects_bare_index_candidates():
    r = MethodResolver(CORPUS, alias_seeds={'gpd': 'Grasp Pose Detection (GPD)'})
    for digit in ['1', '2', '3', '4', '6', '7', '0', '42', '9', '(5)']:
        assert r.resolve(digit).method_id is None, f"{digit!r} must not resolve to a method"


def test_resolver_still_matches_legit_short_and_aliased_names():
    """The guard must not break real short names, which resolve via exact/alias."""
    r = MethodResolver(CORPUS, alias_seeds={'gpd': 'Grasp Pose Detection (GPD)'})
    assert r.resolve('S4G').method_id == 'S4G'                       # exact short name
    assert r.resolve('gpd').method_id == 'Grasp Pose Detection (GPD)'  # alias
    assert r.resolve('GPD').method_id == 'Grasp Pose Detection (GPD)'  # alias, cased
    assert r.resolve('Dex-Net 1.0 (MV-CNNs)').method_id == 'Dex-Net 1.0 (MV-CNNs)'  # exact full


# ── F4 : build drops a record whose RAW label is junk, even if it resolved ───────

def _rec(method_raw, method_id, value):
    return ResultRecord(
        paper_id='equivariant-volumetric-grasping', method_raw=method_raw,
        method_id=method_id, metric_raw='GSR (%)', metric_id='success_rate',
        unit='%', higher_is_better=True, value=value, value_str=str(value),
        extractor='tei_table', verified=True)


def test_build_drops_record_with_letterfree_raw_label():
    """A record laundered to a real id but whose raw label is "1" must be dropped
    at build time — the final backstop independent of the resolver."""
    phantom = _rec('1', 'Dex-Net 1.0 (MV-CNNs)', 84.8)
    legit = _rec('AnyGrasp', 'AnyGrasp', 86.9)
    out = build_benchmark_json([phantom, legit], GRASP)
    methods = {row.get('method') for row in out['results']}
    assert 'Dex-Net 1.0 (MV-CNNs)' not in methods, "phantom survived the build filter"
    assert 'AnyGrasp' in methods, "legit record was wrongly dropped"


# ── F1 : the ablation TABLE is recognized (header-cell cue, stemmed keyword) ─────

def test_ablation_table_detected_from_header_cell_and_stem():
    """is_ablation_table must flag the EVG table via its 'Ablated models' header cell
    (caption/section are empty of the word), stem-match 'ablation'->'Ablated', and
    NOT over-trigger on a normal results table.

    Contract for implementers: add
        is_ablation_table(caption, section_label, rows, abl_kw) -> bool
    to benchmarks/extraction/locate.py and call it from both locate_tables and
    docling_tables_to_locations to set is_ablation_section."""
    from benchmarks.extraction.locate import is_ablation_table
    abl_kw = GRASP.get('ablation_section_keywords', ['ablation'])

    # cue only in a header cell, caption/section empty of it
    assert is_ablation_table('TABLE IV :', '', EVG_TABLE_IV, abl_kw) is True
    # cue in the caption, stemmed form
    assert is_ablation_table('Ablation study of components', '',
                             [['Method', 'GSR'], ['A', '1']], abl_kw) is True
    # normal results table: no cue anywhere -> must be False
    assert is_ablation_table('Table 2: Success rate on pile (%)', 'Quantitative Comparisons',
                             [['Method', 'Success Rate'], ['Ours', '86.9']], abl_kw) is False
