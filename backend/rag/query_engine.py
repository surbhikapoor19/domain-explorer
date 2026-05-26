"""Deterministic query engine: replaces LLM Pass 1 with ML-based decisions.

Given a natural language query, this module:
1. Embeds the query with sentence-transformer
2. Searches ChromaDB for relevant paper chunks
3. Computes query-to-method similarity to find relevant methods
4. Adjusts column weights based on query-column similarity
5. Picks color-by and highlight methods deterministically

The LLM is only used for Pass 2: interpreting results.
"""

import re
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from collections import Counter, defaultdict


# Column keywords for deterministic weight boosting
COLUMN_KEYWORDS = {
    'Planning Method': [
        'planning', 'sampling', 'regression', 'analytical', 'optimization',
        'reinforcement learning', 'rl', 'generative', 'diffusion', 'vae',
    ],
    'Training Data': [
        'training', 'sim', 'real', 'sim-to-real', 'transfer', 'dataset',
        'synthetic', 'self-supervised', 'supervised',
    ],
    'End-effector Hardware': [
        'gripper', 'two-finger', 'parallel-jaw', 'multi-finger', 'dexterous',
        'suction', 'hand', 'end-effector',
    ],
    'Object Configuration': [
        'cluttered', 'piled', 'singulated', 'packed', 'bin picking',
        'scene', 'objects', 'stacked',
    ],
    'Input Data': [
        'point cloud', 'depth', 'rgb', 'rgbd', 'image', 'voxel', 'tsdf',
        'tactile', 'sensor', 'camera',
    ],
    'Output Pose': [
        '6-dof', '7-dof', 'grasp pose', 'pose', 'configuration',
        'rectangle', 'quality',
    ],
    'Backbone': [
        'pointnet', 'resnet', 'vgg', 'transformer', 'cnn', 'architecture',
        'network', 'encoder', 'decoder',
    ],
    'Metric(s) Used ': [
        'metric', 'loss', 'loss function', 'success rate', 'accuracy',
        'precision', 'recall', 'evaluation',
    ],
    'Corresponding Dataset (see repository linked above)': [
        'dataset', 'benchmark', 'acronym', 'graspnet', 'ycb', 'shapenet',
    ],
    'Simulator (see repository linked above)': [
        'simulator', 'simulation', 'isaac', 'mujoco', 'pybullet', 'gazebo',
    ],
    'Camera Position(s)': [
        'camera', 'overhead', 'eye-in-hand', 'multi-view', 'viewpoint',
    ],
    'Language': [
        'pytorch', 'tensorflow', 'python', 'framework', 'implementation',
    ],
    'Description': [
        'describe', 'overview', 'summary', 'about', 'explain',
    ],
}

# Color-by mapping: query keywords -> best column to color by
COLOR_BY_KEYWORDS = {
    'Planning Method': ['planning', 'sampling', 'regression', 'rl', 'approach', 'method type'],
    'Training Data': ['training', 'sim-to-real', 'transfer', 'trained in simulation', 'trained on real'],
    'End-effector Hardware': ['gripper', 'finger', 'dexterous', 'suction', 'end-effector', 'hand'],
    'Object Configuration': ['cluttered', 'piled', 'scene', 'objects', 'singulated', 'bin'],
    'Input Data': ['point cloud', 'depth', 'rgb', 'image', 'sensor', 'input modality'],
    'Corresponding Dataset (see repository linked above)': ['dataset', 'benchmark', 'comparable', 'same dataset', 'acronym', 'ycb', 'graspnet'],
    'Simulator (see repository linked above)': ['simulator', 'same simulator', 'isaac', 'mujoco', 'pybullet', 'gazebo'],
    'Backbone': ['architecture', 'network', 'pointnet', 'transformer', 'cnn', 'backbone'],
    'Learning Paradigm': ['learning', 'paradigm', 'classical', 'hybrid'],
    'Sensor Complexity': ['sensor', 'modality', 'multimodal', '3d', '2d'],
    'Scene Difficulty': ['difficulty', 'easy', 'hard', 'complex'],
    'Gripper Type': ['gripper type', 'parallel-jaw', 'dexterous', 'suction'],
    'Method Era': ['year', 'era', 'recent', 'old', 'modern', 'pioneer', 'evolution', 'trends'],
}


def compute_query_column_relevance(query: str, model) -> dict:
    """Compute how relevant each column is to the query using embedding similarity.

    Returns dict of column_name -> similarity_score.
    """
    query_lower = query.lower()

    # Keyword-based scoring (fast, deterministic)
    scores = {}
    for col, keywords in COLUMN_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in query_lower)
        scores[col] = score

    return scores


def compute_weights_from_query(query: str, default_weights: dict, model=None) -> dict:
    """Adjust column weights based on query relevance. Boost relevant columns, keep others at default.

    Gentle boosting: increase by 30-50% for relevant columns, not 2-3x.
    This preserves the overall UMAP shape while giving more separation along
    the queried dimension.
    """
    relevance = compute_query_column_relevance(query, model)

    weights = dict(default_weights)
    for col, score in relevance.items():
        if col in weights and score > 0:
            # Gentle boost: +3 to +6, not +9 to +10
            boost = min(score * 2, 6)
            weights[col] = min(16, weights[col] + boost)

    return weights


def pick_color_by(query: str, weights: dict = None, default_weights: dict = None) -> str:
    """Deterministically pick the best color-by column from query keywords.
    Falls back to the most-boosted weight column if no keywords match."""
    query_lower = query.lower()
    best_col = 'cluster'
    best_score = 0

    for col, keywords in COLOR_BY_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in query_lower)
        if score > best_score:
            best_score = score
            best_col = col

    # If no keyword match but weights were boosted, color by the most-boosted column
    if best_score == 0 and weights and default_weights:
        max_boost = 0
        for col, w in weights.items():
            default = default_weights.get(col, 10)
            boost = w - default
            if boost > max_boost and col in COLOR_BY_KEYWORDS:
                max_boost = boost
                best_col = col

    return best_col


def find_relevant_methods(query: str, df, model, top_k: int = 10) -> list:
    """Find methods most relevant to the query using embedding similarity.

    Embeds the query and compares against method Description embeddings.
    Returns list of method names sorted by relevance.
    """
    # Embed query
    query_embedding = model.encode(query).reshape(1, -1)

    # Embed all descriptions
    descriptions = df['Description'].fillna('').tolist()
    names = df['Name'].tolist()

    # Also match against concatenated key columns for broader matching
    combined = []
    for _, row in df.iterrows():
        parts = [str(row.get('Description', ''))]
        for col in ['Planning Method', 'End-effector Hardware', 'Input Data',
                     'Object Configuration', 'Training Data']:
            val = str(row.get(col, '')) if not (isinstance(row.get(col), float) and np.isnan(row.get(col))) else ''
            if val:
                parts.append(val)
        combined.append(' '.join(parts))

    desc_embeddings = model.encode(combined, show_progress_bar=False)

    # Cosine similarity
    sims = cosine_similarity(query_embedding, desc_embeddings)[0]

    # Sort by similarity
    ranked = sorted(zip(names, sims), key=lambda x: x[1], reverse=True)

    return ranked[:top_k]


def should_filter(query: str) -> bool:
    """Determine if the query implies filtering to a subset of methods."""
    query_lower = query.lower()
    # Comparison and exploration queries should NOT filter
    no_filter_signals = ['compare', 'comparable', 'comparison', 'overview', 'all methods',
                          'landscape', 'field', 'difference between', 'vs', 'versus',
                          'how do', 'survey', 'same dataset', 'same simulator',
                          'directly comparable', 'differ', 'trends', 'evolution',
                          'gaps', 'underrepresented', 'what gaps']
    if any(s in query_lower for s in no_filter_signals):
        return False
    # Filter signals
    filter_signals = ['which methods', 'find methods', 'methods for', 'methods that',
                       'best for', 'suitable for', 'show me', 'i need']
    return any(s in query_lower for s in filter_signals)


# Mapping of query terms to column values for precise attribute-based filtering
ATTRIBUTE_TERMS = {
    'End-effector Hardware': {
        'multi-finger': ['Multi-finger'],
        'dexterous': ['Multi-finger', 'Three-finger'],
        'three-finger': ['Three-finger'],
        'two-finger': ['Two-finger'],
        'parallel-jaw': ['Two-finger'],
        'suction': ['Suction'],
    },
    'Object Configuration': {
        'cluttered': ['Cluttered'],
        'piled': ['Piled'],
        'singulated': ['Singulated'],
        'packed': ['Packed'],
        'structured': ['Structured'],
        'stacked': ['Stacked'],
        'bin picking': ['Piled', 'Cluttered'],
    },
    'Planning Method': {
        'sampling': ['Sampling'],
        'direct regression': ['Direct regression'],
        'reinforcement learning': ['Reinforcement learning'],
        'analytical': ['Analytical'],
        'generative': ['Generative'],
        'optimization': ['Optimization'],
        'rl': ['Reinforcement learning'],
    },
    'Training Data': {
        'sim-to-real': ['Sim', 'Real'],
        'simulation': ['Sim'],
        'sim only': ['Sim'],
        'real data': ['Real'],
        'training-less': ['Training-less'],
        'training less': ['Training-less'],
    },
    'Input Data': {
        'point cloud': ['Point cloud'],
        'depth image': ['Depth image'],
        'rgbd': ['RGBD image'],
        'rgb-d': ['RGBD image'],
        'rgb image': ['RGB image'],
        'tactile': ['Tactile'],
        'voxel': ['voxelized occupancy grid'],
        'tsdf': ['Truncated Signed Distance Function (TSDF)'],
    },
}


def attribute_filter(query: str, df) -> list:
    """Filter methods by matching query terms against actual column values.

    Returns list of method names that match, or None if no attribute terms found.
    More precise than embedding similarity for queries mentioning specific attributes.
    """
    query_lower = query.lower()
    matched_filters = {}  # column -> set of target values

    for col, term_map in ATTRIBUTE_TERMS.items():
        for term, values in term_map.items():
            if term in query_lower:
                if col not in matched_filters:
                    matched_filters[col] = set()
                matched_filters[col].update(values)

    if not matched_filters:
        return None

    # Filter: method must match ALL columns that had terms (AND across columns)
    # Within a column, any value matches (OR within column)
    matching = []
    for _, row in df.iterrows():
        passes_all = True
        for col, target_values in matched_filters.items():
            cell = str(row.get(col, ''))
            cell_values = [v.strip() for v in cell.split(',')]
            if not any(tv in cell_values or tv.lower() in cell.lower() for tv in target_values):
                passes_all = False
                break
        if passes_all:
            matching.append(row['Name'])

    return matching if len(matching) >= 2 else None


def extract_citations_from_chunks(chunks) -> list:
    """Extract academic citations referenced within retrieved chunk text.

    Looks for patterns like:
      - Author-year: (Smith et al., 2022), (Smith and Jones, 2020)
      - Numbered: [1], [1, 5, 12], [32]

    Returns list of {name, count, source_papers} sorted by frequency.
    """
    # Pattern for author-year citations: (Author et al., YYYY) or (Author and Author, YYYY)
    author_year_re = re.compile(
        r'\(([A-Z][a-z]+(?:\s+(?:et\s+al\.|and\s+[A-Z][a-z]+))?)[.,]?\s*(\d{4})\)'
    )
    # Pattern for numbered citations: [N] or [N, M, ...]
    numbered_re = re.compile(r'\[(\d+(?:\s*[,;]\s*\d+)*)\]')

    citation_counts = Counter()
    citation_sources = defaultdict(set)  # which source paper mentioned this citation

    for chunk in chunks:
        text = chunk.text
        source = chunk.paper_title

        # Extract author-year citations
        for match in author_year_re.finditer(text):
            author = match.group(1).strip()
            year = match.group(2)
            ref_name = f"{author}, {year}"
            citation_counts[ref_name] += 1
            citation_sources[ref_name].add(source)

        # Extract numbered citations and expand ranges
        for match in numbered_re.finditer(text):
            nums_str = match.group(1)
            nums = [n.strip() for n in re.split(r'[,;]', nums_str)]
            for n in nums:
                if n.isdigit():
                    ref_name = f"[{n}]"
                    citation_counts[ref_name] += 1
                    citation_sources[ref_name].add(source)

    # Only keep author-year citations (numbered [1] [32] are ambiguous across papers)
    results = []
    for ref, count in citation_counts.most_common(20):
        if ref.startswith('['):
            continue  # Skip numbered refs entirely - they're paper-specific and meaningless across papers
        results.append({
            'name': ref,
            'count': count,
            'source_papers': list(citation_sources[ref]),
        })

    return results[:15]


def expand_query_acronyms(query: str) -> str:
    """Expand acronyms in the query to include full forms for better retrieval."""
    try:
        from .acronym_extractor import extract_acronyms_from_text
    except ImportError:
        return query

    # Hardcoded common acronyms for expansion
    COMMON_ACRONYMS = {
        'VLM': 'Vision-Language Model',
        'LLM': 'Large Language Model',
        'RL': 'Reinforcement Learning',
        'CNN': 'Convolutional Neural Network',
        'GAN': 'Generative Adversarial Network',
        'VAE': 'Variational Autoencoder',
        'DoF': 'Degrees of Freedom',
        'RGBD': 'RGB-Depth',
        'TSDF': 'Truncated Signed Distance Function',
        'MLP': 'Multi-Layer Perceptron',
        'IK': 'Inverse Kinematics',
        'SSL': 'Self-Supervised Learning',
        'IL': 'Imitation Learning',
        'PPO': 'Proximal Policy Optimization',
        'SAC': 'Soft Actor-Critic',
        'DDPG': 'Deep Deterministic Policy Gradient',
    }

    expansions = []
    for word in query.split():
        clean = re.sub(r'[.,;:!?]', '', word).upper()
        if clean in COMMON_ACRONYMS:
            expansions.append(COMMON_ACRONYMS[clean])

    if expansions:
        return query + ' ' + ' '.join(expansions)
    return query


def deterministic_query_pipeline(query: str, df, model, default_weights: dict,
                                  retriever=None, graph=None) -> dict:
    """Full deterministic query pipeline. Replaces LLM Pass 1.

    Returns dict with:
        weights, colorBy, filterMethods, highlightMethods,
        rag_text, rag_citations, relevant_method_summaries
    """
    # 0. Expand acronyms in query for better retrieval
    expanded_query = expand_query_acronyms(query)
    print(f"[Query] Original: '{query}' -> Expanded: '{expanded_query}'")

    # 1. Compute weights from query
    weights = compute_weights_from_query(query, default_weights, model)

    # 2. Pick color-by (pass weights so it can fall back to most-boosted column)
    color_by = pick_color_by(query, weights, default_weights)

    # 3. Find relevant methods via embedding similarity
    ranked_methods = find_relevant_methods(expanded_query, df, model, top_k=15)

    # 4. Decide filtering — prefer attribute-based, fall back to embedding similarity
    filter_methods = None
    attr_filtered = attribute_filter(query, df)
    if attr_filtered is not None:
        filter_methods = attr_filtered
        print(f"[Filter] Attribute-based: {len(filter_methods)} methods matched")
    elif should_filter(query):
        threshold = 0.15
        relevant = [name for name, sim in ranked_methods if sim > threshold]
        if 3 <= len(relevant) < len(df):
            filter_methods = relevant
            print(f"[Filter] Embedding-based: {len(filter_methods)} methods (threshold={threshold})")

    # 4b. Slightly reduce weights for non-relevant columns
    # Don't be aggressive — we want the full UMAP shape preserved,
    # just with relevant dimensions getting more influence
    relevance = compute_query_column_relevance(query, model)
    has_relevant_cols = any(v > 0 for v in relevance.values())
    if has_relevant_cols:
        for col in weights:
            if col in relevance and relevance[col] == 0:
                # Reduce by ~30%, not by 2/3 — preserve the overall projection shape
                weights[col] = max(2, int(weights[col] * 0.7))

    # 5. Highlights: top 5-8 most relevant methods
    highlight_methods = [name for name, sim in ranked_methods[:min(8, len(ranked_methods))]]
    # If attribute filter gave us a small set, highlight all of them
    if attr_filtered and len(attr_filtered) <= 10:
        highlight_methods = attr_filtered

    # 6. RAG retrieval from vector DB
    rag_text = ""
    rag_citations = []
    rag_analytics = {}
    if retriever is not None:
        try:
            from .retrieval.formatter import format_for_prompt, format_chunk_citations
            from .ingest.store import get_client, create_or_get_collection

            chunks = retriever.retrieve(expanded_query)
            rag_text = format_for_prompt(chunks, token_budget=1500)
            rag_citations = format_chunk_citations(chunks)

            # Build analytics from retrieved chunk metadata
            config = retriever.config
            client = get_client(config)
            col = create_or_get_collection(config, client)

            # Fetch full metadata for retrieved chunks
            if chunks:
                chunk_ids = [c.chunk_id for c in chunks]
                meta_result = col.get(ids=chunk_ids, include=['metadatas'])
                metas = meta_result.get('metadatas', [])

                # Paper source distribution (use paper_id slug as display name since parsed titles can be garbled)
                def format_paper_id(pid):
                    return pid.replace('-', ' ').title()
                paper_counts = Counter(format_paper_id(c.paper_id) for c in chunks)
                # Domain topic frequency across retrieved chunks
                topic_counts = Counter()
                for m in metas:
                    topics_str = m.get('domain_topics', '')
                    if topics_str:
                        for t in topics_str.split(', '):
                            if t.strip():
                                topic_counts[t.strip()] += 1
                # Rhetorical role distribution
                role_counts = Counter(m.get('rhetorical_role', 'unknown') for m in metas)
                # Content type distribution
                content_type_counts = Counter(m.get('content_type', 'unknown') for m in metas)
                # Section distribution
                section_counts = Counter(m.get('section', 'unknown') for m in metas)

                # Extract cited references from chunk text
                cited_refs = extract_citations_from_chunks(chunks)

                rag_analytics = {
                    'paperSources': [{'name': k, 'count': v} for k, v in paper_counts.most_common(10)],
                    'domainTopics': [{'topic': k, 'count': v} for k, v in topic_counts.most_common(15)],
                    'rhetoricalRoles': [{'role': k, 'count': v} for k, v in role_counts.most_common()],
                    'contentTypes': [{'type': k, 'count': v} for k, v in content_type_counts.most_common()],
                    'sections': [{'section': k, 'count': v} for k, v in section_counts.most_common()],
                    'citedReferences': cited_refs,
                }
        except Exception as e:
            print(f"[RAG] Error: {e}")
            import traceback
            traceback.print_exc()

    # 6.5. Knowledge Graph context (if graph is loaded)
    kg_context = ""
    kg_traversal = []
    if graph is not None:
        try:
            from .knowledge_graph import compute_graph_context
            # Use the shared router classifier so intent lookups stay in one place.
            # Critically, this includes the PEOPLE intent (author / institution queries)
            # which the old inline keyword list didn't know about.
            from .retrieval.router import classify_intent as _classify_intent
            intent = _classify_intent(query).name  # "BROAD" / "TECHNICAL" / "PEOPLE" / ...
            kg_context, kg_traversal = compute_graph_context(
                query=query,
                G=graph,
                ranked_methods=ranked_methods[:8],
                intent=intent,
                max_tokens=500,
            )
            if kg_context:
                print(f"[KG] Generated {len(kg_context.split())} words of graph context (intent={intent})")
        except Exception as e:
            print(f"[KG] Error: {e}")

    # 7. Build compact summaries for only the relevant methods (for LLM context)
    relevant_names = set(name for name, _ in ranked_methods[:10])
    method_summaries = []
    for _, row in df.iterrows():
        name = row.get('Name', '')
        if name in relevant_names:
            desc = str(row.get('Description', ''))[:150]
            plan = str(row.get('Planning Method', ''))
            hw = str(row.get('End-effector Hardware', ''))
            inp = str(row.get('Input Data', ''))
            method_summaries.append(f"- {name}: {plan}; {hw}; {inp}; {desc}")

    # 8. Method relevance scores for visualization
    method_relevance = [
        {'name': name, 'score': round(float(sim), 4)}
        for name, sim in ranked_methods
    ]

    return {
        'weights': weights,
        'colorBy': color_by,
        'filterMethods': filter_methods,
        'highlightMethods': highlight_methods,
        'rag_text': rag_text,
        'rag_citations': rag_citations,
        'rag_analytics': rag_analytics,
        'relevant_method_summaries': '\n'.join(method_summaries),
        'ranked_methods': ranked_methods,
        'method_relevance': method_relevance,
        'kg_context': kg_context,
        'kg_traversal': kg_traversal,
    }
