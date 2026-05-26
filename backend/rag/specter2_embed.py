"""SPECTER2 paper-node embeddings for the HGT pipeline.

Produces a 768-dim embedding per paper using ``allenai/specter2_base`` with the
``allenai/specter2`` proximity adapter loaded on top. The proximity head is the
right choice for paper-paper similarity tasks (which is how the HGT trainer
will use these features).

Per-paper input is::

    title + tokenizer.sep_token + abstract

Title and abstract are read from the GROBID TEI file at
``<chroma_persist_dir>/tei/<slug>.tei.xml`` (``teiHeader/titleStmt/title`` and
``teiHeader/profileDesc/abstract``). When TEI is missing or has no abstract we
fall back to the title from ``extracted_facts.json`` (paper_id) plus the first
chunk from ChromaDB (preferring ``chunk_type == 'abstract'``, otherwise the
first coarse chunk for that paper).

Output: ``<chroma_persist_dir>/specter2_paper_embeddings.npz`` with two arrays:

  - ``slugs``     : object/string array of length N
  - ``embeddings``: float32 array of shape (N, 768)

Resumable: if the npz file already exists, slugs already in it are skipped and
only new ones are encoded; the merged result is written back.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from typing import Optional

import numpy as np


TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


# ---------------------------------------------------------------------------
# Title / abstract extraction
# ---------------------------------------------------------------------------

def _tei_text(elem) -> str:
    if elem is None:
        return ""
    parts = [t for t in elem.itertext() if t]
    s = " ".join(parts)
    return " ".join(s.split()).strip()


def load_title_abstract_from_tei(tei_path: str) -> tuple[str, str]:
    """Return (title, abstract) from a GROBID TEI file. Empty strings if missing."""
    if not os.path.exists(tei_path):
        return "", ""
    try:
        root = ET.parse(tei_path).getroot()
    except ET.ParseError:
        return "", ""

    title_elem = root.find(
        "tei:teiHeader/tei:fileDesc/tei:titleStmt/tei:title", TEI_NS
    )
    abstract_elem = root.find(
        "tei:teiHeader/tei:profileDesc/tei:abstract", TEI_NS
    )
    return _tei_text(title_elem), _tei_text(abstract_elem)


def load_paper_slugs(papers_dir: str) -> list[str]:
    """Return sorted list of paper slugs from PDF filenames in papers/."""
    slugs = []
    for path in sorted(glob.glob(os.path.join(papers_dir, "*.pdf"))):
        slug = os.path.splitext(os.path.basename(path))[0]
        slugs.append(slug)
    return slugs


def title_from_extracted_facts(facts_path: str, slug: str) -> str:
    """Return the paper title from extracted_facts.json, or empty string."""
    if not os.path.exists(facts_path):
        return ""
    try:
        with open(facts_path, "r") as f:
            facts = json.load(f)
    except (json.JSONDecodeError, OSError):
        return ""

    # extracted_facts.json is keyed by paper_id (slug); each value is a list of
    # fact dicts. There is no first-class title field, so as a last resort we
    # use the slug itself prettified.
    if isinstance(facts, dict) and slug in facts:
        # No reliable title here; fall back to slug.
        return slug.replace("-", " ").title()
    return slug.replace("-", " ").title()


def fetch_chunk_fallback(collection, slug: str) -> tuple[str, str]:
    """Fetch a fallback text + tag from ChromaDB for a paper.

    Returns ``(text, source_tag)`` where source_tag describes what was used
    (e.g. ``"chroma:abstract-chunk"``, ``"chroma:first-coarse-chunk"``,
    ``"chroma:any-chunk"``, or ``""`` if nothing was available).
    """
    if collection is None:
        return "", ""

    # 1) Look for a chunk explicitly tagged abstract.
    try:
        res = collection.get(
            where={"$and": [{"paper_id": slug}, {"chunk_type": "abstract"}]},
            limit=1,
            include=["documents"],
        )
        docs = res.get("documents") or []
        if docs:
            return docs[0], "chroma:abstract-chunk"
    except Exception:
        pass

    # 2) First coarse chunk for this paper.
    try:
        res = collection.get(
            where={"$and": [{"paper_id": slug}, {"layer": "coarse"}]},
            limit=1,
            include=["documents"],
        )
        docs = res.get("documents") or []
        if docs:
            return docs[0], "chroma:first-coarse-chunk"
    except Exception:
        pass

    # 3) Any chunk for this paper.
    try:
        res = collection.get(
            where={"paper_id": slug},
            limit=1,
            include=["documents"],
        )
        docs = res.get("documents") or []
        if docs:
            return docs[0], "chroma:any-chunk"
    except Exception:
        pass

    return "", ""


# ---------------------------------------------------------------------------
# SPECTER2 model loading
# ---------------------------------------------------------------------------

def load_specter2():
    """Load tokenizer + SPECTER2 model with the proximity adapter active.

    Returns (tokenizer, model, mode) where mode is "adapter" if the proximity
    adapter loaded, else "base" (plain base model — still 768-dim CLS).
    """
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained("allenai/specter2_base")

    # Preferred path: adapters library + proximity adapter.
    try:
        from adapters import AutoAdapterModel  # type: ignore

        model = AutoAdapterModel.from_pretrained("allenai/specter2_base")
        model.load_adapter(
            "allenai/specter2",
            source="hf",
            load_as="proximity",
            set_active=True,
        )
        model.eval()
        return tokenizer, model, "adapter"
    except Exception as e:
        print(
            f"[warn] adapters library / proximity adapter unavailable "
            f"({type(e).__name__}: {e}); falling back to specter2_base CLS",
            flush=True,
        )

    from transformers import AutoModel
    model = AutoModel.from_pretrained("allenai/specter2_base")
    model.eval()
    return tokenizer, model, "base"


def embed_one(tokenizer, model, title: str, abstract: str) -> np.ndarray:
    """Encode a single paper as 768-dim CLS embedding."""
    import torch

    text = (title or "").strip() + tokenizer.sep_token + (abstract or "").strip()
    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=512,
        padding=False,
    )
    with torch.no_grad():
        out = model(**inputs)
    # SPECTER2 uses [CLS]-pooled output.
    last = out.last_hidden_state  # (1, seq, 768)
    cls = last[:, 0, :].squeeze(0).cpu().numpy().astype(np.float32)
    return cls


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def load_existing(npz_path: str) -> dict[str, np.ndarray]:
    """Load existing slug->embedding dict from npz, or empty dict if missing."""
    if not os.path.exists(npz_path):
        return {}
    try:
        data = np.load(npz_path, allow_pickle=True)
        slugs = list(data["slugs"])
        embs = data["embeddings"]
    except Exception as e:
        print(f"[warn] failed to read existing {npz_path}: {e}; starting fresh")
        return {}
    return {str(s): embs[i].astype(np.float32) for i, s in enumerate(slugs)}


def save_embeddings(npz_path: str, embeddings: dict[str, np.ndarray]) -> None:
    """Persist slug->embedding dict to a single .npz file."""
    if not embeddings:
        print("[warn] no embeddings to write")
        return
    slugs_sorted = sorted(embeddings.keys())
    matrix = np.stack([embeddings[s] for s in slugs_sorted]).astype(np.float32)
    os.makedirs(os.path.dirname(npz_path) or ".", exist_ok=True)
    np.savez(
        npz_path,
        slugs=np.array(slugs_sorted, dtype=object),
        embeddings=matrix,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--papers-dir",
        default="papers",
        help="Directory containing <slug>.pdf files (slug = embedding key).",
    )
    parser.add_argument(
        "--config",
        default="rag_config.yaml",
        help="RAG YAML config (used only for chroma_persist_dir + collection_name).",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Override output npz path (default: <chroma_persist_dir>/specter2_paper_embeddings.npz).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-encode all papers even if present in the existing npz.",
    )
    args = parser.parse_args()

    # Resolve paths via the RAG config so everything stays in the project's
    # canonical chroma_db/ directory.
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from rag.config import load_config

    config = load_config(args.config)
    chroma_dir = config.chroma_persist_dir
    tei_dir = os.path.join(chroma_dir, "tei")
    facts_path = os.path.join(chroma_dir, "extracted_facts.json")
    npz_path = args.output or os.path.join(
        chroma_dir, "specter2_paper_embeddings.npz"
    )

    slugs = load_paper_slugs(args.papers_dir)
    if not slugs:
        print(f"[error] no PDFs found in {args.papers_dir}", file=sys.stderr)
        sys.exit(1)
    print(f"found {len(slugs)} paper slugs in {args.papers_dir}")

    # Resume: skip slugs already encoded unless --force.
    existing = {} if args.force else load_existing(npz_path)
    if existing:
        print(f"resuming from {npz_path}: {len(existing)} slugs already encoded")

    todo = [s for s in slugs if s not in existing]
    print(f"to encode: {len(todo)} slug(s)")

    if not todo:
        print("nothing to do; all slugs already present")
        # Still print sanity stats below.
        embeddings = existing
        fallback_log: list[tuple[str, str]] = []
        abstract_lengths: list[int] = []
        wall = 0.0
    else:
        # Lazy chroma client — only built if we need a fallback.
        chroma_client = None
        chroma_collection = None

        def _get_chroma_collection():
            nonlocal chroma_client, chroma_collection
            if chroma_collection is not None:
                return chroma_collection
            try:
                import chromadb
                chroma_client = chromadb.PersistentClient(path=chroma_dir)
                chroma_collection = chroma_client.get_or_create_collection(
                    name=config.collection_name,
                    metadata={"hnsw:space": "cosine"},
                )
            except Exception as e:
                print(f"[warn] chroma fallback unavailable: {e}")
                chroma_collection = None
            return chroma_collection

        print("loading SPECTER2 (this may take a minute on first run)...")
        tokenizer, model, mode = load_specter2()
        print(f"SPECTER2 ready (mode={mode})")

        embeddings = dict(existing)
        fallback_log = []
        abstract_lengths = []
        t0 = time.time()

        for i, slug in enumerate(todo, 1):
            tei_path = os.path.join(tei_dir, f"{slug}.tei.xml")
            title, abstract = load_title_abstract_from_tei(tei_path)

            fallback_tag = ""
            if not abstract:
                # Fallback: title from facts (best-effort) + chunk text from chroma.
                if not title:
                    title = title_from_extracted_facts(facts_path, slug)
                coll = _get_chroma_collection()
                fb_text, fb_tag = fetch_chunk_fallback(coll, slug)
                if fb_text:
                    abstract = fb_text
                    fallback_tag = fb_tag
                    fallback_log.append((slug, fb_tag))
                else:
                    fallback_log.append((slug, "no-abstract-no-chunk"))

            abstract_lengths.append(len(abstract or ""))

            if not title and not abstract:
                print(f"[{i}/{len(todo)}] {slug}: SKIPPED (no title and no abstract)")
                continue

            emb = embed_one(tokenizer, model, title, abstract)
            embeddings[slug] = emb

            if fallback_tag:
                print(
                    f"[{i}/{len(todo)}] {slug}: missing abstract — used {fallback_tag}",
                    flush=True,
                )
            else:
                print(f"[{i}/{len(todo)}] {slug}: embedded", flush=True)

            # Periodic checkpoint every 10 papers so a crash mid-run doesn't
            # lose progress.
            if i % 10 == 0:
                save_embeddings(npz_path, embeddings)

        wall = time.time() - t0

    # Final save.
    save_embeddings(npz_path, embeddings)

    # ---- Sanity check ----
    if not os.path.exists(npz_path):
        print("[error] no output written", file=sys.stderr)
        sys.exit(2)

    size_bytes = os.path.getsize(npz_path)
    data = np.load(npz_path, allow_pickle=True)
    slugs_arr = data["slugs"]
    embs = data["embeddings"]
    norms = np.linalg.norm(embs, axis=1)

    print()
    print(f"wrote {len(slugs_arr)} embeddings to {npz_path}")
    print(f"file size: {size_bytes/1024:.1f} KB")
    print(f"embeddings.shape = {embs.shape}")
    print(f"slugs[0] = {slugs_arr[0]}")
    print(f"embeddings[0][:5] = {embs[0][:5]}")
    print(f"mean norm = {float(norms.mean()):.3f}")
    print(f"min/max norm = {float(norms.min()):.3f} / {float(norms.max()):.3f}")
    if abstract_lengths:
        print(
            f"abstract char count min/max = {min(abstract_lengths)} / {max(abstract_lengths)}"
        )
    print(f"encoding wall clock: {wall:.1f}s")
    if fallback_log:
        print(f"fallbacks ({len(fallback_log)}):")
        for slug, tag in fallback_log:
            print(f"  - {slug}: {tag}")


if __name__ == "__main__":
    main()
