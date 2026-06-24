"""Per-cell context for benchmark leaderboards.

Joins each benchmark cell (a leaderboard, keyed e.g. ``success_rate||packed``)
to its methods' attributes (from methods.json) and its papers' KG relations
(citation stance, technique lineage, stated/predicted outperforms).

Honesty invariants:
  - the method-name join is normalized so emoji-prefixed names still join; a
    miss yields "not reported" on every field (never guessed);
  - STATED outperforms (KG) carry evidence text but NO fabricated confidence;
  - PREDICTED outperforms (HGT) are kept as data tagged kind='predicted'.
"""

import re


def _norm(name):
    if not name:
        return ''
    return re.sub(r'^[\W_]+', '', str(name).strip(), flags=re.UNICODE).lower()


_PRESENT_SOURCE = 'method-typical (KG/CSV)'
_MISSING = {'value': 'not reported', 'source': 'not reported'}


def _field(rec, *keys):
    """First non-empty value across keys (None/'' treated as empty)."""
    if not rec:
        return dict(_MISSING)
    for k in keys:
        v = rec.get(k)
        if v is not None and v != '':
            return {'value': v, 'source': _PRESENT_SOURCE}
    return dict(_MISSING)


def build_cell_context(benchmark, kg, predictions, methods, resolver=None):
    """-> { CELL_KEY: {method_attributes, relations:{citations,technique_lineage,outperforms}, differences} }"""
    benchmark = benchmark or {}
    kg = kg or {}
    predictions = predictions or {}

    methods_index = {_norm(r['Name']): r for r in (methods or []) if r.get('Name')}

    kg_links = kg.get('links') or kg.get('edges') or []
    pred_links = predictions.get('links') or predictions.get('predicted_edges') or []

    result = {}

    for lb_key, lb in (benchmark.get('leaderboards', {}) or {}).items():
        entries = lb.get('entries', []) or []
        methods_in_cell = [e['method'] for e in entries]

        papers = set()
        for e in entries:
            for p in e.get('source_papers', []) or []:
                papers.add(p)
            for s in e.get('sources', []) or []:
                sp = s.get('paper')
                if sp:
                    papers.add(sp)
        paper_ids = {'paper:' + p for p in papers}

        # ── method_attributes ──────────────────────────────────────────────
        method_attributes = {}
        for m in methods_in_cell:
            rec = methods_index.get(_norm(m))
            method_attributes[m] = {
                'gripper': _field(rec, 'Gripper Type', 'End-effector Hardware'),
                'end_effector': _field(rec, 'End-effector Hardware'),
                'sensor': _field(rec, 'Input Data', 'Sensor Complexity'),
                'backbone': _field(rec, 'Backbone'),
                'learning_paradigm': _field(rec, 'Learning Paradigm'),
            }

        # ── relations.citations ────────────────────────────────────────────
        citations = []
        for lk in kg_links:
            if lk.get('type') == 'cites' and lk.get('source') in paper_ids and lk.get('target') in paper_ids:
                citations.append({
                    'from_paper': lk['source'].split(':', 1)[-1],
                    'to_paper': lk['target'].split(':', 1)[-1],
                    'stance': lk.get('sentiment', 'neutral'),
                })

        # ── relations.technique_lineage ────────────────────────────────────
        per_paper_backbones = {}
        for lk in kg_links:
            if lk.get('type') == 'uses_backbone' and lk.get('source') in paper_ids:
                slug = lk['source'].split(':', 1)[-1]
                name = lk['target'].split(':')[-1]
                per_paper_backbones.setdefault(slug, set()).add(name)
        per_paper_backbones = {k: sorted(v) for k, v in per_paper_backbones.items()}

        backbone_paper_count = {}
        for slug, names in per_paper_backbones.items():
            for name in names:
                backbone_paper_count.setdefault(name, set()).add(slug)
        shared_backbones = sorted(
            name for name, slugs in backbone_paper_count.items() if len(slugs) >= 2
        )

        builds_on_pairs = [
            [c['from_paper'], c['to_paper']]
            for c in citations if c['stance'] == 'builds_on'
        ]

        technique_lineage = {
            'per_paper_backbones': per_paper_backbones,
            'shared_backbones': shared_backbones,
            'builds_on_pairs': builds_on_pairs,
        }

        # ── relations.outperforms ──────────────────────────────────────────
        stated = []
        for lk in kg_links:
            if lk.get('type') == 'outperforms' and lk.get('source') in paper_ids and lk.get('target') in paper_ids:
                stated.append({
                    'winner_paper': lk['source'].split(':', 1)[-1],
                    'loser_paper': lk['target'].split(':', 1)[-1],
                    'kind': 'stated',
                    'evidence': lk.get('evidence', ''),
                })

        predicted = []
        for p in pred_links:
            ptype = p.get('type') or p.get('edge_type')
            src = p.get('source') or p.get('src_id')
            tgt = p.get('target') or p.get('tgt_id')
            if ptype == 'outperforms' and src in paper_ids and tgt in paper_ids:
                predicted.append({
                    'winner_paper': src.split(':', 1)[-1],
                    'loser_paper': tgt.split(':', 1)[-1],
                    'kind': 'predicted',
                    'confidence': p.get('confidence'),
                    'semantic_relevance': p.get('semantic_relevance'),
                })

        outperforms = stated + predicted

        # ── differences ────────────────────────────────────────────────────
        differences = []
        if len(methods_in_cell) >= 2:
            for axis in ('gripper', 'sensor', 'backbone'):
                values = {m: method_attributes[m][axis]['value'] for m in methods_in_cell}
                real = {v for v in values.values() if v != 'not reported'}
                if len(real) >= 1:
                    differences.append({
                        'axis': axis,
                        'values': values,
                        'differ': len(real) >= 2,
                        'source': _PRESENT_SOURCE,
                    })

        result[lb_key] = {
            'method_attributes': method_attributes,
            'relations': {
                'citations': citations,
                'technique_lineage': technique_lineage,
                'outperforms': outperforms,
            },
            'differences': differences,
        }

    return result
