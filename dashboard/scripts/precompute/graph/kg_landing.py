"""Emit kg-landing.json — KGLanding dashboard aggregations.

Coverage contract — KGLanding renders these sections, each backed by one key:
  summary                  → 'Knowledge Graph Coverage' cards
  nodeTypeCounts           → 'Node Type Distribution' bars
  edgeTypeCounts           → 'Edge Type Distribution' bars
  totalNodes / totalEdges  → top-line totals
  temporalDistribution     → 'Papers Over Time' from KG paper nodes
  techniqueCooccurrence    → 'Technique Co-occurrence' force-graph
  benchmarkCoverage        → 'Benchmark Coverage' bar list  (CSV-derived)
  temporal                 → 'Methods Over Time' bar chart  (CSV-derived)
  topCited                 → 'Most Cited Papers'
  topInstitutions          → 'Top Institutions'
  topAuthors               → 'Top Authors (2+ papers)'
  citeFlow                 → 'Citation Stance' donut
  topExternalRefs          → 'Most-cited External References'
"""
import json
import os
from collections import Counter, defaultdict


def _build_summary(node_types, edge_types, n_nodes, n_edges):
    n_papers = node_types.get('paper', 0)
    n_methods = node_types.get('method', 0)
    n_techniques = node_types.get('technique', 0)
    n_claims = sum(node_types.get(t, 0) for t in
                   ('contribution', 'comparison', 'limitation', 'problem', 'claim'))
    n_chunks = node_types.get('chunk', 0)
    n_citations = edge_types.get('cites', 0)
    return {
        'methods': n_methods, 'papers': n_papers, 'techniques': n_techniques,
        'claims': n_claims, 'chunks': n_chunks, 'citations': n_citations,
        'nodes': n_nodes, 'edges': n_edges,
    }


def _build_technique_cooccurrence(edges, node_by_id):
    paper_techniques = defaultdict(set)
    for e in edges:
        if e.get('type') in ('uses_backbone', 'uses_loss', 'trained_on', 'uses_technique'):
            src = node_by_id.get(e.get('source'), {})
            tgt = node_by_id.get(e.get('target'), {})
            if src.get('type') == 'paper' and tgt.get('type') == 'technique':
                paper_techniques[e['source']].add(tgt.get('label', ''))

    cooccurrence = defaultdict(int)
    tech_counts = Counter()
    for techs in paper_techniques.values():
        for t in techs:
            tech_counts[t] += 1
        techs_list = sorted(techs)
        for i in range(len(techs_list)):
            for j in range(i + 1, len(techs_list)):
                pair = tuple(sorted([techs_list[i], techs_list[j]]))
                cooccurrence[pair] += 1

    links = [
        {'source': p[0], 'target': p[1], 'weight': c}
        for p, c in sorted(cooccurrence.items(), key=lambda x: -x[1]) if c >= 2
    ][:30]
    nodes = [{'name': n, 'count': c} for n, c in tech_counts.most_common(20)]
    return {'nodes': nodes, 'links': links}


def _build_benchmark_coverage(method_df):
    if method_df is None:
        return []
    dataset_col = next(
        (c for c in method_df.columns
         if 'corresponding' in c.lower() and 'dataset' in c.lower()),
        None,
    )
    if not dataset_col:
        return []
    method_benchmarks = defaultdict(list)
    for _, row in method_df.iterrows():
        name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
        raw = str(row.get(dataset_col, ''))
        datasets = [v.strip() for v in raw.split(',') if v.strip() and v.strip().lower() != 'nan']
        for ds in datasets:
            method_benchmarks[ds].append(name)
    return [
        {'dataset': ds, 'methods': methods, 'count': len(methods)}
        for ds, methods in sorted(method_benchmarks.items(), key=lambda x: -len(x[1]))
        if len(methods) >= 1
    ][:12]


def _build_temporal(method_df):
    if method_df is None:
        return []
    year_methods = defaultdict(list)
    for _, row in method_df.iterrows():
        name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
        year = row.get('Year (Initial Release)', '')
        if year and str(year).strip().lower() != 'nan':
            try:
                y = int(float(str(year)))
                if 2005 <= y <= 2030:
                    year_methods[y].append(name)
            except (ValueError, TypeError):
                pass
    return [{'year': y, 'methods': m, 'count': len(m)}
            for y, m in sorted(year_methods.items())]


def _build_top_cited(edges, node_by_id):
    counts = Counter()
    for e in edges:
        if e.get('type') == 'cites':
            tgt = node_by_id.get(e.get('target'), {})
            label = tgt.get('label', '')
            if label:
                counts[label] += 1
    return [{'paper': n, 'citations': c} for n, c in counts.most_common(10)]


def _build_top_institutions(edges, node_by_id):
    institution_papers = defaultdict(set)
    for e in edges:
        if e.get('type') == 'published_from':
            src = node_by_id.get(e.get('source'), {})
            tgt = node_by_id.get(e.get('target'), {})
            if src.get('type') == 'paper' and tgt.get('type') == 'institution':
                institution_papers[tgt.get('label', '')].add(src.get('label', ''))
    return [
        {'name': n, 'count': len(p), 'papers': sorted(p)[:6]}
        for n, p in sorted(institution_papers.items(), key=lambda x: -len(x[1])) if n
    ][:12]


def _build_top_authors(edges, node_by_id):
    author_papers = defaultdict(set)
    for e in edges:
        if e.get('type') == 'authored_by':
            src = node_by_id.get(e.get('source'), {})
            tgt = node_by_id.get(e.get('target'), {})
            if src.get('type') == 'paper' and tgt.get('type') == 'author':
                author_papers[tgt.get('label', '')].add(src.get('label', ''))
    return [
        {'name': n, 'count': len(p), 'papers': sorted(p)[:4]}
        for n, p in sorted(author_papers.items(), key=lambda x: -len(x[1]))
        if n and len(p) >= 2
    ][:10]


def _build_cite_flow(edges):
    flow = {'builds_on': 0, 'differs_from': 0, 'neutral': 0}
    for e in edges:
        if e.get('type') == 'cites':
            sentiment = e.get('sentiment', 'neutral')
            flow[sentiment] = flow.get(sentiment, 0) + 1
    return flow


def _build_top_external_refs(edges, node_by_id):
    counts = Counter()
    meta = {}
    for e in edges:
        if e.get('type') == 'cites_external':
            tgt = node_by_id.get(e.get('target'), {})
            label = tgt.get('label', '')
            if not label:
                continue
            counts[label] += 1
            if label not in meta:
                meta[label] = {
                    'year': tgt.get('year', ''),
                    'authors': tgt.get('authors', [])[:2],
                    'venue': tgt.get('venue', ''),
                }
    return [
        {'title': label, 'citations': c, **meta.get(label, {})}
        for label, c in counts.most_common(10) if c >= 2
    ]


def _build_temporal_distribution(nodes):
    dist = Counter()
    for n in nodes:
        if n.get('type') == 'paper' and n.get('year'):
            try:
                dist[int(n['year'])] += 1
            except (TypeError, ValueError):
                pass
    return dict(sorted(dist.items()))


def export_kg_landing(nodes, edges, node_by_id, method_df, output_dir):
    node_types = Counter(n.get('type') for n in nodes)
    edge_types = Counter(e.get('type') for e in edges)

    landing = {
        'nodeTypeCounts': dict(node_types),
        'edgeTypeCounts': dict(edge_types),
        'totalNodes': len(nodes),
        'totalEdges': len(edges),
        'temporalDistribution': _build_temporal_distribution(nodes),
        'summary': _build_summary(node_types, edge_types, len(nodes), len(edges)),
        'techniqueCooccurrence': _build_technique_cooccurrence(edges, node_by_id),
        'benchmarkCoverage': _build_benchmark_coverage(method_df),
        'temporal': _build_temporal(method_df),
        'topCited': _build_top_cited(edges, node_by_id),
        'topInstitutions': _build_top_institutions(edges, node_by_id),
        'topAuthors': _build_top_authors(edges, node_by_id),
        'citeFlow': _build_cite_flow(edges),
        'topExternalRefs': _build_top_external_refs(edges, node_by_id),
    }
    from .._safe_write import safe_write_json
    safe_write_json(os.path.join(output_dir, 'kg-landing.json'), landing, label='empty landing')
    print(
        f"  kg-landing.json: summary + "
        f"{len(landing['techniqueCooccurrence']['nodes'])} techniques, "
        f"{len(landing['temporal'])} years, "
        f"{len(landing['topInstitutions'])} institutions, "
        f"{len(landing['topAuthors'])} authors, "
        f"{len(landing['benchmarkCoverage'])} benchmarks"
    )
