#!/usr/bin/env python3
"""Full ingestion pipeline for a domain.

Runs the complete pipeline from raw PDFs + CSV through to precomputed
dashboard data. Designed to be called by GitHub Actions or locally.

Usage:
    python scripts/ingest_domain.py --domain motion_planning
    python scripts/ingest_domain.py --domain motion_planning --steps grobid,rag,kg,hgt,precompute
    python scripts/ingest_domain.py --domain motion_planning --steps precompute
    python scripts/ingest_domain.py --domain motion_planning --force

Steps (in order):
    grobid     - Parse PDFs to TEI XML via GROBID service
    rag        - Chunk TEI, build embeddings, ingest to ChromaDB
    kg         - Build knowledge graph from chunks + entities
    hgt        - Train HGT link prediction model
    precompute - Generate dashboard JSON files

Each step checks if its output already exists and skips if so.
Use --force to re-run all steps regardless.

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

ALL_STEPS = ['grobid', 'rag', 'kg', 'hgt', 'precompute', 'benchmark']
FORCE = False


def resolve_domain_paths(domain_slug):
    """Resolve all paths for a domain. Accepts either slug form ("motion-planning"
    from admin dispatches or "motion_planning"): dataset dirs use dashes, the
    domain YAML + benchmark configs use underscores."""
    slug_dashed = domain_slug.replace('_', '-')
    slug_us = domain_slug.replace('-', '_')
    yaml_path = REPO_ROOT / 'domains' / f'{slug_us}.yaml'
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


def fetch_latest_csv(paths):
    """Pull the newest CSV from the domain's Google Drive folder (`drive_folder`
    in the YAML), strip any banner/preamble rows, and write it to `csv_path` — so
    the build always reads the latest sheet export and no CSV need be committed.
    No-ops (keeps any existing local CSV) if no folder is set or the fetch fails."""
    import re
    import csv as _csv
    import io
    import urllib.request
    import yaml as _yaml

    yaml_path = paths['yaml']
    if not yaml_path.exists():
        return
    cfg = _yaml.safe_load(open(yaml_path)) or {}
    folder = cfg.get('drive_folder')
    csv_rel = cfg.get('csv_path')
    if not folder or not csv_rel:
        return
    csv_path = REPO_ROOT / csv_rel
    ua = {'User-Agent': 'Mozilla/5.0'}

    def _get(u, t=120):
        return urllib.request.urlopen(urllib.request.Request(u, headers=ua), timeout=t).read().decode('utf-8', 'replace')

    try:
        m = re.search(r'/folders/([A-Za-z0-9_-]+)', folder)
        fid = m.group(1) if m else folder.strip()
        html = _get('https://drive.google.com/drive/folders/' + fid)
        pairs = re.findall(r'data-id="([A-Za-z0-9_-]{20,})"[\s\S]{0,800}?([^"<>]+?\.csv)', html)
        seen = {}
        for did, nm in pairs:
            seen.setdefault(nm.strip(), did)
        if not seen:
            print(f"  [csv] no CSV in Drive folder; keeping existing {csv_rel}")
            return

        def _keyf(n):
            mm = re.search(r'(\d{4}-\d{2}-\d{2}[ _]\d{2}-\d{2}-\d{2})', n)
            return (mm.group(1) if mm else '', n)

        name = sorted(seen, key=_keyf)[-1]
        data = _get('https://drive.google.com/uc?export=download&id=' + seen[name])
        if data.lstrip()[:15].lower().startswith(('<!doctype', '<html')):
            print(f"  [csv] download returned HTML (folder/file not public?); keeping existing {csv_rel}")
            return
        rows = list(_csv.reader(io.StringIO(data)))
        # Strip preamble: find the header row by the domain's identity.name column
        # (falls back to the existing committed CSV's first header).
        cols = cfg.get('columns', {}) or {}
        name_col = next((c for c, mp in cols.items() if (mp or {}).get('role') == 'identity.name'), None)
        if not name_col and csv_path.exists():
            with open(csv_path, encoding='utf-8') as cf:
                hdr = next(_csv.reader(cf), [])
                name_col = hdr[0].strip() if hdr else None
        if name_col:
            for i, r in enumerate(rows[:25]):
                if r and r[0].strip() == name_col:
                    rows = rows[i:]
                    break
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        with open(csv_path, 'w', encoding='utf-8', newline='') as f:
            _csv.writer(f).writerows(rows)
        print(f"  [csv] pulled latest from Drive folder: {name} ({max(len(rows) - 1, 0)} rows) → {csv_rel}")
    except Exception as e:
        print(f"  [csv] Drive fetch failed ({e}); keeping existing {csv_rel}")


def step_grobid(paths):
    """Parse PDFs to TEI XML via GROBID."""
    import requests

    grobid_url = os.environ.get('GROBID_URL', 'http://localhost:8070')
    papers_dir = paths['papers']
    tei_dir = paths['tei']

    if not papers_dir.exists():
        print(f"  No papers directory at {papers_dir}")
        return

    pdfs = list(papers_dir.glob('*.pdf'))
    if not pdfs:
        print(f"  No PDFs found in {papers_dir}")
        return

    tei_dir.mkdir(parents=True, exist_ok=True)
    pending = [p for p in pdfs if not (tei_dir / f'{p.stem}.tei.xml').exists()]

    if not pending and not FORCE:
        print(f"  All {len(pdfs)} PDFs already parsed. Skipping. (use --force to re-run)")
        return

    print(f"  Processing {len(pending)}/{len(pdfs)} PDFs via GROBID at {grobid_url}")

    for attempt in range(20):
        try:
            r = requests.get(f'{grobid_url}/api/isalive', timeout=5)
            if r.ok:
                break
        except (requests.ConnectionError, requests.Timeout):
            pass
        if attempt == 19:
            print("  ERROR: GROBID not responding. Is it running?")
            sys.exit(1)
        time.sleep(5)

    processed = 0
    for pdf in pending:
        tei_path = tei_dir / f'{pdf.stem}.tei.xml'
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
    facts_path = chroma_dir / 'extracted_facts.json'

    if not tei_dir.exists() or not list(tei_dir.glob('*.tei.xml')):
        print("  No TEI files found. Skipping RAG ingestion.")
        return

    if facts_path.exists() and not FORCE:
        print(f"  ChromaDB + facts already exist at {chroma_dir}. Skipping. (use --force to re-run)")
        return

    tei_files = list(tei_dir.glob('*.tei.xml'))
    print(f"  Ingesting {len(tei_files)} TEI files into ChromaDB at {chroma_dir}")

    rag_config_path = REPO_ROOT / 'rag_config.yaml'
    if not rag_config_path.exists():
        print(f"  No rag_config.yaml found at {rag_config_path}. Skipping.")
        return

    from backend.rag.config import load_config
    from backend.rag.ingest.pipeline import run_ingestion

    config = load_config(str(rag_config_path))
    config.chroma_persist_dir = str(chroma_dir)
    config.collection_name = f"{paths['slug_dashed']}_papers"
    config.parsing.backend = 'grobid'
    grobid_url = os.environ.get('GROBID_URL', 'http://localhost:8070')
    config.parsing.grobid_url = grobid_url

    chroma_dir.mkdir(parents=True, exist_ok=True)
    summary = run_ingestion(str(paths['papers']), config)
    if summary.get('errors'):
        print(f"  WARNING: RAG ingestion had {len(summary['errors'])} errors")
    else:
        print(f"  RAG ingestion done: {summary.get('n_papers', 0)} papers, {summary.get('n_chunks', 0)} chunks")

    if os.environ.get('GROQ_API_KEY'):
        try:
            from backend.rag.config import save_config
            domain_config_path = chroma_dir / '_rag_config.yaml'
            save_config(config, str(domain_config_path))
            from backend.rag.ingest.llm_entity_extractor import run_entity_extraction
            print("  Running LLM entity extraction...")
            run_entity_extraction(str(domain_config_path), output_path=str(chroma_dir / 'extracted_entities.json'))
        except Exception as e:
            print(f"  WARNING: Entity extraction failed: {e}")
        try:
            # Evidence-quoted triples: every semantic relation carries a verbatim,
            # mechanically-verified source quote (the KG build consumes the file).
            from backend.rag.ingest.verified_triple_extractor import run_verified_triple_extraction
            print("  Running verified triple extraction...")
            run_verified_triple_extraction(str(chroma_dir / '_rag_config.yaml'),
                                           output_path=str(chroma_dir / 'verified_triples.json'))
        except Exception as e:
            print(f"  WARNING: Verified triple extraction failed: {e}")
    else:
        print("  Skipping entity extraction (no GROQ_API_KEY)")


def step_kg(paths):
    """Build knowledge graph from ChromaDB data.

    Mirrors rebuild_kg.py: base graph → TEI enrichment → feature engineering.
    """
    chroma_dir = paths['chroma']
    kg_path = chroma_dir / 'knowledge_graph.json'
    facts_path = chroma_dir / 'extracted_facts.json'
    entities_path = chroma_dir / 'extracted_entities.json'

    if not chroma_dir.exists() or not facts_path.exists():
        print("  No extracted data found. Skipping KG build.")
        return

    if kg_path.exists() and not FORCE:
        print(f"  KG already exists at {kg_path}. Skipping. (use --force to re-run)")
        return

    print(f"  Building knowledge graph from {chroma_dir}")

    from backend.rag.knowledge_graph import build_knowledge_graph, save_graph
    from backend.rag.method_paper_map import build_method_paper_map
    from backend.rag.config import load_config
    from backend.rag.ingest.store import get_client, create_or_get_collection

    csv_path = next(paths['dataset'].glob('*.csv'), None)
    method_paper_map = build_method_paper_map(
        csv_path=str(csv_path) if csv_path else None,
        papers_dir=str(paths['papers']),
    )
    print(f"  Method-paper map: {len(method_paper_map.get('method_to_paper', {}))} matched, "
          f"{len(method_paper_map.get('unmatched_methods', []))} unmatched")

    # Domain-specific KG normalization (technique/hardware/problem aliases) from
    # the domain YAML's `kg_aliases`; absent → built-in grasp-planning defaults.
    domain_config = None
    yaml_path = paths.get('yaml')
    if yaml_path and yaml_path.exists():
        import yaml as _yaml
        with open(yaml_path) as _f:
            _ycfg = _yaml.safe_load(_f) or {}
        if _ycfg.get('kg_aliases'):
            domain_config = {'kg_aliases': _ycfg['kg_aliases']}
            print(f"  KG aliases from config: "
                  f"{', '.join(f'{k}={len(v)}' for k, v in _ycfg['kg_aliases'].items())}")

    G = build_knowledge_graph(
        facts_path=str(facts_path),
        entities_path=str(entities_path),
        method_paper_map=method_paper_map,
        csv_path=str(csv_path) if csv_path else None,
        domain_config=domain_config,
    )
    print(f"  Base KG: {len(G.nodes)} nodes, {len(G.edges)} edges")

    # TEI enrichment: authors, citations, figures, tables, equations
    # Prefer chroma_db/tei/ (from RAG pipeline, dashed IDs matching graph)
    tei_dir = chroma_dir / 'tei'
    if not tei_dir.exists() or not list(tei_dir.glob('*.tei.xml')):
        tei_dir = paths['tei']

    paper_texts = _build_paper_texts(chroma_dir, paths['slug_dashed'])

    if tei_dir.exists() and list(tei_dir.glob('*.tei.xml')):
        from backend.rag.tei_graph import enrich_graph_from_tei
        paper_titles = {
            nid.replace('paper:', ''): G.nodes[nid].get('label', '')
            for nid in G.nodes if G.nodes[nid].get('type') == 'paper'
        }
        stats = enrich_graph_from_tei(G, str(tei_dir), paper_titles, paper_texts=paper_texts)
        print(f"  TEI enrichment: {len(G.nodes)} nodes, {len(G.edges)} edges")
    else:
        print("  No TEI files found, skipping TEI enrichment")

    # Feature engineering: CSV explosion, chunks, keyphrases, TF-IDF, centrality
    try:
        from sentence_transformers import SentenceTransformer
        from backend.rag.feature_engineering import enrich_knowledge_graph

        rag_config_path = REPO_ROOT / 'rag_config.yaml'
        config = load_config(str(rag_config_path))
        config.chroma_persist_dir = str(chroma_dir)
        config.collection_name = f"{paths['slug_dashed']}_papers"

        model = SentenceTransformer(config.embedding_model)
        client = get_client(config)
        collection = create_or_get_collection(config, client)

        skip_ft = tei_dir.exists() and bool(list(tei_dir.glob('*.tei.xml')))
        G = enrich_knowledge_graph(
            G, collection, model,
            paper_texts=paper_texts or None,
            csv_path=str(csv_path) if csv_path else None,
            method_paper_map=method_paper_map,
            skip_figure_table_heuristic=skip_ft,
        )
        print(f"  Feature engineering done: {len(G.nodes)} nodes, {len(G.edges)} edges")
    except Exception as e:
        print(f"  WARNING: Feature engineering failed: {e}")

    save_graph(G, str(kg_path))
    print(f"  Saved KG to {kg_path}")


def _build_paper_texts(chroma_dir, slug_dashed):
    """Build {paper_id: full_text} from ChromaDB chunks."""
    from collections import defaultdict
    from backend.rag.config import load_config
    from backend.rag.ingest.store import get_client, create_or_get_collection

    rag_config_path = REPO_ROOT / 'rag_config.yaml'
    config = load_config(str(rag_config_path))
    config.chroma_persist_dir = str(chroma_dir)
    config.collection_name = f"{slug_dashed}_papers"

    try:
        client = get_client(config)
        collection = create_or_get_collection(config, client)
        total = collection.count()
        if total == 0:
            return {}
        all_data = collection.get(include=['documents', 'metadatas'], limit=total)
        texts = defaultdict(list)
        for doc, meta in zip(all_data['documents'], all_data['metadatas']):
            pid = meta.get('paper_id', '')
            if pid and doc:
                texts[pid].append(doc)
        return {pid: ' '.join(chunks) for pid, chunks in texts.items()}
    except Exception:
        return {}


def step_hgt(paths):
    """Train HGT link prediction model."""
    chroma_dir = paths['chroma']
    kg_path = chroma_dir / 'knowledge_graph.json'
    model_path = chroma_dir / 'hgt_model.pt'

    if not kg_path.exists():
        print("  No knowledge_graph.json found. Skipping HGT training.")
        return

    if model_path.exists() and not FORCE:
        print(f"  HGT model already exists at {model_path}. Skipping. (use --force to re-run)")
        return

    print(f"  Training HGT model (chroma_dir={chroma_dir})")

    try:
        from hgt.run import main as hgt_main
        # --rebuild-schema derives the HGT schema from THIS domain's fresh
        # knowledge_graph.json; --schema-dir points training at the domain's own
        # schema (the old --chroma-dir flag never existed — argparse SystemExit'd).
        hgt_main(['--schema-dir', str(chroma_dir / 'hgt_schema'),
                  '--rebuild-schema', '--epochs', '300'])
    except Exception as e:
        print(f"  HGT training failed: {e}")
        print("  This is OK for very small KGs (<100 edges).")


def step_precompute(paths, domain_slug):
    """Generate dashboard JSON files."""
    import subprocess

    yaml_path = paths['yaml']
    output_dir = paths['output']
    chroma_dir = paths['chroma']
    methods_json = output_dir / 'methods.json'

    if not yaml_path.exists():
        print(f"  Domain YAML not found: {yaml_path}")
        return

    if methods_json.exists() and not FORCE:
        csv_path = next(paths['dataset'].glob('*.csv'), None)
        kg_path = chroma_dir / 'knowledge_graph.json'
        latest_source = 0
        if csv_path:
            latest_source = max(latest_source, csv_path.stat().st_mtime)
        if kg_path.exists():
            latest_source = max(latest_source, kg_path.stat().st_mtime)
        if latest_source and latest_source < methods_json.stat().st_mtime:
            print(f"  Dashboard JSONs up-to-date (sources unchanged). Skipping. (use --force to re-run)")
            return

    print(f"  Running precompute: {yaml_path} → {output_dir}")

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


def step_benchmark(paths, domain):
    """Build benchmark-comparisons.json + crops for a domain via the Docling extractor.
    Docling-only unless ANTHROPIC_API_KEY is set; skips if output exists (FORCE_BENCHMARK=1 to rebuild)."""
    import os
    import subprocess
    import tempfile
    output_dir = paths['output']
    out_json = output_dir / 'benchmark-comparisons.json'
    # Honor the global --force flag too (the CI workflow passes it via
    # client_payload.force) — previously only the FORCE_BENCHMARK env re-ran this.
    if out_json.exists() and not FORCE and os.environ.get('FORCE_BENCHMARK') != '1':
        print(f"  [benchmark] {out_json} exists; skipping (--force or FORCE_BENCHMARK=1 to rebuild)")
        return
    pre = Path(__file__).resolve().parent.parent / 'dashboard' / 'scripts' / 'precompute'
    # Config files use underscore slugs (grasp_planning.json) but dispatches may
    # carry either form ("grasp-planning" from the admin UI/API) — accept both.
    cfg = pre / 'benchmarks' / 'config' / f"{domain.replace('-', '_')}.json"
    if not cfg.exists():
        cfg = pre / 'benchmarks' / 'config' / f'{domain}.json'
    if not cfg.exists():
        print(f"  [benchmark] no benchmarks config at {cfg}; skipping")
        return
    csv_path = next(paths['dataset'].glob('*.csv'), None)
    if csv_path is None:
        print(f"  [benchmark] no methods CSV in {paths['dataset']}; skipping")
        return
    crops_dir = output_dir / 'crops'
    crops_url = f"/data-{paths['slug_dashed']}/crops"
    rr = Path(tempfile.mkdtemp()) / 'result-records.json'
    # VLM runs with an Anthropic key OR the Groq vision fallback (GROQ_API_KEY).
    no_vlm = [] if (os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('GROQ_API_KEY')) else ['--no-vlm']
    extract = [sys.executable, '-m', 'benchmarks.extraction.run_extraction',
               '--engine', 'docling', '--config', str(cfg), '--pdf-dir', str(paths['papers']),
               '--methods-csv', str(csv_path), '--crops-dir', str(crops_dir),
               '--crops-url', crops_url, '--output', str(rr)] + no_vlm
    print(f"  [benchmark] extracting via Docling ({'born-digital' if no_vlm else 'with VLM'}) ...")
    subprocess.run(extract, cwd=str(pre), check=True)
    # Persist the raw extraction records: aggregation-only fixes can then re-run
    # via --from-records in seconds instead of re-paying a ~50-min Docling pass.
    import shutil
    records_keep = paths['chroma'] / 'result-records.json'
    try:
        shutil.copyfile(rr, records_keep)
        print(f"  [benchmark] kept raw records at {records_keep}")
    except OSError as e:
        print(f"  [benchmark] could not persist records ({e})")
    export = [sys.executable, 'graph/benchmark_data.py', '--from-records', str(rr),
              '--output-dir', str(output_dir), '--config', str(cfg)]
    # Enrich the domain's knowledge graph with the graded, protocol-scoped
    # benchmark comparisons (table-derived `outperforms` edges beat prose claims;
    # previously the export never received --kg-path, so the deployed graph kept
    # only the ~7 prose-resolved edges).
    kg_full = output_dir / 'kg-full.json'
    if kg_full.exists():
        export += ['--kg-path', str(kg_full)]
    subprocess.run(export, cwd=str(pre), check=True)
    print(f"  [benchmark] wrote {out_json}")


def main():
    global FORCE
    parser = argparse.ArgumentParser(description='Domain ingestion pipeline')
    parser.add_argument('--domain', required=True, help='Domain slug (e.g., motion_planning)')
    parser.add_argument('--steps', default=','.join(ALL_STEPS),
                        help=f'Comma-separated steps: {",".join(ALL_STEPS)}')
    parser.add_argument('--force', action='store_true',
                        help='Re-run all steps even if outputs exist')
    args = parser.parse_args()

    FORCE = args.force
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

    # Pull the latest CSV from the domain's Drive folder before any step that reads
    # it, so the build always uses the current sheet (no committed CSV required).
    if any(s in steps for s in ('kg', 'precompute', 'benchmark')):
        fetch_latest_csv(paths)

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
        elif step == 'benchmark':
            step_benchmark(paths, args.domain)
        elapsed = time.time() - t0
        print(f"[{step}] Done ({elapsed:.1f}s)\n")

    print("=== All steps complete ===")


if __name__ == '__main__':
    main()
