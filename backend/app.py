#!/usr/bin/env python3
import os, signal, sys

# Load .env file from repo root
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))

os.environ['OMP_NUM_THREADS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

# Catch crashes
def crash_handler(signum, frame):
    print(f"\n!!! PROCESS KILLED BY SIGNAL {signum} !!!", file=sys.stderr, flush=True)
    sys.exit(1)
signal.signal(signal.SIGABRT, crash_handler)

import json
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import pandas as pd
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
import hdbscan
import umap
from sentence_transformers import SentenceTransformer
import csv
import io

app = Flask(__name__, static_folder='../frontend/build', static_url_path='')
CORS(app)

# Load sentence-transformer model once at startup
print("Loading sentence-transformer model...")
st_model = SentenceTransformer('all-MiniLM-L6-v2')
print("Model loaded.")
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_FILE = os.path.join(BASE_DIR, 'datasets', 'csv-gp-combined.csv')
EMBEDDINGS_CACHE = os.path.join(BASE_DIR, 'backend', '.description_embeddings.npy')

DEFAULT_WEIGHTS = {
    'Planning Method': 10,
    'Training Data': 8,
    'End-effector Hardware': 6,
    'Object Configuration': 10,
    'Input Data': 6,
    'Output Pose': 10,
    'Corresponding Dataset (see repository linked above)': 5,
    'Simulator (see repository linked above)': 3,
    'Backbone': 5,
    'Metric(s) Used ': 5,
    'Camera Position(s)': 4,
    'Language': 4,
    'Description': 7,
}

DERIVED_COLUMNS = [
    'Grasp Dimensionality',
    'Learning Paradigm',
    'Sensor Complexity',
    'Scene Difficulty',
    'Gripper Type',
    'ML Framework',
    'Method Era',
]

UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.1
UMAP_METRIC = 'cosine'
UMAP_RANDOM_STATE = 42

# Domain context for AI insight prompts
DOMAIN_CONTEXT = """ROBOTICS DOMAIN CONTEXT:
Grasp planning is the problem of computing how a robot should position its gripper to pick up objects.

Key distinctions that matter:
- Planning Method: "Sampling" generates many candidate grasps and scores them; "Direct regression" predicts a grasp pose end-to-end from sensor data; "Analytical" uses geometric/force analysis; "RL" learns through trial-and-error; "Generative" uses models like VAEs/diffusion to generate diverse grasps.
- Object Configuration: "Singulated" = one isolated object (easiest); "Structured" = orderly arrangement; "Packed" = objects touching but organized; "Cluttered" = random pile (hardest) — requires reasoning about occlusion and inter-object contact. "Piled" = heaped objects.
- End-effector: "Two-finger" (parallel-jaw) grippers are simple but limited; "Multi-finger" and "Three-finger" (dexterous) grippers can perform complex in-hand manipulation but are much harder to plan for; "Suction" grippers work well on flat surfaces.
- Input Data: "Point cloud" and "Depth image" provide 3D geometry; "RGB" adds appearance; "RGBD" combines both; "TSDF" is a volumetric 3D representation. More modalities = more information but more complexity.
- Output Pose: "6-DoF" (x,y,z + roll,pitch,yaw) is the standard full grasp pose; "7-DoF" adds gripper width or approach angle; "2D grasp rectangle" is a simpler top-down formulation.
- Training Data: "Sim" = trained in simulation (scalable but sim-to-real gap); "Real" = trained on real robot data (expensive but accurate); methods using both attempt to bridge the gap.
- Backbone: The neural network architecture — PointNet/PointNet++ process point clouds directly; ResNet/VGG process images; transformers (ViT) handle both.
- Camera Position: "Overhead" = top-down view; "Eye-in-hand" = camera on the robot gripper; "Multi-view" = multiple cameras for better 3D reconstruction.

Why clustering matters: Methods that cluster together share fundamental design choices. Separation between clusters often reflects genuinely different philosophies (e.g., learning-based vs. analytical, or 2D vs. 3D grasp representations)."""

# AI Copilot configuration
# Supports: "ollama", "huggingface", or "groq"
AI_PROVIDER = os.environ.get('AI_PROVIDER', 'groq')
OLLAMA_BASE_URL = os.environ.get('OLLAMA_BASE_URL', 'http://localhost:11434')
OLLAMA_MODEL = os.environ.get('OLLAMA_MODEL', 'llama3.1:8b')
HF_API_TOKEN = os.environ.get('HF_API_TOKEN', os.environ.get('HF_TOKEN', ''))
HF_MODEL = os.environ.get('AI_MODEL', 'Qwen/Qwen2.5-72B-Instruct')
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')
GROQ_MODEL = os.environ.get('GROQ_MODEL', 'llama-3.3-70b-versatile')
USE_RAG = os.environ.get('USE_RAG', 'false').lower() == 'true'
USE_TOOLS = os.environ.get('USE_TOOLS', 'true').lower() == 'true'

# RAG + Tool calling initialization (lazy-loaded)
_rag_retriever = None
_rag_config = None

def _get_rag_config():
    global _rag_config
    if _rag_config is None:
        config_path = os.path.join(BASE_DIR, 'rag_config.yaml')
        if os.path.exists(config_path):
            from rag.config import load_config
            _rag_config = load_config(config_path)
    return _rag_config

def _get_rag_retriever():
    global _rag_retriever
    if _rag_retriever is None:
        config = _get_rag_config()
        if config:
            from rag.retrieval.retriever import RAGRetriever
            from rag.ingest.embedder import ChunkEmbedder
            embedder = ChunkEmbedder(model_name=config.embedding_model, model_instance=st_model)
            _rag_retriever = RAGRetriever(config=config, embedder=embedder)
    return _rag_retriever


_knowledge_graph = None

def _get_knowledge_graph():
    """Lazy-load the knowledge graph from JSON."""
    global _knowledge_graph
    if _knowledge_graph is None:
        config = _get_rag_config()
        if config:
            kg_path = os.path.join(config.chroma_persist_dir, 'knowledge_graph.json')
            if os.path.exists(kg_path):
                from rag.knowledge_graph import load_graph
                _knowledge_graph = load_graph(kg_path)
                print(f"[KG] Loaded knowledge graph: {_knowledge_graph.number_of_nodes()} nodes, {_knowledge_graph.number_of_edges()} edges")
    return _knowledge_graph


def llm_chat(messages, max_tokens=2048, temperature=0.3):
    """Send a chat completion request to the configured LLM provider."""
    if AI_PROVIDER == 'ollama':
        import urllib.request
        payload = json.dumps({
            'model': OLLAMA_MODEL,
            'messages': messages,
            'stream': False,
            'options': {'temperature': temperature, 'num_predict': max_tokens}
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{OLLAMA_BASE_URL}/api/chat',
            data=payload,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        return result['message']['content'].strip()
    elif AI_PROVIDER == 'groq':
        # Groq (free, fast, OpenAI-compatible)
        if not GROQ_API_KEY:
            raise ValueError('GROQ_API_KEY not configured. Set it as an environment variable.')
        from groq import Groq
        client = Groq(api_key=GROQ_API_KEY)
        completion = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        return completion.choices[0].message.content.strip()
    else:
        # HuggingFace Inference API
        if not HF_API_TOKEN:
            raise ValueError('HF_API_TOKEN not configured. Set it as an environment variable.')
        from huggingface_hub import InferenceClient
        client = InferenceClient(token=HF_API_TOKEN)
        completion = client.chat_completion(
            model=HF_MODEL,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        return completion.choices[0].message.content.strip()

SHORT_COLUMN_NAMES = {
    'Planning Method': 'Plan',
    'Training Data': 'Train',
    'End-effector Hardware': 'Effector',
    'Object Configuration': 'ObjConfig',
    'Input Data': 'Input',
    'Output Pose': 'Output',
    'Corresponding Dataset (see repository linked above)': 'Dataset',
    'Simulator (see repository linked above)': 'Sim',
    'Backbone': 'Backbone',
    'Metric(s) Used ': 'Metrics',
    'Camera Position(s)': 'Camera',
    'Language': 'Lang',
    'Description': 'Desc',
}

def smart_split(value):
    """Split a comma-separated string, respecting double-quoted fields.
    E.g. 'Dexterous grasp, "6-DoF grasp pose (x, y, z, r, p, y)"'
    -> ['Dexterous grasp', '6-DoF grasp pose (x, y, z, r, p, y)']
    """
    if not value or (isinstance(value, float) and np.isnan(value)):
        return []
    s = str(value).strip()
    if not s:
        return []
    reader = csv.reader(io.StringIO(s), skipinitialspace=True)
    parts = next(reader)
    return [p.strip() for p in parts if p.strip()]

def normalize_multi_value(val):
    """Sort multi-value cells alphabetically so order doesn't affect TF-IDF."""
    parts = smart_split(val)
    return ', '.join(sorted(parts)) if parts else ''

def compute_derived_features(df):
    """Compute derived feature columns from existing data."""
    n = len(df)
    result = {col: [''] * n for col in DERIVED_COLUMNS}

    for i in range(n):
        # --- Grasp Dimensionality (from Output Pose) ---
        output = str(df.at[i, 'Output Pose']) if pd.notna(df.at[i, 'Output Pose']) else ''
        if '6-DoF' in output:
            result['Grasp Dimensionality'][i] = '6-DoF'
        elif '7-DoF' in output:
            result['Grasp Dimensionality'][i] = '7-DoF'
        elif '2D grasp' in output:
            result['Grasp Dimensionality'][i] = '2D'
        elif 'Grasp policy' in output:
            result['Grasp Dimensionality'][i] = 'Policy'
        elif 'Grasp success' in output:
            result['Grasp Dimensionality'][i] = 'Evaluation'
        else:
            result['Grasp Dimensionality'][i] = 'Other'

        # --- Learning Paradigm (from Planning Method + Training Data) ---
        method = str(df.at[i, 'Planning Method']) if pd.notna(df.at[i, 'Planning Method']) else ''
        training = str(df.at[i, 'Training Data']) if pd.notna(df.at[i, 'Training Data']) else ''
        method_parts = [p.strip() for p in method.split(',')]

        if training == 'Training-less':
            result['Learning Paradigm'][i] = 'Classical'
        elif all(p in ('Analytical', 'Sampling', 'Optimization') for p in method_parts):
            result['Learning Paradigm'][i] = 'Classical'
        elif any('Reinforcement' in p for p in method_parts):
            result['Learning Paradigm'][i] = 'RL-based'
        elif any(p in ('Direct regression', 'Generative') for p in method_parts) and len(method_parts) == 1:
            result['Learning Paradigm'][i] = 'Learning-based'
        elif 'Direct regression' in method_parts or 'Generative' in method_parts:
            result['Learning Paradigm'][i] = 'Learning-based'
        else:
            result['Learning Paradigm'][i] = 'Hybrid'

        # --- Sensor Complexity (from Input Data) ---
        input_data = str(df.at[i, 'Input Data']) if pd.notna(df.at[i, 'Input Data']) else ''
        input_parts = smart_split(input_data)
        input_lower = input_data.lower()

        if 'natural language' in input_lower or len(input_parts) > 1:
            result['Sensor Complexity'][i] = 'Multimodal'
        elif any(k in input_lower for k in ('point cloud', 'tsdf', '3d', 'mesh', 'voxel')):
            result['Sensor Complexity'][i] = '3D'
        elif 'rgbd' in input_lower:
            result['Sensor Complexity'][i] = '2.5D'
        elif any(k in input_lower for k in ('rgb', 'depth')):
            result['Sensor Complexity'][i] = '2D'
        else:
            result['Sensor Complexity'][i] = 'Other'

        # --- Scene Difficulty (from Object Configuration) ---
        obj_config = str(df.at[i, 'Object Configuration']) if pd.notna(df.at[i, 'Object Configuration']) else ''
        difficulty_map = {'Singulated': 1, 'Structured': 2, 'Cluttered': 3, 'Packed': 4, 'Piled': 5, 'Stacked': 5}
        label_map = {1: 'Singulated', 2: 'Structured', 3: 'Cluttered', 4: 'Packed', 5: 'Piled'}
        parts = smart_split(obj_config)
        max_diff = 0
        for p in parts:
            max_diff = max(max_diff, difficulty_map.get(p, 0))
        result['Scene Difficulty'][i] = label_map.get(max_diff, 'Unknown')

        # --- Gripper Type (from End-effector Hardware) ---
        hardware = str(df.at[i, 'End-effector Hardware']) if pd.notna(df.at[i, 'End-effector Hardware']) else ''
        hw_parts = smart_split(hardware)
        if len(hw_parts) > 1:
            result['Gripper Type'][i] = 'Multi-gripper'
        elif any(k in hardware for k in ('Multi-finger', 'Three-finger')):
            result['Gripper Type'][i] = 'Dexterous'
        elif 'Suction' in hardware:
            result['Gripper Type'][i] = 'Suction'
        elif 'Two-finger' in hardware:
            result['Gripper Type'][i] = 'Parallel-jaw'
        else:
            result['Gripper Type'][i] = 'Unknown'

        # --- ML Framework (from Language) ---
        lang = str(df.at[i, 'Language']) if pd.notna(df.at[i, 'Language']) else ''
        if 'PyTorch' in lang:
            result['ML Framework'][i] = 'PyTorch'
        elif 'TensorFlow' in lang:
            result['ML Framework'][i] = 'TensorFlow'
        elif 'Keras' in lang:
            result['ML Framework'][i] = 'Keras'
        else:
            result['ML Framework'][i] = 'None'

        # --- Method Era (from Year) ---
        year_val = df.at[i, 'Year (Initial Release)']
        if pd.notna(year_val):
            year = int(year_val)
            if year <= 2018:
                result['Method Era'][i] = 'Pioneer (2016-2018)'
            elif year <= 2021:
                result['Method Era'][i] = 'Growth (2019-2021)'
            else:
                result['Method Era'][i] = 'Modern (2022+)'
        else:
            result['Method Era'][i] = 'Unknown'

    return result

def compute_weighted_embeddings(df, weights):
    """Compute TF-IDF embeddings for categorical columns and sentence-transformer
    embeddings for Description, then combine with weights."""
    feature_matrices = []

    for col, weight in weights.items():
        if weight == 0:
            print(f"Skipping '{col}' (weight=0)")
            continue
        if col not in df.columns:
            print(f"Warning: Column '{col}' not found")
            continue

        # Use sentence-transformer for Description column
        # PCA to 50 dims to match TF-IDF scale and prevent dominating the feature matrix
        if col == 'Description':
            n_rows = len(df)
            embeddings = None
            # Use cache only when processing the full (unfiltered) dataset
            if n_rows == 56 and os.path.exists(EMBEDDINGS_CACHE):
                try:
                    cached = np.load(EMBEDDINGS_CACHE)
                    if cached.shape[0] == n_rows:
                        embeddings = cached
                        print(f"Loaded cached description embeddings: {embeddings.shape}")
                    else:
                        print(f"Cache shape mismatch ({cached.shape[0]} vs {n_rows}), recomputing...")
                except Exception as e:
                    print(f"Cache load failed: {e}, recomputing...")
            if embeddings is None:
                texts = df[col].fillna('').astype(str).tolist()
                full_embeddings = st_model.encode(texts, show_progress_bar=False)
                from sklearn.decomposition import PCA
                n_components = min(50, n_rows - 1) if n_rows > 1 else 1
                pca = PCA(n_components=n_components, random_state=42)
                embeddings = pca.fit_transform(full_embeddings)
                # Only cache for full dataset
                if n_rows == 56:
                    np.save(EMBEDDINGS_CACHE, embeddings)
                print(f"Computed description embeddings: {full_embeddings.shape} -> {embeddings.shape}")
            weighted_embeddings = embeddings * np.sqrt(weight)
            feature_matrices.append(weighted_embeddings)
            print(f"Processed '{col}' (sentence-transformer+PCA): {embeddings.shape}, weight={weight}")
            continue

        texts = df[col].fillna('').apply(normalize_multi_value)
        vectorizer = TfidfVectorizer(max_features=50, ngram_range=(1, 2))

        try:
            embeddings = vectorizer.fit_transform(texts).toarray()
            weighted_embeddings = embeddings * np.sqrt(weight)
            feature_matrices.append(weighted_embeddings)
            print(f"Processed '{col}' (TF-IDF): {embeddings.shape}, weight={weight}")
        except Exception as e:
            print(f"Skipping '{col}': {e}")

    if not feature_matrices:
        raise ValueError("No valid columns to process. At least one column must have weight > 0")

    combined = np.hstack(feature_matrices)
    print(f"Combined feature matrix: {combined.shape}")
    return combined

def compute_umap(features):
    """Compute UMAP projection using precomputed distances to avoid
    torch/UMAP OpenMP segfault on macOS."""
    from sklearn.metrics import pairwise_distances
    dist_matrix = pairwise_distances(features, metric=UMAP_METRIC)
    print(f"Precomputed {UMAP_METRIC} distance matrix: {dist_matrix.shape}")
    reducer = umap.UMAP(
        n_neighbors=UMAP_N_NEIGHBORS,
        min_dist=UMAP_MIN_DIST,
        metric='precomputed',
        random_state=UMAP_RANDOM_STATE,
        n_components=2,
        n_jobs=1
    )
    return reducer.fit_transform(dist_matrix)

def run_umap_pipeline(weights, filter_methods=None):
    """Core UMAP/clustering pipeline. Returns (response_data, clustering_info, df, df_full) or raises."""
    import sys

    print(f"Loading CSV: {CSV_FILE}")
    df_full = pd.read_csv(CSV_FILE)
    print(f"Loaded {len(df_full)} rows")

    # Apply method filter if provided
    if filter_methods:
        df = df_full[df_full['Name'].isin(filter_methods)].reset_index(drop=True)
        print(f"Filtered to {len(df)} methods")
        if len(df) == 0:
            raise ValueError('No methods matched the filter')
    else:
        df = df_full

    # Compute derived features (for frontend UI, not embeddings)
    derived = compute_derived_features(df)
    print(f"Computed {len(DERIVED_COLUMNS)} derived features")

    features = compute_weighted_embeddings(df, weights)
    print("Computing UMAP...")
    sys.stdout.flush()

    # Adjust UMAP params for small filtered sets
    n_methods = len(df)
    n_neighbors = min(UMAP_N_NEIGHBORS, max(2, n_methods - 1))

    try:
        if n_methods == 1:
            embedding = np.array([[0.0, 0.0]])
            print("Single method — placed at origin")
        elif n_methods < 4:
            from sklearn.decomposition import PCA
            n_pca = min(2, features.shape[1], n_methods)
            pca = PCA(n_components=n_pca, random_state=42)
            embedding = pca.fit_transform(features)
            if embedding.shape[1] == 1:
                embedding = np.hstack([embedding, np.zeros((n_methods, 1))])
            print(f"Used PCA (only {n_methods} methods)")
        else:
            from sklearn.metrics import pairwise_distances
            dist_matrix = pairwise_distances(features, metric=UMAP_METRIC)
            reducer = umap.UMAP(
                n_neighbors=n_neighbors,
                min_dist=UMAP_MIN_DIST,
                metric='precomputed',
                random_state=UMAP_RANDOM_STATE,
                n_components=2,
                n_jobs=1
            )
            embedding = reducer.fit_transform(dist_matrix)
    except Exception as umap_err:
        print(f"UMAP CRASHED: {umap_err}")
        import traceback
        traceback.print_exc()
        sys.stdout.flush()
        raise
    print("UMAP complete!")

    # HDBSCAN clustering — finds natural clusters, no need to specify k
    if n_methods <= 3:
        cluster_labels = [0] * n_methods
    else:
        min_cluster = max(3, n_methods // 15)
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_cluster,
            min_samples=1,
            metric='euclidean',
            cluster_selection_method='eom'
        )
        labels = clusterer.fit_predict(features)

        # Reassign noise points (-1) to nearest real cluster
        from sklearn.metrics import pairwise_distances
        noise_mask = labels == -1
        if noise_mask.any() and not noise_mask.all():
            real_mask = ~noise_mask
            real_indices = np.where(real_mask)[0]
            noise_indices = np.where(noise_mask)[0]
            dists = pairwise_distances(features[noise_indices], features[real_indices])
            nearest = dists.argmin(axis=1)
            for i, ni in enumerate(noise_indices):
                labels[ni] = labels[real_indices[nearest[i]]]
        elif noise_mask.all():
            # HDBSCAN found no clusters — fall back to single cluster
            labels = np.zeros(n_methods, dtype=int)

        cluster_labels = labels.tolist()

    n_clusters = len(set(cluster_labels))
    print(f"HDBSCAN: {n_clusters} clusters ({n_methods} methods)")

    # Compute value → dominant cluster mapping
    weighted_cols = [col for col, w in weights.items() if w > 0 and col in df.columns and col != 'Description']
    value_cluster_map = {}
    for col in weighted_cols:
        value_cluster_map[col] = {}
        val_cluster_pairs = []
        for idx, raw in enumerate(df[col].fillna('').astype(str)):
            for part in smart_split(raw):
                val_cluster_pairs.append((part, cluster_labels[idx]))
        if not val_cluster_pairs:
            continue
        pairs_df = pd.DataFrame(val_cluster_pairs, columns=['value', 'cluster'])
        for val, group in pairs_df.groupby('value'):
            dominant = group['cluster'].value_counts().index[0]
            value_cluster_map[col][val] = int(dominant)

    # Build response data
    response_data = []
    for i, row in df.iterrows():
        metadata = {}
        for col in df.columns:
            val = row.get(col, '')
            metadata[col] = '' if pd.isna(val) else str(val)
        for col in DERIVED_COLUMNS:
            metadata[col] = derived[col][i]

        response_data.append({
            'id': i,
            'name': row.get('Name', ''),
            'x': float(embedding[i, 0]),
            'y': float(embedding[i, 1]),
            'description': row.get('Description', ''),
            'cluster': cluster_labels[i],
            'metadata': metadata
        })

    clustering_info = {
        'n_clusters': n_clusters,
        'cluster_labels': cluster_labels,
        'value_cluster_map': value_cluster_map
    }

    return response_data, clustering_info, df, df_full


@app.route('/api/dendrogram', methods=['GET', 'POST'])
def get_dendrogram():
    """Compute agglomerative hierarchical clustering and return dendrogram data."""
    try:
        if request.method == 'POST':
            data = request.get_json() or {}
            weights = data.get('weights', DEFAULT_WEIGHTS)
        else:
            weights = DEFAULT_WEIGHTS

        df = pd.read_csv(CSV_FILE)
        features = compute_weighted_embeddings(df, weights)
        names = df['Name'].tolist()

        from scipy.cluster.hierarchy import linkage, dendrogram as scipy_dendro
        from scipy.spatial.distance import pdist

        # Ward linkage on cosine distances
        dist_condensed = pdist(features, metric='cosine')
        Z = linkage(dist_condensed, method='ward')

        # Get dendrogram layout (scipy computes coordinates)
        dendro = scipy_dendro(Z, labels=names, no_plot=True, count_sort='descending')

        # Convert to JSON-serializable format
        # icoord/dcoord are lists of 4-element lists (U-shape segments)
        return jsonify({
            'success': True,
            'icoord': dendro['icoord'],
            'dcoord': dendro['dcoord'],
            'ivl': dendro['ivl'],  # leaf labels in display order
            'leaves': dendro['leaves'],  # leaf indices in display order
            'color_list': dendro.get('color_list', []),
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/umap', methods=['GET', 'POST'])
def get_umap():
    """Compute and return UMAP projection with metadata."""
    try:
        filter_methods = None
        if request.method == 'POST':
            data = request.get_json() or {}
            weights = data.get('weights', DEFAULT_WEIGHTS)
            filter_methods = data.get('filterMethods', None)
            print(f"Using custom weights: {weights}")
            if filter_methods:
                print(f"Filtering to {len(filter_methods)} methods: {filter_methods}")
        else:
            weights = DEFAULT_WEIGHTS
            print(f"Using default weights")

        response_data, clustering_info, df, df_full = run_umap_pipeline(weights, filter_methods)
        _, cluster_stats = build_cluster_stats(response_data, clustering_info, weights)

        return jsonify({
            'success': True,
            'data': response_data,
            'clusterStats': cluster_stats,
            'config': {
                'weights': weights,
                'defaultWeights': DEFAULT_WEIGHTS,
                'derivedColumns': DERIVED_COLUMNS,
                'n_neighbors': UMAP_N_NEIGHBORS,
                'min_dist': UMAP_MIN_DIST,
                'metric': UMAP_METRIC
            },
            'clustering': {
                'n_clusters': clustering_info['n_clusters'],
                'value_cluster_map': clustering_info['value_cluster_map']
            },
            'filter': {
                'active': filter_methods is not None,
                'methods': filter_methods,
                'total': len(df_full)
            }
        })

    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

def build_schema_context(df):
    """Build schema context string: column names, valid values, defaults."""
    column_values = {}
    for col in DEFAULT_WEIGHTS.keys():
        if col == 'Description':
            continue
        if col in df.columns:
            all_vals = set()
            for val in df[col].fillna('').astype(str):
                for part in smart_split(val):
                    all_vals.add(part)
            column_values[col] = sorted(all_vals - {''})

    derived_info = '\n'.join([
        'Derived columns (metadata-only, available for color-by):',
        '- Grasp Dimensionality: 6-DoF, 7-DoF, 2D, Policy, Evaluation, Other',
        '- Learning Paradigm: Classical, Learning-based, RL-based, Hybrid',
        '- Sensor Complexity: 3D, 2.5D, 2D, Multimodal',
        '- Scene Difficulty: Singulated, Structured, Cluttered, Packed, Piled',
        '- Gripper Type: Parallel-jaw, Dexterous, Suction, Multi-gripper',
        '- ML Framework: PyTorch, TensorFlow, Keras, None',
        '- Method Era: Pioneer (2016-2018), Growth (2019-2021), Modern (2022+)',
    ])

    return f"""HOW THE TOOL WORKS:
- 13 columns are used to compute a weighted feature matrix (TF-IDF for categorical columns, sentence-transformer embeddings for Description).
- Each column has a weight (0-20). Higher weight = that column has more influence on which methods appear close together in the 2D UMAP projection.
- Weight 0 disables a column entirely.
- After weighting, UMAP projects to 2D and K-Means assigns clusters.
- The user can "color by" any column to see patterns.

WEIGHTED COLUMNS AND THEIR POSSIBLE VALUES:
{json.dumps(column_values, indent=2)}

Description: Free-text describing each method (weighted via sentence-transformer embeddings).

{derived_info}

DEFAULT WEIGHTS:
{json.dumps(dict(DEFAULT_WEIGHTS), indent=2)}"""


SUMMARY_COLUMNS = [
    'Planning Method', 'End-effector Hardware', 'Input Data',
    'Training Data', 'Object Configuration',
]

def build_method_summaries(df):
    """Build compact one-line summaries of all methods (key columns only to save tokens)."""
    summaries = []
    for _, row in df.iterrows():
        name = row.get('Name', '')
        parts = []
        for col in SUMMARY_COLUMNS:
            val = str(row.get(col, '')) if pd.notna(row.get(col, '')) else ''
            if val:
                short = SHORT_COLUMN_NAMES.get(col, col)
                parts.append(f"{short}={val}")
        summaries.append(f"- {name}: {'; '.join(parts)}")
    return '\n'.join(summaries)


def retrieve_relevant_chunks(query, paper_ids=None):
    """Retrieve relevant paper chunks from ChromaDB.

    Returns (prompt_text, citations) where prompt_text is formatted for LLM
    injection and citations is structured data for the frontend.
    """
    if not USE_RAG:
        return "", []
    retriever = _get_rag_retriever()
    if retriever is None:
        return "", []
    try:
        from rag.retrieval.formatter import format_for_prompt, format_chunk_citations
        config = _get_rag_config()
        chunks = retriever.retrieve(query, paper_ids=paper_ids)
        token_budget = config.retrieval.token_budget if config else 3000
        prompt_text = format_for_prompt(chunks, token_budget=token_budget)
        citations = format_chunk_citations(chunks)
        print(f"[RAG] Retrieved {len(chunks)} chunks ({len(prompt_text)} chars)")
        return prompt_text, citations
    except Exception as e:
        print(f"[RAG] Error: {e}")
        return "", []


def build_ai_system_prompt(df, query):
    """Assemble the full system prompt for the AI copilot."""
    schema = build_schema_context(df)
    methods = build_method_summaries(df)

    tools_section = ""
    if USE_TOOLS or USE_RAG:
        try:
            import rag.tools  # triggers registration of all tools including search_papers
            from rag.tools.registry import get_tool_prompt_section
            tools_section = "\n\n" + get_tool_prompt_section()
        except Exception:
            pass

    tools_instruction = ""
    if tools_section:
        tools_instruction = '\n5. "tools" (OPTIONAL) - Array of tool calls if the query needs computed results or paper content. Each: {"name": "tool_name", "arguments": {...}}. Use "search_papers" when the query asks about specific techniques, loss functions, architectures, or anything that requires reading actual paper content.'

    return f"""You are an AI copilot for the Grasp Planner Explorer, a visualization tool that shows 56 robotic grasp planning methods projected via weighted UMAP.

{schema}

ALL {len(df)} METHODS:
{methods}
{tools_section}

YOUR TASK (Pass 1 — Configuration):
Given a natural language query from a researcher, respond with a JSON object containing:
1. "filterMethods" - Array of method names to FILTER the dataset to. Only these methods will be shown in the UMAP projection and clustered together. Include ALL methods that match the query criteria (not just the best ones). If the query doesn't ask for filtering, include all method names. Use exact names from the dataset.
2. "weights" - Complete weight dictionary (all 13 columns, values 0-20). Adjust weights to make the UMAP projection most useful for the query. Keep weights you don't need to change at their default values.
3. "colorBy" - Which column to color by (must be one of the weighted column names, a derived column name, "cluster", or "index"). Pick the one most informative for the query.
4. "highlightMethods" - Array of method names (subset of filterMethods) that deserve visual emphasis. Include 3-8 methods. HOW TO CHOOSE depends on query type:
   - For SEARCH queries ("find methods for X"): highlight the strongest matches for X.
   - For COMPARISON queries ("how do X and Y differ?"): highlight representative examples from EACH side — e.g., 3-4 examples of X AND 3-4 examples of Y so the user sees both groups.
   - For EXPLORATION queries ("overview of the field"): highlight diverse, well-known methods spanning different clusters.
{tools_instruction}

FILTERING GUIDELINES:
- When the query specifies attributes (e.g., "cluttered scenes"), filter to methods that have those attributes.
- Be INCLUSIVE — include methods that partially match. Better to show a few extra than miss relevant ones.
- When the query is comparative or exploratory (e.g., "compare sim vs real", "overview"), do NOT filter — include all methods so both sides are visible.
- For comparison queries, the full unfiltered dataset is essential to see the contrast.

IMPORTANT RULES:
- Use EXACT column names as keys in the weights dict (including trailing spaces and long names like "Corresponding Dataset (see repository linked above)").
- Only use method names that actually exist in the dataset.
- When the query is about comparing methods along a dimension, suggest coloring by that dimension.
- For comparison queries, increase the weight of the compared dimension so UMAP separates the groups clearly.
- Respond with ONLY the JSON object, no markdown fences, no explanation outside the JSON."""


def build_cluster_stats(response_data, clustering_info, weights):
    """Build structured cluster stats for both AI context and frontend legend.
    Returns (summary_text, cluster_stats_list)."""
    from collections import Counter
    cluster_labels = clustering_info['cluster_labels']
    value_cluster_map = clustering_info['value_cluster_map']

    # Group methods by cluster
    clusters = {}
    for point in response_data:
        c = point['cluster']
        if c not in clusters:
            clusters[c] = []
        clusters[c].append(point)

    # Key columns for characterizing clusters (most interpretable)
    key_cols = ['Planning Method', 'End-effector Hardware', 'Object Configuration',
                'Input Data', 'Training Data']
    weighted_cols = [col for col, w in weights.items() if w > 0 and col != 'Description']

    lines = [f"GROUPING RESULTS ({len(response_data)} methods in {len(clusters)} groups):\n"]
    cluster_stats_list = []

    for cluster_id in sorted(clusters.keys()):
        members = clusters[cluster_id]
        names = [m['name'] for m in members]
        # Generate a short characterization label from the top-weighted columns
        all_label_cols = [c for c in weights.keys() if c != 'Description']
        label_cols = sorted(all_label_cols, key=lambda c: weights.get(c, 0), reverse=True)[:3]
        dominant_attrs = []
        for col in label_cols:
            short_col = SHORT_COLUMN_NAMES.get(col, col)
            vals_for_label = []
            for m in members:
                raw = m['metadata'].get(col, '')
                if raw:
                    for part in smart_split(raw):
                        vals_for_label.append(part)
            if vals_for_label:
                top_val = Counter(vals_for_label).most_common(1)[0][0]
                dominant_attrs.append(top_val)
        cluster_label = ' / '.join(dominant_attrs) if dominant_attrs else f'Group {cluster_id}'
        lines.append(f"Group \"{cluster_label}\" ({len(members)} methods): {', '.join(names)}")

        stat = {
            'id': cluster_id,
            'methods': names,
            'size': len(members),
            'topAttributes': {}
        }

        for col in weighted_cols:
            vals = []
            for m in members:
                raw = m['metadata'].get(col, '')
                if raw:
                    for part in smart_split(raw):
                        vals.append(part)
            if vals:
                counts = Counter(vals)
                top = counts.most_common(3)
                summary = ', '.join([f"{v} ({c})" for v, c in top])
                short = SHORT_COLUMN_NAMES.get(col, col)
                lines.append(f"  {short}: {summary}")
                # Only include key columns in frontend stats for readability
                if col in key_cols:
                    stat['topAttributes'][short] = [{'value': v, 'count': c} for v, c in top]
        lines.append("")

        stat['label'] = cluster_label
        cluster_stats_list.append(stat)

    # Build cluster ID → label lookup for value mapping
    id_to_label = {s['id']: s['label'] for s in cluster_stats_list}

    lines.append("DOMINANT GROUP PER VALUE (which group each attribute value is most associated with):")
    for col, mapping in value_cluster_map.items():
        if mapping:
            short = SHORT_COLUMN_NAMES.get(col, col)
            pairs = [f"{v}→\"{id_to_label.get(c, f'Group {c}')}\"" for v, c in sorted(mapping.items())]
            lines.append(f"  {short}: {', '.join(pairs)}")

    return '\n'.join(lines), cluster_stats_list


def build_insight_prompt(query, response_data, clustering_info, weights, color_by, highlight_methods, filter_methods):
    """Build the Pass 2 prompt that asks the AI to interpret clustering results."""
    cluster_summary, _ = build_cluster_stats(response_data, clustering_info, weights)

    return f"""You are an AI copilot for the Grasp Planner Explorer, a visualization tool for robotic grasp planning methods.

{DOMAIN_CONTEXT}

You have just configured the visualization based on a researcher's query, and UMAP + K-Means clustering have been computed.

RESEARCHER'S QUERY: {query}

WHAT YOU DID:
- Filtered to {len(response_data)} methods{' (from 56 total)' if filter_methods else ''}
- Colored by: {color_by}
- Highlighted {len(highlight_methods)} best matches: {', '.join(highlight_methods)}
- Weights adjusted: {json.dumps({k: v for k, v in weights.items() if v != 10})}

{cluster_summary}

YOUR TASK (Pass 2 — Insight):
Based on the ACTUAL clustering results, paper excerpts (if provided), and computed tool results (if provided), write concise bullet points. Format as bullet points starting with "- ".

Write 3-5 bullet points that:
- DIRECTLY ANSWER the researcher's query using specific evidence from the paper excerpts and clustering results
- When paper excerpts are provided, CITE specific papers by name (e.g., "Contact-GraspNet uses a binary cross-entropy loss on predicted contact points")
- Reference concrete technical details from the papers, not generic descriptions
- Point out meaningful patterns relevant to the query, grounded in actual paper content
- If computed results are provided (e.g., similarity scores, distributions), incorporate the exact numbers

IMPORTANT RULES:
- Do NOT reference cluster numbers (e.g., "Cluster 0", "Cluster 3"). Refer to groups by their defining characteristics.
- Do NOT give generic overviews of the clusters. Focus on answering the specific query.
- When paper excerpts are available, prioritize insights derived from actual paper content over general domain knowledge.
- Reference specific method names and attribute values.

Respond with ONLY the bullet points, no JSON, no markdown fences, no headers."""


@app.route('/api/ai-query', methods=['POST'])
def ai_query():
    """Deterministic pipeline + single LLM call:
    1. Deterministic: embed query, search vector DB, compute weights/filters/highlights
    2. Pipeline: run UMAP + HDBSCAN with computed weights
    3. LLM: interpret results with RAG context (single, small prompt)
    """
    try:
        data = request.get_json() or {}
        query = data.get('query', '').strip()
        if not query:
            return jsonify({'success': False, 'error': 'Empty query'}), 400

        df = pd.read_csv(CSV_FILE)

        # ── Step 1: Deterministic query analysis ──────────────────────
        print(f"[Query] '{query}'")
        from rag.query_engine import deterministic_query_pipeline
        retriever = _get_rag_retriever()
        kg = _get_knowledge_graph()
        pipeline_result = deterministic_query_pipeline(
            query, df, st_model, DEFAULT_WEIGHTS, retriever=retriever, graph=kg
        )

        result = {
            'weights': pipeline_result['weights'],
            'colorBy': pipeline_result['colorBy'],
            'filterMethods': pipeline_result['filterMethods'],
            'highlightMethods': pipeline_result['highlightMethods'],
        }

        rag_text = pipeline_result['rag_text']
        rag_citations = pipeline_result['rag_citations']
        rag_analytics = pipeline_result.get('rag_analytics', {})
        method_relevance = pipeline_result.get('method_relevance', [])
        method_summaries = pipeline_result['relevant_method_summaries']
        kg_context = pipeline_result.get('kg_context', '')

        print(f"[Deterministic] Filter: {len(result['filterMethods']) if result['filterMethods'] else 'none'}, "
              f"Highlights: {len(result['highlightMethods'])}, ColorBy: {result['colorBy']}, "
              f"RAG chunks: {len(rag_citations)}")

        # ── Step 2: Run UMAP/Clustering pipeline ─────────────────────
        print("[Pipeline] Running UMAP + HDBSCAN...")
        response_data, clustering_info, _, _ = run_umap_pipeline(
            result['weights'], result['filterMethods']
        )
        print(f"[Pipeline] Done: {len(response_data)} methods, {clustering_info['n_clusters']} clusters")

        # ── Step 3: Single LLM call (interpret results) ──────────────
        print("[LLM] Generating insight...")
        _, cluster_stats = build_cluster_stats(
            response_data, clustering_info, result['weights']
        )

        # Build compact cluster summary
        compact_clusters = []
        for cs in cluster_stats:
            compact_clusters.append(f"- {cs['label']} ({cs['size']} methods): {', '.join(cs['methods'][:5])}")
        cluster_text = '\n'.join(compact_clusters)

        # Build the single, well-structured prompt
        insight_prompt = f"""You are an expert research assistant for a robotic grasp planning visualization tool. A researcher has queried the system and you have access to real data from academic papers and clustering analysis.

RESEARCHER'S QUESTION: "{query}"

EVIDENCE FROM PAPERS:
{rag_text if rag_text else '(No paper excerpts available for this query)'}

KNOWLEDGE GRAPH INSIGHTS:
{kg_context if kg_context else '(No structured knowledge available)'}

RELEVANT METHODS IN THE DATASET:
{method_summaries}

CLUSTERING RESULTS ({len(response_data)} methods in {len(cluster_stats)} groups):
{cluster_text}

Highlighted methods (most relevant to query): {', '.join(result['highlightMethods'][:6])}

INSTRUCTIONS:
Write exactly 3-5 bullet points that answer the researcher's question. Each bullet must start with "- ".

Rules:
1. Lead with evidence from the paper excerpts. Quote specific techniques, equations, or results by paper name (e.g., "Contact-GraspNet uses a binary cross-entropy loss on predicted contact points").
2. When no paper excerpt covers a point, draw on the method metadata (planning approach, gripper type, etc.) to provide grounded analysis.
3. Connect findings to the clustering: explain why methods using similar approaches end up in the same group.
4. Be specific and technical. Avoid generic statements like "various methods use different approaches."
5. Never reference cluster numbers. Use group names like "the sampling-based parallel-jaw group."
6. Always use the exact method names as provided in the data (e.g., "Grasp Pose Detection (GPD)" not just "GPD", "Volumetric Grasping Network (VGN)" not just "VGN"). This ensures methods are correctly linked in the interface.
7. Do NOT use markdown formatting like **bold** or *italic*. Write plain text only. The interface has its own highlighting system that automatically color-codes technique names, method names, and domain terms.

Respond with ONLY the bullet points, nothing else."""

        insight_text = llm_chat([
            {'role': 'user', 'content': insight_prompt}
        ], max_tokens=1024)
        if insight_text.startswith('```'):
            lines = insight_text.split('\n')
            insight_text = '\n'.join(lines[1:-1])

        # ── Guardrail: validate entity mentions against KG ──
        grounding_report = {'grounded': [], 'ungrounded': []}
        try:
            kg_check = _get_knowledge_graph()
            if kg_check:
                import re as _gre
                # Collect all known entities from the KG
                kg_methods = set()
                kg_papers = set()
                kg_techniques = set()
                for node_id, nd in kg_check.nodes(data=True):
                    label = (nd.get('label', '') or '').lower()
                    ntype = nd.get('type', '')
                    if ntype == 'method':
                        kg_methods.add(label)
                    elif ntype == 'paper':
                        kg_papers.add(label)
                    elif ntype == 'technique':
                        kg_techniques.add(label)

                # Also add CSV method names
                csv_methods = set(str(row.get('Name', '')).replace('\U0001f916 ', '').strip().lower() for _, row in df.iterrows())
                all_known = kg_methods | kg_papers | kg_techniques | csv_methods

                # Only look for method/system names — not citations, venues, or generic terms
                # Method names look like: CamelCase, Hyphenated-CamelCase, or ALLCAPS acronyms
                mentions = set()
                # CamelCase or hyphenated method names (Contact-GraspNet, DexDiffuser, PointNet++)
                for m in _gre.finditer(r'\b([A-Z][a-z]+(?:[-]?[A-Z][a-z]+)+(?:\+\+)?(?:\s*\([^)]+\))?)\b', insight_text):
                    mentions.add(m.group(1))
                # ALLCAPS acronyms that look like system names (VGN, GPD, GIGA) — min 2 chars
                for m in _gre.finditer(r'\b([A-Z]{2,6}(?:-[A-Z]+)?)\b', insight_text):
                    name = m.group(1)
                    # Skip common non-method acronyms
                    skip = {'RGB', 'RGBD', 'CNN', 'GNN', 'MLP', 'LLM', 'DOF', 'SAM', 'GPU',
                            'CPU', 'PDF', 'API', 'IOU', 'MAP', 'BCE', 'MSE', 'SGD', 'IEEE',
                            'ICRA', 'IROS', 'RSS', 'CVPR', 'ICLR', 'RAG', 'KG', 'HGT',
                            'RL', 'IL', 'SE', 'TSDF', 'BPS', 'FPS', 'NMS'}
                    if name not in skip:
                        mentions.add(name)

                for mention in mentions:
                    mention_lower = mention.lower()
                    found = any(
                        mention_lower in known or known in mention_lower
                        for known in all_known
                        if len(known) > 3
                    )
                    if found:
                        grounding_report['grounded'].append(mention)
                    else:
                        grounding_report['ungrounded'].append(mention)

                n_g = len(grounding_report['grounded'])
                n_u = len(grounding_report['ungrounded'])
                print(f"[Guardrail] Entities: {n_g} grounded, {n_u} ungrounded")
                if grounding_report['ungrounded']:
                    print(f"[Guardrail] Ungrounded: {grounding_report['ungrounded']}")
        except Exception as e:
            print(f"[Guardrail] Error: {e}")

        result['insight'] = insight_text
        result['grounding'] = grounding_report

        print(f"[LLM] Insight: {len(insight_text)} chars")

        # ── Build response ────────────────────────────────────────────
        result['umapData'] = response_data
        result['clustering'] = {
            'n_clusters': clustering_info['n_clusters'],
            'value_cluster_map': clustering_info['value_cluster_map']
        }
        result['clusterStats'] = cluster_stats
        if rag_citations:
            result['ragCitations'] = rag_citations
        if rag_analytics:
            result['ragAnalytics'] = rag_analytics
        if method_relevance:
            result['methodRelevance'] = method_relevance

        # Knowledge graph traversal data
        kg_traversal = pipeline_result.get('kg_traversal', [])
        if kg_traversal:
            result['kgTraversal'] = kg_traversal
        if kg_context:
            result['kgContext'] = kg_context

        # Generate traversal narrative (NL explanation of why the graph found what it found)
        if kg_context and kg_traversal:
            try:
                # Build a concise summary of what was found
                step_summaries = []
                for step in kg_traversal:
                    if step.get('step') in ('summary', 'query_intent'):
                        continue
                    n_edges = len(step.get('edges', []))
                    if n_edges > 0:
                        step_summaries.append(f"{step.get('description', '')} ({step.get('detail', '')})")

                if step_summaries:
                    narrate_prompt = (
                        f'A researcher asked: "{query}"\n\n'
                        f'The knowledge graph traversal found:\n'
                        + '\n'.join(f'- {s}' for s in step_summaries) + '\n\n'
                        f'Structured facts found:\n{kg_context}\n\n'
                        f'Write 2-3 sentences explaining what the graph found and WHY it matters '
                        f'for the researcher\'s question. Be specific about paper names and techniques. '
                        f'Do not repeat the question. Start with the most important finding.\n\n'
                        f'IMPORTANT: Do NOT use markdown formatting like **bold** or *italic*. '
                        f'Write plain text only. The interface has its own highlighting system '
                        f'that will automatically color-code technique names, method names, and '
                        f'domain terms. Just write the names naturally.'
                    )
                    narrative = llm_chat(
                        [{'role': 'user', 'content': narrate_prompt}],
                        max_tokens=300, temperature=0.2
                    )
                    result['traversalNarrative'] = narrative
                    print(f"[KG] Narrative: {len(narrative)} chars")
            except Exception as e:
                print(f"[KG] Narrative error: {e}")

        # Paper relevance scores for similarity bars
        ranked = pipeline_result.get('ranked_methods', [])
        if ranked:
            result['paperRelevance'] = [
                {'name': name, 'score': round(float(score), 4)}
                for name, score in ranked[:10]
            ]

        # Equations from retrieved chunks (already relevance-scored by the retriever)
        try:
            import re as _re
            import numpy as np

            # Equation patterns to find in chunk text
            _EQ_PATTERNS = [
                _re.compile(r'\\begin\{(?:equation|align|gather)\*?\}(.+?)\\end\{(?:equation|align|gather)\*?\}', _re.DOTALL),
                _re.compile(r'\$([^$]{5,80})\$'),
                _re.compile(r'(?:^|\s)((?:L|J|E|R|V|Q)\s*(?:[_]\w+)?\s*(?:\([^)]*\))?\s*=\s*[^,.\n]{8,80})', _re.MULTILINE),
            ]

            equations = []
            seen_eqs = set()

            # Search through the RAG-retrieved chunks (already relevant to the query)
            if rag_citations:
                for cite in rag_citations:
                    chunk_text = cite.get('full_text', cite.get('snippet', ''))
                    if not chunk_text:
                        continue
                    chunk_score = cite.get('score', 0)
                    paper_title = cite.get('paper_title', '')
                    paper_id = cite.get('paper_id', '')
                    section = cite.get('section', '')

                    for pattern in _EQ_PATTERNS:
                        for match in pattern.finditer(chunk_text):
                            eq_text = (match.group(1) if match.lastindex else match.group(0)).strip()
                            if len(eq_text) < 5 or len(eq_text) > 200:
                                continue
                            # Must have at least one math symbol
                            if sum(1 for c in eq_text if c in '=+-*/^_{}\\') < 1:
                                continue
                            # Dedup
                            eq_key = eq_text[:40]
                            if eq_key in seen_eqs:
                                continue
                            seen_eqs.add(eq_key)

                            # Context: surrounding sentence
                            start = max(0, match.start() - 60)
                            context = chunk_text[start:match.start()].strip().split('.')[-1].strip()

                            equations.append({
                                'paper_id': paper_id,
                                'paper': paper_title or paper_id.replace('-', ' ').title(),
                                'latex': eq_text,
                                'context': context[:120] if context else section,
                                'relevance': round(chunk_score, 4),
                                'section': section,
                            })

            # Also check extracted_facts for equations from traversed papers
            # (catches equations the regex missed in chunks but found during ingestion)
            facts_path = os.path.join(_get_rag_config().chroma_persist_dir, 'extracted_facts.json')
            if os.path.exists(facts_path):
                with open(facts_path) as f:
                    all_facts = json.load(f)
                traversed_pids = set()
                for step in kg_traversal:
                    for edge in step.get('edges', []):
                        src_id = edge.get('source_id', '')
                        if src_id.startswith('paper:'):
                            traversed_pids.add(src_id.replace('paper:', ''))
                for pid in traversed_pids:
                    for fact in all_facts.get(pid, []):
                        if fact.get('type') == 'equation':
                            eq_text = fact.get('value', '').strip()
                            eq_key = eq_text[:40]
                            if eq_key in seen_eqs:
                                continue
                            seen_eqs.add(eq_key)
                            # Score against query
                            eq_combined = f"{fact.get('context', '')} {eq_text}"
                            eq_emb = st_model.encode(eq_combined)
                            eq_norm = eq_emb / (np.linalg.norm(eq_emb) + 1e-8)
                            q_emb = st_model.encode(query)
                            q_norm = q_emb / (np.linalg.norm(q_emb) + 1e-8)
                            score = float(np.dot(q_norm, eq_norm))
                            equations.append({
                                'paper_id': pid,
                                'paper': pid.replace('-', ' ').title(),
                                'latex': eq_text,
                                'context': fact.get('context', '')[:120],
                                'relevance': round(score, 4),
                            })

            # Sort by relevance, threshold at 0.35
            equations.sort(key=lambda x: x['relevance'], reverse=True)
            equations = [eq for eq in equations if eq['relevance'] >= 0.35]
            if equations:
                equations = equations[:8]  # Cap at 8

                # LLM explanation: why each equation is relevant to the query
                try:
                    eq_list = "\n".join(
                        f'{i+1}. [{eq["paper"]}] {eq["latex"]}  (context: {eq["context"][:60]})'
                        for i, eq in enumerate(equations)
                    )
                    explain_prompt = (
                        f'A researcher asked: "{query}"\n\n'
                        f'These equations were found in relevant papers:\n{eq_list}\n\n'
                        f'For each equation, write ONE sentence explaining what it represents '
                        f'and why it is relevant to the question. Be specific about what each '
                        f'variable means. Format: "1. [explanation]" per line. No preamble.'
                    )
                    explanations_text = llm_chat(
                        [{'role': 'user', 'content': explain_prompt}],
                        max_tokens=600, temperature=0.2
                    )
                    # Parse numbered explanations
                    import re as _re2
                    for line in explanations_text.strip().split('\n'):
                        match = _re2.match(r'(\d+)\.\s*(.+)', line.strip())
                        if match:
                            idx = int(match.group(1)) - 1
                            if 0 <= idx < len(equations):
                                equations[idx]['explanation'] = match.group(2).strip()
                except Exception as e:
                    print(f"[Equations] Explanation error: {e}")

                result['equations'] = equations
        except Exception as e:
            print(f"[Equations] Error: {e}")
            import traceback; traceback.print_exc()

        return jsonify({'success': True, **result})

    except json.JSONDecodeError as e:
        return jsonify({
            'success': False,
            'error': f'Failed to parse AI response as JSON: {str(e)}',
            'raw_response': response_text
        }), 500
    except Exception as e:
        print(f"AI query error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/cluster-insight', methods=['POST'])
def cluster_insight():
    """Generate AI insight for the current clustering (used on initial page load)."""
    try:
        data = request.get_json() or {}
        umap_data = data.get('umapData', [])
        clustering = data.get('clustering', {})
        weights = data.get('weights', DEFAULT_WEIGHTS)

        if not umap_data:
            return jsonify({'success': False, 'error': 'No UMAP data provided'}), 400

        clustering_info = {
            'n_clusters': clustering.get('n_clusters', 11),
            'cluster_labels': [p['cluster'] for p in umap_data],
            'value_cluster_map': clustering.get('value_cluster_map', {})
        }

        cluster_summary, cluster_stats = build_cluster_stats(umap_data, clustering_info, weights)

        prompt = f"""You are an AI copilot for the Grasp Planner Explorer, a visualization tool for robotic grasp planning methods.

{DOMAIN_CONTEXT}

The researcher has just opened the tool and sees {len(umap_data)} methods projected via weighted UMAP and grouped by K-Means clustering. Give them an orientation.

{cluster_summary}

YOUR TASK:
Write 4-6 bullet points summarizing what the clustering reveals about the field of robotic grasp planning. Format as bullet points starting with "- ".

Each bullet should:
- Explain WHY methods group together using domain knowledge (not just "Cluster X has Y")
- Reference specific cluster numbers, method names, and attribute values
- Help the researcher build a mental map of the landscape

Write in a welcoming, informative tone.

Respond with ONLY the bullet points, no JSON, no markdown fences, no headers."""

        insight = llm_chat([{'role': 'user', 'content': prompt}], max_tokens=1024)
        if insight.startswith('```'):
            lines = insight.split('\n')
            insight = '\n'.join(lines[1:-1])

        return jsonify({'success': True, 'insight': insight, 'clusterStats': cluster_stats})

    except Exception as e:
        print(f"Cluster insight error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/papers/<path:paper_id>')
def serve_paper(paper_id):
    """Serve a PDF from the papers directory."""
    papers_dir = os.path.join(BASE_DIR, 'papers')
    # Sanitize: only allow alphanumeric, hyphens, underscores
    import re as _re
    safe_id = _re.sub(r'[^a-zA-Z0-9\-_]', '', paper_id.replace('.pdf', ''))
    pdf_path = os.path.join(papers_dir, f'{safe_id}.pdf')
    if os.path.isfile(pdf_path):
        return send_from_directory(papers_dir, f'{safe_id}.pdf', mimetype='application/pdf')
    return jsonify({'error': 'Paper not found'}), 404


@app.route('/api/papers')
def list_papers():
    """List available PDF papers."""
    papers_dir = os.path.join(BASE_DIR, 'papers')
    if not os.path.isdir(papers_dir):
        return jsonify({'papers': []})
    pdfs = [f.replace('.pdf', '') for f in sorted(os.listdir(papers_dir)) if f.endswith('.pdf')]
    return jsonify({'papers': pdfs})


@app.route('/api/kg-macro')
def get_kg_macro():
    """Return the macro-level knowledge graph for the landing visualization.
    Papers + techniques + methods + their connections. No chunks/claims/keyphrases."""
    try:
        kg = _get_knowledge_graph()
        if kg is None:
            return jsonify({'success': False, 'error': 'KG not loaded'}), 404

        SHOW_TYPES = {'paper', 'method', 'technique', 'hardware',
                      'figure', 'table', 'impl_language', 'author',
                      'institution', 'reference', 'equation', 'dataset',
                      'contribution', 'comparison', 'limitation', 'problem'}
        SHOW_EDGE_TYPES = {'uses_backbone', 'uses_loss', 'trained_on', 'uses_technique',
                           'described_in', 'cites', 'outperforms', 'uses_hardware',
                           'has_figure', 'has_table', 'implemented_in', 'maintained_by',
                           'authored_by', 'affiliated_with', 'published_from',
                           'cites_external', 'has_equation',
                           # Dataset relationships (CSV-derived + TEI-mined)
                           'evaluated_on', 'uses_dataset',
                           # Derived TEI relationships
                           'co_authored_with', 'colleagues_with',
                           'co_cited_with', 'shares_bibliography',
                           'author_works_on',
                           # Claim edges — needed for side panel narrative block
                           'contributes', 'has_limitation', 'addresses_problem', 'compares'}

        # Load method metadata from CSV for enriching method nodes
        import pandas as pd
        config = _get_rag_config()
        method_meta = {}
        if config and config.csv_path:
            try:
                mdf = pd.read_csv(config.csv_path)
                for _, row in mdf.iterrows():
                    name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
                    method_meta[name] = {
                        'planning': str(row.get('Planning Method', '')),
                        'training': str(row.get('Training Data', '')),
                        'effector': str(row.get('End-effector Hardware', '')),
                        'scene': str(row.get('Object Configuration', '')),
                        'input': str(row.get('Input Data', '')),
                        'output': str(row.get('Output Pose', '')),
                        'year': str(row.get('Year (Initial Release)', '')),
                        'description': str(row.get('Description', ''))[:150],
                    }
            except Exception:
                pass

        nodes = []
        node_set = set()
        for nid, nd in kg.nodes(data=True):
            ntype = nd.get('type', '')
            if ntype not in SHOW_TYPES:
                continue
            degree = sum(1 for _ in kg.neighbors(nid))
            node = {
                'id': nid,
                'label': nd.get('label', ''),
                'type': ntype,
                'subtype': nd.get('subtype', ''),
                'degree': degree,
                'paper_id': nd.get('paper_id', ''),
            }
            # Include body content for table/figure/claim/equation/contribution/comparison/limitation/problem nodes
            if ntype in ('table', 'figure', 'claim', 'equation',
                         'contribution', 'comparison', 'limitation', 'problem') and nd.get('value'):
                node['value'] = nd.get('value', '')
                node['section'] = nd.get('section', '')
            if ntype in ('contribution', 'comparison', 'limitation', 'problem') and nd.get('confidence'):
                node['confidence'] = nd.get('confidence', '')
            # Structured table cells (from TEI)
            if ntype == 'table' and nd.get('cells'):
                node['cells'] = nd.get('cells')
                node['caption'] = nd.get('caption', '')
            # Equation LaTeX
            if ntype == 'equation' and nd.get('latex'):
                node['latex'] = nd.get('latex', '')
            # External reference metadata
            if ntype == 'reference':
                node['year'] = nd.get('year', '')
                node['authors'] = nd.get('authors', [])
                node['venue'] = nd.get('venue', '')
                node['doi'] = nd.get('doi', '')
                node['arxiv'] = nd.get('arxiv', '')
            # Author affiliation
            if ntype == 'author':
                node['institution'] = nd.get('institution', '')
                node['affiliation'] = nd.get('affiliation', '')
            # Enrich method nodes with CSV metadata
            if ntype == 'method' and nd.get('label', '') in method_meta:
                node['meta'] = method_meta[nd['label']]
            # Mark methods without a paper node so the UI can render them differently
            # (the final product will have all 56 papers; currently ~22 methods are
            # "awaiting ingestion"). Don't hide them — their CSV-derived edges
            # (e.g. to datasets, hardware) are real ecosystem data.
            if ntype == 'method':
                has_paper = any(
                    kg.nodes.get(n, {}).get('type') == 'paper'
                    for n in list(kg.successors(nid)) + list(kg.predecessors(nid))
                )
                node['has_paper'] = has_paper

            nodes.append(node)
            node_set.add(nid)

        links = []
        seen = set()
        for src, tgt, ed in kg.edges(data=True):
            etype = ed.get('type', '')
            if etype not in SHOW_EDGE_TYPES:
                continue
            if src not in node_set or tgt not in node_set:
                continue
            key = (src, tgt, etype)
            if key in seen:
                continue
            seen.add(key)
            link = {
                'source': src,
                'target': tgt,
                'type': etype,
            }
            # Enrich citation edges with stance + in-text context so the UI
            # can explain *why* a citation was classified builds_on / differs_from.
            if etype == 'cites':
                if ed.get('sentiment'):
                    link['sentiment'] = ed.get('sentiment')
                if ed.get('contexts'):
                    link['contexts'] = (ed.get('contexts') or [])[:2]
                if ed.get('mentions'):
                    link['mentions'] = ed.get('mentions')
            # Tag edge provenance so UI can show "from CSV" vs "from paper text"
            if ed.get('source'):
                link['source_type'] = ed.get('source')
            links.append(link)

        return jsonify({
            'success': True,
            'nodes': nodes,
            'links': links,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/kg-subgraph', methods=['POST'])
def get_kg_subgraph():
    """Return a query-relevant subgraph for visualization."""
    try:
        body = request.get_json()
        paper_ids = body.get('paperIds', [])
        intent = body.get('intent', 'general')  # comparison, limitation, hardware, technical, evaluation, general
        kg = _get_knowledge_graph()
        if kg is None:
            return jsonify({'success': False, 'error': 'KG not loaded'}), 404

        import networkx as nx

        # Adapt node/edge priorities based on query intent
        INTENT_CONFIG = {
            'comparison': {
                'structural_types': {'paper', 'method', 'technique'},
                'priority_edges': {'outperforms', 'compares', 'cites'},
                'claim_edges': {'compares', 'outperforms', 'contributes'},
                'max_claims': 8,
            },
            'limitation': {
                'structural_types': {'paper', 'method', 'technique'},
                'priority_edges': {'has_limitation', 'addresses_problem', 'cites'},
                'claim_edges': {'has_limitation', 'addresses_problem', 'contributes'},
                'max_claims': 10,
            },
            'hardware': {
                'structural_types': {'paper', 'method', 'technique', 'hardware'},
                'priority_edges': {'uses_hardware', 'trained_on', 'described_in'},
                'claim_edges': {'contributes', 'compares'},
                'max_claims': 5,
            },
            'technical': {
                'structural_types': {'paper', 'method', 'technique'},
                'priority_edges': {'uses_backbone', 'uses_loss', 'uses_technique', 'contributes', 'implements_step'},
                'claim_edges': {'contributes', 'implements_step', 'addresses_problem'},
                'max_claims': 8,
            },
            'evaluation': {
                'structural_types': {'paper', 'method', 'technique', 'hardware'},
                'priority_edges': {'outperforms', 'compares', 'trained_on', 'uses_hardware'},
                'claim_edges': {'compares', 'outperforms', 'contributes'},
                'max_claims': 8,
            },
        }
        cfg = INTENT_CONFIG.get(intent, {})
        STRUCTURAL_TYPES = cfg.get('structural_types', {'paper', 'method', 'technique', 'hardware'})
        STRUCTURAL_EDGES = {'described_in', 'uses_backbone', 'uses_loss', 'trained_on',
                            'uses_technique', 'uses_hardware', 'cites', 'outperforms',
                            'has_figure', 'has_table', 'implemented_in', 'maintained_by'}
        CLAIM_EDGES = cfg.get('claim_edges', {'has_limitation', 'compares', 'contributes', 'addresses_problem'})
        MAX_CLAIMS = cfg.get('max_claims', 5)

        relevant_nodes = set()

        # 1-hop: queried papers + their structural neighbors
        for pid in paper_ids:
            paper_node = f"paper:{pid}"
            if paper_node not in kg:
                continue
            relevant_nodes.add(paper_node)
            for neighbor in list(kg.successors(paper_node)) + list(kg.predecessors(paper_node)):
                nd = kg.nodes.get(neighbor, {})
                ntype = nd.get('type', '')
                if ntype in STRUCTURAL_TYPES:
                    relevant_nodes.add(neighbor)

        # 2-hop: papers that share techniques with queried papers
        queried_techniques = set()
        for nid in list(relevant_nodes):
            if kg.nodes.get(nid, {}).get('type') == 'technique':
                queried_techniques.add(nid)

        for tech_node in queried_techniques:
            for pred in kg.predecessors(tech_node):
                pred_data = kg.nodes.get(pred, {})
                if pred_data.get('type') == 'paper':
                    relevant_nodes.add(pred)
                    # Also add the method for this paper
                    for p2 in kg.predecessors(pred):
                        if kg.nodes.get(p2, {}).get('type') == 'method':
                            relevant_nodes.add(p2)

        # 2-hop: papers cited by or citing queried papers
        for pid in paper_ids:
            paper_node = f"paper:{pid}"
            if paper_node not in kg:
                continue
            for neighbor in kg.successors(paper_node):
                edge_data = kg[paper_node].get(neighbor, {})
                if edge_data.get('type') == 'cites':
                    relevant_nodes.add(neighbor)
            for neighbor in kg.predecessors(paper_node):
                edge_data = kg[neighbor].get(paper_node, {})
                if edge_data.get('type') == 'cites':
                    relevant_nodes.add(neighbor)

        # Claims: prioritized by query intent
        for pid in paper_ids:
            paper_node = f"paper:{pid}"
            if paper_node not in kg:
                continue
            claim_count = 0
            # First pass: priority claims matching intent
            for neighbor in kg.successors(paper_node):
                if claim_count >= MAX_CLAIMS:
                    break
                edge = kg[paper_node][neighbor]
                etype = edge.get('type', '')
                if etype in CLAIM_EDGES:
                    relevant_nodes.add(neighbor)
                    claim_count += 1
            # Second pass: other claims up to limit
            for neighbor in kg.successors(paper_node):
                if claim_count >= MAX_CLAIMS:
                    break
                nd = kg.nodes.get(neighbor, {})
                edge = kg[paper_node][neighbor]
                etype = edge.get('type', '')
                if etype in ('has_limitation', 'compares', 'contributes', 'addresses_problem') and neighbor not in relevant_nodes:
                    relevant_nodes.add(neighbor)
                    claim_count += 1

        # Build subgraph data
        nodes = []
        node_set = set()
        for node_id in relevant_nodes:
            nd = kg.nodes.get(node_id, {})
            ntype = nd.get('type', '')
            # Map contribution/comparison/limitation/problem to 'claim' for consistent viz
            viz_type = ntype
            if ntype in ('contribution', 'comparison', 'limitation', 'problem'):
                viz_type = 'claim'
            degree = sum(1 for n in kg.neighbors(node_id) if n in relevant_nodes)
            # Tables/figures/equations need full body to render; other types keep short preview
            val_raw = nd.get('value', '')
            val_field = val_raw if ntype in ('table', 'figure', 'equation') else val_raw[:100]
            n = {
                'id': node_id,
                'label': nd.get('label', node_id.split(':')[-1]),
                'type': viz_type,
                'subtype': nd.get('subtype', nd.get('original_type', ntype)),
                'value': val_field,
                'section': nd.get('section', ''),
                'paper_id': nd.get('paper_id', ''),
                'degree': degree,
            }
            if ntype == 'table' and nd.get('cells'):
                n['cells'] = nd.get('cells')
                n['caption'] = nd.get('caption', '')
            if ntype == 'equation' and nd.get('latex'):
                n['latex'] = nd.get('latex', '')
            if ntype == 'reference':
                n['year'] = nd.get('year', '')
                n['authors'] = nd.get('authors', [])
                n['venue'] = nd.get('venue', '')
            if ntype == 'author':
                n['institution'] = nd.get('institution', '')
            nodes.append(n)
            node_set.add(node_id)

        links = []
        seen_links = set()
        for src, tgt, data in kg.edges(data=True):
            if src in node_set and tgt in node_set:
                link_key = (src, tgt)
                if link_key in seen_links:
                    continue
                seen_links.add(link_key)
                links.append({
                    'source': src,
                    'target': tgt,
                    'type': data.get('type', ''),
                    'inferred': data.get('inferred', False),
                })

        return jsonify({
            'success': True,
            'nodes': nodes,
            'links': links,
            'stats': {'n_nodes': len(nodes), 'n_links': len(links)},
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/gap-matrix')
def get_gap_matrix():
    """Custom research-gap matrix for any CSV column pair.
    Query params: row=<csv col>, col=<csv col>"""
    try:
        import pandas as pd
        from collections import defaultdict
        config = _get_rag_config()
        method_df = pd.read_csv(config.csv_path)

        row_col = request.args.get('row', 'Planning Method')
        col_col = request.args.get('col', 'End-effector Hardware')

        # Valid columns for cross-tabulation (categorical/multi-value only)
        exclude = {'Name', 'Title', 'Authors', 'Venue', 'URL', 'Notes',
                   'Description', 'Combined_Description', 'Citation', 'Link(s)'}
        all_cols = [c for c in method_df.columns if c not in exclude and c.strip()]

        if row_col not in method_df.columns or col_col not in method_df.columns:
            return jsonify({'success': False, 'error': f'Unknown column', 'availableColumns': all_cols}), 400

        matrix = defaultdict(lambda: defaultdict(list))
        for _, row in method_df.iterrows():
            name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
            vals_a = [v.strip() for v in str(row.get(row_col, '')).split(',') if v.strip() and v.strip().lower() != 'nan']
            vals_b = [v.strip() for v in str(row.get(col_col, '')).split(',') if v.strip() and v.strip().lower() != 'nan']
            for va in vals_a:
                for vb in vals_b:
                    matrix[va][vb].append(name)

        cols = sorted(set(vb for d in matrix.values() for vb in d))
        rows_out = []
        for va in sorted(matrix.keys()):
            cells = [{'value': len(matrix[va].get(vb, [])), 'methods': matrix[va].get(vb, [])[:10]} for vb in cols]
            rows_out.append({'label': va, 'cells': cells})

        return jsonify({
            'success': True,
            'row_label': row_col, 'col_label': col_col,
            'columns': cols, 'rows': rows_out,
            'availableColumns': all_cols,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/kg-landing')
def get_kg_landing():
    """Return all data needed for the Graph Reasoning landing page:
    summary stats, gap matrix, technique co-occurrence, benchmark coverage, temporal data."""
    try:
        kg = _get_knowledge_graph()
        if kg is None:
            return jsonify({'success': False, 'error': 'KG not loaded'}), 404

        import networkx as nx
        from collections import defaultdict, Counter
        import pandas as pd

        # ── Summary stats ──
        node_types = Counter(d.get('type', '') for _, d in kg.nodes(data=True))
        edge_types = Counter(d.get('type', '') for _, _, d in kg.edges(data=True))
        n_papers = node_types.get('paper', 0)
        n_methods = node_types.get('method', 0)
        n_techniques = node_types.get('technique', 0)
        n_claims = sum(node_types.get(t, 0) for t in ('contribution', 'comparison', 'limitation', 'problem', 'claim'))
        n_chunks = node_types.get('chunk', 0)
        n_citations = edge_types.get('cites', 0)

        summary = {
            'methods': n_methods,
            'papers': n_papers,
            'techniques': n_techniques,
            'claims': n_claims,
            'chunks': n_chunks,
            'citations': n_citations,
            'nodes': kg.number_of_nodes(),
            'edges': kg.number_of_edges(),
        }

        # ── Gap matrix: attribute x attribute cross-tab ──
        # Build method -> attribute values mapping from CSV
        config = _get_rag_config()
        method_df = pd.read_csv(config.csv_path)

        # Default gap matrix computed here; frontend fetches custom pairs via /api/gap-matrix
        def _build_gap_matrix(col_a, col_b):
            matrix = defaultdict(lambda: defaultdict(list))
            for _, row in method_df.iterrows():
                name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
                vals_a = [v.strip() for v in str(row.get(col_a, '')).split(',') if v.strip() and v.strip().lower() != 'nan']
                vals_b = [v.strip() for v in str(row.get(col_b, '')).split(',') if v.strip() and v.strip().lower() != 'nan']
                for va in vals_a:
                    for vb in vals_b:
                        matrix[va][vb].append(name)
            cols = sorted(set(vb for d in matrix.values() for vb in d))
            rows_out = []
            for va in sorted(matrix.keys()):
                cells = [{'value': len(matrix[va].get(vb, [])), 'methods': matrix[va].get(vb, [])[:5]} for vb in cols]
                rows_out.append({'label': va, 'cells': cells})
            if rows_out and cols:
                return {'row_label': col_a, 'col_label': col_b, 'columns': cols, 'rows': rows_out}
            return None

        default_matrix = _build_gap_matrix('Planning Method', 'End-effector Hardware')
        gap_matrices = [default_matrix] if default_matrix else []

        # ── Technique co-occurrence ──
        # Which techniques appear together in the same paper?
        paper_techniques = defaultdict(set)
        for src, tgt, d in kg.edges(data=True):
            if d.get('type') in ('uses_backbone', 'uses_loss', 'trained_on', 'uses_technique'):
                src_data = kg.nodes.get(src, {})
                tgt_data = kg.nodes.get(tgt, {})
                if src_data.get('type') == 'paper' and tgt_data.get('type') == 'technique':
                    paper_techniques[src].add(tgt_data.get('label', ''))

        cooccurrence = defaultdict(int)
        tech_counts = Counter()
        for pid, techs in paper_techniques.items():
            for t in techs:
                tech_counts[t] += 1
            techs_list = sorted(techs)
            for i in range(len(techs_list)):
                for j in range(i + 1, len(techs_list)):
                    pair = tuple(sorted([techs_list[i], techs_list[j]]))
                    cooccurrence[pair] += 1

        cooccurrence_list = [
            {'source': pair[0], 'target': pair[1], 'weight': count}
            for pair, count in sorted(cooccurrence.items(), key=lambda x: -x[1])
            if count >= 2
        ][:30]

        technique_nodes = [
            {'name': name, 'count': count}
            for name, count in tech_counts.most_common(20)
        ]

        # ── Benchmark coverage ──
        method_benchmarks = defaultdict(list)
        # Find the dataset column (name varies)
        dataset_col = None
        for c in method_df.columns:
            if 'corresponding' in c.lower() and 'dataset' in c.lower():
                dataset_col = c
                break
        for _, row in method_df.iterrows():
            name = str(row.get('Name', '')).replace('\U0001f916 ', '').strip()
            raw = str(row.get(dataset_col, '')) if dataset_col else ''
            datasets = [v.strip() for v in raw.split(',') if v.strip() and v.strip().lower() != 'nan']
            for ds in datasets:
                method_benchmarks[ds].append(name)

        benchmark_data = [
            {'dataset': ds, 'methods': methods, 'count': len(methods)}
            for ds, methods in sorted(method_benchmarks.items(), key=lambda x: -len(x[1]))
            if len(methods) >= 1
        ][:12]

        # ── Temporal data ──
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

        temporal = [
            {'year': y, 'methods': methods, 'count': len(methods)}
            for y, methods in sorted(year_methods.items())
        ]

        # ── Top cited papers ──
        cited_counts = Counter()
        for src, tgt, d in kg.edges(data=True):
            if d.get('type') == 'cites':
                tgt_label = kg.nodes[tgt].get('label', '')
                cited_counts[tgt_label] += 1

        top_cited = [{'paper': name, 'citations': count} for name, count in cited_counts.most_common(10)]

        # ── Top institutions (TEI-derived) ──
        institution_paper_counts = defaultdict(set)
        for src, tgt, d in kg.edges(data=True):
            if d.get('type') == 'published_from':
                src_data = kg.nodes.get(src, {})
                tgt_data = kg.nodes.get(tgt, {})
                if src_data.get('type') == 'paper' and tgt_data.get('type') == 'institution':
                    institution_paper_counts[tgt_data.get('label', '')].add(src_data.get('label', ''))
        top_institutions = [
            {'name': name, 'count': len(papers), 'papers': sorted(papers)[:6]}
            for name, papers in sorted(institution_paper_counts.items(), key=lambda x: -len(x[1]))
            if name
        ][:12]

        # ── Top authors (TEI-derived) — authors on 2+ papers ──
        author_paper_counts = defaultdict(set)
        for src, tgt, d in kg.edges(data=True):
            if d.get('type') == 'authored_by':
                src_data = kg.nodes.get(src, {})
                tgt_data = kg.nodes.get(tgt, {})
                if src_data.get('type') == 'paper' and tgt_data.get('type') == 'author':
                    author_paper_counts[tgt_data.get('label', '')].add(src_data.get('label', ''))
        top_authors = [
            {'name': name, 'count': len(papers), 'papers': sorted(papers)[:4]}
            for name, papers in sorted(author_paper_counts.items(), key=lambda x: -len(x[1]))
            if name and len(papers) >= 2
        ][:10]

        # ── Citation flow (builds_on / differs_from breakdown) ──
        cite_flow = {'builds_on': 0, 'differs_from': 0, 'neutral': 0}
        for src, tgt, d in kg.edges(data=True):
            if d.get('type') == 'cites':
                cite_flow[d.get('sentiment', 'neutral')] = cite_flow.get(d.get('sentiment', 'neutral'), 0) + 1

        # ── Top external references (most-cited prior works) ──
        ext_ref_counts = Counter()
        ext_ref_meta = {}
        for src, tgt, d in kg.edges(data=True):
            if d.get('type') == 'cites_external':
                tgt_data = kg.nodes.get(tgt, {})
                label = tgt_data.get('label', '')
                if label:
                    ext_ref_counts[label] += 1
                    if label not in ext_ref_meta:
                        ext_ref_meta[label] = {
                            'year': tgt_data.get('year', ''),
                            'authors': tgt_data.get('authors', [])[:2],
                            'venue': tgt_data.get('venue', ''),
                        }
        top_external_refs = [
            {'title': label, 'citations': count, **ext_ref_meta.get(label, {})}
            for label, count in ext_ref_counts.most_common(10)
            if count >= 2
        ]

        return jsonify({
            'success': True,
            'summary': summary,
            'gapMatrices': gap_matrices,
            'techniqueCooccurrence': {'nodes': technique_nodes, 'links': cooccurrence_list},
            'benchmarkCoverage': benchmark_data,
            'temporal': temporal,
            'topCited': top_cited,
            'topInstitutions': top_institutions,
            'topAuthors': top_authors,
            'citeFlow': cite_flow,
            'topExternalRefs': top_external_refs,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/kg-predictions')
def get_kg_predictions():
    """Return HGT link-prediction results as a focused graph.

    Only includes nodes that participate in at least one prediction, plus the
    predicted edges themselves (marked `inferred: true`, `source: 'hgt'`).

    Query params:
      - min_confidence: float 0-1 (default 0.55)
      - edge_type: filter to a single type (default: all)
      - include_existing: 1 → also emit already-observed edges between the
        involved nodes so the UI can overlay predictions on the existing KG
        (new vs. known, at a glance).
    """
    try:
        config = _get_rag_config()
        predictions_path = os.path.join(config.chroma_persist_dir, 'hgt_schema', 'predicted_edges.json')
        if not os.path.exists(predictions_path):
            return jsonify({'success': False, 'error': 'Predictions file not found. Run rebuild_kg.py --with-hgt first.'}), 404

        min_conf = float(request.args.get('min_confidence', 0.55))
        edge_type_filter = request.args.get('edge_type', '').strip()
        include_existing = request.args.get('include_existing', '0') in ('1', 'true', 'yes')

        with open(predictions_path) as f:
            all_preds = json.load(f)

        # Filter + collect involved node IDs
        preds = []
        for p in all_preds:
            if p.get('confidence', 0) < min_conf:
                continue
            if edge_type_filter and p.get('edge_type') != edge_type_filter:
                continue
            preds.append(p)

        # Build nodes from involved papers/entities, pulling metadata from the live KG
        kg = _get_knowledge_graph()
        node_ids = set()
        for p in preds:
            node_ids.add(p.get('src_id'))
            node_ids.add(p.get('tgt_id'))

        # Also include 1-hop claim neighbors so the side panel can render
        # contribution/comparison/limitation/problem narrative blocks.
        claim_types = {'contribution', 'comparison', 'limitation', 'problem'}
        extra_claim_ids = set()
        if kg is not None:
            for nid in list(node_ids):
                if nid not in kg:
                    continue
                for neighbor in kg.successors(nid):
                    if kg.nodes[neighbor].get('type') in claim_types:
                        extra_claim_ids.add(neighbor)
                for neighbor in kg.predecessors(nid):
                    if kg.nodes[neighbor].get('type') in claim_types:
                        extra_claim_ids.add(neighbor)
        all_node_ids = node_ids | extra_claim_ids

        nodes = []
        seen_nodes = set()
        for nid in all_node_ids:
            if not nid or nid in seen_nodes:
                continue
            seen_nodes.add(nid)
            nd = kg.nodes.get(nid, {}) if kg else {}
            node = {
                'id': nid,
                'label': nd.get('label', nid.split(':')[-1]),
                'type': nd.get('type', 'paper'),
                'paper_id': nd.get('paper_id', nid.replace('paper:', '') if nid.startswith('paper:') else ''),
                'prediction_degree': sum(1 for q in preds if q.get('src_id') == nid or q.get('tgt_id') == nid),
            }
            if nd.get('value'):
                node['value'] = nd['value']
            if nd.get('confidence'):
                node['confidence'] = nd['confidence']
            nodes.append(node)

        links = []
        for p in preds:
            links.append({
                'source': p.get('src_id'),
                'target': p.get('tgt_id'),
                'type': p.get('edge_type'),
                'confidence': round(p.get('confidence', 0), 3),
                'semantic_relevance': round(p.get('semantic_relevance', 0), 3),
                'inferred': True,
                'source_type': 'hgt',
            })

        # Always include claim edges (contributes, has_limitation, etc.) so the
        # side panel's narrative block renders even without include_existing.
        claim_edge_types = {'contributes', 'has_limitation', 'addresses_problem', 'compares'}
        if kg is not None:
            existing_seen = set()
            for src, tgt, ed in kg.edges(data=True):
                if src not in all_node_ids or tgt not in all_node_ids:
                    continue
                etype = ed.get('type', '')
                is_claim_edge = etype in claim_edge_types
                if not is_claim_edge and not include_existing:
                    continue
                if etype in ('semantically_similar', 'similar_in_role', 'contains_chunk',
                             'has_keyphrase', 'has_distinctive_term', 'discusses_topic'):
                    continue
                key = (src, tgt, etype)
                if key in existing_seen:
                    continue
                existing_seen.add(key)
                links.append({
                    'source': src,
                    'target': tgt,
                    'type': etype,
                    'inferred': False,
                    'source_type': 'observed',
                })

        # Summary
        from collections import Counter
        type_counts = Counter(l['type'] for l in links if l.get('inferred'))
        existing_counts = Counter(l['type'] for l in links if not l.get('inferred'))

        return jsonify({
            'success': True,
            'nodes': nodes,
            'links': links,
            'stats': {
                'n_predictions': sum(1 for l in links if l.get('inferred')),
                'n_existing': sum(1 for l in links if not l.get('inferred')),
                'n_nodes': len(nodes),
                'min_confidence': min_conf,
                'by_type': dict(type_counts),
                'existing_by_type': dict(existing_counts) if include_existing else {},
                'total_available': len(all_preds),
                'include_existing': include_existing,
            },
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/kg-contradictions')
def get_kg_contradictions():
    """Return detected contradictions/disputes between papers."""
    try:
        kg = _get_knowledge_graph()
        if kg is None:
            return jsonify({'success': False, 'error': 'KG not loaded'}), 404
        from rag.knowledge_graph import detect_contradictions
        contradictions = detect_contradictions(kg)
        return jsonify({'success': True, 'contradictions': contradictions, 'count': len(contradictions)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/knowledge-graph')
def get_knowledge_graph_api():
    """Return the knowledge graph as nodes/links JSON for visualization."""
    try:
        kg = _get_knowledge_graph()
        if kg is None:
            return jsonify({'success': False, 'error': 'Knowledge graph not built yet'}), 404
        import networkx as nx
        from rag.knowledge_graph import get_graph_stats
        data = nx.node_link_data(kg)
        stats = get_graph_stats(kg)
        return jsonify({'success': True, 'graph': data, 'stats': stats})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/rag-corpus')
def rag_corpus():
    """Return chunk-level data for the RAG insights page."""
    try:
        config = _get_rag_config()
        if not config:
            return jsonify({'success': False, 'error': 'RAG not configured'}), 400

        from rag.ingest.store import get_client, create_or_get_collection
        client = get_client(config)
        col = create_or_get_collection(config, client)

        total = col.count()
        print(f"[RAG Corpus] Collection has {total} chunks")
        if total == 0:
            return jsonify({'success': True, 'chunks': [], 'stats': {}})

        # Get all chunks with metadata
        print("[RAG Corpus] Fetching metadata and documents...")
        result = col.get(limit=total, include=['metadatas', 'documents'])
        ids = result.get('ids', [])
        metas = result.get('metadatas', [])
        docs = result.get('documents', [])
        print(f"[RAG Corpus] Got {len(ids)} chunks")

        # Get embeddings for UMAP projection
        print("[RAG Corpus] Fetching embeddings for UMAP...")
        emb_result = col.get(limit=total, include=['embeddings'])
        embeddings = emb_result.get('embeddings', [])
        print(f"[RAG Corpus] Got {len(embeddings)} embeddings")

        chunk_coords = []
        if embeddings is not None and len(embeddings) > 0:
            import numpy as np
            emb_array = np.array(embeddings)
            n_chunks = len(emb_array)
            print(f"[RAG Corpus] Embedding matrix: {emb_array.shape}")

            if n_chunks >= 15:
                n_neighbors = min(15, n_chunks - 1)
                reducer = umap.UMAP(
                    n_neighbors=n_neighbors, min_dist=0.1,
                    metric='cosine', random_state=42, n_components=2, n_jobs=1
                )
                coords_2d = reducer.fit_transform(emb_array)
                chunk_coords = coords_2d.tolist()
                print(f"[RAG Corpus] UMAP projection complete: {len(chunk_coords)} points")
            else:
                from sklearn.decomposition import PCA
                pca = PCA(n_components=2, random_state=42)
                coords_2d = pca.fit_transform(emb_array)
                chunk_coords = coords_2d.tolist()
                print(f"[RAG Corpus] PCA fallback: {len(chunk_coords)} points")

        # Build chunk data
        print("[RAG Corpus] Building response...")
        from collections import Counter
        chunks = []
        paper_ids = set()
        topic_counts = Counter()
        role_counts = Counter()
        type_counts = Counter()
        layer_counts = Counter()
        section_counts = Counter()

        for i in range(len(ids)):
            meta = metas[i]
            paper_id = meta.get('paper_id', '')
            paper_ids.add(paper_id)

            topics_str = meta.get('domain_topics', '')
            if topics_str:
                for t in topics_str.split(', '):
                    if t.strip():
                        topic_counts[t.strip()] += 1

            role = meta.get('rhetorical_role', 'general')
            role_counts[role] += 1
            ctype = meta.get('content_type', 'general')
            type_counts[ctype] += 1
            layer_counts[meta.get('layer', 'unknown')] += 1
            section_counts[meta.get('section', 'unknown')] += 1

            chunk = {
                'id': ids[i],
                'paper_id': paper_id,
                'paper_title': meta.get('paper_title', ''),
                'layer': meta.get('layer', ''),
                'section': meta.get('section', ''),
                'chunk_type': meta.get('chunk_type', ''),
                'rhetorical_role': role,
                'content_type': ctype,
                'token_count': meta.get('token_count', 0),
                'domain_topics': topics_str,
                'snippet': (docs[i] or '')[:150],
            }
            if i < len(chunk_coords):
                chunk['x'] = chunk_coords[i][0]
                chunk['y'] = chunk_coords[i][1]
            chunks.append(chunk)

        # Extract acronyms from chunk text
        print("[RAG Corpus] Extracting acronyms...")
        try:
            from rag.acronym_extractor import extract_acronyms_from_chunks
            acronyms = extract_acronyms_from_chunks(docs)
            acronym_list = [
                {'acronym': acr, 'full_form': info['full_form'], 'count': info['count']}
                for acr, info in acronyms.items()
            ][:30]
            print(f"[RAG Corpus] Found {len(acronym_list)} acronyms")
        except Exception as ae:
            print(f"[RAG Corpus] Acronym extraction error: {ae}")
            acronym_list = []

        stats = {
            'total_chunks': total,
            'total_papers': len(paper_ids),
            'papers': sorted(paper_ids),
            'topics': [{'topic': k, 'count': v} for k, v in topic_counts.most_common(25)],
            'roles': [{'role': k, 'count': v} for k, v in role_counts.most_common()],
            'content_types': [{'type': k, 'count': v} for k, v in type_counts.most_common()],
            'layers': [{'layer': k, 'count': v} for k, v in layer_counts.most_common()],
            'sections': [{'section': k, 'count': v} for k, v in section_counts.most_common(15)],
            'acronyms': acronym_list,
        }

        return jsonify({'success': True, 'chunks': chunks, 'stats': stats})

    except Exception as e:
        print(f"RAG corpus error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/paper-anatomy/<paper_id>')
def paper_anatomy(paper_id):
    """Return chunk details for a single paper, ordered by position."""
    try:
        config = _get_rag_config()
        if not config:
            return jsonify({'success': False, 'error': 'RAG not configured'}), 400

        from rag.ingest.store import get_client, create_or_get_collection
        client = get_client(config)
        col = create_or_get_collection(config, client)

        result = col.get(
            where={"paper_id": paper_id},
            include=['metadatas', 'documents']
        )

        if not result.get('ids'):
            return jsonify({'success': False, 'error': f'No chunks for paper {paper_id}'}), 404

        chunks = []
        for i in range(len(result['ids'])):
            meta = result['metadatas'][i]
            chunks.append({
                'id': result['ids'][i],
                'text': result['documents'][i],
                'layer': meta.get('layer', ''),
                'section': meta.get('section', ''),
                'chunk_type': meta.get('chunk_type', ''),
                'rhetorical_role': meta.get('rhetorical_role', ''),
                'content_type': meta.get('content_type', ''),
                'position': meta.get('position', 0),
                'page': meta.get('page', 0),
                'token_count': meta.get('token_count', 0),
                'domain_topics': meta.get('domain_topics', ''),
            })

        # Sort by position
        chunks.sort(key=lambda c: (c['position'], c['page']))

        return jsonify({'success': True, 'paper_id': paper_id, 'chunks': chunks})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/term-dictionary')
def term_dictionary():
    """Return the corpus-derived term importance dictionary for frontend highlighting."""
    try:
        config = _get_rag_config()
        if not config:
            return jsonify({'success': False, 'error': 'RAG not configured'}), 400
        from rag.term_engine import load_term_dictionary
        term_dict = load_term_dictionary(config.chroma_persist_dir)
        if term_dict is None:
            return jsonify({'success': True, 'terms': [], 'acronyms': []})
        return jsonify({'success': True, **term_dict})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/health')
def health():
    """Health check endpoint."""
    return jsonify({'status': 'ok'})

@app.route('/')
def serve():
    """Serve the React frontend."""
    return app.send_static_file('index.html')

@app.errorhandler(404)
def not_found(e):
    """Fallback to index.html for client-side routing."""
    return app.send_static_file('index.html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5005))
    debug = False  # disabled — torch + Flask reloader causes fork crashes on macOS
    print(f"Starting Flask server on http://0.0.0.0:{port}")
    print(f"CSV file: {CSV_FILE}")
    print(f"Default weights: {DEFAULT_WEIGHTS}")
    app.run(debug=debug, port=port, host='0.0.0.0')
