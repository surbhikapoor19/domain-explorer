#!/usr/bin/env python3
"""Full ingestion pipeline for a domain.

Runs the complete pipeline from raw PDFs + CSV through to precomputed
dashboard data. Designed to be called by GitHub Actions or locally.

Usage:
    python scripts/ingest_domain.py --domain motion_planning
    python scripts/ingest_domain.py --domain motion_planning --steps grobid,rag,kg,hgt,precompute
    python scripts/ingest_domain.py --domain motion_planning --steps precompute

Steps (in order):
    grobid     - Parse PDFs to TEI XML via GROBID service
    rag        - Chunk TEI, build embeddings, ingest to ChromaDB
    kg         - Build knowledge graph from chunks + entities
    hgt        - Train HGT link prediction model
    precompute - Generate dashboard JSON files

Environment:
    GROBID_URL     - GROBID service URL (default: http://localhost:8070)
    GROQ_API_KEY   - For LLM-enhanced extraction (optional)
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / 'dashboard'))

ALL_STEPS = ['grobid', 'rag', 'kg', 'hgt', 'precompute']


def resolve_domain_paths(domain_slug):
    """Resolve all paths for a domain."""
    slug_dashed = domain_slug.replace('_', '-')
    yaml_path = REPO_ROOT / 'domains' / f'{domain_slug}.yaml'
    dataset_dir = REPO_ROOT / 'datasets' / slug_dashed
    papers_dir = dataset_dir / 'papers'
    tei_dir = dataset_dir / 'tei'
    chroma_dir = dataset_dir / 'chroma_db'
    output_dir = REPO_ROOT / 'dashboard' / 'public' / f'data-{slug_dashed}'

    return {
        'yaml': yaml_path,
        'dataset': dataset_dir,
        'papers': papers_dir,
        'tei': tei_dir,
        'chroma': chroma_dir,
        'output': output_dir,
        'slug_dashed': slug_dashed,
    }


def step_grobid(paths):
    """Parse PDFs to TEI XML via GROBID."""
    import requests

    grobid_url = os.environ.get('GROBID_URL', 'http://localhost:8070')
    papers_dir = paths['papers']
    tei_dir = paths['tei']
    tei_dir.mkdir(parents=True, exist_ok=True)

    if not papers_dir.exists():
        print(f"  No papers directory at {papers_dir}")
        return

    pdfs = list(papers_dir.glob('*.pdf'))
    if not pdfs:
        print(f"  No PDFs found in {papers_dir}")
        return

    print(f"  Processing {len(pdfs)} PDFs via GROBID at {grobid_url}")

    # Check GROBID is alive
    for attempt in range(10):
        try:
            r = requests.get(f'{grobid_url}/api/isalive', timeout=5)
            if r.ok:
                break
        except requests.ConnectionError:
            pass
        if attempt == 9:
            print("  ERROR: GROBID not responding. Is it running?")
            sys.exit(1)
        time.sleep(3)

    processed = 0
    for pdf in pdfs:
        tei_path = tei_dir / f'{pdf.stem}.tei.xml'
        if tei_path.exists():
            print(f"    Skip (exists): {pdf.name}")
            continue
        try:
            with open(pdf, 'rb') as f:
                r = requests.post(
                    f'{grobid_url}/api/processFulltextDocument',
                    files={'input': (pdf.name, f)},
                    data={'consolidateHeader': '1'},
                    timeout=120,
                )
            if r.ok:
                tei_path.write_text(r.text)
                processed += 1
                print(f"    OK: {pdf.name}")
            else:
                print(f"    WARN: GROBID returned {r.status_code} for {pdf.name}")
        except Exception as e:
            print(f"    ERROR: {pdf.name}: {e}")

    print(f"  GROBID done: {processed} new, {len(pdfs)} total PDFs")


def step_rag(paths):
    """Chunk TEI XMLs and ingest to ChromaDB."""
    tei_dir = paths['tei']
    chroma_dir = paths['chroma']

    if not tei_dir.exists() or not list(tei_dir.glob('*.tei.xml')):
        print("  No TEI files found. Skipping RAG ingestion.")
        return

    tei_files = list(tei_dir.glob('*.tei.xml'))
    print(f"  Ingesting {len(tei_files)} TEI files into ChromaDB at {chroma_dir}")

    rag_config = REPO_ROOT / 'backend' / 'rag_config.yaml'
    if not rag_config.exists():
        print(f"  No rag_config.yaml found at {rag_config}. Skipping.")
        return

    import subprocess
    cmd = [
        sys.executable, '-m', 'backend.rag.ingest.pipeline',
        '--papers-dir', str(paths['papers']),
        '--config', str(rag_config),
    ]
    result = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if result.returncode != 0:
        print(f"  WARNING: RAG ingestion exited with code {result.returncode}")
    else:
        print("  RAG ingestion done")


def step_kg(paths):
    """Build knowledge graph from ChromaDB data."""
    chroma_dir = paths['chroma']
    tei_dir = paths['tei']

    facts_path = chroma_dir / 'extracted_facts.json'
    entities_path = chroma_dir / 'extracted_entities.json'

    if not chroma_dir.exists() or not facts_path.exists():
        print("  No extracted data found. Skipping KG build.")
        return

    print(f"  Building knowledge graph from {chroma_dir}")

    from backend.rag.knowledge_graph import build_knowledge_graph, save_graph
    from backend.rag.method_paper_map import build_method_paper_map
    from backend.rag.tei_graph import enrich_graph_from_tei

    csv_path = next(paths['dataset'].glob('*.csv'), None)
    method_paper_map = build_method_paper_map(
        csv_path=str(csv_path) if csv_path else None,
        papers_dir=str(paths['papers']),
    )

    G = build_knowledge_graph(
        facts_path=str(facts_path),
        entities_path=str(entities_path),
        method_paper_map=method_paper_map,
        csv_path=str(csv_path) if csv_path else None,
    )
    print(f"  Base KG: {len(G.nodes)} nodes, {len(G.edges)} edges")

    if tei_dir.exists() and list(tei_dir.glob('*.tei.xml')):
        paper_titles = {n: G.nodes[n].get('title', n) for n in G.nodes if G.nodes[n].get('type') == 'paper'}
        enrich_graph_from_tei(G, str(tei_dir), paper_titles)
        print(f"  TEI enrichment done: {len(G.nodes)} nodes, {len(G.edges)} edges")

    kg_path = chroma_dir / 'knowledge_graph.json'
    save_graph(G, str(kg_path))
    print(f"  Saved KG to {kg_path}")


def step_hgt(paths):
    """Train HGT link prediction model."""
    chroma_dir = paths['chroma']
    kg_path = chroma_dir / 'knowledge_graph.json'

    if not kg_path.exists():
        print("  No knowledge_graph.json found. Run 'kg' step first.")
        return

    print(f"  Training HGT model (chroma_dir={chroma_dir})")

    try:
        from hgt.run import main as hgt_main
        hgt_main(['--chroma-dir', str(chroma_dir), '--epochs', '300'])
    except Exception as e:
        print(f"  HGT training failed: {e}")
        print("  This is OK for very small KGs (<100 edges).")


def step_precompute(paths, domain_slug):
    """Generate dashboard JSON files."""
    import subprocess

    yaml_path = paths['yaml']
    output_dir = paths['output']
    chroma_dir = paths['chroma']

    if not yaml_path.exists():
        print(f"  Domain YAML not found: {yaml_path}")
        return

    print(f"  Running precompute: {yaml_path} → {output_dir}")

    # Precompute is designed to run from dashboard/ as `python -m scripts.precompute`
    cmd = [
        sys.executable, '-m', 'scripts.precompute',
        '--domain', str(yaml_path),
        '--output', str(output_dir),
        '--chroma', str(chroma_dir),
    ]
    result = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT / 'dashboard'),
        capture_output=False,
    )
    if result.returncode != 0:
        print(f"  WARNING: precompute exited with code {result.returncode}")


def main():
    parser = argparse.ArgumentParser(description='Domain ingestion pipeline')
    parser.add_argument('--domain', required=True, help='Domain slug (e.g., motion_planning)')
    parser.add_argument('--steps', default=','.join(ALL_STEPS),
                        help=f'Comma-separated steps: {",".join(ALL_STEPS)}')
    args = parser.parse_args()

    steps = [s.strip() for s in args.steps.split(',')]
    for s in steps:
        if s not in ALL_STEPS:
            print(f"Unknown step: {s}. Valid: {ALL_STEPS}")
            sys.exit(1)

    paths = resolve_domain_paths(args.domain)
    print(f"=== Domain Ingestion: {args.domain} ===")
    print(f"  Dataset dir: {paths['dataset']}")
    print(f"  Output dir:  {paths['output']}")
    print(f"  Steps:       {' → '.join(steps)}")
    print()

    for step in steps:
        print(f"[{step}] Starting...")
        t0 = time.time()
        if step == 'grobid':
            step_grobid(paths)
        elif step == 'rag':
            step_rag(paths)
        elif step == 'kg':
            step_kg(paths)
        elif step == 'hgt':
            step_hgt(paths)
        elif step == 'precompute':
            step_precompute(paths, args.domain)
        elapsed = time.time() - t0
        print(f"[{step}] Done ({elapsed:.1f}s)\n")

    print("=== All steps complete ===")


if __name__ == '__main__':
    main()
