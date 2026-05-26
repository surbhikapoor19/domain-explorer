"""Term importance engine: builds a highlight dictionary from corpus metadata.

Instead of raw tokenization (which fails on noisy PDF text), this engine
uses two clean sources:
1. Domain topics already extracted during chunking (from rag_config.yaml vocabulary)
2. Acronyms auto-extracted from paper text patterns

Terms are scored by IDF across chunks: distinctive terms (appearing in few
chunks) get high scores and are worth highlighting. Common terms (appearing
everywhere) are suppressed.
"""

import json
import math
import os
from collections import Counter

try:
    from .acronym_extractor import extract_acronyms_from_chunks
except ImportError:
    from rag.acronym_extractor import extract_acronyms_from_chunks


def compute_term_dictionary(chunk_texts, chunk_metadatas=None):
    """Compute a term importance dictionary from chunk texts and metadata.

    Args:
        chunk_texts: list of chunk text strings
        chunk_metadatas: optional list of metadata dicts (with domain_topics field)

    Returns dict with:
        terms: list of {term, idf, df, type, definition}
        acronyms: list of {acronym, full_form, count}
    """
    n_docs = len(chunk_texts)
    if n_docs == 0:
        return {'terms': [], 'acronyms': []}

    # Source 1: Domain topics from chunk metadata
    topic_df = Counter()  # how many chunks contain each topic
    if chunk_metadatas:
        for meta in chunk_metadatas:
            topics_str = meta.get('domain_topics', '') if isinstance(meta, dict) else ''
            if topics_str:
                seen = set()
                for t in topics_str.split(', '):
                    t = t.strip()
                    if t and t not in seen:
                        topic_df[t] += 1
                        seen.add(t)

    # Source 2: Scan chunk text for topic mentions (case-insensitive)
    # if no metadata provided, extract from text using simple matching
    if not chunk_metadatas or not topic_df:
        # Fallback: extract common multi-word technical terms from text
        import re
        # Look for capitalized multi-word terms and hyphenated terms
        term_pattern = re.compile(r'\b[A-Z][a-z]+(?:[\-\s][A-Z]?[a-z]+)+\b')
        acro_pattern = re.compile(r'\b[A-Z]{2,6}\b')

        for text in chunk_texts:
            seen = set()
            for m in term_pattern.finditer(text):
                term = m.group()
                if term.lower() not in seen and len(term) > 4:
                    topic_df[term] += 1
                    seen.add(term.lower())
            for m in acro_pattern.finditer(text):
                acr = m.group()
                if acr not in seen and len(acr) >= 3:
                    topic_df[acr] += 1
                    seen.add(acr)

    # Source 3: Auto-extracted acronyms
    acronyms = extract_acronyms_from_chunks(chunk_texts)

    # Add acronym full forms as terms too
    for acr, info in acronyms.items():
        if acr not in topic_df:
            topic_df[acr] = info['count']
        if info['full_form'] not in topic_df:
            topic_df[info['full_form']] = info['count']

    # Compute IDF scores
    terms = []
    for term, doc_freq in topic_df.items():
        if doc_freq < 2:
            continue
        df_ratio = doc_freq / n_docs
        if df_ratio > 0.5:
            continue  # Too common, not distinctive

        idf = round(math.log(n_docs / (1 + doc_freq)), 3)

        # Classify
        term_type = 'domain'
        term_upper = term.upper()
        if term_upper in acronyms:
            term_type = 'acronym'
        elif term.isupper() and len(term) <= 6:
            term_type = 'acronym'
        elif any(p in term.lower() for p in ['net', 'model', 'encoder', 'decoder', 'former']):
            term_type = 'architecture'
        elif any(p in term.lower() for p in ['gripper', 'finger', 'suction', 'jaw']):
            term_type = 'gripper'
        elif any(p in term.lower() for p in ['cloud', 'depth', 'image', 'rgb', 'voxel']):
            term_type = 'sensor'

        definition = ''
        if term_upper in acronyms:
            definition = acronyms[term_upper].get('full_form', '')

        terms.append({
            'term': term,
            'idf': idf,
            'df': doc_freq,
            'type': term_type,
            'definition': definition,
        })

    # Sort by IDF descending (most distinctive first)
    terms.sort(key=lambda t: t['idf'], reverse=True)
    terms = terms[:200]

    acronym_list = [
        {'acronym': acr, 'full_form': info['full_form'], 'count': info['count']}
        for acr, info in acronyms.items()
    ]

    return {
        'terms': terms,
        'acronyms': acronym_list,
    }


def save_term_dictionary(term_dict, output_dir):
    """Save term dictionary as JSON."""
    path = os.path.join(output_dir, 'term_dictionary.json')
    with open(path, 'w') as f:
        json.dump(term_dict, f, indent=2)
    print(f"[TermEngine] Saved {len(term_dict['terms'])} terms, {len(term_dict['acronyms'])} acronyms to {path}")
    return path


def load_term_dictionary(output_dir):
    """Load term dictionary from JSON."""
    path = os.path.join(output_dir, 'term_dictionary.json')
    if not os.path.exists(path):
        return None
    with open(path, 'r') as f:
        return json.load(f)
