"""Emit kg-predictions.json — HGT-predicted candidate edges, enriched.

Mirrors backend/app.py::get_kg_predictions() for the basic {nodes, links}
shape, then adds per-link enrichment so the dashboard can render the
detail-side panel without recomputing on every click:

  - comparability: shared / differs / gaps over the 8 priority dimensions,
    with both methods' values per dim. Only computed for paper↔paper edges
    where both endpoints have CSV metadata.
  - shared_context: KG nodes (topics + techniques) that both endpoints
    already touch in the observed graph — the structural overlap that the
    HGT model leveraged.

The enrichment is faithful to what the model can be evaluated against: it
describes the two endpoints and their observed overlap. It does not impose
post-hoc categories ("motif", "verdict") that the model itself did not
emit. Edge type and confidence remain the only categorization.

Filters applied (matching backend defaults):
  - confidence >= MIN_CONFIDENCE (0.55)

Consumed by KGGraphViz when KGLanding's "Predicted Edges" toggle is on.
"""
import json
import os
from collections import defaultdict

MIN_CONFIDENCE = 0.55
# Edge types whose underlying signal is structurally symmetric. When the
# model scores both (A→B) and (B→A) of these and the two scores agree
# within this tolerance, we collapse them to a single undirected edge so
# the viz isn't visually claiming a direction the model can't actually
# decide. Tolerance is generous because these scores typically agree to 3
# decimals when the relation is genuinely symmetric.
SYMMETRIC_EDGE_TYPES = {'outperforms', 'compared_against'}
SYMMETRY_TOLERANCE = 0.02

# Default comparability dimensions for grasp planning. When a domain config
# is provided, its priority_dims override this list.
_DEFAULT_PRIORITY_DIMS = [
    ('Object Configuration',                                   'Scene / Object Config'),
    ('Planning Method',                                        'Planning Method'),
    ('Training Data',                                          'Training Data'),
    ('End-effector Hardware',                                  'End-effector Hardware'),
    ('Input Data',                                             'Input / Sensor'),
    ('Corresponding Dataset (see repository linked above)',    'Dataset'),
    ('Simulator (see repository linked above)',                'Simulator'),
    ('Metric(s) Used ',                                        'Metrics'),
]

# When looking for "shared structural neighbors" we keep types whose meaning
# is interpretable to a researcher reviewing a prediction. Hidden types like
# 'chunk', 'tfidf_term', 'keyphrase' are excluded — they're noise here.
SHARED_NEIGHBOR_TYPES = {'topic', 'technique', 'dataset', 'hardware'}


def _normalize_value(v):
    """Strip quoting + the 'nan' sentinel; return '' for missing."""
    if v is None:
        return ''
    s = str(v).strip()
    if not s or s.lower() == 'nan' or s == '-':
        return ''
    return s


def _build_method_index(method_df, priority_dims=None):
    """Return {paper_id_slug: {dim_key: value}} keyed by the slug derived
    from the method's CSV Name."""
    if method_df is None:
        return {}
    dims = priority_dims or _DEFAULT_PRIORITY_DIMS
    import re
    out = {}
    for _, row in method_df.iterrows():
        name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
        if not name:
            continue
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
        out[slug] = {key: _normalize_value(row.get(key, '')) for key, _ in dims}
    return out


def _comparability(meta_a, meta_b, priority_dims=None):
    """Bucket each priority dim into shared / differs / gaps."""
    dims = priority_dims or _DEFAULT_PRIORITY_DIMS
    shared, differs, gaps = [], [], []
    for key, label in dims:
        va = meta_a.get(key, '') if meta_a else ''
        vb = meta_b.get(key, '') if meta_b else ''
        if not va and not vb:
            gaps.append({'key': key, 'label': label, 'value_a': '', 'value_b': ''})
        elif not va or not vb:
            gaps.append({'key': key, 'label': label, 'value_a': va, 'value_b': vb})
        elif va.lower() == vb.lower():
            shared.append({'key': key, 'label': label, 'value_a': va, 'value_b': vb})
        else:
            differs.append({'key': key, 'label': label, 'value_a': va, 'value_b': vb})
    return {'shared': shared, 'differs': differs, 'gaps': gaps}


def _build_neighbor_index(edges, node_by_id):
    """Return {node_id: set(neighbor_ids)} restricted to interpretable
    neighbor node types (topics, techniques, datasets, hardware)."""
    nb = defaultdict(set)
    for e in edges:
        s, t = e.get('source'), e.get('target')
        if s is None or t is None:
            continue
        s_type = node_by_id.get(s, {}).get('type')
        t_type = node_by_id.get(t, {}).get('type')
        if t_type in SHARED_NEIGHBOR_TYPES:
            nb[s].add(t)
        if s_type in SHARED_NEIGHBOR_TYPES:
            nb[t].add(s)
    return nb


def _shared_context(neighbor_index, node_by_id, src_id, tgt_id, limit=12):
    """List of {type, label} that both endpoints touch."""
    a = neighbor_index.get(src_id, set())
    b = neighbor_index.get(tgt_id, set())
    out = []
    for nid in (a & b):
        nd = node_by_id.get(nid, {})
        out.append({'type': nd.get('type', ''), 'label': nd.get('label', '')})
    # Stable sort: by type then label, longest-first within label so
    # multi-word topics surface above generic single tokens.
    out.sort(key=lambda d: (d['type'], -len(d['label']), d['label']))
    return out[:limit]


def export_kg_predictions(chroma_dir, output_dir, node_by_id=None,
                          edges=None, method_df=None, domain_cfg=None):
    """Build {nodes, links} from chroma_db/hgt_schema/predicted_edges.json,
    enriched with comparability + shared_context per link."""
    priority_dims = (domain_cfg.priority_dims if domain_cfg
                     else _DEFAULT_PRIORITY_DIMS)

    out_path = os.path.join(output_dir, 'kg-predictions.json')
    src_path = os.path.join(chroma_dir, 'hgt_schema', 'predicted_edges.json')
    if not os.path.exists(src_path):
        # No HGT output this run — keep any committed predictions rather than
        # blanking the Predicted-Relationships tab (e.g. a build without HGT).
        from .._safe_write import safe_write_json
        safe_write_json(out_path, {'success': True, 'nodes': [], 'links': []}, label='no HGT output')
        print(f"  kg-predictions.json: empty (no HGT output found)")
        return

    with open(src_path) as f:
        all_preds = json.load(f)

    preds = [p for p in all_preds if p.get('confidence', 0) >= MIN_CONFIDENCE]

    by_pair = defaultdict(list)
    for p in preds:
        if p.get('edge_type') in SYMMETRIC_EDGE_TYPES:
            key = (p.get('edge_type'),) + tuple(sorted([p.get('src_id'), p.get('tgt_id')]))
            by_pair[key].append(p)
    deduped = []
    seen_pair_keys = set()
    for p in preds:
        if p.get('edge_type') not in SYMMETRIC_EDGE_TYPES:
            deduped.append(p)
            continue
        key = (p.get('edge_type'),) + tuple(sorted([p.get('src_id'), p.get('tgt_id')]))
        if key in seen_pair_keys:
            continue
        partners = by_pair[key]
        if len(partners) >= 2:
            confs = [q.get('confidence', 0) for q in partners]
            symmetric = (max(confs) - min(confs)) <= SYMMETRY_TOLERANCE
            if symmetric:
                top = max(partners, key=lambda q: q.get('confidence', 0))
                top = dict(top)
                top['bidirectional'] = True
                deduped.append(top)
                seen_pair_keys.add(key)
                continue
        for q in partners:
            qq = dict(q)
            qq['bidirectional'] = False
            deduped.append(qq)
        seen_pair_keys.add(key)
    preds = deduped

    node_ids = set()
    for p in preds:
        if p.get('src_id'):
            node_ids.add(p['src_id'])
        if p.get('tgt_id'):
            node_ids.add(p['tgt_id'])

    node_by_id = node_by_id or {}
    method_index = _build_method_index(method_df, priority_dims)
    neighbor_index = _build_neighbor_index(edges or [], node_by_id)

    pred_node_info = {}
    for p in preds:
        sid, tid = p.get('src_id'), p.get('tgt_id')
        if sid and sid not in pred_node_info:
            pred_node_info[sid] = {
                'type': p.get('src_type', ''),
                'label': p.get('src_label', ''),
            }
        if tid and tid not in pred_node_info:
            pred_node_info[tid] = {
                'type': p.get('tgt_type', ''),
                'label': p.get('tgt_label', ''),
            }

    nodes = []
    n_fallback = 0
    for nid in node_ids:
        nd = node_by_id.get(nid, {})
        fb = pred_node_info.get(nid, {})
        in_kg = bool(nd)
        if not in_kg:
            n_fallback += 1
        ntype = nd.get('type') or fb.get('type') or (
            nid.split(':')[0] if isinstance(nid, str) and ':' in nid else 'unknown'
        )
        nlabel = nd.get('label') or fb.get('label') or (
            nid.split(':')[-1] if isinstance(nid, str) else str(nid)
        )
        nodes.append({
            'id': nid,
            'label': nlabel,
            'type': ntype,
            'paper_id': nd.get('paper_id', (
                nid.replace('paper:', '')
                if isinstance(nid, str) and nid.startswith('paper:')
                else ''
            )),
            'prediction_degree': sum(
                1 for q in preds
                if q.get('src_id') == nid or q.get('tgt_id') == nid
            ),
        })
    if n_fallback:
        print(f"    ({n_fallback} nodes used prediction metadata — not in KG)")

    links = []
    n_with_cmp = 0
    for p in preds:
        src_id, tgt_id = p.get('src_id'), p.get('tgt_id')
        link = {
            'source': src_id,
            'target': tgt_id,
            'type': p.get('edge_type'),
            'confidence': round(p.get('confidence', 0), 3),
            'semantic_relevance': round(p.get('semantic_relevance', 0), 3),
            'inferred': True,
            'source_type': 'hgt',
            'bidirectional': bool(p.get('bidirectional', False)),
            'shared_context': _shared_context(
                neighbor_index, node_by_id, src_id, tgt_id,
            ),
        }
        s_node = node_by_id.get(src_id, {})
        t_node = node_by_id.get(tgt_id, {})
        if s_node.get('type') == 'paper' and t_node.get('type') == 'paper':
            s_paper = s_node.get('paper_id', '')
            t_paper = t_node.get('paper_id', '')
            meta_a = method_index.get(s_paper)
            meta_b = method_index.get(t_paper)
            if meta_a and meta_b:
                link['comparability'] = _comparability(meta_a, meta_b,
                                                       priority_dims)
                n_with_cmp += 1
        links.append(link)

    from .kg_full import detruncate_labels
    detruncate_labels(nodes)   # restore labels cut mid-word, same as kg-full.json
    payload = {'success': True, 'nodes': nodes, 'links': links}
    from .._safe_write import safe_write_json
    safe_write_json(out_path, payload, label='empty predictions')
    print(
        f"  kg-predictions.json: {len(nodes)} nodes, {len(links)} links "
        f"(min_confidence={MIN_CONFIDENCE}, comparability on {n_with_cmp} edges)"
    )
