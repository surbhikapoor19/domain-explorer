"""Emit papers-index.json — the list of source PDFs in the corpus.

The PDFs themselves are deliberately NOT copied into the web root: the corpus
must never be published (see dashboard/.vercelignore).
"""
import json
import os


def export_papers(papers_src, output_dir):
    pdfs = sorted(f for f in os.listdir(papers_src) if f.endswith('.pdf')) \
        if os.path.isdir(papers_src) else []

    with open(os.path.join(output_dir, 'papers-index.json'), 'w') as f:
        json.dump(pdfs, f)
    print(f"  papers-index.json: {len(pdfs)} PDFs")
