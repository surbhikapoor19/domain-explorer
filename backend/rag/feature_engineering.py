"""Feature engineering for the paper knowledge graph.

Computes and attaches features to KG paper nodes using:
  0. CSV column explosion (structured metadata → nodes + edges)
  1. KeyBERT keyphrases (topical fingerprint per paper)
  2. Granular section/role/content embeddings (leveraging chunker metadata)
  3. TF-IDF feature vectors (lexical specificity)
  4. Graph centrality metrics (structural importance in KG)

All features are stored as nodes/edges on the NetworkX DiGraph.
"""

import logging
import re
import numpy as np
import pandas as pd
from collections import defaultdict, Counter
from sklearn.feature_extraction.text import TfidfVectorizer

import networkx as nx

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 0. CSV Column Explosion → Nodes + Edges
# ---------------------------------------------------------------------------

# Which CSV columns to explode and how to model them
CSV_COLUMN_SCHEMA = {
    'Planning Method': {
        'node_type': 'planning_method',
        'edge_type': 'uses_planning_method',
    },
    'Training Data': {
        'node_type': 'training_paradigm',
        'edge_type': 'trained_with',
    },
    'End-effector Hardware': {
        'node_type': 'effector_type',
        'edge_type': 'uses_effector',
    },
    'Object Configuration': {
        'node_type': 'scene_type',
        'edge_type': 'handles_scene',
    },
    'Input Data': {
        'node_type': 'input_modality',
        'edge_type': 'requires_input',
    },
    'Output Pose': {
        'node_type': 'output_format',
        'edge_type': 'outputs',
    },
    'Corresponding Dataset': {
        'node_type': 'dataset',
        'edge_type': 'evaluated_on',
    },
    'Corresponding Dataset (see repository linked above)': {
        'node_type': 'dataset',
        'edge_type': 'evaluated_on',
    },
    'Simulator': {
        'node_type': 'simulator',
        'edge_type': 'simulated_in',
    },
    'Backbone': {
        'node_type': 'backbone_arch',
        'edge_type': 'uses_architecture',
    },
    'Metric(s) Used': {
        'node_type': 'eval_metric',
        'edge_type': 'measured_by',
    },
    'Camera Position(s)': {
        'node_type': 'camera_config',
        'edge_type': 'uses_camera',
    },
    'Year (Initial Release)': {
        'node_type': 'year',
        'edge_type': 'published_in_year',
    },
    'Language': {
        'node_type': 'impl_language',
        'edge_type': 'implemented_in',
    },
    'Maintainer(s)': {
        'node_type': 'author',
        'edge_type': 'maintained_by',
    },
}


def _split_csv_value(value: str) -> list:
    """Split a multi-valued CSV cell into individual values.

    Handles: "Sim, Real", "Two-finger, Multi-finger", "ACRONYM, PRISM"
    """
    if not value or pd.isna(value) or str(value).strip().lower() in ('nan', '', '-', 'n/a', 'none'):
        return []
    raw = str(value).strip()
    # Split on comma, semicolon, or " and "
    parts = re.split(r'[,;]\s*|\s+and\s+', raw)
    return [p.strip() for p in parts if p.strip() and len(p.strip()) > 1]


def explode_csv_columns(
    G: nx.DiGraph,
    csv_path: str,
    method_paper_map: dict,
) -> nx.DiGraph:
    """Explode CSV columns into graph nodes and edges.

    Each unique value in a CSV column becomes a node.
    Each method connects to its values via typed edges.

    Args:
        G: Existing KG (modified in-place)
        csv_path: Path to the methods CSV
        method_paper_map: {method_to_paper: {name: paper_id}, ...}

    Returns:
        Modified graph
    """
    df = pd.read_csv(csv_path)
    m2p = method_paper_map.get('method_to_paper', {})

    n_nodes_added = 0
    n_edges_added = 0

    for _, row in df.iterrows():
        method_name = str(row.get('Name', '')).replace('🤖 ', '').strip()
        method_node = f"method:{method_name}"

        # If method isn't in the graph (no paper match), add it
        if method_node not in G:
            G.add_node(method_node, label=method_name, type='method', paper_id='')

        for col, schema in CSV_COLUMN_SCHEMA.items():
            raw_value = row.get(col, '')
            values = _split_csv_value(raw_value)

            for val in values:
                val_clean = val.strip()
                node_type = schema['node_type']
                edge_type = schema['edge_type']
                node_id = f"{node_type}:{val_clean.lower()}"

                if node_id not in G:
                    G.add_node(node_id,
                               label=val_clean,
                               type=node_type,
                               value=val_clean,
                               column=col)
                    n_nodes_added += 1

                if not G.has_edge(method_node, node_id):
                    G.add_edge(method_node, node_id,
                               type=edge_type,
                               column=col)
                    n_edges_added += 1

    logger.info(f"CSV explosion: {n_nodes_added} attribute nodes, {n_edges_added} edges")
    print(f"[Features] CSV explosion: {n_nodes_added} attribute nodes, {n_edges_added} edges")
    return G


# ---------------------------------------------------------------------------
# 0b. Chunk Nodes + Cross-Paper Chunk Edges
# ---------------------------------------------------------------------------

def add_chunk_nodes(
    G: nx.DiGraph,
    collection,
    model,
    layer: str = "mid",
    similarity_threshold: float = 0.72,   # p99 of cross-paper distribution
    similarity_top_k: int = 5,
    role_similarity_threshold: float = 0.66,  # p95 of same-role cross-paper distribution
    role_similarity_top_k: int = 3,
) -> nx.DiGraph:
    """Add chunks as first-class nodes and create cross-paper edges
    based on embedding/text similarity.

    Each mid-layer chunk becomes a node connected to its paper.
    Cross-paper edges are created based on:
      1. Global embedding similarity (any chunk ↔ any chunk across papers)
      2. Same-role embedding similarity (method↔method, result↔result)
         — uses a lower threshold since role context already constrains relevance

    Threshold derivation (517 mid-layer chunks, 128K cross-paper pairs):
      Cross-paper similarity: mean=0.43, std=0.16
      Global threshold 0.72 = p99 (top 1% of pairs)
      Same-role threshold 0.66 = p95 (top 5%, constrained by shared role)

    Args:
        G: Knowledge graph (modified in-place)
        collection: ChromaDB collection
        model: SentenceTransformer for computing similarities
        layer: Which chunk layer to use ("mid" recommended)
        similarity_threshold: Min cosine similarity for global cross-paper edges
        similarity_top_k: Max similar chunks to link per chunk (global)
        role_similarity_threshold: Lower threshold for same-role edges
        role_similarity_top_k: Max per chunk for same-role edges

    Returns:
        Modified graph
    """
    # Fetch all chunks of the target layer
    total = collection.count()
    all_data = collection.get(
        include=["documents", "metadatas", "embeddings"],
        limit=total,
    )

    # Filter to target layer
    chunk_indices = []
    for i, meta in enumerate(all_data["metadatas"]):
        if meta.get("layer") == layer:
            chunk_indices.append(i)

    n_papers = len(set(
        all_data["metadatas"][i].get('paper_id', '')
        for i in chunk_indices
    ))
    print(f"[Chunks] Found {len(chunk_indices)} {layer}-layer chunks across {n_papers} papers")

    # Build chunk data
    chunks = []
    for i in chunk_indices:
        meta = all_data["metadatas"][i]
        chunks.append({
            "idx": i,
            "chunk_id": all_data["ids"][i],
            "paper_id": meta.get("paper_id", ""),
            "section": meta.get("section", ""),
            "rhetorical_role": meta.get("rhetorical_role", ""),
            "content_type": meta.get("content_type", ""),
            "chunk_type": meta.get("chunk_type", ""),
            "domain_topics": set(
                t.strip() for t in meta.get("domain_topics", "").split(",")
                if t.strip()
            ),
            "text_preview": (all_data["documents"][i] or "")[:100],
        })

    # ── Step 1: Add chunk nodes + paper edges ──
    n_chunk_nodes = 0
    for c in chunks:
        node_id = f"chunk:{c['chunk_id']}"
        G.add_node(
            node_id,
            type="chunk",
            label=f"{c['section'][:30]} ({c['rhetorical_role']})",
            paper_id=c["paper_id"],
            section=c["section"],
            rhetorical_role=c["rhetorical_role"],
            content_type=c["content_type"],
            chunk_type=c["chunk_type"],
            n_topics=len(c["domain_topics"]),
            text_preview=c["text_preview"],
        )
        paper_node = f"paper:{c['paper_id']}"
        if paper_node in G:
            G.add_edge(paper_node, node_id, type="contains_chunk",
                        section=c["section"], role=c["rhetorical_role"])
        n_chunk_nodes += 1

    print(f"[Chunks] Added {n_chunk_nodes} chunk nodes")

    # ── Step 2: Embedding-based cross-paper edges ──
    embeddings = all_data.get("embeddings")
    if embeddings is None or len(embeddings) == 0:
        print("[Chunks] No embeddings available, skipping similarity edges")
        return G

    chunk_embeddings = np.array([embeddings[c["idx"]] for c in chunks])
    norms = np.linalg.norm(chunk_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    chunk_emb_normed = chunk_embeddings / norms

    # Pre-compute paper_id index for masking
    paper_ids = [c["paper_id"] for c in chunks]
    roles = [c["rhetorical_role"] for c in chunks]

    # 2a. Global similarity: any chunk ↔ any chunk (different paper)
    n_global_edges = 0
    # 2b. Same-role similarity: method↔method, result↔result (lower threshold)
    n_role_edges = 0

    LINKABLE_ROLES = {"result", "algorithm_description", "experimental_setup", "comparison", "limitation"}

    batch_size = 100
    for start in range(0, len(chunks), batch_size):
        end = min(start + batch_size, len(chunks))
        batch = chunk_emb_normed[start:end]
        sims = batch @ chunk_emb_normed.T  # (batch_size, n_chunks)

        for bi, ci_a in enumerate(range(start, end)):
            pid_a = paper_ids[ci_a]
            role_a = roles[ci_a]
            sim_row = sims[bi].copy()

            # Mask same-paper chunks
            for ci_b in range(len(chunks)):
                if paper_ids[ci_b] == pid_a:
                    sim_row[ci_b] = -1

            node_a = f"chunk:{chunks[ci_a]['chunk_id']}"

            # 2a. Global top-k
            top_global = np.argsort(sim_row)[-similarity_top_k:][::-1]
            for ci_b in top_global:
                score = float(sim_row[ci_b])
                if score < similarity_threshold:
                    continue
                node_b = f"chunk:{chunks[ci_b]['chunk_id']}"
                if not G.has_edge(node_a, node_b):
                    G.add_edge(node_a, node_b,
                               type="semantically_similar",
                               weight=round(score, 4))
                    n_global_edges += 1

            # 2b. Same-role similarity (lower threshold, separate top-k)
            if role_a in LINKABLE_ROLES:
                role_sim = sim_row.copy()
                # Mask chunks with different roles
                for ci_b in range(len(chunks)):
                    if roles[ci_b] != role_a:
                        role_sim[ci_b] = -1

                top_role = np.argsort(role_sim)[-role_similarity_top_k:][::-1]
                for ci_b in top_role:
                    score = float(role_sim[ci_b])
                    if score < role_similarity_threshold:
                        continue
                    node_b = f"chunk:{chunks[ci_b]['chunk_id']}"
                    if not G.has_edge(node_a, node_b):
                        shared_role = role_a
                        G.add_edge(node_a, node_b,
                                   type="similar_in_role",
                                   weight=round(score, 4),
                                   shared_role=shared_role)
                        n_role_edges += 1

    print(f"[Chunks] Global similarity edges: {n_global_edges} (threshold={similarity_threshold})")
    print(f"[Chunks] Same-role similarity edges: {n_role_edges} (threshold={role_similarity_threshold})")
    print(f"[Chunks] Total: {n_chunk_nodes} nodes, {n_global_edges + n_role_edges} cross-paper edges")

    return G


# ---------------------------------------------------------------------------
# 0c. Figure/Table Nodes from Chunks
# ---------------------------------------------------------------------------

def _extract_table_caption(text: str, section: str) -> str:
    """Find 'Table N: ...' / 'TABLE N ...' caption, else use first non-pipe line, else section."""
    import re
    # Look for explicit table caption on any line
    for line in text.split('\n')[:10]:
        m = re.match(r'^\s*(TABLE|Table)\s+([IVX\d]+)[\.:\s]+(.{3,80})', line)
        if m:
            caption = m.group(3).strip().rstrip('.').strip('|').strip()
            return f"Table {m.group(2)}: {caption[:70]}"
        m2 = re.match(r'^\s*(TABLE|Table)\s+([IVX\d]+)\s*$', line)
        if m2:
            return f"Table {m2.group(2)}"
    # Use section heading if it starts with "Table"
    if section and section.lower().startswith('table'):
        return section[:70]
    # First meaningful non-pipe non-separator line
    for line in text.split('\n')[:5]:
        stripped = line.strip().strip('|').strip()
        if stripped and '---' not in stripped and len(stripped) > 3:
            return stripped[:70]
    return section[:60] if section else 'Table'


def _looks_like_table(text: str, section: str) -> bool:
    """Heuristic: real markdown tables, not LaTeX equations."""
    if not text:
        return False
    # Exclude LaTeX-heavy content
    latex_markers = ('\\text', '\\frac', '\\sum', '\\int', '_{', '^{', '\\mathcal', '\\begin{equation')
    if any(m in text for m in latex_markers):
        return False
    lines = text.split('\n')
    pipe_lines = [ln for ln in lines if ln.count('|') >= 2]
    has_separator = any('---' in ln and '|' in ln for ln in lines)
    if has_separator and len(pipe_lines) >= 2:
        return True
    # Section explicitly named "Table X" with multi-row pipe content
    if section and section.lower().startswith('table') and len(pipe_lines) >= 3:
        return True
    return False


def add_figure_table_nodes(G: nx.DiGraph, collection) -> nx.DiGraph:
    """Extract figure captions and table content from chunks as dedicated graph nodes.

    These are high-value content that contain results summaries and visual descriptions
    but are currently buried in generic chunk nodes.
    """
    total = collection.count()
    all_data = collection.get(include=["documents", "metadatas"], limit=total)

    n_figures = 0
    n_tables = 0

    for i, meta in enumerate(all_data["metadatas"]):
        pid = meta.get("paper_id", "")
        text = all_data["documents"][i] or ""
        chunk_type = meta.get("chunk_type", "")
        section = meta.get("section", "")

        paper_node = f"paper:{pid}"
        if paper_node not in G:
            continue

        # Figure captions
        if chunk_type == "figure_captions" and len(text.strip()) > 20:
            fig_id = f"figure:{pid}_{n_figures}"
            label = text.strip()[:80]
            G.add_node(fig_id, type="figure", label=label, paper_id=pid,
                       value=text.strip()[:300], section=section)
            G.add_edge(paper_node, fig_id, type="has_figure")
            n_figures += 1

        # Tables: require real markdown table structure, not LaTeX equations
        if _looks_like_table(text, section) and len(text.strip()) > 30:
            tbl_id = f"table:{pid}_{n_tables}"
            label = _extract_table_caption(text, section)
            G.add_node(tbl_id, type="table", label=label, paper_id=pid,
                       value=text.strip()[:1200], section=section)
            G.add_edge(paper_node, tbl_id, type="has_table")
            n_tables += 1

    print(f"[Features] Figure/table nodes: {n_figures} figures, {n_tables} tables")
    return G


# ---------------------------------------------------------------------------
# 1. KeyBERT Keyphrases
# ---------------------------------------------------------------------------

def compute_keyphrases(paper_texts: dict, model, top_n: int = 10) -> dict:
    """Extract keyphrases per paper using KeyBERT.

    Args:
        paper_texts: {paper_id: full_text_or_abstract}
        model: SentenceTransformer instance (reused from existing pipeline)
        top_n: Number of keyphrases per paper

    Returns:
        {paper_id: [(phrase, score), ...]}
    """
    from keybert import KeyBERT
    kw_model = KeyBERT(model=model)

    results = {}
    for pid, text in paper_texts.items():
        if not text or len(text.split()) < 20:
            results[pid] = []
            continue
        try:
            keyphrases = kw_model.extract_keywords(
                text[:5000],  # cap input length
                keyphrase_ngram_range=(1, 3),
                stop_words="english",
                top_n=top_n,
                use_mmr=True,
                diversity=0.5,
            )
            results[pid] = keyphrases
        except Exception as e:
            logger.warning(f"KeyBERT failed for {pid}: {e}")
            results[pid] = []

    logger.info(f"Keyphrases: extracted for {len(results)} papers")
    return results


# ---------------------------------------------------------------------------
# 2. Granular Section/Role/Content Embeddings
# ---------------------------------------------------------------------------

# Embedding dimensions we compute per paper, using the chunker's metadata
EMBEDDING_SLICES = {
    # By rhetorical role
    'emb_problem_statement': {'rhetorical_role': 'problem_statement'},
    'emb_algorithm_description': {'rhetorical_role': 'algorithm_description'},
    'emb_experimental_setup': {'rhetorical_role': 'experimental_setup'},
    'emb_result': {'rhetorical_role': 'result'},
    'emb_comparison': {'rhetorical_role': 'comparison'},
    'emb_limitation': {'rhetorical_role': 'limitation'},
    # By content type
    'emb_theory': {'content_type': 'theory'},
    'emb_implementation': {'content_type': 'implementation'},
    'emb_evaluation': {'content_type': 'evaluation'},
    # By chunk type
    'emb_abstract': {'chunk_type': 'abstract'},
    'emb_equations': {'chunk_type': 'equation'},
    'emb_citations': {'chunk_type': 'citation_context'},
    'emb_figures': {'chunk_type': 'figure_captions'},
}


def compute_granular_embeddings(
    collection,
    paper_ids: list,
    model,
) -> dict:
    """Compute granular embeddings per paper by aggregating chunk embeddings
    filtered by rhetorical role, content type, and chunk type.

    Uses the rich metadata already set by the chunker — no re-processing needed.

    Args:
        collection: ChromaDB collection with chunks
        paper_ids: List of paper IDs to process
        model: SentenceTransformer instance

    Returns:
        {paper_id: {emb_name: np.array(384,) or None, ...}}
    """
    results = {}

    for pid in paper_ids:
        # Fetch all chunks for this paper
        data = collection.get(
            where={"paper_id": pid},
            include=["documents", "metadatas"],
        )
        if not data or not data.get("documents"):
            results[pid] = {}
            continue

        paper_embeddings = {}

        for emb_name, filter_spec in EMBEDDING_SLICES.items():
            # Filter chunks matching this slice
            matching_texts = []
            for doc, meta in zip(data["documents"], data["metadatas"]):
                match = all(
                    meta.get(key, '') == val
                    for key, val in filter_spec.items()
                )
                if match and doc and len(doc.split()) > 10:
                    matching_texts.append(doc)

            if matching_texts:
                # Combine and embed (truncate to model max length)
                combined = ' '.join(matching_texts)[:2048]
                emb = model.encode(combined)
                paper_embeddings[emb_name] = emb
            else:
                paper_embeddings[emb_name] = None

        # Also compute: domain topic distribution vector
        topic_counts = Counter()
        total_chunks = 0
        for meta in data["metadatas"]:
            topics_str = meta.get('domain_topics', '')
            if topics_str:
                for t in topics_str.split(', '):
                    if t.strip():
                        topic_counts[t.strip()] += 1
            total_chunks += 1

        paper_embeddings['topic_distribution'] = dict(topic_counts)
        paper_embeddings['n_chunks'] = total_chunks

        # Role distribution (what % of chunks are each role)
        role_counts = Counter(m.get('rhetorical_role', '') for m in data["metadatas"])
        if total_chunks > 0:
            paper_embeddings['role_distribution'] = {
                role: count / total_chunks
                for role, count in role_counts.items()
            }
        else:
            paper_embeddings['role_distribution'] = {}

        # Content type distribution
        ct_counts = Counter(m.get('content_type', '') for m in data["metadatas"])
        if total_chunks > 0:
            paper_embeddings['content_distribution'] = {
                ct: count / total_chunks
                for ct, count in ct_counts.items()
            }
        else:
            paper_embeddings['content_distribution'] = {}

        results[pid] = paper_embeddings

    logger.info(f"Granular embeddings: computed {len(EMBEDDING_SLICES)} slices for {len(results)} papers")
    return results


# ---------------------------------------------------------------------------
# 3. TF-IDF Feature Vectors
# ---------------------------------------------------------------------------

def compute_tfidf_features(
    paper_texts: dict,
    max_features: int = 500,
) -> tuple:
    """Compute TF-IDF vectors per paper.

    Args:
        paper_texts: {paper_id: full_text}
        max_features: Max vocabulary size

    Returns:
        (paper_ids, tfidf_matrix, feature_names, top_terms_per_paper)
        - tfidf_matrix: scipy sparse matrix (n_papers x max_features)
        - top_terms_per_paper: {paper_id: [(term, score), ...]}
    """
    pids = sorted(paper_texts.keys())
    texts = [paper_texts[pid] for pid in pids]

    vectorizer = TfidfVectorizer(
        max_features=max_features,
        stop_words='english',
        ngram_range=(1, 2),
        min_df=2,      # term must appear in at least 2 papers
        max_df=0.8,    # skip terms in >80% of papers
    )

    tfidf_matrix = vectorizer.fit_transform(texts)
    feature_names = vectorizer.get_feature_names_out()

    # Extract top terms per paper
    top_terms = {}
    for i, pid in enumerate(pids):
        row = tfidf_matrix[i].toarray().flatten()
        top_indices = row.argsort()[-15:][::-1]
        top_terms[pid] = [
            (feature_names[j], round(float(row[j]), 4))
            for j in top_indices if row[j] > 0
        ]

    logger.info(f"TF-IDF: {tfidf_matrix.shape[0]} papers x {tfidf_matrix.shape[1]} terms")
    return pids, tfidf_matrix, feature_names, top_terms


# ---------------------------------------------------------------------------
# 4. Graph Centrality Features
# ---------------------------------------------------------------------------

def compute_graph_centrality(G: nx.DiGraph) -> dict:
    """Compute centrality metrics for paper nodes in the KG.

    Returns:
        {paper_id: {pagerank, degree, betweenness, in_degree, out_degree, n_techniques}}
    """
    # PageRank on the full directed graph
    try:
        pagerank = nx.pagerank(G, alpha=0.85)
    except nx.PowerIterationFailedConvergence:
        pagerank = {n: 0.0 for n in G.nodes()}

    # Betweenness centrality
    betweenness = nx.betweenness_centrality(G)

    # Degree centrality
    degree_cent = nx.degree_centrality(G)

    results = {}
    for node_id, data in G.nodes(data=True):
        if data.get('type') != 'paper':
            continue
        pid = data.get('paper_id', '')

        # Count connected nodes by type
        successors = list(G.successors(node_id))
        n_techniques = sum(1 for s in successors if G.nodes[s].get('type') == 'technique')
        n_contributions = sum(1 for s in successors if G.nodes[s].get('type') == 'contribution')
        n_comparisons = sum(1 for s in successors if G.nodes[s].get('type') == 'comparison')
        n_hardware = sum(1 for s in successors if G.nodes[s].get('type') == 'hardware')
        n_problems = sum(1 for s in successors if G.nodes[s].get('type') == 'problem')

        results[pid] = {
            'pagerank': round(pagerank.get(node_id, 0.0), 6),
            'betweenness': round(betweenness.get(node_id, 0.0), 6),
            'degree_centrality': round(degree_cent.get(node_id, 0.0), 6),
            'in_degree': G.in_degree(node_id),
            'out_degree': G.out_degree(node_id),
            'n_techniques': n_techniques,
            'n_contributions': n_contributions,
            'n_comparisons': n_comparisons,
            'n_hardware': n_hardware,
            'n_problems': n_problems,
        }

    logger.info(f"Centrality: computed for {len(results)} paper nodes")
    return results


# ---------------------------------------------------------------------------
# 5. Integrate all features into the KG
# ---------------------------------------------------------------------------

def enrich_knowledge_graph(
    G: nx.DiGraph,
    collection,
    model,
    paper_texts: dict = None,
    csv_path: str = None,
    method_paper_map: dict = None,
    skip_figure_table_heuristic: bool = False,
) -> nx.DiGraph:
    """Compute all features and attach them to KG paper nodes.

    Args:
        G: Existing knowledge graph (modified in-place)
        collection: ChromaDB collection with chunks
        model: SentenceTransformer instance
        paper_texts: {paper_id: full_text} for keyphrases and TF-IDF.
                     If None, builds from ChromaDB chunks.
        csv_path: Path to methods CSV for column explosion
        method_paper_map: For CSV explosion

    Returns:
        The enriched graph (same object, modified in-place).
    """
    # Get paper IDs from graph
    paper_ids = [
        data['paper_id']
        for _, data in G.nodes(data=True)
        if data.get('type') == 'paper'
    ]

    # Build paper_texts from chunks if not provided
    if paper_texts is None:
        paper_texts = {}
        for pid in paper_ids:
            data = collection.get(
                where={"paper_id": pid},
                include=["documents"],
            )
            if data and data.get("documents"):
                paper_texts[pid] = ' '.join(data["documents"])

    print(f"[Features] Processing {len(paper_ids)} papers...")

    # 0a. CSV column explosion
    if csv_path and method_paper_map:
        print("[Features] 0a/5 Exploding CSV columns into graph...")
        explode_csv_columns(G, csv_path, method_paper_map)

    # 0b. Chunk nodes + cross-paper edges
    print("[Features] 0b/5 Adding chunk nodes + cross-paper edges...")
    add_chunk_nodes(G, collection, model)

    # 0c. Figure/table nodes (skipped when TEI extraction already populated them)
    if skip_figure_table_heuristic:
        print("[Features] 0c/5 Figure/table nodes already provided by TEI (skipping heuristic)")
    else:
        print("[Features] 0c/5 Extracting figure/table nodes...")
        add_figure_table_nodes(G, collection)

    # 1. KeyBERT keyphrases
    print("[Features] 1/4 Extracting keyphrases...")
    keyphrases = compute_keyphrases(paper_texts, model)

    # 2. Granular embeddings from chunk metadata
    print("[Features] 2/4 Computing granular embeddings...")
    granular = compute_granular_embeddings(collection, paper_ids, model)

    # 3. TF-IDF
    print("[Features] 3/4 Computing TF-IDF vectors...")
    _, tfidf_matrix, feature_names, top_terms = compute_tfidf_features(paper_texts)

    # 4. Graph centrality
    print("[Features] 4/4 Computing graph centrality...")
    centrality = compute_graph_centrality(G)

    # ── Attach features as nodes + edges ──

    n_keyphrase_nodes = 0
    n_topic_nodes = 0
    n_tfidf_nodes = 0

    for pid in paper_ids:
        node_id = f"paper:{pid}"
        if node_id not in G:
            continue

        # --- Keyphrases as nodes + edges ---
        # Each keyphrase becomes a shared node; papers connect to it
        kps = keyphrases.get(pid, [])
        for phrase, score in kps:
            kp_id = f"keyphrase:{phrase.lower()}"
            if kp_id not in G:
                G.add_node(kp_id, label=phrase, type='keyphrase', value=phrase)
                n_keyphrase_nodes += 1
            G.add_edge(node_id, kp_id, type='has_keyphrase', weight=round(score, 4))

        # --- Domain topics as nodes + edges ---
        gr = granular.get(pid, {})
        topic_dist = gr.get('topic_distribution', {})
        for topic, count in topic_dist.items():
            topic_id = f"topic:{topic.lower()}"
            if topic_id not in G:
                G.add_node(topic_id, label=topic, type='topic', value=topic)
                n_topic_nodes += 1
            G.add_edge(node_id, topic_id, type='discusses_topic', weight=count)

        # --- TF-IDF top terms as nodes + edges ---
        for term, score in top_terms.get(pid, [])[:8]:  # top 8 per paper
            term_id = f"term:{term.lower()}"
            if term_id not in G:
                G.add_node(term_id, label=term, type='tfidf_term', value=term)
                n_tfidf_nodes += 1
            G.add_edge(node_id, term_id, type='has_distinctive_term', weight=round(score, 4))

        # --- Granular embeddings as node attributes (too high-dim for edges) ---
        for emb_name in EMBEDDING_SLICES:
            emb = gr.get(emb_name)
            if emb is not None:
                G.nodes[node_id][emb_name] = emb.tolist()

        # --- Distributions as node attributes ---
        G.nodes[node_id]['role_distribution'] = gr.get('role_distribution', {})
        G.nodes[node_id]['content_distribution'] = gr.get('content_distribution', {})
        G.nodes[node_id]['n_chunks'] = gr.get('n_chunks', 0)

        # --- Centrality as node attributes ---
        cent = centrality.get(pid, {})
        for key, val in cent.items():
            G.nodes[node_id][key] = val

    n_with_emb = sum(1 for pid in paper_ids if granular.get(pid, {}).get('emb_abstract') is not None)
    n_with_cent = sum(1 for pid in paper_ids if centrality.get(pid))

    print(f"\n[Features] Enrichment complete:")
    print(f"  Keyphrase nodes: {n_keyphrase_nodes} (edges to papers via has_keyphrase)")
    print(f"  Topic nodes: {n_topic_nodes} (edges to papers via discusses_topic)")
    print(f"  TF-IDF term nodes: {n_tfidf_nodes} (edges to papers via has_distinctive_term)")
    print(f"  Granular embeddings: {n_with_emb}/{len(paper_ids)} papers (13 slices each)")
    print(f"  Centrality metrics: {n_with_cent}/{len(paper_ids)} papers")

    return G
