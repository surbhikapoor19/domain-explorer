"""Emit kg-macro.json — landing-view graph mirroring backend /api/kg-macro.

Coverage contract: node + edge types, per-type enrichment, and citation-edge
context fields are byte-identical to backend/app.py::get_kg_macro(). The only
intentional difference between this static JSON and the live API response is
the data path — same fields, same shape.

Consumed by:
  - KGGraphViz when dataUrl='kg-macro' (the default landing view)
  - KGNodeDetail when a user clicks a node in that view
"""
import json
import os
from collections import defaultdict

# Mirrors /api/kg-macro::SHOW_TYPES.
MACRO_TYPES = {
    'paper', 'method', 'technique', 'hardware',
    'figure', 'table', 'impl_language', 'author',
    'institution', 'reference', 'equation', 'dataset',
}

# Mirrors /api/kg-macro::SHOW_EDGE_TYPES.
MACRO_EDGE_TYPES = {
    'uses_backbone', 'uses_loss', 'trained_on', 'uses_technique',
    'described_in', 'cites', 'outperforms', 'uses_hardware',
    'has_figure', 'has_table', 'implemented_in', 'maintained_by',
    'authored_by', 'affiliated_with', 'published_from',
    'cites_external', 'has_equation',
    'evaluated_on', 'uses_dataset',
    'co_authored_with', 'colleagues_with',
    'co_cited_with', 'shares_bibliography',
    'author_works_on',
}


_ROLE_TO_META_KEY = {
    'method.family': 'planning',
    'train.regime': 'training',
    'hardware.platform': 'effector',
    'env.context': 'scene',
    'input.modality': 'input',
    'output.shape': 'output',
    'identity.year': 'year',
    'identity.description': 'description',
    'method.middleware': 'middleware',
    'method.ik_controller': 'ik_controller',
}


def _build_method_meta(method_df, domain_cfg=None):
    """Pull CSV columns into a flat dict keyed by method Name."""
    meta = {}
    if method_df is None:
        return meta

    col_roles = {}
    if domain_cfg:
        col_roles = domain_cfg.column_roles
    else:
        col_roles = {
            'Planning Method': 'method.family',
            'Training Data': 'train.regime',
            'End-effector Hardware': 'hardware.platform',
            'Object Configuration': 'env.context',
            'Input Data': 'input.modality',
            'Output Pose': 'output.shape',
            'Year (Initial Release)': 'identity.year',
            'Description': 'identity.description',
        }

    for _, row in method_df.iterrows():
        name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
        if not name:
            continue
        entry = {}
        for col_name, role in col_roles.items():
            meta_key = _ROLE_TO_META_KEY.get(role)
            if not meta_key or col_name not in method_df.columns:
                continue
            val = str(row.get(col_name, ''))
            if meta_key == 'description':
                val = val[:150]
            entry[meta_key] = val
        meta[name] = entry
    return meta


def _build_adjacency(nodes, edges):
    """Adjacency by node id — needed to compute degree + has_paper without
    materializing a full networkx graph."""
    neighbors = defaultdict(set)
    for e in edges:
        s = e.get('source')
        t = e.get('target')
        if s is None or t is None:
            continue
        neighbors[s].add(t)
        neighbors[t].add(s)
    return neighbors


def export_kg_macro(nodes, edges, output_dir, method_df=None, node_by_id=None,
                    domain_cfg=None):
    """Mirrors backend/app.py::get_kg_macro() byte-for-byte on the wire format."""
    if node_by_id is None:
        node_by_id = {n['id']: n for n in nodes}
    method_meta = _build_method_meta(method_df, domain_cfg)
    adjacency = _build_adjacency(nodes, edges)

    out_nodes = []
    node_set = set()
    for nd in nodes:
        nid = nd.get('id')
        ntype = nd.get('type', '')
        if ntype not in MACRO_TYPES:
            continue
        degree = len(adjacency.get(nid, ()))
        node = {
            'id': nid,
            'label': nd.get('label', ''),
            'type': ntype,
            'subtype': nd.get('subtype', ''),
            'degree': degree,
            'paper_id': nd.get('paper_id', ''),
        }
        # Body content for table/figure/claim/equation so KGNodeDetail can render it.
        if ntype in ('table', 'figure', 'claim', 'equation') and nd.get('value'):
            node['value'] = nd.get('value', '')
            node['section'] = nd.get('section', '')
        if ntype == 'table' and nd.get('cells'):
            node['cells'] = nd.get('cells')
            node['caption'] = nd.get('caption', '')
        if ntype == 'equation' and nd.get('latex'):
            node['latex'] = nd.get('latex', '')
        if ntype == 'reference':
            node['year'] = nd.get('year', '')
            node['authors'] = nd.get('authors', [])
            node['venue'] = nd.get('venue', '')
            node['doi'] = nd.get('doi', '')
            node['arxiv'] = nd.get('arxiv', '')
        if ntype == 'author':
            node['institution'] = nd.get('institution', '')
            node['affiliation'] = nd.get('affiliation', '')
        if ntype == 'method':
            label = nd.get('label', '')
            if label in method_meta:
                node['meta'] = method_meta[label]
            # has_paper: does this method touch any paper node? Some methods
            # in the CSV are awaiting paper ingestion — we keep them but
            # flag them so the UI can render them differently.
            has_paper = any(
                node_by_id.get(nb, {}).get('type') == 'paper'
                for nb in adjacency.get(nid, ())
            )
            node['has_paper'] = has_paper
        out_nodes.append(node)
        node_set.add(nid)

    out_links = []
    seen = set()
    for e in edges:
        etype = e.get('type', '')
        if etype not in MACRO_EDGE_TYPES:
            continue
        s = e.get('source')
        t = e.get('target')
        if s not in node_set or t not in node_set:
            continue
        key = (s, t, etype)
        if key in seen:
            continue
        seen.add(key)
        link = {'source': s, 'target': t, 'type': etype}
        # Citation context (sentiment/snippet) lets the UI explain *why* a
        # citation was classified builds_on / differs_from / neutral.
        if etype == 'cites':
            if e.get('sentiment'):
                link['sentiment'] = e.get('sentiment')
            if e.get('contexts'):
                link['contexts'] = (e.get('contexts') or [])[:2]
            if e.get('mentions'):
                link['mentions'] = e.get('mentions')
        # Edge provenance: 'csv' vs 'tei' vs 'groq' — UI distinguishes
        # ground-truth CSV edges from text-extracted ones.
        if e.get('source_type'):
            link['source_type'] = e.get('source_type')
        out_links.append(link)

    payload = {'success': True, 'nodes': out_nodes, 'links': out_links}
    with open(os.path.join(output_dir, 'kg-macro.json'), 'w') as f:
        json.dump(payload, f)
    print(f"  kg-macro.json: {len(out_nodes)} nodes, {len(out_links)} links")
