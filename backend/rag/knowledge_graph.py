"""Build and query a knowledge graph from extracted facts and LLM entities.

Node types:
  - paper: each ingested paper
  - method: each of the 56 CSV methods
  - technique: shared components (backbones, losses, datasets, simulators)
  - contribution: key contributions from paper text (LLM-extracted)
  - problem: grasp planning problems addressed (LLM-extracted, deduplicated)
  - limitation: acknowledged limitations (LLM-extracted)
  - hardware: specific robot arms, grippers, sensors (LLM-extracted, deduplicated)
  - comparison: comparison claims between methods (LLM-extracted)

Edge types:
  - described_in: method → paper
  - uses_backbone, uses_loss, trained_on, simulated_in: paper → technique
  - contributes: paper → contribution
  - addresses_problem: paper → problem
  - has_limitation: paper → limitation
  - uses_hardware: paper → hardware
  - outperforms: paper → paper (derived from comparison claims)
  - compared_against: paper → method

Output: NetworkX DiGraph, serializable to JSON for persistence and visualization.
"""

import json
import os
import re
import hashlib
import logging
from collections import Counter, defaultdict

import networkx as nx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Normalization aliases
# ---------------------------------------------------------------------------

TECHNIQUE_ALIASES = {
    'pointnet++': 'PointNet++', 'pointnet': 'PointNet',
    'resnet': 'ResNet', 'resnet-50': 'ResNet-50', 'resnet50': 'ResNet-50',
    'vgg': 'VGG', 'vgg-16': 'VGG-16', 'vgg16': 'VGG-16',
    'u-net': 'U-Net', 'unet': 'U-Net',
    'transformer': 'Transformer', 'vit': 'ViT',
    'equiformerv2': 'EquiformerV2', 'equiformer': 'EquiformerV2',
    'gcn': 'GCN', 'gat': 'GAT',
    'cross entropy': 'Cross-Entropy', 'cross-entropy': 'Cross-Entropy',
    'binary cross entropy': 'Binary CE', 'binary cross-entropy': 'Binary CE', 'bce': 'Binary CE',
    'mse': 'MSE', 'l1 loss': 'L1 Loss', 'l2 loss': 'L2 Loss',
    'focal loss': 'Focal Loss',
    'adam': 'Adam', 'adamw': 'AdamW', 'sgd': 'SGD',
    'fully connected': 'Fully Connected', 'fully-connected': 'Fully Connected',
    'convolutional': 'CNN', 'graph neural': 'GNN',
    'contrastive loss': 'Contrastive Loss', 'triplet loss': 'Triplet Loss',
    'infonce': 'InfoNCE', 'kl divergence': 'KL Divergence',
    'reconstruction loss': 'Reconstruction Loss', 'adversarial loss': 'Adversarial Loss',
    'huber loss': 'Huber Loss',
    'graspnet-1billion': 'GraspNet-1B', 'acronym': 'ACRONYM',
    'ycb': 'YCB', 'shapenet': 'ShapeNet',
    'isaac sim': 'Isaac Sim', 'isaac gym': 'Isaac Gym',
    'mujoco': 'MuJoCo', 'pybullet': 'PyBullet',
    'gazebo': 'Gazebo', 'sapien': 'SAPIEN',
}

HARDWARE_ALIASES = {
    'franka': 'Franka Emika Panda', 'franka panda': 'Franka Emika Panda',
    'panda robot': 'Franka Emika Panda', 'franka emika': 'Franka Emika Panda',
    'robotiq 2f-85': 'Robotiq 2F-85', 'robotiq 2f85': 'Robotiq 2F-85',
    'robotiq': 'Robotiq 2F-85',
    'realsense d435': 'Intel RealSense D435', 'd435': 'Intel RealSense D435',
    'realsense d415': 'Intel RealSense D415', 'd415': 'Intel RealSense D415',
    'realsense': 'Intel RealSense',
    'kinect': 'Microsoft Kinect', 'kinect v2': 'Microsoft Kinect V2',
    'allegro hand': 'Allegro Hand', 'allegro': 'Allegro Hand',
    'shadow hand': 'Shadow Dexterous Hand', 'shadow dexterous': 'Shadow Dexterous Hand',
    'ur5': 'Universal Robots UR5', 'ur5e': 'Universal Robots UR5e',
    'ur10': 'Universal Robots UR10',
    'kuka iiwa': 'KUKA LBR iiwa', 'kuka': 'KUKA LBR iiwa',
    'sawyer': 'Rethink Sawyer', 'baxter': 'Rethink Baxter',
    'fetch': 'Fetch Robot',
    'wsg 50': 'Schunk WSG 50', 'wsg50': 'Schunk WSG 50',
    'barrett hand': 'Barrett Hand',
    'isaacgym': 'Isaac Gym', 'isaac gym': 'Isaac Gym',
}

PROBLEM_ALIASES = {
    'cluttered grasping': 'grasping in clutter',
    'bin picking': 'grasping in clutter',
    'pile grasping': 'grasping in clutter',
    'grasping in cluttered scenes': 'grasping in clutter',
    'dexterous manipulation': 'dexterous grasping',
    'multi-finger grasping': 'dexterous grasping',
    'unknown objects': 'novel object grasping',
    'unseen objects': 'novel object grasping',
    'novel object': 'novel object grasping',
    'category-level grasping': 'category-level grasp planning',
    'task-oriented grasping': 'task-oriented grasp planning',
    'sim-to-real': 'sim-to-real transfer',
    'sim to real': 'sim-to-real transfer',
}


def _normalize_technique(name: str) -> str:
    """Normalize technique names to canonical form."""
    raw = name.strip()
    key = raw.lower().strip()
    if key in TECHNIQUE_ALIASES:
        return TECHNIQUE_ALIASES[key]
    alt_key = key.replace('-', ' ')
    if alt_key in TECHNIQUE_ALIASES:
        return TECHNIQUE_ALIASES[alt_key]
    alt_key = key.replace(' ', '-')
    if alt_key in TECHNIQUE_ALIASES:
        return TECHNIQUE_ALIASES[alt_key]
    return re.sub(r'[\s_-]+', ' ', raw).strip().title()


def _normalize_hardware(name: str) -> str:
    """Normalize hardware names."""
    key = name.lower().strip()
    for alias, canonical in HARDWARE_ALIASES.items():
        if alias in key:
            return canonical
    return name.strip()


def _normalize_problem(text: str) -> str:
    """Normalize problem descriptions."""
    key = text.lower().strip()
    for alias, canonical in PROBLEM_ALIASES.items():
        if alias in key:
            return canonical
    # Shorten to first sentence, max 80 chars
    first = text.split('.')[0].strip()
    return first[:80] if len(first) > 80 else first


def _short_hash(text: str) -> str:
    """Generate a short hash for node IDs."""
    return hashlib.md5(text.encode()).hexdigest()[:8]


def _format_paper_name(pid: str) -> str:
    return pid.replace('-', ' ').replace('_', ' ').title()


def _resolve_method_reference(mention: str, method_names: list) -> str:
    """Fuzzy-match a method mention to a known method name."""
    mention_lower = mention.lower().strip()
    for name in method_names:
        if name.lower() in mention_lower or mention_lower in name.lower():
            return name
    # Try token overlap
    mention_tokens = set(re.findall(r'\w+', mention_lower))
    best_match = None
    best_overlap = 0
    for name in method_names:
        name_tokens = set(re.findall(r'\w+', name.lower()))
        overlap = len(mention_tokens & name_tokens)
        if overlap > best_overlap and overlap >= 2:
            best_overlap = overlap
            best_match = name
    return best_match


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_knowledge_graph(
    facts_path: str,
    entities_path: str,
    method_paper_map: dict,
    csv_path: str = None,
) -> nx.DiGraph:
    """Build the enriched knowledge graph.

    Combines regex-extracted facts with LLM-extracted entities.

    Args:
        facts_path: Path to extracted_facts.json
        entities_path: Path to extracted_entities.json
        method_paper_map: Output of build_method_paper_map()
        csv_path: Optional CSV path for method metadata

    Returns:
        NetworkX DiGraph with all nodes and edges.
    """
    G = nx.DiGraph()

    # Load data
    all_facts = {}
    if os.path.exists(facts_path):
        with open(facts_path) as f:
            all_facts = json.load(f)

    all_entities = {}
    if os.path.exists(entities_path):
        with open(entities_path) as f:
            all_entities = json.load(f)

    m2p = method_paper_map.get('method_to_paper', {})
    p2m = method_paper_map.get('paper_to_methods', {})
    all_method_names = list(m2p.keys())

    # ── Paper nodes ──
    all_paper_ids = set(all_facts.keys()) | set(all_entities.keys()) | set(p2m.keys())
    for pid in all_paper_ids:
        node_id = f"paper:{pid}"
        G.add_node(node_id,
                    label=_format_paper_name(pid),
                    type='paper',
                    paper_id=pid,
                    methods=p2m.get(pid, []),
                    n_facts=len(all_facts.get(pid, [])),
                    n_entities=len(all_entities.get(pid, [])))

    # ── Method nodes ──
    for method_name, pid in m2p.items():
        node_id = f"method:{method_name}"
        G.add_node(node_id, label=method_name, type='method', paper_id=pid)
        G.add_edge(node_id, f"paper:{pid}", type='described_in', label='described in')

    # ── Technique nodes from regex facts ──
    for pid, facts in all_facts.items():
        paper_node = f"paper:{pid}"
        if paper_node not in G:
            continue

        for fact in facts:
            ftype = fact.get('type', '')
            value = fact.get('value', '').strip()
            if not value:
                continue

            if ftype == 'backbone':
                tech = _normalize_technique(value)
                tech_id = f"tech:backbone:{tech}"
                if tech_id not in G:
                    G.add_node(tech_id, label=tech, type='technique', subtype='backbone')
                G.add_edge(paper_node, tech_id, type='uses_backbone', label='uses')

            elif ftype == 'loss_function':
                tech = _normalize_technique(value)
                tech_id = f"tech:loss:{tech}"
                if tech_id not in G:
                    G.add_node(tech_id, label=tech, type='technique', subtype='loss')
                G.add_edge(paper_node, tech_id, type='uses_loss', label='loss')

            elif ftype == 'dataset':
                # Datasets get their own node type, NOT 'technique'. The id
                # pattern matches feature_engineering.explode_csv_columns
                # (`dataset:{lower}`) so PaperFact-derived dataset edges
                # merge into the same node the CSV explosion already created
                # — instead of producing a phantom `tech:dataset:Acronym`
                # technique alongside the real `dataset:acronym` dataset.
                ds_label = _normalize_technique(value)  # Title-case for display
                ds_id = f"dataset:{ds_label.lower()}"
                if ds_id not in G:
                    G.add_node(ds_id, label=ds_label, type='dataset', value=ds_label)
                G.add_edge(paper_node, ds_id, type='trained_on', label='trained on')

    # ── LLM-extracted entity nodes ──
    for pid, entities in all_entities.items():
        paper_node = f"paper:{pid}"
        if paper_node not in G:
            continue

        for entity in entities:
            etype = entity.get('type', '')
            value = entity.get('value', '').strip()
            confidence = entity.get('confidence', 'medium')

            # Skip low-confidence and noise entries
            if confidence == 'low' or not value or len(value) < 10:
                continue
            if 'not explicitly' in value.lower() or 'no specific' in value.lower():
                continue

            if etype == 'contribution':
                node_id = f"contrib:{pid}:{_short_hash(value)}"
                if node_id not in G:
                    G.add_node(node_id, label=value[:60], type='contribution',
                               value=value, confidence=confidence, paper_id=pid)
                G.add_edge(paper_node, node_id, type='contributes')

            elif etype == 'novelty_claim':
                # Treat as a contribution with novelty flag
                node_id = f"contrib:{pid}:{_short_hash(value)}"
                if node_id not in G:
                    G.add_node(node_id, label=value[:60], type='contribution',
                               value=value, confidence=confidence, paper_id=pid,
                               is_novelty=True)
                G.add_edge(paper_node, node_id, type='contributes')

            elif etype == 'methodology_step':
                node_id = f"contrib:{pid}:{_short_hash(value)}"
                if node_id not in G:
                    G.add_node(node_id, label=value[:60], type='contribution',
                               value=value, confidence=confidence, paper_id=pid,
                               is_methodology=True)
                G.add_edge(paper_node, node_id, type='implements_step')

            elif etype == 'problem_addressed':
                normalized = _normalize_problem(value)
                node_id = f"problem:{_short_hash(normalized)}"
                if node_id not in G:
                    G.add_node(node_id, label=normalized[:60], type='problem',
                               value=normalized)
                G.add_edge(paper_node, node_id, type='addresses_problem')

            elif etype == 'limitation':
                node_id = f"limit:{pid}:{_short_hash(value)}"
                if node_id not in G:
                    G.add_node(node_id, label=value[:60], type='limitation',
                               value=value, confidence=confidence, paper_id=pid)
                G.add_edge(paper_node, node_id, type='has_limitation')

            elif etype == 'hardware_detail':
                normalized = _normalize_hardware(value)
                node_id = f"hw:{_short_hash(normalized)}"
                if node_id not in G:
                    G.add_node(node_id, label=normalized[:60], type='hardware',
                               value=normalized)
                G.add_edge(paper_node, node_id, type='uses_hardware')

            elif etype == 'comparison_claim':
                node_id = f"comp:{pid}:{_short_hash(value)}"
                if node_id not in G:
                    G.add_node(node_id, label=value[:60], type='comparison',
                               value=value, confidence=confidence, paper_id=pid)
                G.add_edge(paper_node, node_id, type='compares')

                # Try to resolve the compared method and create outperforms edge
                target = _resolve_method_reference(value, all_method_names)
                if target:
                    target_pid = m2p.get(target, '')
                    if target_pid and target_pid != pid:
                        G.add_edge(paper_node, f"paper:{target_pid}",
                                   type='outperforms', evidence=value)

            elif etype == 'quantitative_claim':
                # Store as metadata on the paper node
                metrics = G.nodes[paper_node].get('quantitative_claims', [])
                metrics.append(value[:200])
                G.nodes[paper_node]['quantitative_claims'] = metrics[:10]

            elif etype == 'scene_description':
                scenes = G.nodes[paper_node].get('scene_descriptions', [])
                scenes.append(value[:200])
                G.nodes[paper_node]['scene_descriptions'] = scenes[:5]

    # ── Citation edges (from citation_resolver) ──
    citation_path = os.path.join(
        os.path.dirname(facts_path), 'citation_edges.json'
    )
    if os.path.exists(citation_path):
        with open(citation_path) as f:
            citation_edges = json.load(f)
        n_cite_edges = 0
        for cite in citation_edges:
            src_node = f"paper:{cite['source']}"
            tgt_node = f"paper:{cite['target']}"
            if src_node in G and tgt_node in G:
                if not G.has_edge(src_node, tgt_node) or G[src_node][tgt_node].get('type') != 'cites':
                    G.add_edge(src_node, tgt_node,
                               type='cites',
                               mentions=cite.get('mentions', 1),
                               context=cite.get('contexts', [''])[0][:150] if cite.get('contexts') else '')
                    n_cite_edges += 1
        logger.info(f"Added {n_cite_edges} citation edges from citation_resolver")

    # ── Compute shared_by counts for technique nodes ──
    for node_id, data in G.nodes(data=True):
        if data.get('type') == 'technique':
            predecessors = [n for n in G.predecessors(node_id)]
            G.nodes[node_id]['shared_by'] = len(predecessors)
            G.nodes[node_id]['papers'] = [
                G.nodes[n].get('paper_id', '') for n in predecessors
            ]

    logger.info(
        f"Knowledge graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges"
    )
    return G


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_graph(G: nx.DiGraph, output_path: str):
    """Serialize graph to JSON."""
    data = nx.node_link_data(G)
    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2, default=str)
    logger.info(f"Saved graph to {output_path}")


def load_graph(path: str) -> nx.DiGraph:
    """Load graph from JSON."""
    with open(path) as f:
        data = json.load(f)
    return nx.node_link_graph(data, directed=True)


# ---------------------------------------------------------------------------
# Graph queries
# ---------------------------------------------------------------------------

def graph_query(G: nx.DiGraph, query_type: str, **kwargs) -> list:
    """Execute a structured graph query.

    Returns list of result dicts.
    """
    if query_type == "papers_using_technique":
        tech_name = kwargs.get("technique", "").lower()
        results = []
        for node_id, data in G.nodes(data=True):
            if data.get('type') == 'technique' and tech_name in data.get('label', '').lower():
                for pred in G.predecessors(node_id):
                    pred_data = G.nodes[pred]
                    if pred_data.get('type') == 'paper':
                        edge = G[pred][node_id]
                        results.append({
                            'paper': pred_data.get('label'),
                            'paper_id': pred_data.get('paper_id'),
                            'technique': data.get('label'),
                            'relationship': edge.get('type'),
                        })
        return results

    elif query_type == "contributions_for_paper":
        pid = kwargs.get("paper_id", "")
        paper_node = f"paper:{pid}"
        results = []
        if paper_node in G:
            for succ in G.successors(paper_node):
                succ_data = G.nodes[succ]
                edge = G[paper_node][succ]
                if succ_data.get('type') == 'contribution':
                    results.append({
                        'value': succ_data.get('value', ''),
                        'confidence': succ_data.get('confidence', ''),
                        'is_novelty': succ_data.get('is_novelty', False),
                        'is_methodology': succ_data.get('is_methodology', False),
                        'edge_type': edge.get('type', ''),
                    })
        return results

    elif query_type == "comparisons_involving":
        method_name = kwargs.get("method", "").lower()
        results = []
        for node_id, data in G.nodes(data=True):
            if data.get('type') == 'comparison':
                if method_name in data.get('value', '').lower():
                    parents = [n for n in G.predecessors(node_id)]
                    results.append({
                        'comparison': data['value'],
                        'paper_id': data.get('paper_id', ''),
                        'paper': G.nodes[parents[0]].get('label') if parents else '',
                        'confidence': data.get('confidence', ''),
                    })
        return results

    elif query_type == "limitations_of":
        pid = kwargs.get("paper_id", "")
        paper_node = f"paper:{pid}"
        results = []
        if paper_node in G:
            for succ in G.successors(paper_node):
                succ_data = G.nodes[succ]
                if succ_data.get('type') == 'limitation':
                    results.append({
                        'value': succ_data.get('value', ''),
                        'confidence': succ_data.get('confidence', ''),
                    })
        return results

    elif query_type == "hardware_for_paper":
        pid = kwargs.get("paper_id", "")
        paper_node = f"paper:{pid}"
        results = []
        if paper_node in G:
            for succ in G.successors(paper_node):
                succ_data = G.nodes[succ]
                if succ_data.get('type') == 'hardware':
                    results.append({
                        'hardware': succ_data.get('value', ''),
                    })
        return results

    elif query_type == "hardware_overlap":
        pid = kwargs.get("paper_id", "")
        paper_node = f"paper:{pid}"
        results = []
        if paper_node in G:
            hw_nodes = [
                n for n in G.successors(paper_node)
                if G.nodes[n].get('type') == 'hardware'
            ]
            for hw_node in hw_nodes:
                other_papers = [
                    n for n in G.predecessors(hw_node)
                    if n != paper_node and G.nodes[n].get('type') == 'paper'
                ]
                for op in other_papers:
                    results.append({
                        'hardware': G.nodes[hw_node].get('value', ''),
                        'other_paper': G.nodes[op].get('label', ''),
                        'other_paper_id': G.nodes[op].get('paper_id', ''),
                    })
        return results

    elif query_type == "similar_problems":
        pid = kwargs.get("paper_id", "")
        paper_node = f"paper:{pid}"
        results = []
        if paper_node in G:
            problems = [
                n for n in G.successors(paper_node)
                if G.nodes[n].get('type') == 'problem'
            ]
            seen = set()
            for prob in problems:
                other_papers = [
                    n for n in G.predecessors(prob)
                    if n != paper_node and G.nodes[n].get('type') == 'paper'
                ]
                for op in other_papers:
                    opid = G.nodes[op].get('paper_id', '')
                    if opid not in seen:
                        seen.add(opid)
                        results.append({
                            'paper': G.nodes[op].get('label', ''),
                            'paper_id': opid,
                            'shared_problem': G.nodes[prob].get('value', ''),
                        })
        return results

    elif query_type == "shared_techniques":
        pid_a = kwargs.get("paper_a", "")
        pid_b = kwargs.get("paper_b", "")
        node_a = f"paper:{pid_a}"
        node_b = f"paper:{pid_b}"
        results = []
        if node_a in G and node_b in G:
            techs_a = {n for n in G.successors(node_a) if G.nodes[n].get('type') == 'technique'}
            techs_b = {n for n in G.successors(node_b) if G.nodes[n].get('type') == 'technique'}
            shared = techs_a & techs_b
            for tech_node in shared:
                results.append({
                    'technique': G.nodes[tech_node].get('label', ''),
                    'subtype': G.nodes[tech_node].get('subtype', ''),
                })
        return results

    elif query_type == "problems_addressed":
        results = []
        seen = set()
        for node_id, data in G.nodes(data=True):
            if data.get('type') == 'problem':
                val = data.get('value', '')
                if val not in seen:
                    seen.add(val)
                    papers = [
                        G.nodes[n].get('paper_id', '')
                        for n in G.predecessors(node_id)
                        if G.nodes[n].get('type') == 'paper'
                    ]
                    results.append({
                        'problem': val,
                        'n_papers': len(papers),
                        'papers': papers[:5],
                    })
        results.sort(key=lambda x: x['n_papers'], reverse=True)
        return results

    return []


# ---------------------------------------------------------------------------
# Context formatting for LLM prompts
# ---------------------------------------------------------------------------

def compute_graph_context(
    query: str,
    G: nx.DiGraph,
    ranked_methods: list,
    intent: str = "BROAD",
    max_tokens: int = 500,
) -> tuple:
    """Derive KG context relevant to a query for injection into LLM prompt.

    Args:
        query: User's natural language query
        G: The knowledge graph
        ranked_methods: List of (method_name, score) or method names
        intent: Query intent from router (BROAD, TECHNICAL, EVALUATION, COMPARISON, LIMITATION)
        max_tokens: Approximate token budget

    Returns:
        (formatted_text, traversal_data) where traversal_data is a list of
        traversal steps for the frontend's graph reasoning page.
    """
    if G is None or G.number_of_nodes() == 0:
        return "", []

    # Get paper IDs for top methods
    top_pids = []
    top_method_names = []
    for item in ranked_methods[:5]:
        method_name = item[0] if isinstance(item, (list, tuple)) else item
        node_id = f"method:{method_name}"
        if node_id in G:
            pid = G.nodes[node_id].get('paper_id', '')
            if pid:
                top_pids.append(pid)
                top_method_names.append(method_name)

    sections = []
    traversal = []  # Structured traversal log

    # Log the starting point
    traversal.append({
        'step': 'query_intent',
        'description': f'Classified query as {intent}',
        'detail': f'Matched {len(top_pids)} methods to papers',
        'nodes': [f"method:{m}" for m in top_method_names],
        'edges': [],
    })

    # --- Intent-driven queries ---

    if intent in ("BROAD", "TECHNICAL"):
        contribs = []
        traversal_nodes = []
        traversal_edges = []
        for pid in top_pids[:3]:
            paper_node = f"paper:{pid}"
            results = graph_query(G, "contributions_for_paper", paper_id=pid)
            # Only keep contributions that are substantial (>30 chars) and high confidence
            key = [r for r in results
                   if not r.get('is_methodology')
                   and r.get('confidence') == 'high'
                   and len(r.get('value', '')) > 30]
            for r in key[:2]:
                contribs.append(f"- {_format_paper_name(pid)}: {r['value']}")
                # Find the actual contribution node
                for succ in G.successors(paper_node):
                    sd = G.nodes.get(succ, {})
                    if sd.get('type') == 'contribution' and sd.get('value', '') == r.get('value', ''):
                        traversal_nodes.append(succ)
                        traversal_edges.append({'source': paper_node, 'target': succ, 'type': 'contributes'})
                        break
        if contribs:
            sections.append("Key Contributions:\n" + "\n".join(contribs))
            traversal.append({
                'step': 'contributions',
                'description': f'Traversed paper→contribution edges for {len(top_pids[:3])} papers',
                'detail': f'Found {len(contribs)} key contributions',
                'nodes': traversal_nodes,
                'edges': traversal_edges,
            })

    if intent in ("EVALUATION", "COMPARISON"):
        comps = []
        traversal_nodes = []
        traversal_edges = []
        import re as _re
        for pid in top_pids[:3]:
            paper_node = f"paper:{pid}"
            for node_id in G.successors(paper_node):
                data = G.nodes.get(node_id, {})
                if data.get('type') == 'comparison' and data.get('confidence') != 'low':
                    value = data.get('value', '')
                    # Only keep comparisons that are specific:
                    # must contain a number/percentage OR a named method
                    has_metric = bool(_re.search(r'\d+\.?\d*\s*%|\d+\.\d+', value))
                    has_method_name = bool(_re.search(r'[A-Z][a-z]+(?:Net|GAN|GPD|Grasp|VGN|SAM|GPT|Former)', value))
                    if not has_metric and not has_method_name:
                        continue
                    comps.append(f"- {_format_paper_name(pid)}: {value}")
                    traversal_nodes.append(node_id)
                    traversal_edges.append({'source': paper_node, 'target': node_id, 'type': 'compares'})
                    # Check for outperforms edge
                    for succ in G.successors(paper_node):
                        edge = G[paper_node].get(succ, {})
                        if edge.get('type') == 'outperforms':
                            traversal_edges.append({'source': paper_node, 'target': succ, 'type': 'outperforms', 'evidence': edge.get('evidence', '')})
        if comps:
            sections.append("Cross-Method Comparisons:\n" + "\n".join(comps[:5]))
            traversal.append({
                'step': 'comparisons',
                'description': f'Traversed paper→comparison and paper→outperforms edges',
                'detail': f'Found {len(comps)} comparison claims',
                'nodes': traversal_nodes,
                'edges': traversal_edges,
            })

    if intent == "LIMITATION":
        limits = []
        traversal_nodes = []
        traversal_edges = []
        for pid in top_pids[:5]:
            paper_node = f"paper:{pid}"
            results = graph_query(G, "limitations_of", paper_id=pid)
            for r in results[:2]:
                limits.append(f"- {_format_paper_name(pid)}: {r['value']}")
                for succ in G.successors(paper_node):
                    sd = G.nodes.get(succ, {})
                    if sd.get('type') == 'limitation' and sd.get('value', '') == r.get('value', ''):
                        traversal_nodes.append(succ)
                        traversal_edges.append({'source': paper_node, 'target': succ, 'type': 'has_limitation'})
                        break
        if limits:
            sections.append("Known Limitations:\n" + "\n".join(limits))
            traversal.append({
                'step': 'limitations',
                'description': f'Traversed paper→limitation edges for {len(top_pids[:5])} papers',
                'detail': f'Found {len(limits)} limitations',
                'nodes': traversal_nodes,
                'edges': traversal_edges,
            })

    # --- Shared techniques (ONLY those mentioned in query or used by the top methods) ---
    query_lower = query.lower()
    # Find techniques used by the top-ranked papers specifically
    top_paper_techniques = {}  # tech_node -> set of paper_ids that use it
    for pid in top_pids:
        paper_node = f"paper:{pid}"
        if paper_node not in G:
            continue
        for succ in G.successors(paper_node):
            sd = G.nodes.get(succ, {})
            if sd.get('type') == 'technique':
                if succ not in top_paper_techniques:
                    top_paper_techniques[succ] = set()
                top_paper_techniques[succ].add(pid)

    # Only show techniques shared by 2+ of the TOP methods, or explicitly mentioned in query
    tech_hits = []
    tech_traversal_nodes = []
    tech_traversal_edges = []
    for tech_node, pids_using in top_paper_techniques.items():
        td = G.nodes.get(tech_node, {})
        label = td.get('label', '')
        mentioned_in_query = label.lower() in query_lower
        shared_by_top = len(pids_using) >= 2

        if mentioned_in_query or shared_by_top:
            tech_hits.append({
                'label': label,
                'subtype': td.get('subtype', ''),
                'count': len(pids_using),
                'papers': [_format_paper_name(p) for p in pids_using],
            })
            tech_traversal_nodes.append(tech_node)
            for pid in pids_using:
                paper_node = f"paper:{pid}"
                edge = G[paper_node].get(tech_node, {})
                tech_traversal_edges.append({'source': paper_node, 'target': tech_node, 'type': edge.get('type', '')})

    if tech_hits:
        tech_hits.sort(key=lambda x: x['count'], reverse=True)
        lines = [f"- {t['label']} ({t['subtype']}): used by {', '.join(t['papers'])}" for t in tech_hits[:5]]
        sections.append("Shared Techniques (among relevant methods):\n" + "\n".join(lines))
        traversal.append({
            'step': 'shared_techniques',
            'description': f'Found techniques shared among top-ranked methods',
            'detail': f'{len(tech_hits)} shared techniques across {len(top_pids)} relevant papers',
            'nodes': tech_traversal_nodes[:10],
            'edges': tech_traversal_edges[:20],
        })

    # --- Hardware (only when query is about hardware/robots/grippers) ---
    if any(kw in query_lower for kw in ('hardware', 'robot', 'gripper', 'sensor', 'camera', 'arm', 'franka', 'allegro', 'realsense')):
        hw_lines = []
        hw_nodes = []
        hw_edges = []
        for pid in top_pids[:5]:
            paper_node = f"paper:{pid}"
            results = graph_query(G, "hardware_for_paper", paper_id=pid)
            for r in results:
                hw_lines.append(f"- {_format_paper_name(pid)}: {r['hardware']}")
                for succ in G.successors(paper_node):
                    if G.nodes.get(succ, {}).get('type') == 'hardware':
                        hw_nodes.append(succ)
                        hw_edges.append({'source': paper_node, 'target': succ, 'type': 'uses_hardware'})
        if hw_lines:
            sections.append("Hardware Used:\n" + "\n".join(hw_lines[:5]))
            traversal.append({
                'step': 'hardware',
                'description': f'Traversed paper\u2192hardware edges',
                'detail': f'Found {len(hw_lines)} hardware mentions',
                'nodes': hw_nodes,
                'edges': hw_edges,
            })

    # --- Citation network for relevant papers ---
    cite_lines = []
    cite_edges = []
    for pid in top_pids[:5]:
        paper_node = f"paper:{pid}"
        if paper_node not in G:
            continue
        # Papers this paper cites (outgoing cites edges)
        for succ in G.successors(paper_node):
            edge = G[paper_node].get(succ, {})
            if edge.get('type') == 'cites':
                tgt_label = G.nodes[succ].get('label', '')
                mentions = edge.get('mentions', 0)
                cite_lines.append(f"- {_format_paper_name(pid)} cites {tgt_label} ({mentions} mentions)")
                cite_edges.append({'source': paper_node, 'target': succ, 'type': 'cites'})
        # Papers that cite this paper (incoming cites edges)
        for pred in G.predecessors(paper_node):
            edge = G[pred].get(paper_node, {})
            if edge.get('type') == 'cites':
                src_label = G.nodes[pred].get('label', '')
                mentions = edge.get('mentions', 0)
                cite_lines.append(f"- {src_label} cites {_format_paper_name(pid)} ({mentions} mentions)")
                cite_edges.append({'source': pred, 'target': paper_node, 'type': 'cites'})

    if cite_lines:
        # Deduplicate
        cite_lines = list(dict.fromkeys(cite_lines))[:8]
        sections.append("Citation Network:\n" + "\n".join(cite_lines))
        traversal.append({
            'step': 'citations',
            'description': f'Found citation relationships for relevant papers',
            'detail': f'{len(cite_lines)} citation links',
            'nodes': [],
            'edges': cite_edges[:10],
        })

    # --- TEI-derived: Citation stance breakdown (COMPARISON/BROAD) ---
    if intent in ("COMPARISON", "BROAD"):
        stance_lines = []
        stance_edges = []
        for pid in top_pids[:4]:
            paper_node = f"paper:{pid}"
            if paper_node not in G:
                continue
            for succ in G.successors(paper_node):
                edge = G[paper_node].get(succ, {})
                if edge.get('type') == 'cites' and edge.get('sentiment'):
                    sentiment = edge.get('sentiment', 'neutral')
                    if sentiment == 'neutral':
                        continue
                    tgt_label = G.nodes[succ].get('label', '')
                    stance_lines.append(f"- {_format_paper_name(pid)} {sentiment.replace('_', ' ')} {tgt_label}")
                    stance_edges.append({'source': paper_node, 'target': succ, 'type': 'cites', 'sentiment': sentiment})
        if stance_lines:
            stance_lines = list(dict.fromkeys(stance_lines))[:6]
            sections.append("Citation Stance (builds-on vs differs-from):\n" + "\n".join(stance_lines))
            traversal.append({
                'step': 'citation_stance',
                'description': 'Analyzed citation sentiment (builds_on/differs_from) from in-text context',
                'detail': f'{len(stance_lines)} non-neutral citations',
                'nodes': [],
                'edges': stance_edges[:8],
            })

    # --- TEI-derived: Authors + institutions (PEOPLE intent, or mentioned in query) ---
    people_query = any(kw in query_lower for kw in
                       ('author', 'wrote', 'researcher', 'lab', 'university', 'institution', 'who'))
    if intent == "PEOPLE" or people_query:
        people_lines = []
        people_nodes = []
        people_edges = []
        from collections import Counter
        inst_counter = Counter()
        for pid in top_pids[:6]:
            paper_node = f"paper:{pid}"
            if paper_node not in G:
                continue
            paper_authors = []
            for succ in G.successors(paper_node):
                sd = G.nodes.get(succ, {})
                if sd.get('type') == 'author':
                    paper_authors.append(sd.get('label', ''))
                    people_nodes.append(succ)
                    people_edges.append({'source': paper_node, 'target': succ, 'type': 'authored_by'})
                if sd.get('type') == 'institution':
                    inst_counter[sd.get('label', '')] += 1
            if paper_authors:
                people_lines.append(f"- {_format_paper_name(pid)}: {', '.join(paper_authors[:5])}"
                                    f"{' +' + str(len(paper_authors)-5) if len(paper_authors) > 5 else ''}")
        if people_lines:
            sections.append("Authors (from TEI headers):\n" + "\n".join(people_lines[:6]))
        if inst_counter:
            top_insts = [f"- {name} ({c} papers)" for name, c in inst_counter.most_common(5)]
            sections.append("Institutions Involved:\n" + "\n".join(top_insts))
        if people_lines or inst_counter:
            traversal.append({
                'step': 'people',
                'description': 'Traversed paper→author and paper→institution edges (TEI)',
                'detail': f'{len(people_nodes)} author relations, {len(inst_counter)} institutions',
                'nodes': people_nodes[:10],
                'edges': people_edges[:12],
            })

    # --- TEI-derived: Shared foundational works (BROAD/COMPARISON) ---
    if intent in ("BROAD", "COMPARISON") and len(top_pids) >= 2:
        from collections import Counter
        ref_counter = Counter()
        ref_meta = {}
        for pid in top_pids[:6]:
            paper_node = f"paper:{pid}"
            if paper_node not in G:
                continue
            for succ in G.successors(paper_node):
                edge = G[paper_node].get(succ, {})
                if edge.get('type') == 'cites_external':
                    sd = G.nodes.get(succ, {})
                    label = sd.get('label', '')
                    if label:
                        ref_counter[label] += 1
                        if label not in ref_meta:
                            ref_meta[label] = {
                                'year': sd.get('year', ''),
                                'authors': sd.get('authors', [])[:2],
                            }
        # Only keep refs shared by 2+ of the top papers
        shared_refs = [(label, c) for label, c in ref_counter.most_common(5) if c >= 2]
        if shared_refs:
            lines = []
            for label, c in shared_refs:
                meta = ref_meta.get(label, {})
                authors = ', '.join(meta.get('authors', [])) if meta.get('authors') else ''
                yr = meta.get('year', '')
                extra = f" ({authors}, {yr})" if authors else (f" ({yr})" if yr else '')
                lines.append(f"- [{c} papers] {label[:120]}{extra}")
            sections.append("Foundational Works Shared Across Top Methods:\n" + "\n".join(lines))
            traversal.append({
                'step': 'shared_refs',
                'description': 'Found external references cited by multiple top papers',
                'detail': f'{len(shared_refs)} shared foundational works',
                'nodes': [],
                'edges': [],
            })

    # --- TEI-derived: Benchmark tables (EVALUATION) ---
    if intent == "EVALUATION":
        table_lines = []
        for pid in top_pids[:4]:
            paper_node = f"paper:{pid}"
            if paper_node not in G:
                continue
            for succ in G.successors(paper_node):
                sd = G.nodes.get(succ, {})
                if sd.get('type') == 'table' and sd.get('caption'):
                    caption = sd.get('caption', '')[:200]
                    cells = sd.get('cells', [])
                    # Show header + up to 3 data rows
                    preview = ''
                    if cells and len(cells) >= 2:
                        header_row = ' | '.join(str(c)[:24] for c in cells[0])
                        data_rows = ['; '.join(str(c)[:20] for c in row) for row in cells[1:4]]
                        preview = f"\n    Columns: {header_row}\n    Rows: {' / '.join(data_rows)}"
                    table_lines.append(f"- {_format_paper_name(pid)}: {caption}{preview}")
        if table_lines:
            sections.append("Benchmark Tables (structured data):\n" + "\n".join(table_lines[:4]))
            traversal.append({
                'step': 'tables',
                'description': 'Surfaced structured table data from TEI',
                'detail': f'{len(table_lines)} tables',
                'nodes': [],
                'edges': [],
            })

    # --- Ground-truth training / evaluation datasets (EVALUATION / TECHNICAL) ---
    # Uses CSV-backed `evaluated_on` (method→dataset) — authoritative, unlike
    # `trained_on` which comes from Groq extracting paper prose. Critical to
    # counter the LLM's imprecise "trained on Egad/ACRONYM" hallucinations.
    if intent in ("EVALUATION", "TECHNICAL", "BROAD"):
        ds_lines = []
        ds_nodes = []
        ds_edges = []
        for pid in top_pids[:5]:
            paper_node = f"paper:{pid}"
            if paper_node not in G:
                continue
            # Walk paper → method (described_in) → dataset (evaluated_on / uses_dataset)
            method_nodes = [
                p for p in G.predecessors(paper_node)
                if G.nodes.get(p, {}).get('type') == 'method'
            ]
            datasets_for_paper = []
            for m in method_nodes:
                for succ in G.successors(m):
                    etype = G[m].get(succ, {}).get('type', '')
                    if etype in ('evaluated_on', 'uses_dataset'):
                        d = G.nodes.get(succ, {})
                        if d.get('type') == 'dataset':
                            datasets_for_paper.append(d.get('label', ''))
                            ds_nodes.append(succ)
                            ds_edges.append({'source': m, 'target': succ, 'type': etype})
            if datasets_for_paper:
                ds_lines.append(
                    f"- {_format_paper_name(pid)}: "
                    + ", ".join(sorted(set(datasets_for_paper))[:5])
                )
        if ds_lines:
            sections.append(
                "Datasets (ground truth, from method metadata):\n" + "\n".join(ds_lines[:5])
            )
            traversal.append({
                'step': 'datasets_ground_truth',
                'description': 'CSV-derived method→dataset evaluations (authoritative)',
                'detail': f'{len(ds_lines)} papers with dataset links',
                'nodes': ds_nodes[:10],
                'edges': ds_edges[:10],
            })

    # --- Intellectual siblings (COMPARISON / BROAD) — papers sharing heavy
    #     bibliographic overlap even when they don't cite each other directly.
    #     Surfaces relationships the model discovered via co-citation. ---
    if intent in ("COMPARISON", "BROAD"):
        sibling_lines = []
        seen_pairs = set()
        for pid in top_pids[:4]:
            paper_node = f"paper:{pid}"
            if paper_node not in G:
                continue
            for succ in G.successors(paper_node):
                ed = G[paper_node].get(succ, {})
                etype = ed.get('type', '')
                if etype not in ('co_cited_with', 'shares_bibliography'):
                    continue
                tgt = G.nodes.get(succ, {})
                if tgt.get('type') != 'paper':
                    continue
                tgt_pid = succ.replace('paper:', '')
                if tgt_pid == pid:
                    continue
                key = tuple(sorted([pid, tgt_pid]))
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                detail = ''
                if etype == 'co_cited_with':
                    detail = f"share {ed.get('weight', '?')} external references"
                elif etype == 'shares_bibliography':
                    j = ed.get('jaccard', 0)
                    detail = f"{int(j*100)}% bibliography overlap"
                sibling_lines.append(
                    f"- {_format_paper_name(pid)} ↔ {_format_paper_name(tgt_pid)} ({detail})"
                )
        if sibling_lines:
            sections.append(
                "Intellectual Siblings (shared scholarly lineage):\n"
                + "\n".join(sibling_lines[:5])
            )
            traversal.append({
                'step': 'intellectual_siblings',
                'description': 'Papers drawing from overlapping bibliographic bases',
                'detail': f'{len(sibling_lines)} sibling pairs',
                'nodes': [],
                'edges': [],
            })

    # --- Co-authorship network (PEOPLE / TECHNICAL) — who collaborates with whom ---
    if intent in ("PEOPLE", "TECHNICAL"):
        coauth_counts = {}
        for pid in top_pids[:5]:
            paper_node = f"paper:{pid}"
            if paper_node not in G:
                continue
            # paper → author → co_authored_with → author
            for a in G.successors(paper_node):
                if G.nodes.get(a, {}).get('type') != 'author':
                    continue
                for co in G.successors(a):
                    ed = G[a].get(co, {})
                    if ed.get('type') != 'co_authored_with':
                        continue
                    co_data = G.nodes.get(co, {})
                    if co_data.get('type') != 'author':
                        continue
                    label = co_data.get('label', '')
                    if label:
                        coauth_counts[label] = coauth_counts.get(label, 0) + 1
        top_collabs = sorted(coauth_counts.items(), key=lambda x: -x[1])[:6]
        if top_collabs:
            sections.append(
                "Recurring Collaborators (across these papers' author networks):\n"
                + "\n".join(f"- {name} ({n} shared-paper links)" for name, n in top_collabs)
            )
            traversal.append({
                'step': 'coauthorship',
                'description': 'Walked author→co_authored_with→author',
                'detail': f'{len(top_collabs)} recurring collaborators',
                'nodes': [],
                'edges': [],
            })

    # --- Inferred relationships from HGT link prediction ---
    predicted_edges_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', 'chroma_db', 'hgt_schema', 'predicted_edges.json'
    )
    if os.path.exists(predicted_edges_path):
        try:
            with open(predicted_edges_path) as f:
                all_predicted = json.load(f)

            # Filter to predictions relevant to the top methods' papers
            inferred_items = []
            inferred_edges = []
            for pred in all_predicted:
                src_pid = pred.get('src_id', '').replace('paper:', '')
                if src_pid not in top_pids:
                    continue
                # Skip outperforms (too noisy at this scale)
                if pred['edge_type'] == 'outperforms':
                    continue
                sem_rel = pred.get('semantic_relevance', 0)
                if sem_rel < 0.35:
                    continue

                paper_name = _format_paper_name(src_pid)
                tgt_value = pred.get('tgt_value', pred.get('tgt_label', ''))
                etype = pred['edge_type']
                conf = pred['confidence']

                inferred_items.append(
                    f"- {paper_name} likely {etype.replace('_', ' ')}: {tgt_value} "
                    f"({conf:.0%} graph confidence, {sem_rel:.0%} semantic match)"
                )
                inferred_edges.append({
                    'source': pred['src_id'],
                    'target': pred['tgt_id'],
                    'type': etype,
                    'confidence': conf,
                    'semantic_relevance': sem_rel,
                    'inferred': True,
                })

            if inferred_items:
                sections.append("Inferred Relationships (from graph structure):\n" + "\n".join(inferred_items[:5]))
                traversal.append({
                    'step': 'inferred',
                    'description': 'HGT link prediction on graph structure',
                    'detail': f'{len(inferred_items)} relationships inferred for relevant papers',
                    'nodes': [],
                    'edges': inferred_edges[:5],
                })
        except Exception as e:
            logger.warning(f"Failed to load predicted edges: {e}")

    # --- Summary stats for traversal ---
    all_traversed_nodes = set()
    all_traversed_edges = 0
    for t in traversal:
        all_traversed_nodes.update(t.get('nodes', []))
        all_traversed_edges += len(t.get('edges', []))

    traversal.append({
        'step': 'summary',
        'description': f'Traversal complete',
        'detail': f'{len(all_traversed_nodes)} nodes visited, {all_traversed_edges} edges followed, {len(traversal)-1} reasoning steps',
        'nodes': [],
        'edges': [],
    })

    result = "\n\n".join(sections)
    words = result.split()
    if len(words) > max_tokens:
        result = ' '.join(words[:max_tokens])

    # Resolve all traversal edges to human-readable data
    for step in traversal:
        resolved_edges = []
        for edge in step.get('edges', []):
            src = edge.get('source', '')
            tgt = edge.get('target', '')
            etype = edge.get('type', '')
            extra = {k: v for k, v in edge.items() if k not in ('source', 'target', 'type')}
            resolved_edges.append(_resolve_edge(G, src, tgt, etype, extra))
        step['edges'] = resolved_edges

    return result, traversal


# ---------------------------------------------------------------------------
# Graph stats (for logging / API)
# ---------------------------------------------------------------------------

def _resolve_edge(G: nx.DiGraph, source: str, target: str, edge_type: str, extra: dict = None) -> dict:
    """Turn a raw edge into a human-readable dict for the frontend."""
    src_data = G.nodes.get(source, {})
    tgt_data = G.nodes.get(target, {})

    resolved = {
        'source_id': source,
        'target_id': target,
        'type': edge_type,
        'source_label': src_data.get('label', source.split(':')[-1].replace('-', ' ').title()),
        'source_type': src_data.get('type', ''),
        'target_label': tgt_data.get('label', target.split(':')[-1].replace('-', ' ').title()),
        'target_type': tgt_data.get('type', ''),
    }
    # Add the full value text for contribution/comparison/limitation/problem targets
    if tgt_data.get('type') in ('contribution', 'comparison', 'limitation', 'problem'):
        resolved['target_value'] = tgt_data.get('value', '')
    if tgt_data.get('type') == 'hardware':
        resolved['target_value'] = tgt_data.get('value', '')
    if tgt_data.get('type') == 'technique':
        resolved['target_value'] = tgt_data.get('label', '')
        resolved['target_subtype'] = tgt_data.get('subtype', '')
    if extra:
        resolved.update(extra)
    return resolved


def detect_contradictions(G: nx.DiGraph, model=None) -> list:
    """Find conflicting claims across papers about the same technique or topic.

    Looks for:
    1. Same technique used by papers with contradicting claims
    2. Limitation of one paper vs contribution of another about same concept
    3. Comparison claims that conflict

    Returns list of {paper_a, paper_b, topic, claim_a, claim_b, conflict_type}
    """
    contradictions = []

    # Collect claims grouped by paper
    paper_claims = defaultdict(list)
    for node_id, data in G.nodes(data=True):
        if data.get('type') in ('contribution', 'comparison', 'limitation', 'problem'):
            pid = data.get('paper_id', '')
            if not pid:
                # Find parent paper
                for pred in G.predecessors(node_id):
                    if G.nodes[pred].get('type') == 'paper':
                        pid = G.nodes[pred].get('paper_id', '')
                        break
            if pid:
                paper_claims[pid].append({
                    'node_id': node_id,
                    'type': data.get('type', ''),
                    'original_type': data.get('subtype', data.get('original_type', data.get('type', ''))),
                    'value': data.get('value', ''),
                    'confidence': data.get('confidence', ''),
                })

    # Find techniques shared by 2+ papers
    technique_papers = defaultdict(set)
    for node_id, data in G.nodes(data=True):
        if data.get('type') == 'technique':
            for pred in G.predecessors(node_id):
                if G.nodes[pred].get('type') == 'paper':
                    technique_papers[node_id].add(G.nodes[pred].get('paper_id', ''))

    # For each shared technique, compare claims between papers
    for tech_node, pids in technique_papers.items():
        if len(pids) < 2:
            continue
        tech_label = G.nodes[tech_node].get('label', '')
        pid_list = list(pids)

        for i in range(len(pid_list)):
            for j in range(i + 1, len(pid_list)):
                pa, pb = pid_list[i], pid_list[j]
                claims_a = paper_claims.get(pa, [])
                claims_b = paper_claims.get(pb, [])

                # Check for limitation vs contribution about same concept
                limits_a = [c for c in claims_a if c['original_type'] == 'limitation']
                contribs_b = [c for c in claims_b if c['original_type'] in ('contribution', 'comparison')]

                for la in limits_a:
                    for cb in contribs_b:
                        # Check if they're about the same topic (keyword overlap)
                        la_words = set(la['value'].lower().split())
                        cb_words = set(cb['value'].lower().split())
                        shared = la_words & cb_words - {'the', 'a', 'an', 'is', 'are', 'of', 'in', 'to', 'and', 'for', 'with', 'on'}
                        if len(shared) >= 3:
                            contradictions.append({
                                'paper_a': _format_paper_name(pa),
                                'paper_a_id': pa,
                                'paper_b': _format_paper_name(pb),
                                'paper_b_id': pb,
                                'technique': tech_label,
                                'claim_a': la['value'],
                                'claim_a_type': 'limitation',
                                'claim_b': cb['value'],
                                'claim_b_type': cb['original_type'],
                                'conflict_type': 'limitation_vs_claim',
                                'shared_words': list(shared)[:5],
                            })

    # Check for competing comparison claims
    comparison_targets = defaultdict(list)
    for node_id, data in G.nodes(data=True):
        if data.get('type') == 'comparison':
            pid = data.get('paper_id', '')
            value = data.get('value', '')
            if pid and value:
                comparison_targets[pid].append(value)

    # If paper A says "outperforms X" and paper X exists in corpus, flag if X claims superiority too
    for src, tgt, edge_data in G.edges(data=True):
        if edge_data.get('type') == 'outperforms':
            src_pid = G.nodes[src].get('paper_id', '')
            tgt_pid = G.nodes[tgt].get('paper_id', '')
            # Check if the target also claims to outperform the source (mutual competition)
            if G.has_edge(tgt, src) and G[tgt][src].get('type') == 'outperforms':
                contradictions.append({
                    'paper_a': _format_paper_name(src_pid),
                    'paper_a_id': src_pid,
                    'paper_b': _format_paper_name(tgt_pid),
                    'paper_b_id': tgt_pid,
                    'technique': 'performance comparison',
                    'claim_a': G[src][tgt].get('evidence', 'claims to outperform'),
                    'claim_a_type': 'outperforms',
                    'claim_b': G[tgt][src].get('evidence', 'claims to outperform'),
                    'claim_b_type': 'outperforms',
                    'conflict_type': 'mutual_superiority',
                    'shared_words': [],
                })

    # Deduplicate
    seen = set()
    unique = []
    for c in contradictions:
        key = tuple(sorted([c['paper_a_id'], c['paper_b_id']])) + (c['conflict_type'],)
        if key not in seen:
            seen.add(key)
            unique.append(c)

    return unique


def get_graph_stats(G: nx.DiGraph) -> dict:
    """Return summary statistics about the graph."""
    type_counts = Counter(d.get('type', '') for _, d in G.nodes(data=True))
    edge_type_counts = Counter(d.get('type', '') for _, _, d in G.edges(data=True))
    return {
        'n_nodes': G.number_of_nodes(),
        'n_edges': G.number_of_edges(),
        'node_types': dict(type_counts),
        'edge_types': dict(edge_type_counts),
    }
