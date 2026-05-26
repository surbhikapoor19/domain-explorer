"""Run the precompute package.

Usage examples (from dashboard/):
  python -m scripts.precompute                      # build all (grasp planning)
  python -m scripts.precompute --domain domains/motion_planning.yaml --page explorer
  python -m scripts.precompute --page rag           # build only the RAG page
  python -m scripts.precompute --page explorer graph
  python -m scripts.precompute --output /tmp/out    # custom output dir

Defaults are pulled from shared.config — override with CLI flags or --domain.
"""
import argparse
import os

from .shared.config import (
    DEFAULT_CHROMA, DEFAULT_CSV, DEFAULT_EMBEDDINGS_CACHE,
    DEFAULT_OUTPUT_DIR, DEFAULT_PAPERS_DEST, DEFAULT_PAPERS_SRC,
    DomainConfig, REPO_ROOT,
)

PAGES = ('explorer', 'rag', 'graph')


def parse_args():
    p = argparse.ArgumentParser(
        description='Generate static JSON for the Vercel dashboard',
    )
    p.add_argument('--page', nargs='+', default=['all'], choices=('all',) + PAGES,
                   help='Which page(s) to build (default: all)')
    p.add_argument('--domain', default=None,
                   help='Path to domain YAML config (e.g. domains/motion_planning.yaml)')
    p.add_argument('--output', default=None)
    p.add_argument('--csv', default=None)
    p.add_argument('--papers', default=None)
    p.add_argument('--papers-dest', default=DEFAULT_PAPERS_DEST)
    p.add_argument('--chroma', default=DEFAULT_CHROMA)
    p.add_argument('--embeddings-cache', default=DEFAULT_EMBEDDINGS_CACHE)
    return p.parse_args()


def main():
    args = parse_args()
    pages = set(PAGES) if 'all' in args.page else set(args.page)

    if args.domain:
        yaml_path = args.domain
        if not os.path.isabs(yaml_path):
            yaml_path = os.path.join(REPO_ROOT, yaml_path)
        domain_cfg = DomainConfig.from_yaml(yaml_path)
        print(f"Domain: {domain_cfg.display_name} ({domain_cfg.domain})")
    else:
        domain_cfg = DomainConfig.default_grasp()

    csv_path = args.csv or domain_cfg.csv_path
    papers_src = args.papers or domain_cfg.papers_dir
    output_dir = args.output or DEFAULT_OUTPUT_DIR

    os.makedirs(output_dir, exist_ok=True)
    print(f"Output dir: {output_dir}")
    print(f"CSV: {csv_path}")
    print(f"Building pages: {sorted(pages)}\n")

    method_df = None

    if 'explorer' in pages:
        from .explorer.build import build as build_explorer
        method_df = build_explorer(csv_path, output_dir,
                                   args.embeddings_cache, domain_cfg)
        print()

    if 'rag' in pages:
        from .rag.build import build as build_rag
        build_rag(args.chroma, output_dir, papers_src, args.papers_dest)
        print()

    if 'graph' in pages:
        if method_df is None:
            import pandas as pd
            try:
                method_df = pd.read_csv(csv_path)
            except Exception as e:
                print(f"  Note: could not read CSV for graph landing aggregations ({e})")
        from .graph.build import build as build_graph
        build_graph(args.chroma, output_dir, method_df=method_df,
                    domain_cfg=domain_cfg)
        print()

    print("Done — all requested pages built.")


if __name__ == '__main__':
    main()
