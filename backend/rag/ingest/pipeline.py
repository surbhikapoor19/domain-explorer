"""Ingestion pipeline CLI: parse PDFs, chunk, embed, and store in ChromaDB.

Usage:
    python -m rag.ingest.pipeline --papers-dir ./papers/ --config rag_config.yaml

Scans the papers directory for PDFs, matches them to dataset rows by filename,
and runs the full parse -> chunk -> embed -> store pipeline.
"""

import argparse
import dataclasses
import hashlib
import os
import sys
import time

import json

import warnings

from ..config import load_config, RAGConfig
from .pdf_parser import parse_pdf
from .chunker import chunk_paper
from .embedder import ChunkEmbedder
from .store import (
    get_client,
    create_or_get_collection,
    upsert_chunks,
    delete_paper,
    get_collection_stats,
    get_paper_hash,
    list_paper_ids,
)
from .fact_extractor import extract_facts


def _sha256_file(path: str, chunk_size: int = 1 << 20) -> str:
    """Streaming sha256 (hex) of a file's bytes."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(chunk_size), b''):
            h.update(chunk)
    return h.hexdigest()


def compute_ingest_salt(config) -> str:
    """16-hex salt folding in everything that changes RAG ingest output: the
    embedding model, the chunking config, and the parsing backend. A change to
    any of these mismatches the per-chunk `ingest_salt` metadata and forces a
    full re-ingest. Stable across dict key ordering (sort_keys)."""
    chunking = getattr(config, 'chunking', None)
    if dataclasses.is_dataclass(chunking):
        chunking_cfg = dataclasses.asdict(chunking)
    elif chunking is not None:
        chunking_cfg = dict(getattr(chunking, '__dict__', {}) or {})
    else:
        chunking_cfg = {}
    payload = {
        "rag_cache_format": 1,
        "embedding_model": getattr(config, 'embedding_model', ''),
        "chunking": chunking_cfg,
        "backend": getattr(getattr(config, 'parsing', None), 'backend', ''),
    }
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def find_pdfs(papers_dir: str) -> list:
    """Find all PDF files in the given directory."""
    pdfs = []
    for f in sorted(os.listdir(papers_dir)):
        if f.lower().endswith('.pdf'):
            pdfs.append(os.path.join(papers_dir, f))
    return pdfs


def paper_id_from_path(pdf_path: str) -> str:
    """Derive a paper_id from the PDF filename."""
    name = os.path.splitext(os.path.basename(pdf_path))[0]
    # Slugify: lowercase, replace spaces/special chars with hyphens
    slug = name.lower().strip()
    slug = slug.replace(' ', '-').replace('_', '-')
    return slug


def _parse_with_config(pdf_path: str, paper_id: str, config: RAGConfig):
    """Dispatch to the right PDF parser based on config."""
    backend = getattr(getattr(config, 'parsing', None), 'backend', 'pymupdf')

    if backend == "grobid":
        from .grobid_parser import parse_pdf_grobid, is_grobid_available, DEFAULT_GROBID_URL
        grobid_url = getattr(config.parsing, 'grobid_url', DEFAULT_GROBID_URL)
        if not is_grobid_available(grobid_url):
            warnings.warn(
                f"GROBID unreachable at {grobid_url}, falling back to PyMuPDF."
            )
            return parse_pdf(pdf_path, paper_id=paper_id)
        tei_dir = os.path.join(config.chroma_persist_dir, "tei")
        return parse_pdf_grobid(
            pdf_path, paper_id=paper_id, grobid_url=grobid_url, tei_cache_dir=tei_dir
        )

    if backend == "docling":
        from .docling_parser import is_docling_available, parse_pdf_docling
        if not is_docling_available():
            warnings.warn(
                "Docling requested but not installed. Falling back to PyMuPDF. "
                "Install with: pip install docling"
            )
            return parse_pdf(pdf_path, paper_id=paper_id)
        parsing = config.parsing
        return parse_pdf_docling(
            pdf_path,
            paper_id=paper_id,
            ocr=parsing.docling_ocr,
            table_mode=parsing.docling_table_mode,
            max_pages=parsing.docling_max_pages,
        )

    return parse_pdf(pdf_path, paper_id=paper_id)


def ingest_single(pdf_path: str, config: RAGConfig, embedder: ChunkEmbedder, collection,
                  *, content_hash: str = None, skip_if_unchanged: bool = False) -> dict:
    """Ingest a single PDF. Returns stats dict.

    Incremental skip: when ``skip_if_unchanged`` is set and the collection already
    holds this paper stamped with the same (pdf_sha256, ingest_salt), the PDF is
    unchanged under the current embedding/chunking/backend, so parsing is skipped
    entirely and a status="cached" result is returned.
    """
    paper_id = paper_id_from_path(pdf_path)
    ingest_salt = compute_ingest_salt(config)

    if skip_if_unchanged and content_hash:
        existing = get_paper_hash(collection, paper_id)
        if existing == (content_hash, ingest_salt):
            print(f"\n  Cached (unchanged): {os.path.basename(pdf_path)} (id={paper_id})")
            return {"paper_id": paper_id, "status": "cached", "n_chunks": 0, "facts": None}

    print(f"\n  Parsing: {os.path.basename(pdf_path)} (id={paper_id})")

    # Parse using configured backend (pymupdf or docling)
    paper = _parse_with_config(pdf_path, paper_id, config)
    print(f"    Title: {paper.title[:80]}")
    print(f"    Sections: {len(paper.sections)}, Figures: {len(paper.figures)}")
    print(f"    Abstract: {len(paper.abstract)} chars")

    # Chunk (pass embedder's model for semantic chunking)
    chunks = chunk_paper(paper, config.chunking, model=embedder.model)

    # Propagate section_type from the GROBID-parsed sections into each chunk
    # so ChromaDB metadata carries intent (method/experiments/limitations/...).
    section_type_by_title = {}
    for s in paper.sections:
        if getattr(s, 'section_type', None):
            section_type_by_title[s.title.strip().lower()] = s.section_type
            # Also store normalized version (matches chunker's _normalize_section_name)
            norm = s.title.strip().lower()
            norm = __import__('re').sub(r'^\d+\.?\d*\.?\s*', '', norm).strip()
            if norm:
                section_type_by_title[norm] = s.section_type
    for c in chunks:
        key = (c.section or '').strip().lower()
        if key in section_type_by_title:
            c.section_type = section_type_by_title[key]
        elif c.chunk_type == 'abstract':
            c.section_type = 'abstract'
        elif c.chunk_type == 'figure_captions':
            c.section_type = 'figure'
    coarse = sum(1 for c in chunks if c.layer == "coarse")
    mid = sum(1 for c in chunks if c.layer == "mid")
    fine = sum(1 for c in chunks if c.layer == "fine")
    # Count enrichment stats
    with_topics = sum(1 for c in chunks if c.domain_topics)
    roles = set(c.rhetorical_role for c in chunks if c.rhetorical_role)
    print(f"    Chunks: {len(chunks)} total (coarse={coarse}, mid={mid}, fine={fine})")
    print(f"    Enrichment: {with_topics} chunks with domain topics, roles: {roles}")

    if not chunks:
        print(f"    WARNING: No chunks produced, skipping")
        return {"paper_id": paper_id, "status": "empty", "n_chunks": 0}

    # Delete existing chunks for this paper (idempotent re-ingestion)
    delete_paper(collection, paper_id)

    # Embed
    embeddings = embedder.embed_chunks(chunks)
    print(f"    Embeddings: {embeddings.shape}")

    # Store (stamp the incremental-memoization metadata so an unchanged PDF can
    # be skipped on the next run).
    extra_metadata = {"ingest_salt": ingest_salt}
    if content_hash is not None:
        extra_metadata["pdf_sha256"] = content_hash
    upsert_chunks(collection, chunks, embeddings, extra_metadata=extra_metadata)
    print(f"    Stored in ChromaDB")

    # Extract structured facts from all chunks
    paper_facts = []
    for c in chunks:
        facts = extract_facts(c.text, chunk_id=c.chunk_id, paper_id=paper_id)
        paper_facts.extend(facts)
    if paper_facts:
        n_metrics = sum(1 for f in paper_facts if f['type'] == 'metric')
        n_equations = sum(1 for f in paper_facts if f['type'] == 'equation')
        n_arch = sum(1 for f in paper_facts if f['type'] in ('backbone', 'loss_function', 'optimizer', 'training_size'))
        n_datasets = sum(1 for f in paper_facts if f['type'] == 'dataset')
        print(f"    Facts: {len(paper_facts)} total (metrics={n_metrics}, equations={n_equations}, arch={n_arch}, datasets={n_datasets})")

    return {
        "paper_id": paper_id,
        "status": "success",
        "n_chunks": len(chunks),
        "n_sections": len(paper.sections),
        "layers": {"coarse": coarse, "mid": mid, "fine": fine},
        "facts": paper_facts,
    }


def run_ingestion(papers_dir: str, config: RAGConfig, *, skip_unchanged: bool = False) -> dict:
    """Run the full ingestion pipeline.

    Args:
        papers_dir: Directory containing PDF files.
        config: RAG configuration.
        skip_unchanged: when True, PDFs whose bytes + ingest salt already match
            the stored chunks are skipped (incremental mode), papers whose facts
            were computed on a previous run are preserved, and papers whose PDF is
            gone are pruned from the collection. When False the pipeline behaves
            exactly as a full rebuild.

    Returns:
        Summary dict with stats.
    """
    pdfs = find_pdfs(papers_dir)
    if not pdfs:
        print(f"No PDF files found in {papers_dir}")
        return {"n_papers": 0, "n_chunks": 0, "errors": []}

    print(f"Found {len(pdfs)} PDFs in {papers_dir}")
    print(f"Embedding model: {config.embedding_model}")
    print(f"ChromaDB path: {config.chroma_persist_dir}")

    # Initialize
    embedder = ChunkEmbedder(model_name=config.embedding_model)
    client = get_client(config)
    collection = create_or_get_collection(config, client)

    # Load the PRIOR extracted_facts.json up front: it drives both the facts merge
    # below AND the per-paper skip decision. Facts/Chroma desync must not silently
    # starve the KG — a paper may only be treated as "cached" (skipped) when its
    # facts are actually present in the prior file. If the Chroma stamp matches but
    # its prior facts are missing (deleted / desynced), it is re-ingested instead so
    # the facts are regenerated rather than silently lost.
    facts_path = os.path.join(config.chroma_persist_dir, 'extracted_facts.json')
    prior_facts = {}
    if os.path.exists(facts_path):
        try:
            with open(facts_path) as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                prior_facts = loaded
        except Exception as e:
            print(f"  WARNING: could not read prior facts {facts_path} ({e}); starting fresh")

    results = []
    errors = []
    start = time.time()

    for pdf_path in pdfs:
        try:
            content_hash = _sha256_file(pdf_path)
            # Only honour the incremental skip when this paper's facts are present in
            # the prior file; otherwise force a re-ingest so the facts are regenerated
            # (facts/Chroma desync guard).
            paper_skip = skip_unchanged and bool(prior_facts.get(paper_id_from_path(pdf_path)))
            result = ingest_single(
                pdf_path, config, embedder, collection,
                content_hash=content_hash, skip_if_unchanged=paper_skip,
            )
            results.append(result)
        except Exception as e:
            error_msg = f"{os.path.basename(pdf_path)}: {str(e)}"
            print(f"    ERROR: {error_msg}")
            errors.append(error_msg)

    elapsed = time.time() - start
    total_chunks = sum(r.get("n_chunks", 0) for r in results)

    stats = get_collection_stats(collection)

    # --- Facts merge (correctness-critical for incremental re-ingest) ---
    # extracted_facts.json is always fully rewritten, but its contents are merged
    # (prior_facts was loaded up front). Papers skipped this run (status="cached")
    # keep the facts extracted last time; re-ingested papers get fresh facts. A
    # paper's facts are only dropped when its PDF is genuinely gone (orphan cleanup
    # below), never merely because a re-ingest produced nothing. On a full rebuild
    # (nothing cached, no prior file) this reduces to the old all-fresh behaviour.
    disk_ids = {paper_id_from_path(p) for p in pdfs}

    all_facts = {}
    for r in results:
        pid = r.get('paper_id', '')
        if not pid:
            continue
        if r.get('status') == 'cached':
            prev = prior_facts.get(pid)
            if prev:
                all_facts[pid] = prev
        else:
            facts = r.get('facts') or []
            if facts:
                all_facts[pid] = facts
            else:
                # Re-ingested but yielded NO fresh facts (transient parse/extract
                # failure, or a genuinely fact-free paper). Never drop a paper's
                # prior facts while its PDF is still on disk — fall back rather than
                # starving the KG. Genuine removals are handled by orphan cleanup.
                prev = prior_facts.get(pid)
                if prev and pid in disk_ids:
                    all_facts[pid] = prev

    # A paper whose ingest_single RAISED never reaches `results` (it is recorded in
    # `errors`). Preserve its prior facts too, as long as its PDF is on disk, so a
    # transient failure can never starve the KG for that paper.
    for pid in disk_ids:
        if pid not in all_facts:
            prev = prior_facts.get(pid)
            if prev:
                all_facts[pid] = prev

    # --- Orphan cleanup (incremental mode only) ---
    # A paper whose PDF has been removed from disk should not linger in the
    # collection or the facts file. Full-rebuild runs keep the legacy behaviour.
    if skip_unchanged:
        try:
            existing_ids = list_paper_ids(collection)
        except Exception as e:
            print(f"  WARNING: could not list collection paper_ids ({e})")
            existing_ids = set()
        orphans = existing_ids - disk_ids
        for pid in sorted(orphans):
            delete_paper(collection, pid)
            all_facts.pop(pid, None)
        if orphans:
            print(f"  Orphan cleanup: removed {len(orphans)} paper(s) with no PDF on disk: {sorted(orphans)}")

    with open(facts_path, 'w') as f:
        json.dump(all_facts, f, indent=2)
    total_facts = sum(len(v) for v in all_facts.values())
    print(f"  Extracted facts: {total_facts} across {len(all_facts)} papers -> {facts_path}")

    # Build term dictionary from all chunks. compute_term_dictionary's second
    # arg is the per-chunk metadatas list (it reads `domain_topics` off each
    # one) — passing the RAGConfig there raises "object is not iterable".
    print("\nComputing term importance dictionary...")
    try:
        all_docs = collection.get(
            limit=stats['total_chunks'],
            include=['documents', 'metadatas'],
        )
        all_texts = all_docs.get('documents', [])
        all_metas = all_docs.get('metadatas', [])
        from ..term_engine import compute_term_dictionary, save_term_dictionary
        term_dict = compute_term_dictionary(all_texts, all_metas)
        save_term_dictionary(term_dict, config.chroma_persist_dir)
    except Exception as e:
        print(f"  Term dictionary error: {e}")

    print(f"\n{'='*60}")
    print(f"Ingestion complete in {elapsed:.1f}s")
    print(f"  Papers processed: {len(results)}")
    print(f"  Total chunks: {total_chunks}")
    print(f"  Errors: {len(errors)}")
    print(f"  Collection total: {stats['total_chunks']} chunks")

    return {
        "n_papers": len(results),
        "n_chunks": total_chunks,
        "elapsed_seconds": round(elapsed, 1),
        "errors": errors,
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Ingest academic papers into ChromaDB")
    parser.add_argument("--papers-dir", required=True, help="Directory containing PDF files")
    parser.add_argument("--config", required=True, help="Path to rag_config.yaml")
    args = parser.parse_args()

    if not os.path.isdir(args.papers_dir):
        print(f"Error: {args.papers_dir} is not a directory")
        sys.exit(1)
    if not os.path.isfile(args.config):
        print(f"Error: {args.config} not found")
        sys.exit(1)

    config = load_config(args.config)
    summary = run_ingestion(args.papers_dir, config)

    if summary["errors"]:
        print(f"\nErrors encountered:")
        for e in summary["errors"]:
            print(f"  - {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
