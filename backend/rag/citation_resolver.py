"""Resolve within-corpus citations to create 'cites' edges.

Scans each paper's text for mentions of other papers' method names,
paper titles, or known aliases. Creates directed edges:
  paper_A --[cites]--> paper_B

This captures relationships like "we compare against Contact-GraspNet [15]"
without needing to resolve numbered reference markers.
"""

import json
import logging
import os
import re
from collections import defaultdict

logger = logging.getLogger(__name__)

# Known method name aliases (short forms that appear in text)
METHOD_ALIASES = {
    'contact-graspnet': ['contact-graspnet', 'contactgraspnet', 'contact grasp net'],
    'anygrasp': ['anygrasp', 'any grasp'],
    'pointnetgpd': ['pointnetgpd', 'pointnet gpd', 'pointnet-gpd'],
    'grasp-pose-detection-gpd': ['gpd', 'grasp pose detection'],
    'volumetric-grasping-network-vgn': ['vgn', 'volumetric grasping network'],
    'grasp-detection-via-implicit-geometry-and-affordance-giga': ['giga'],
    'edge-grasp-network': ['edge grasp network', 'edgegraspnet'],
    'single-shot-se-3-grasp-detection-s4g': ['s4g'],
    'region-based-grasp-network-regnet': ['regnet'],
    'goal-auxiliary-deep-deterministic-policy-gradient-ga-ddpg': ['ga-ddpg'],
    'dexdiffuser': ['dexdiffuser', 'dex-diffuser'],
    'dexgrasp-anything': ['dexgrasp anything', 'dexgrasp-anything'],
    'catgrasp': ['catgrasp', 'cat-grasp'],
    'gcngrasp': ['gcngrasp', 'gcn-grasp'],
    'neugraspnet': ['neugraspnet', 'neu-graspnet'],
    'graspgen': ['graspgen', 'grasp-gen'],
    'graspsam': ['graspsam', 'grasp-sam'],
    'graspgpt': ['graspgpt', 'grasp-gpt'],
    'foundationgrasp': ['foundationgrasp', 'foundation-grasp'],
    'zerograsp': ['zerograsp', 'zero-grasp'],
    'robustdexgrasp': ['robustdexgrasp'],
    'graspxl': ['graspxl', 'grasp-xl'],
    'graspmolmo': ['graspmolmo'],
    'graspvla': ['graspvla'],
    'graspqp': ['graspqp'],
}


def _classify_citation_sentiment(contexts: list) -> str:
    """Classify citation as positive (builds_on), negative (differs_from), or neutral.

    Uses keyword patterns in the surrounding context to infer sentiment.
    """
    positive_signals = re.compile(
        r'\b(build(?:s|ing)?\s+on|extend(?:s|ing)?|follow(?:s|ing)?|inspired\s+by|based\s+on|'
        r'leverage(?:s|d)?|adopt(?:s|ed)?|similar\s+to|we\s+use|improve(?:s|d)?\s+upon)\b',
        re.IGNORECASE
    )
    negative_signals = re.compile(
        r'\b(outperform(?:s|ed)?|unlike|in\s+contrast|differ(?:s|ent)?|'
        r'suffer(?:s|ed)?\s+from|limited|fail(?:s|ed)?|cannot|worse|'
        r'however|although|disadvantage|shortcoming)\b',
        re.IGNORECASE
    )

    pos_count = 0
    neg_count = 0
    for ctx in contexts:
        pos_count += len(positive_signals.findall(ctx))
        neg_count += len(negative_signals.findall(ctx))

    if pos_count > neg_count and pos_count >= 1:
        return 'builds_on'
    elif neg_count > pos_count and neg_count >= 1:
        return 'differs_from'
    return 'neutral'


def _auto_aliases(method_name: str) -> list:
    """Generate plausible name variants from a method name.

    E.g. "Contact-GraspNet" → ["contact-graspnet", "contactgraspnet", "contact graspnet"]
    """
    name = method_name.strip()
    variants = set()
    lower = name.lower()
    variants.add(lower)
    # Remove hyphens
    variants.add(lower.replace('-', ''))
    # Hyphens to spaces
    variants.add(lower.replace('-', ' '))
    # CamelCase split: "GraspNet" → "grasp net"
    camel = re.sub(r'([a-z])([A-Z])', r'\1 \2', name).lower()
    if camel != lower:
        variants.add(camel)
    # Extract acronym from parenthetical: "Something (ABC)" → "abc"
    m = re.search(r'\(([A-Z]{2,})\)', name)
    if m:
        variants.add(m.group(1).lower())
    return [v for v in variants if len(v) >= 3]


def build_mention_patterns(paper_ids: list, method_names: list) -> dict:
    """Build regex patterns for detecting paper mentions.

    Returns:
        {paper_id: compiled_regex}
    """
    patterns = {}

    for pid in paper_ids:
        # Collect all name variants for this paper
        variants = set()

        # The paper_id itself (with hyphens as spaces)
        clean = pid.replace('-', ' ').replace('_', ' ')
        if len(clean) > 4:
            variants.add(re.escape(clean))

        # Known manual aliases
        for alias in METHOD_ALIASES.get(pid, []):
            if len(alias) >= 3:
                variants.add(re.escape(alias))

        # Method names that map to this paper + auto-generated aliases
        for method_name in method_names:
            method_slug = method_name.lower().strip()
            method_slug_hyphen = re.sub(r'[^a-z0-9]+', '-', method_slug).strip('-')
            if method_slug_hyphen == pid or pid.startswith(method_slug_hyphen) or method_slug_hyphen.startswith(pid):
                if len(method_name) >= 4:
                    variants.add(re.escape(method_name))
                for alias in _auto_aliases(method_name):
                    variants.add(re.escape(alias))

        if not variants:
            continue

        # Build combined regex (case-insensitive, word boundary)
        combined = '|'.join(sorted(variants, key=len, reverse=True))
        try:
            patterns[pid] = re.compile(r'\b(' + combined + r')\b', re.IGNORECASE)
        except re.error:
            continue

    return patterns


def resolve_citations(
    paper_texts: dict,
    paper_ids: list,
    method_names: list,
    method_paper_map: dict = None,
) -> list:
    """Scan paper texts for cross-references to other papers in the corpus.

    Args:
        paper_texts: {paper_id: full_text}
        paper_ids: list of all paper IDs
        method_names: list of method names from CSV
        method_paper_map: {method_to_paper: {name: pid}, ...}

    Returns:
        List of citation edges: {source: pid, target: pid, mentions: int, contexts: [str]}
    """
    m2p = {}
    if method_paper_map:
        m2p = method_paper_map.get('method_to_paper', {})

    patterns = build_mention_patterns(paper_ids, method_names)
    print(f"[Citations] Built patterns for {len(patterns)} papers")

    edges = []
    seen = set()

    for src_pid, text in paper_texts.items():
        if not text or len(text) < 100:
            continue

        for tgt_pid, pattern in patterns.items():
            # Skip self-references
            if tgt_pid == src_pid:
                continue

            matches = list(pattern.finditer(text))
            if not matches:
                continue

            # Skip if already seen
            edge_key = (src_pid, tgt_pid)
            if edge_key in seen:
                continue
            seen.add(edge_key)

            # Extract context snippets around mentions and classify sentiment
            contexts = []
            for match in matches[:3]:  # max 3 context snippets
                start = max(0, match.start() - 100)
                end = min(len(text), match.end() + 100)
                ctx = text[start:end].replace('\n', ' ').strip()
                contexts.append(ctx)

            # Classify citation sentiment from context
            sentiment = _classify_citation_sentiment(contexts)

            edges.append({
                'source': src_pid,
                'target': tgt_pid,
                'mentions': len(matches),
                'contexts': contexts,
                'matched_text': matches[0].group(0),
                'sentiment': sentiment,
            })

    # Sort by mention count
    edges.sort(key=lambda x: x['mentions'], reverse=True)
    return edges


def run_citation_resolution(
    config_path: str = 'rag_config.yaml',
    output_path: str = None,
):
    """Full pipeline: load papers from ChromaDB, resolve citations, save edges."""
    from .config import load_config
    from .ingest.store import get_client, create_or_get_collection
    from .method_paper_map import build_method_paper_map
    import pandas as pd

    config = load_config(config_path)
    client = get_client(config)
    collection = create_or_get_collection(config, client)

    # Build paper texts from chunks
    total = collection.count()
    all_data = collection.get(include=['documents', 'metadatas'], limit=total)

    paper_texts = defaultdict(list)
    for doc, meta in zip(all_data['documents'], all_data['metadatas']):
        pid = meta.get('paper_id', '')
        if pid and doc:
            paper_texts[pid].append(doc)
    paper_texts = {pid: ' '.join(texts) for pid, texts in paper_texts.items()}

    paper_ids = sorted(paper_texts.keys())
    df = pd.read_csv(config.csv_path)
    method_names = [str(r['Name']).replace('\U0001f916 ', '').strip() for _, r in df.iterrows()]
    mpm = build_method_paper_map(config.csv_path, 'papers')

    print(f"[Citations] Scanning {len(paper_texts)} papers for cross-references...")

    edges = resolve_citations(paper_texts, paper_ids, method_names, mpm)

    print(f"[Citations] Found {len(edges)} citation edges")

    # Show results
    for edge in edges[:15]:
        print(f"  {edge['source']} --cites--> {edge['target']} "
              f"({edge['mentions']}x, matched: \"{edge['matched_text']}\")")

    # Save
    if output_path is None:
        output_path = os.path.join(config.chroma_persist_dir, 'citation_edges.json')
    with open(output_path, 'w') as f:
        json.dump(edges, f, indent=2)
    print(f"[Citations] Saved to {output_path}")

    return edges
