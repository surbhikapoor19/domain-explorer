import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from benchmarks.normalize.registries import load_config
from benchmarks.adapters.v4_results import records_from_v4
from benchmarks.aggregate.build_benchmarks import build_benchmark_json
from benchmarks.aggregate.cell_context import build_cell_context


def _attach_cell_context(out, output_dir):
    """Defensively enrich the benchmark dict with per-cell context, joining each
    leaderboard to its methods' attributes and its papers' KG relations.

    Loads sibling artifacts (kg-full.json, kg-predictions.json, methods.json)
    from the SAME output dir as the benchmark JSON. If any artifact is missing
    or anything errors, sets cell_context to {} and never crashes the build."""
    try:
        def _load(name):
            p = os.path.join(output_dir, name)
            with open(p) as f:
                return json.load(f)
        kg = _load('kg-full.json')
        predictions = _load('kg-predictions.json')
        methods = _load('methods.json')
        out['cell_context'] = build_cell_context(out, kg, predictions, methods)
    except Exception as e:
        print(f"  cell_context skipped ({type(e).__name__}: {e})")
        out['cell_context'] = {}
    return out


def _write_benchmark_json(out, output_dir):
    """Write benchmark-comparisons.json — but NEVER clobber existing non-empty
    data with an empty build (e.g. a failed/empty extraction). This is the
    overwrite hazard guard: a Docling crash that yields 0 records must not wipe
    the live page. Returns True if written, False if the write was refused."""
    _attach_cell_context(out, output_dir)
    path = os.path.join(output_dir, 'benchmark-comparisons.json')
    s = out.get('stats', {})
    new_empty = s.get('n_comparisons', 0) == 0 and s.get('n_leaderboards', 0) == 0
    if new_empty and os.path.exists(path):
        try:
            with open(path) as f:
                prev = json.load(f).get('stats', {})
            if prev.get('n_comparisons', 0) > 0 or prev.get('n_leaderboards', 0) > 0:
                print(f"  REFUSING overwrite of {path}: new build is empty "
                      f"(0 comparisons/leaderboards) but the existing file has "
                      f"{prev.get('n_comparisons', 0)} comparisons. Keeping existing data.")
                return False
        except Exception:
            pass  # unreadable existing file -> fall through and write
    with open(path, 'w') as f:
        json.dump(out, f)
    return True


def export_benchmark_data(extraction_results_path, output_dir, kg_path=None, config_path=None):
    with open(extraction_results_path) as f:
        v4 = json.load(f)
    cfg = load_config(config_path)
    records = records_from_v4(v4, cfg)
    out = build_benchmark_json(records, cfg)
    if not _write_benchmark_json(out, output_dir):
        return out
    s = out['stats']
    print(f"  benchmark-comparisons.json: {s['n_comparisons']} comparisons, "
          f"{s['n_leaderboards']} leaderboards, {s['n_cross_validations']} cross-validations, "
          f"{s['n_grade_a']} grade-A, {s['n_quarantined']} quarantined")
    if kg_path and os.path.exists(kg_path):
        added = _enrich_kg(kg_path, out['comparisons'])
        print(f"  kg-full.json enriched: +{added} graded outperforms edges")
    return out

def _enrich_kg(kg_path, comparisons):
    """Inject graded, table-derived outperforms edges into the domain KG.
    One edge per (winner paper, loser paper) pair, AGGREGATED over every metric/
    condition the pair was compared on — the edge carries n_comparisons, the metric
    list, and the pair's best evidence grade, so a pair compared on 12 cells isn't
    reduced to whichever comparison happened to come first. Idempotent: existing
    benchmark-derived edges are refreshed in place, prose-claimed edges untouched."""
    with open(kg_path) as f:
        kg = json.load(f)
    m2p = {}
    for link in kg.get('links', []):
        if link.get('type') == 'described_in':
            m2p[link['source'].replace('method:', '')] = link['target'].replace('paper:', '')

    # Aggregate comparisons per directed paper pair.
    by_pair = {}
    grade_rank = {'A': 3, 'B': 2, 'C': 1}
    for c in comparisons:
        wp, lp = m2p.get(c['winner']), m2p.get(c['loser'])
        if not wp or not lp or wp == lp:
            continue
        key = (f"paper:{wp}", f"paper:{lp}")
        agg = by_pair.setdefault(key, {
            'n_comparisons': 0, 'metrics': [], 'grade': 'C',
            'representative': c,   # highest-graded single comparison for the numbers
        })
        agg['n_comparisons'] += 1
        if c['metric_id'] not in agg['metrics']:
            agg['metrics'].append(c['metric_id'])
        if grade_rank.get(c['grade'], 0) > grade_rank.get(agg['grade'], 0):
            agg['grade'] = c['grade']
            agg['representative'] = c

    # Refresh-in-place: drop previous benchmark-derived edges (prose edges stay),
    # then append the current aggregate set. Re-running is a no-op.
    links = [l for l in kg.get('links', [])
             if not (l.get('type') == 'outperforms' and l.get('extraction') == 'benchmark_v2')]
    before = len([l for l in kg.get('links', []) if l.get('type') == 'outperforms' and l.get('extraction') == 'benchmark_v2'])
    for (src, tgt), agg in by_pair.items():
        c = agg['representative']
        links.append({'type': 'outperforms', 'source': src, 'target': tgt,
            'metric': c['metric_id'], 'condition': c.get('condition'),
            'winner_value': c['winner_value'], 'loser_value': c['loser_value'],
            'margin': c['margin'], 'grade': agg['grade'],
            'n_comparisons': agg['n_comparisons'], 'metrics': agg['metrics'],
            'extraction': 'benchmark_v2'})
    kg['links'] = links
    with open(kg_path, 'w') as f:
        json.dump(kg, f)
    return len(by_pair) - before

def export_from_records(records_path, output_dir, kg_path=None, config_path=None):
    """Build benchmark-comparisons.json from a Phase-C result-records.json artifact."""
    from benchmarks.adapters.records_io import load_records
    with open(records_path) as f:
        payload = json.load(f)
    cfg = load_config(config_path)
    out = build_benchmark_json(load_records(payload), cfg)
    if not _write_benchmark_json(out, output_dir):
        return out
    s = out['stats']
    print(f"  benchmark-comparisons.json (from records): {s['n_comparisons']} comparisons, "
          f"{s['n_leaderboards']} leaderboards, {s['n_cross_validations']} cross-validations, "
          f"{s['n_grade_a']} grade-A, {s['n_quarantined']} quarantined")
    if kg_path and os.path.exists(kg_path):
        added = _enrich_kg(kg_path, out['comparisons'])
        print(f"  kg-full.json enriched: +{added} graded outperforms edges")
    return out

if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--extraction-results', help='v4 table_extraction_results json')
    p.add_argument('--from-records', help='Docling result-records.json (engine=docling path)')
    p.add_argument('--output-dir', required=True)
    p.add_argument('--kg-path', default=None)
    p.add_argument('--config', default=None)
    a = p.parse_args()
    if a.from_records:
        export_from_records(a.from_records, a.output_dir, a.kg_path, a.config)
    elif a.extraction_results:
        export_benchmark_data(a.extraction_results, a.output_dir, a.kg_path, a.config)
    else:
        p.error('one of --from-records or --extraction-results is required')
