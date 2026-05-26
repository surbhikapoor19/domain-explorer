"""Emit papers-index.json + copy PDFs to public/papers/.

papers-index.json is the authoritative list of PDFs that ship with the app;
the PDF copy step uses it so the JSON and the actual /papers/ folder can
never drift apart.
"""
import json
import os
import shutil


def export_papers(papers_src, output_dir, papers_dest):
    pdfs = sorted(f for f in os.listdir(papers_src) if f.endswith('.pdf')) \
        if os.path.isdir(papers_src) else []

    with open(os.path.join(output_dir, 'papers-index.json'), 'w') as f:
        json.dump(pdfs, f)
    print(f"  papers-index.json: {len(pdfs)} PDFs")

    if not os.path.isdir(papers_src):
        return

    os.makedirs(papers_dest, exist_ok=True)
    copied = 0
    for fname in pdfs:
        src = os.path.join(papers_src, fname)
        dst = os.path.join(papers_dest, fname)
        if not os.path.exists(dst):
            shutil.copy2(src, dst)
            copied += 1
    print(f"  papers/: copied {copied} new PDFs to {papers_dest}")
