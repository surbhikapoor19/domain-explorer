"""Emit query-keywords.json — column / color-by / attribute keyword lookups.

Consumed by ai-pipeline.js for query rewriting; not rendered directly.
Sourced from backend/rag/query_engine.py so the front-end and back-end share
the same keyword vocabulary.
"""
import json
import os
import sys

from ..shared.config import REPO_ROOT


def export_query_keywords(output_dir):
    try:
        sys.path.insert(0, os.path.join(REPO_ROOT, 'backend'))
        from rag.query_engine import COLUMN_KEYWORDS, COLOR_BY_KEYWORDS, ATTRIBUTE_TERMS
        data = {
            'columnKeywords': {k: list(v) if not isinstance(v, list) else v for k, v in COLUMN_KEYWORDS.items()},
            'colorByKeywords': {k: list(v) if not isinstance(v, list) else v for k, v in COLOR_BY_KEYWORDS.items()},
            'attributeTerms': ATTRIBUTE_TERMS,
        }
    except Exception as e:
        print(f"  Warning: query_engine import failed ({e}), using empty keywords")
        data = {'columnKeywords': {}, 'colorByKeywords': {}, 'attributeTerms': {}}
    with open(os.path.join(output_dir, 'query-keywords.json'), 'w') as f:
        json.dump(data, f)
    print(f"  query-keywords.json: {len(data.get('columnKeywords', {}))} column keyword sets")
