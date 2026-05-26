"""Semantic Scholar enrichment for the grasp-planner paper corpus.

For each paper PDF in ``papers/``:
  1. Resolve the canonical title via the matching TEI XML in ``chroma_db/tei/``
     (falls back to a prettified slug).
  2. Look up the paper on S2 (/paper/search/match → /paper/search fallback).
  3. Fetch up to 100 references and 100 citations with rich metadata.
  4. Persist to ``<chroma_persist_dir>/s2_enrichment.json`` keyed by paper slug.

The output file is updated *after every paper* so partial runs are resumable
(re-running with the same flags will skip slugs already present).

Run:
    python -m rag.s2_enrichment --papers-dir papers --config rag_config.yaml
    python -m rag.s2_enrichment --papers anygrasp dexdiffuser   # subset

Endpoints used (see https://api.semanticscholar.org/api-docs/graph) — all via
``S2Client``:
  - GET /graph/v1/paper/search/match
  - GET /graph/v1/paper/search
  - GET /graph/v1/paper/{paper_id}/references
  - GET /graph/v1/paper/{paper_id}/citations
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

# Make `rag` importable when run as a script (python -m rag.s2_enrichment works
# from the backend dir; this also covers running the file directly).
THIS_DIR = Path(__file__).resolve().parent
BACKEND_DIR = THIS_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from rag.config import load_config  # noqa: E402
from rag.s2_client import S2Client, load_dotenv_value  # noqa: E402


logger = logging.getLogger("s2_enrichment")

TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


# ----------------------------------------------------------------------
# Title resolution
# ----------------------------------------------------------------------
def slug_from_pdf(pdf_path: Path) -> str:
    return pdf_path.stem


def prettify_slug(slug: str) -> str:
    """Last-resort title when no TEI is available."""
    s = slug.replace("-", " ").replace("_", " ").strip()
    return s


def title_from_tei(tei_path: Path) -> Optional[str]:
    """Pull the main paper title from a GROBID TEI XML.

    GROBID puts the paper title at /TEI/teiHeader/fileDesc/titleStmt/title — but
    bibliography entries also have <title> elements, so we anchor on titleStmt.
    """
    try:
        tree = ET.parse(tei_path)
    except (ET.ParseError, OSError) as e:
        logger.warning("could not parse TEI %s: %s", tei_path, e)
        return None
    root = tree.getroot()
    el = root.find(".//tei:teiHeader//tei:titleStmt/tei:title", TEI_NS)
    if el is None or not (el.text or "").strip():
        return None
    # Collapse whitespace.
    text = re.sub(r"\s+", " ", "".join(el.itertext())).strip()
    return text or None


def resolve_title(slug: str, tei_dir: Path) -> str:
    tei_path = tei_dir / f"{slug}.tei.xml"
    if tei_path.exists():
        t = title_from_tei(tei_path)
        if t:
            return t
        logger.info("TEI for %s exists but title was empty; falling back to slug", slug)
    return prettify_slug(slug)


# ----------------------------------------------------------------------
# Persistence
# ----------------------------------------------------------------------
def load_existing(out_path: Path) -> dict:
    if not out_path.exists():
        return {}
    try:
        with out_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        logger.warning("existing %s is not a dict; ignoring", out_path)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("could not read existing %s: %s", out_path, e)
    return {}


def save_atomic(out_path: Path, data: dict) -> None:
    """Write JSON atomically so a crash mid-write can't corrupt the file."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, out_path)


# ----------------------------------------------------------------------
# Per-paper enrichment
# ----------------------------------------------------------------------
def enrich_paper(client: S2Client, slug: str, title: str, max_per_side: int = 100) -> Optional[dict]:
    """Look up paper, fetch references + citations. Returns the record or None."""
    paper = client.get_paper(title)
    if not paper or not paper.get("paperId"):
        logger.warning("S2 paper not found for slug=%s title=%r", slug, title)
        return None
    pid = paper["paperId"]

    refs = client.get_references(pid, limit=max_per_side) or []
    cits = client.get_citations(pid, limit=max_per_side) or []

    return {
        "paper_id": pid,
        "title": paper.get("title") or title,
        "queried_title": title,
        "external_ids": paper.get("externalIds") or {},
        "year": paper.get("year"),
        "venue": paper.get("venue"),
        "authors": paper.get("authors") or [],
        "abstract": paper.get("abstract"),
        "citation_count": paper.get("citationCount"),
        "reference_count": paper.get("referenceCount"),
        "references": refs,
        "citations": cits,
    }


# ----------------------------------------------------------------------
# CLI driver
# ----------------------------------------------------------------------
def discover_slugs(papers_dir: Path) -> list:
    return sorted(p.stem for p in papers_dir.glob("*.pdf"))


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="Enrich grasp-planner papers with Semantic Scholar metadata.")
    parser.add_argument("--papers-dir", default="papers", help="directory containing <slug>.pdf files")
    parser.add_argument("--config", default="rag_config.yaml", help="RAG config YAML (for chroma_persist_dir)")
    parser.add_argument("--papers", nargs="*", default=None, help="optional subset of slugs to process")
    parser.add_argument("--max-per-side", type=int, default=100,
                        help="max references AND max citations to fetch per paper (default 100)")
    parser.add_argument("--env-file", default=None,
                        help="path to .env-style file with SEMANTIC_SCHOLAR_API_KEY (auto-detected if omitted)")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # ------------------------------------------------------------------
    # Resolve repo paths. Config paths in rag_config.yaml are relative to the
    # repo root, so anchor everything off the config file's directory.
    # ------------------------------------------------------------------
    config_path = Path(args.config).resolve()
    if not config_path.exists():
        # Try repo-root-relative as well.
        repo_root = BACKEND_DIR.parent
        cand = (repo_root / args.config).resolve()
        if cand.exists():
            config_path = cand
        else:
            logger.error("config not found: %s", args.config)
            return 2
    repo_root = config_path.parent

    cfg = load_config(str(config_path))
    chroma_dir = (repo_root / cfg.chroma_persist_dir).resolve()
    tei_dir = chroma_dir / "tei"
    out_path = chroma_dir / "s2_enrichment.json"

    papers_dir = Path(args.papers_dir)
    if not papers_dir.is_absolute():
        papers_dir = (repo_root / papers_dir).resolve()
    if not papers_dir.is_dir():
        logger.error("papers dir not found: %s", papers_dir)
        return 2

    # ------------------------------------------------------------------
    # API key. Prefer explicit --env-file, then dashboard/.env.local, then env.
    # ------------------------------------------------------------------
    api_key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY")
    if not api_key:
        env_candidates = []
        if args.env_file:
            env_candidates.append(Path(args.env_file))
        env_candidates.append(repo_root / "dashboard" / ".env.local")
        env_candidates.append(repo_root / ".env.local")
        env_candidates.append(repo_root / ".env")
        for cand in env_candidates:
            if cand.exists():
                v = load_dotenv_value(str(cand), "SEMANTIC_SCHOLAR_API_KEY")
                if v:
                    api_key = v
                    logger.info("loaded SEMANTIC_SCHOLAR_API_KEY from %s", cand)
                    break
    if not api_key:
        logger.error("SEMANTIC_SCHOLAR_API_KEY not found in env or .env files; aborting.")
        return 2

    # Slug selection.
    all_slugs = discover_slugs(papers_dir)
    if args.papers:
        wanted = set(args.papers)
        slugs = [s for s in all_slugs if s in wanted]
        missing = wanted - set(all_slugs)
        if missing:
            logger.warning("requested slugs not found in %s: %s", papers_dir, sorted(missing))
        if not slugs:
            logger.error("no requested slugs match PDFs in %s", papers_dir)
            return 2
    else:
        slugs = all_slugs

    existing = load_existing(out_path)
    todo = [s for s in slugs if s not in existing]
    skipped = [s for s in slugs if s in existing]
    if skipped:
        logger.info("skipping %d slugs already in %s: %s",
                    len(skipped), out_path.name, ", ".join(skipped))
    if not todo:
        logger.info("nothing to do — all requested slugs already present.")
        _print_summary(existing, slugs, rate_limit_events=0, server_error_events=0)
        return 0

    client = S2Client(api_key=api_key)

    # ------------------------------------------------------------------
    # Per-paper processing. Save after every successful paper so a crash mid-run
    # leaves a valid, partial output file.
    # ------------------------------------------------------------------
    for slug in todo:
        title = resolve_title(slug, tei_dir)
        try:
            record = enrich_paper(client, slug, title, max_per_side=args.max_per_side)
        except Exception as e:  # noqa: BLE001 — never let one paper kill the run
            logger.warning("unhandled error enriching %s: %s", slug, e)
            record = None
        if not record:
            print(f"{slug}: skipped (no S2 match or fetch failed)")
            continue
        existing[slug] = record
        save_atomic(out_path, existing)
        n_refs = len(record.get("references") or [])
        n_cits = len(record.get("citations") or [])
        print(f"{slug}: {n_refs} references, {n_cits} citations")

    _print_summary(
        existing,
        slugs,
        rate_limit_events=client.rate_limit_events,
        server_error_events=client.server_error_events,
    )
    return 0


def _print_summary(existing: dict, requested: list, *, rate_limit_events: int, server_error_events: int) -> None:
    total_refs = 0
    total_cits = 0
    total_contexts = 0
    covered = 0
    for slug in requested:
        rec = existing.get(slug)
        if not rec:
            continue
        covered += 1
        refs = rec.get("references") or []
        cits = rec.get("citations") or []
        total_refs += len(refs)
        total_cits += len(cits)
        for c in cits:
            total_contexts += len(c.get("contexts") or [])
        for r in refs:
            total_contexts += len(r.get("contexts") or [])
    print("---")
    print(f"summary: {covered}/{len(requested)} papers enriched")
    print(f"  total references:       {total_refs}")
    print(f"  total citations:        {total_cits}")
    print(f"  total context strings:  {total_contexts}")
    print(f"  429 rate-limit events:  {rate_limit_events}")
    print(f"  5xx server events:      {server_error_events}")


if __name__ == "__main__":
    sys.exit(main())
