"""Emit term-dictionary.json — domain terms + acronym expansions.

Consumed by InsightCard / InsightBullets (Explorer page) and HighlightedText
(Graph page) to mark up technical terms in LLM-generated narrative text.
"""
import json
import os
import sys

from ..shared.config import REPO_ROOT


def export_term_dictionary(output_dir):
    try:
        sys.path.insert(0, os.path.join(REPO_ROOT, 'backend'))
        from rag.term_engine import load_term_dictionary
        chroma_dir = os.path.join(REPO_ROOT, 'chroma_db')
        terms = load_term_dictionary(chroma_dir)
        payload = terms if isinstance(terms, dict) else {'success': True, 'terms': terms}
        with open(os.path.join(output_dir, 'term-dictionary.json'), 'w') as f:
            json.dump(payload, f)
        size = len(terms) if isinstance(terms, dict) else 'exported'
        print(f"  term-dictionary.json: {size}")
    except Exception as e:
        print(f"  term-dictionary.json: skipped ({e})")
        with open(os.path.join(output_dir, 'term-dictionary.json'), 'w') as f:
            json.dump({}, f)
