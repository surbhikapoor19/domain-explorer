"""Schema consolidation and feature engineering for the HGT model.

Consolidates raw KG node types into HGT-trainable types and computes
frozen feature vectors using the sentence-transformer model.

Claim subtypes (contribution / comparison / limitation / problem) stay
distinct as separate HGT node types. Collapsing them into a single
`claim` type erases the per-subtype signal HGT needs to predict the
relation correctly.
"""

import json
import logging
import os
from collections import defaultdict
import numpy as np
import networkx as nx

from .config import BASE_DIM, CONTENT_DIM, FEATURE_DIM

logger = logging.getLogger(__name__)

TYPE_CONSOLIDATION = {
    'paper': 'paper',
    'method': 'method',
    'technique': 'technique',
    'contribution': 'contribution',
    'comparison': 'comparison',
    'limitation': 'limitation',
    'problem': 'problem',
    'hardware': 'technique',
    'planning_method': 'attribute',
    'training_paradigm': 'attribute',
    'effector_type': 'attribute',
    'scene_type': 'attribute',
    'input_modality': 'attribute',
    'output_format': 'attribute',
    'benchmark_dataset': 'attribute',
    'simulator': 'attribute',
    'backbone_arch': 'attribute',
    'eval_metric': 'attribute',
    'camera_config': 'attribute',
    'year': 'attribute',
    'impl_language': 'attribute',
    'topic': 'topic',
    'keyphrase': 'keyphrase',
    'tfidf_term': 'keyphrase',
    'chunk': 'chunk',
    'author': 'author',
    'institution': 'institution',
    'reference': 'reference',
    'figure': 'content',
    'table': 'content',
    'equation': 'content',
    'dataset': 'attribute',
}

EDGE_CONSOLIDATION = {
    'uses_backbone': 'uses_technique',
    'uses_loss': 'uses_technique',
    'trained_on': 'uses_technique',
    'uses_hardware': 'uses_technique',
    'uses_planning_method': 'has_attribute',
    'trained_with': 'has_attribute',
    'uses_effector': 'has_attribute',
    'handles_scene': 'has_attribute',
    'requires_input': 'has_attribute',
    'outputs': 'has_attribute',
    'evaluated_on': 'has_attribute',
    'simulated_in': 'has_attribute',
    'uses_architecture': 'has_attribute',
    'measured_by': 'has_attribute',
    'uses_camera': 'has_attribute',
    'published_in_year': 'has_attribute',
    'uses_dataset': 'has_attribute',
    'implemented_in': 'has_attribute',
    'has_keyphrase': 'has_keyphrase',
    'has_distinctive_term': 'has_keyphrase',
    'discusses_topic': 'discusses_topic',
    'contains_chunk': 'contains_chunk',
    'contributes': 'contributes',
    'implements_step': 'implements_step',
    'has_limitation': 'has_limitation',
    'compares': 'compares',
    'addresses_problem': 'addresses_problem',
    'described_in': 'described_in',
    'outperforms': 'outperforms',
    'semantically_similar': 'semantically_similar',
    'similar_in_role': 'similar_in_role',
    'authored_by': 'authored_by',
    'affiliated_with': 'affiliated_with',
    'published_from': 'published_from',
    'cites': 'cites',
    'cites_external': 'cites_external',
    'has_figure': 'has_content',
    'has_table': 'has_content',
    'has_equation': 'has_content',
    'maintained_by': 'maintained_by',
    'co_authored_with': 'co_authored_with',
    'colleagues_with': 'colleagues_with',
    'co_cited_with': 'co_cited_with',
    'shares_bibliography': 'shares_bibliography',
    'author_works_on': 'author_works_on',
}

HGT_NODE_TYPES = [
    'paper', 'method', 'technique',
    'contribution', 'comparison', 'limitation', 'problem',
    'attribute', 'topic', 'keyphrase', 'chunk',
    'author', 'institution', 'reference', 'content',
]

ROLE_BUCKETS = [
    'algorithm_description', 'experimental_setup', 'result',
    'comparison', 'problem_statement', 'limitation', 'definition', 'general',
]
CONTENT_BUCKETS = ['theory', 'implementation', 'evaluation', 'general']
TOPIC_K = 20


def load_kg_as_networkx(kg_path: str) -> nx.DiGraph:
    """Load knowledge_graph.json into a NetworkX DiGraph."""
    import json as _json
    with open(kg_path) as f:
        data = _json.load(f)
    return nx.node_link_graph(data, directed=True)


def consolidate_graph(G: nx.DiGraph) -> dict:
    """Consolidate the graph into HGT-compatible schema.

    Returns:
        {
            'node_mappings': {hgt_type: {original_id: int_index, ...}},
            'node_metadata': {hgt_type: [{original_id, label, subtype, value}, ...]},
            'edges': [(src_type, edge_type, tgt_type, src_idx, tgt_idx), ...],
            'meta_relations': set of (src_type, edge_type, tgt_type) tuples,
        }
    """
    node_mappings = {t: {} for t in HGT_NODE_TYPES}
    node_metadata = {t: [] for t in HGT_NODE_TYPES}

    for node_id, data in G.nodes(data=True):
        original_type = data.get('type', '')
        hgt_type = TYPE_CONSOLIDATION.get(original_type)
        if hgt_type is None:
            continue

        idx = len(node_mappings[hgt_type])
        node_mappings[hgt_type][node_id] = idx
        node_metadata[hgt_type].append({
            'original_id': node_id,
            'label': data.get('label', ''),
            'value': data.get('value', data.get('label', '')),
            'subtype': data.get('subtype', original_type),
            'original_type': original_type,
        })

    edges = []
    meta_relations = set()

    for src, tgt, edge_data in G.edges(data=True):
        original_edge_type = edge_data.get('type', '')
        hgt_edge_type = EDGE_CONSOLIDATION.get(original_edge_type, original_edge_type)

        src_data = G.nodes.get(src, {})
        tgt_data = G.nodes.get(tgt, {})
        src_orig_type = src_data.get('type', '')
        tgt_orig_type = tgt_data.get('type', '')

        src_hgt_type = TYPE_CONSOLIDATION.get(src_orig_type)
        tgt_hgt_type = TYPE_CONSOLIDATION.get(tgt_orig_type)

        if src_hgt_type is None or tgt_hgt_type is None:
            continue
        if src not in node_mappings[src_hgt_type] or tgt not in node_mappings[tgt_hgt_type]:
            continue

        src_idx = node_mappings[src_hgt_type][src]
        tgt_idx = node_mappings[tgt_hgt_type][tgt]

        meta_rel = (src_hgt_type, hgt_edge_type, tgt_hgt_type)
        meta_relations.add(meta_rel)

        edges.append({
            'src_type': src_hgt_type,
            'edge_type': hgt_edge_type,
            'tgt_type': tgt_hgt_type,
            'src_idx': src_idx,
            'tgt_idx': tgt_idx,
        })

    logger.info(
        f"Consolidated: {sum(len(v) for v in node_mappings.values())} nodes "
        f"in {len(HGT_NODE_TYPES)} types, "
        f"{len(edges)} edges in {len(meta_relations)} meta-relations"
    )

    return {
        'node_mappings': node_mappings,
        'node_metadata': node_metadata,
        'edges': edges,
        'meta_relations': meta_relations,
    }


def _load_specter2_paper_embeddings(chroma_dir: str):
    """Return {paper_slug: 768-dim np.ndarray} or None if file is missing."""
    path = os.path.join(chroma_dir, 'specter2_paper_embeddings.npz')
    if not os.path.exists(path):
        return None
    try:
        data = np.load(path, allow_pickle=True)
        slugs = data['slugs']
        emb = data['embeddings']
        return {str(slugs[i]): emb[i].astype(np.float32) for i in range(len(slugs))}
    except Exception as e:
        logger.warning(f"  Failed to load SPECTER2 embeddings: {e}")
        return None


def _compute_paper_content_channels(schema: dict, collection) -> np.ndarray:
    """Per-paper content-summary vector (n_papers, CONTENT_DIM)."""
    paper_meta = schema['node_metadata'].get('paper', [])
    n_papers = len(paper_meta)
    out = np.zeros((n_papers, CONTENT_DIM), dtype=np.float32)
    if n_papers == 0:
        return out

    paper_id_by_idx = [m.get('original_id', '').replace('paper:', '') for m in paper_meta]
    idx_by_paper_id = {pid: i for i, pid in enumerate(paper_id_by_idx)}

    chunk_meta_by_paper = defaultdict(list)
    if collection is not None:
        try:
            total = collection.count()
            chunk_data = collection.get(limit=total, include=['metadatas'])
            for m in chunk_data.get('metadatas', []):
                pid = m.get('paper_id', '')
                if pid in idx_by_paper_id:
                    chunk_meta_by_paper[pid].append(m)
        except Exception as e:
            logger.warning(f"  content channels: chunk metadata pull failed ({e})")

    topic_counts = defaultdict(int)
    for chunks in chunk_meta_by_paper.values():
        for m in chunks:
            t = m.get('domain_topics', '') or ''
            for tok in (s.strip() for s in t.split(',')):
                if tok:
                    topic_counts[tok] += 1
    top_topics = [t for t, _ in sorted(topic_counts.items(), key=lambda kv: -kv[1])[:TOPIC_K]]
    topic_idx = {t: i for i, t in enumerate(top_topics)}

    claim_types = {'contribution', 'comparison', 'limitation', 'problem'}
    n_claims_per_paper = np.zeros(n_papers, dtype=np.float32)
    n_equations_per_paper = np.zeros(n_papers, dtype=np.float32)
    for e in schema.get('edges', []):
        if e.get('src_type') != 'paper':
            continue
        src_idx = e.get('src_idx')
        if src_idx is None or src_idx >= n_papers:
            continue
        tgt_t = e.get('tgt_type')
        if tgt_t in claim_types:
            n_claims_per_paper[src_idx] += 1

    for e in schema.get('edges', []):
        if e.get('src_type') == 'paper' and e.get('edge_type') == 'has_equation':
            si = e.get('src_idx')
            if si is not None and si < n_papers:
                n_equations_per_paper[si] += 1

    for i, pid in enumerate(paper_id_by_idx):
        chunks = chunk_meta_by_paper.get(pid, [])
        n = max(1, len(chunks))

        role_hist = np.zeros(len(ROLE_BUCKETS), dtype=np.float32)
        for m in chunks:
            r = m.get('rhetorical_role', 'general')
            if r in ROLE_BUCKETS:
                role_hist[ROLE_BUCKETS.index(r)] += 1
        role_hist /= n

        content_hist = np.zeros(len(CONTENT_BUCKETS), dtype=np.float32)
        for m in chunks:
            c = m.get('content_type', 'general')
            if c in CONTENT_BUCKETS:
                content_hist[CONTENT_BUCKETS.index(c)] += 1
        content_hist /= n

        claim_density = float(min(1.0, n_claims_per_paper[i] / n))
        eqn_density = float(min(1.0, n_equations_per_paper[i] / n))

        topic_vec = np.zeros(TOPIC_K, dtype=np.float32)
        seen_topics = set()
        for m in chunks:
            t = m.get('domain_topics', '') or ''
            for tok in (s.strip() for s in t.split(',')):
                if tok and tok in topic_idx and tok not in seen_topics:
                    topic_vec[topic_idx[tok]] = 1.0
                    seen_topics.add(tok)

        out[i] = np.concatenate([
            role_hist, content_hist,
            [claim_density, eqn_density],
            topic_vec,
        ])
    return out


def _pad_to_feature_dim(emb: np.ndarray) -> np.ndarray:
    """Right-pad an embedding matrix to FEATURE_DIM with zeros."""
    if emb.shape[1] >= FEATURE_DIM:
        return emb[:, :FEATURE_DIM]
    pad = np.zeros((emb.shape[0], FEATURE_DIM - emb.shape[1]), dtype=np.float32)
    return np.concatenate([emb, pad], axis=1)


def compute_node_features(
    schema: dict,
    model,
    collection=None,
    chroma_dir: str = None,
) -> dict:
    """Compute frozen feature vectors for all nodes.

    All node types share FEATURE_DIM (802). Papers get SPECTER2 + content
    channels; all others get sentence-transformer zero-padded.
    """
    features = {}

    specter2_lookup = _load_specter2_paper_embeddings(chroma_dir) if chroma_dir else None
    paper_content = _compute_paper_content_channels(schema, collection)

    for node_type in HGT_NODE_TYPES:
        metadata = schema['node_metadata'][node_type]
        n_nodes = len(metadata)

        if n_nodes == 0:
            features[node_type] = np.zeros((0, FEATURE_DIM), dtype=np.float32)
            continue

        if node_type == 'chunk' and collection is not None:
            chunk_ids = [m['original_id'].replace('chunk:', '') for m in metadata]
            try:
                result = collection.get(ids=chunk_ids, include=['embeddings'])
                embs = result.get('embeddings') if result else None
                if embs is not None and len(embs) > 0:
                    emb_array = np.array(embs, dtype=np.float32)
                    if emb_array.shape[0] == n_nodes:
                        features[node_type] = _pad_to_feature_dim(emb_array)
                        logger.info(f"  {node_type}: {n_nodes} nodes, ChromaDB embeds (padded to {FEATURE_DIM})")
                        continue
            except Exception as e:
                logger.warning(f"  Failed to load chunk embeddings: {e}")

        if node_type == 'paper':
            paper_base = np.zeros((n_nodes, BASE_DIM), dtype=np.float32)
            n_specter = 0
            for i, m in enumerate(metadata):
                slug = m.get('original_id', '').replace('paper:', '')
                if specter2_lookup and slug in specter2_lookup:
                    paper_base[i] = specter2_lookup[slug]
                    n_specter += 1
            missing = [i for i, m in enumerate(metadata)
                       if not (specter2_lookup and
                               m.get('original_id', '').replace('paper:', '') in specter2_lookup)]
            if missing:
                texts = [metadata[i].get('value', '') or metadata[i].get('label', 'unknown')
                         for i in missing]
                texts = [t[:512] for t in texts]
                fallback = np.array(model.encode(texts, show_progress_bar=False, batch_size=64),
                                     dtype=np.float32)
                fallback = _pad_to_feature_dim(fallback)[:, :BASE_DIM]
                for j, i in enumerate(missing):
                    paper_base[i] = fallback[j]

            paper_full = np.concatenate([paper_base, paper_content], axis=1)
            features[node_type] = paper_full
            logger.info(
                f"  {node_type}: {n_nodes} nodes, "
                f"SPECTER2 {n_specter}/{n_nodes} + content channels ({CONTENT_DIM} dims)"
            )
            continue

        texts = []
        for m in metadata:
            text = m.get('value', '') or m.get('label', '')
            if not text or len(text.strip()) < 3:
                text = m.get('label', 'unknown')
            texts.append(text[:512])

        embeddings = model.encode(texts, show_progress_bar=False, batch_size=64)
        emb_array = np.array(embeddings, dtype=np.float32)
        features[node_type] = _pad_to_feature_dim(emb_array)
        logger.info(f"  {node_type}: {n_nodes} nodes, embedded from text (padded to {FEATURE_DIM})")

    return features


def save_schema(schema: dict, features: dict, output_dir: str):
    """Save consolidated schema and features to disk."""
    os.makedirs(output_dir, exist_ok=True)

    np.savez(
        os.path.join(output_dir, 'node_features.npz'),
        **{f'{t}_features': features[t] for t in HGT_NODE_TYPES if t in features}
    )

    mappings_serializable = {
        t: {k: v for k, v in mapping.items()}
        for t, mapping in schema['node_mappings'].items()
    }
    with open(os.path.join(output_dir, 'node_mappings.json'), 'w') as f:
        json.dump(mappings_serializable, f, indent=2)

    with open(os.path.join(output_dir, 'node_metadata.json'), 'w') as f:
        json.dump(schema['node_metadata'], f, indent=2)

    with open(os.path.join(output_dir, 'edge_list.json'), 'w') as f:
        json.dump(schema['edges'], f)

    meta_rels = [list(mr) for mr in schema['meta_relations']]
    with open(os.path.join(output_dir, 'meta_relations.json'), 'w') as f:
        json.dump(meta_rels, f, indent=2)

    logger.info(f"Saved schema to {output_dir}")


def load_schema(output_dir: str) -> tuple:
    """Load saved schema and features.

    Returns:
        (features_dict, node_mappings, node_metadata, edges, meta_relations)
    """
    data = np.load(os.path.join(output_dir, 'node_features.npz'))
    features = {
        t: data[f'{t}_features'] for t in HGT_NODE_TYPES
        if f'{t}_features' in data
    }

    with open(os.path.join(output_dir, 'node_mappings.json')) as f:
        node_mappings = json.load(f)

    with open(os.path.join(output_dir, 'node_metadata.json')) as f:
        node_metadata = json.load(f)

    with open(os.path.join(output_dir, 'edge_list.json')) as f:
        edges = json.load(f)

    with open(os.path.join(output_dir, 'meta_relations.json')) as f:
        meta_relations = [tuple(mr) for mr in json.load(f)]

    return features, node_mappings, node_metadata, edges, meta_relations


def inject_tei_outperforms(G: nx.DiGraph, tei_dir: str, output_dir: str = None):
    """Add outperforms edges extracted from TEI benchmark tables into G.

    Returns the number of new edges added. Edges between node pairs that
    already have an outperforms edge are skipped to avoid duplicates.
    """
    import sys
    _project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    if _project_root not in sys.path:
        sys.path.insert(0, _project_root)
    from backend.rag.tei_table_extractor import extract_outperforms_from_tei

    edges, unresolved = extract_outperforms_from_tei(tei_dir, G, output_dir)

    existing = {(u, v) for u, v, d in G.edges(data=True) if d.get('type') == 'outperforms'}
    added = 0
    for e in edges:
        pair = (e['src_id'], e['tgt_id'])
        if pair in existing:
            continue
        if not G.has_node(e['src_id']) or not G.has_node(e['tgt_id']):
            continue
        G.add_edge(e['src_id'], e['tgt_id'], type='outperforms',
                   metric=e.get('metric', ''), paper_id=e.get('paper_id', ''),
                   provenance='tei_table')
        existing.add(pair)
        added += 1
    return added


def build_and_save(
    G: nx.DiGraph,
    model,
    output_dir: str,
    collection=None,
    tei_dir: str = None,
):
    """Full pipeline: [inject TEI outperforms ->] consolidate -> embed -> save."""
    if tei_dir and os.path.isdir(tei_dir):
        print("[Schema] Extracting outperforms edges from TEI tables...")
        n_added = inject_tei_outperforms(G, tei_dir, output_dir)
        print(f"  Added {n_added} outperforms edges from TEI tables")

    print("[Schema] Consolidating graph types...")
    schema = consolidate_graph(G)

    for t in HGT_NODE_TYPES:
        n = len(schema['node_mappings'][t])
        if n > 0:
            print(f"  {t}: {n} nodes")

    print(f"  Meta-relations: {len(schema['meta_relations'])}")
    print(f"  Edges: {len(schema['edges'])}")

    print("\n[Schema] Computing feature vectors...")
    chroma_dir = os.path.dirname(output_dir.rstrip('/'))
    features = compute_node_features(schema, model, collection, chroma_dir=chroma_dir)

    print("\n[Schema] Saving...")
    save_schema(schema, features, output_dir)

    return schema, features
