#!/usr/bin/env python3
"""
Rebuild the knowledge graph from existing ingested data.

Reads from:
  - chroma_db/extracted_facts.json    (regex-extracted facts from papers)
  - chroma_db/extracted_entities.json (LLM-extracted entities, already generated)
  - chroma_db/citation_edges.json     (cross-paper citation edges)
  - chroma_db/ ChromaDB collection    (paper chunks + embeddings)
  - datasets/csv-gp-combined.csv      (56 methods × 20 columns)
  - papers/                           (PDF directory for method-paper mapping)

Writes to:
  - chroma_db/knowledge_graph.json    (the full enriched graph)
  - chroma_db/citation_edges.json     (updated citation edges)

NO LLM APIs are called. Everything runs locally:
  - NetworkX for graph construction
  - KeyBERT for keyphrase extraction
  - TF-IDF for lexical features
  - SentenceTransformer (all-MiniLM-L6-v2) for embeddings
  - Regex + heuristics for citation resolution

Usage:
  cd grasp-explorer
  source backend/venv/bin/activate
  python backend/rebuild_kg.py
  python backend/rebuild_kg.py --config rag_config.yaml      # explicit config
  python backend/rebuild_kg.py --skip-features                # base graph only
  python backend/rebuild_kg.py --skip-citations               # skip re-resolving citations
"""

import argparse
import json
import os
import sys
import time

# Ensure backend/ is on the path so `rag.*` imports work
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))


# ── Step functions ──────────────────────────────────────────────────────────

def load_config(config_path):
    """Load the RAG config from YAML."""
    from rag.config import load_config as _load
    return _load(config_path)


def build_base_graph(config):
    """Step 1: Build the base KG from facts + entities + method-paper mapping.

    Returns (graph, method_paper_map, paper_texts)
    """
    from rag.knowledge_graph import build_knowledge_graph
    from rag.method_paper_map import build_method_paper_map

    facts_path = os.path.join(config.chroma_persist_dir, 'extracted_facts.json')
    entities_path = os.path.join(config.chroma_persist_dir, 'extracted_entities.json')

    mpm = build_method_paper_map(config.csv_path, 'papers')
    print(f"  Method-paper map: {len(mpm.get('method_to_paper', {}))} matched, "
          f"{len(mpm.get('unmatched_methods', []))} orphaned methods")

    G = build_knowledge_graph(facts_path, entities_path, mpm, csv_path=config.csv_path)
    print(f"  Base graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    return G, mpm


def build_paper_texts(config):
    """Build {paper_id: full_text} from ChromaDB chunks."""
    from collections import defaultdict
    from rag.ingest.store import get_client, create_or_get_collection

    client = get_client(config)
    collection = create_or_get_collection(config, client)

    total = collection.count()
    all_data = collection.get(include=['documents', 'metadatas'], limit=total)

    texts = defaultdict(list)
    for doc, meta in zip(all_data['documents'], all_data['metadatas']):
        pid = meta.get('paper_id', '')
        if pid and doc:
            texts[pid].append(doc)

    paper_texts = {pid: ' '.join(chunks) for pid, chunks in texts.items()}
    print(f"  Paper texts: {len(paper_texts)} papers from {total} chunks")

    return paper_texts, collection


def resolve_citations(config, G, mpm, paper_texts):
    """Step 2: Cross-reference citations.

    Prefers TEI-based resolution (precise) when TEI files exist. Falls back
    to the legacy fuzzy string matcher otherwise.
    """
    import pandas as pd

    # Prefer TEI-based resolution when grobid artifacts exist
    tei_dir = os.path.join(config.chroma_persist_dir, 'tei')
    from rag import tei_graph
    if tei_graph.available(tei_dir):
        print("  Using TEI-based citation resolver (biblStruct matching)")
        # Build {paper_id: title} from KG paper nodes
        paper_titles = {
            nid.replace('paper:', ''): G.nodes[nid].get('label', '')
            for nid in G.nodes if G.nodes[nid].get('type') == 'paper'
        }
        stats = tei_graph.enrich_graph_from_tei(G, tei_dir, paper_titles, paper_texts=paper_texts)
        print(f"  TEI enrichment: papers={stats.papers_processed}, "
              f"authors={stats.authors}, institutions={stats.institutions}, "
              f"internal_citations={stats.internal_citations}, "
              f"external_refs={stats.external_refs}, "
              f"tables={stats.tables}, figures={stats.figures}, formulas={stats.formulas}")
        # Also persist a flat citation_edges.json for back-compat / downstream tools
        edges = []
        for src, tgt, ed in G.edges(data=True):
            if ed.get('type') == 'cites' and ed.get('source') == 'tei':
                edges.append({
                    'source': src.replace('paper:', ''),
                    'target': tgt.replace('paper:', ''),
                    'mentions': ed.get('mentions', 1),
                    'sentiment': ed.get('sentiment', 'neutral'),
                    'contexts': ed.get('contexts', []),
                })
        citation_path = os.path.join(config.chroma_persist_dir, 'citation_edges.json')
        with open(citation_path, 'w') as f:
            json.dump(edges, f, indent=2)
        print(f"  Persisted {len(edges)} TEI citation edges to {citation_path}")
        return G

    # Legacy path (PyMuPDF or no TEI cache)
    print("  TEI files not found, falling back to fuzzy string-match resolver")
    from rag.citation_resolver import resolve_citations as _resolve
    df = pd.read_csv(config.csv_path)
    method_names = [str(r['Name']).replace('\U0001f916 ', '').strip() for _, r in df.iterrows()]
    paper_ids = sorted(paper_texts.keys())

    edges = _resolve(paper_texts, paper_ids, method_names, mpm)
    print(f"  Resolved {len(edges)} citation edges")

    n_added = 0
    for edge in edges:
        src = f"paper:{edge['source']}"
        tgt = f"paper:{edge['target']}"
        if src in G and tgt in G and not G.has_edge(src, tgt):
            G.add_edge(src, tgt,
                       type='cites',
                       mentions=edge['mentions'],
                       sentiment=edge.get('sentiment', 'neutral'),
                       matched_text=edge.get('matched_text', ''))
            n_added += 1

    citation_path = os.path.join(config.chroma_persist_dir, 'citation_edges.json')
    with open(citation_path, 'w') as f:
        json.dump(edges, f, indent=2)

    print(f"  Added {n_added} new citation edges (saved to {citation_path})")
    return G


def run_feature_engineering(config, G, mpm, paper_texts, collection):
    """Step 3: Enrich the graph with CSV columns, chunks, keyphrases, TF-IDF, centrality."""
    from sentence_transformers import SentenceTransformer
    from rag.feature_engineering import enrich_knowledge_graph
    from rag import tei_graph

    print(f"  Loading embedding model ({config.embedding_model})...")
    model = SentenceTransformer(config.embedding_model)

    tei_dir = os.path.join(config.chroma_persist_dir, 'tei')
    skip_ft_heuristic = tei_graph.available(tei_dir)

    G = enrich_knowledge_graph(
        G, collection, model,
        paper_texts=paper_texts,
        csv_path=config.csv_path,
        method_paper_map=mpm,
        skip_figure_table_heuristic=skip_ft_heuristic,
    )
    return G


def save(config, G):
    """Save the final graph to JSON."""
    from rag.knowledge_graph import save_graph
    kg_path = os.path.join(config.chroma_persist_dir, 'knowledge_graph.json')
    save_graph(G, kg_path)
    print(f"  Saved to {kg_path}")


def run_hgt_pipeline(config, G, epochs=150):
    """Step 4 (optional): re-export HGT schema, train HGT, predict latent edges.

    Produces under <chroma_persist_dir>/hgt_schema/:
      - node_features.npz, edge_list.json, node_mappings.json, ... (schema)
      - hgt_model.pt, hgt_embeddings.npz               (trained model)
      - predicted_edges.json                           (latent relationships)
    """
    from sentence_transformers import SentenceTransformer
    from rag.graph_schema import build_and_save
    from rag.graph_train import train_and_evaluate
    from rag.graph_predictor import run_prediction
    from rag.ingest.store import get_client, create_or_get_collection

    schema_dir = os.path.join(config.chroma_persist_dir, 'hgt_schema')

    print("  [1/3] Building HGT schema from current graph...")
    model = SentenceTransformer(config.embedding_model)
    client = get_client(config)
    collection = create_or_get_collection(config, client)
    build_and_save(G, model, schema_dir, collection=collection)

    print(f"\n  [2/3] Training HGT ({epochs} epochs)...")
    train_and_evaluate(schema_dir=schema_dir, epochs=epochs)

    print("\n  [3/3] Predicting latent relationships...")
    predictions_path = os.path.join(schema_dir, 'predicted_edges.json')
    run_prediction(schema_dir=schema_dir, output_path=predictions_path, top_k=5, min_confidence=0.5)
    print(f"  Latent edges saved to {predictions_path}")


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Rebuild the knowledge graph from existing ingested data.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='No LLM APIs are called. All computation is local.'
    )
    parser.add_argument('--config', default='rag_config.yaml',
                        help='Path to rag_config.yaml (default: rag_config.yaml)')
    parser.add_argument('--skip-citations', action='store_true',
                        help='Skip citation re-resolution (use existing citation_edges.json)')
    parser.add_argument('--skip-features', action='store_true',
                        help='Skip feature engineering (CSV explosion, chunks, keyphrases, TF-IDF, centrality)')
    parser.add_argument('--with-hgt', action='store_true',
                        help='After rebuilding KG, re-export HGT schema, retrain the model, and predict latent edges')
    parser.add_argument('--hgt-epochs', type=int, default=150,
                        help='Epochs for HGT retraining when --with-hgt is set (default: 150)')
    args = parser.parse_args()

    if not os.path.isfile(args.config):
        print(f"Error: config not found at {args.config}")
        sys.exit(1)

    t0 = time.time()
    config = load_config(args.config)
    print(f"Config: {config.project_name}")
    print(f"  CSV:      {config.csv_path}")
    print(f"  ChromaDB: {config.chroma_persist_dir}")
    print()

    # Step 1: Base graph
    print("Step 1/5 — Building base graph (facts + entities + methods)...")
    G, mpm = build_base_graph(config)
    print()

    # Step 2: Citations
    if args.skip_citations:
        print("Step 2/5 — Skipped (--skip-citations)")
        # Load existing citation edges
        citation_path = os.path.join(config.chroma_persist_dir, 'citation_edges.json')
        if os.path.exists(citation_path):
            with open(citation_path) as f:
                edges = json.load(f)
            for edge in edges:
                src = f"paper:{edge['source']}"
                tgt = f"paper:{edge['target']}"
                if src in G and tgt in G and not G.has_edge(src, tgt):
                    G.add_edge(src, tgt, type='cites',
                               mentions=edge.get('mentions', 1),
                               sentiment=edge.get('sentiment', 'neutral'))
            print(f"  Loaded {len(edges)} existing citation edges")
    else:
        print("Step 2/5 — Resolving citations...")
        paper_texts, collection = build_paper_texts(config)
        G = resolve_citations(config, G, mpm, paper_texts)
    print()

    # Step 3: S2 enrichment (implicit when chroma_db/s2_enrichment.json exists)
    s2_path = os.path.join(config.chroma_persist_dir, 's2_enrichment.json')
    if os.path.exists(s2_path):
        print("Step 3/5 — S2 enrichment...")
        from rag.s2_kg_integrator import enrich_graph_with_s2
        s2_stats = enrich_graph_with_s2(G, s2_path)
        print(f"  S2 enrichment: papers={s2_stats.get('papers', 0)}, "
              f"enriched_refs={s2_stats.get('enriched_refs', 0)}, "
              f"new_refs={s2_stats.get('new_refs', 0)}, "
              f"back_citations={s2_stats.get('back_citations', 0)}, "
              f"context_strings={s2_stats.get('context_strings', 0)}")
    else:
        print(f"Step 3/5 — S2 enrichment skipped (no {s2_path})")
    print()

    # Step 4: SciCite citation-intent enrichment (implicit when
    # chroma_db/citation_intents.json exists). Adds intent labels to existing
    # citation edges and materializes compared_against edges for high
    # confidence result-class citations. Must run after S2 (which is what
    # produces the external citing reference nodes that the SciCite step
    # links into).
    intents_path = os.path.join(config.chroma_persist_dir, 'citation_intents.json')
    if os.path.exists(intents_path):
        print("Step 4/5 — SciCite citation-intent enrichment...")
        from rag.scicite_kg_integrator import enrich_graph_with_scicite_intents
        sc_stats = enrich_graph_with_scicite_intents(G, intents_path)
        print(f"  SciCite enrichment: internal={sc_stats.get('internal', 0)}, "
              f"external_back={sc_stats.get('external_back', 0)}, "
              f"compared_against_added={sc_stats.get('compared_against_added', 0)}, "
              f"method_intent={sc_stats.get('method_intent_annotated', 0)}, "
              f"background_intent={sc_stats.get('background_intent_annotated', 0)}")
    else:
        print(f"Step 4/5 — SciCite enrichment skipped (no {intents_path})")
    print()

    # Step 5: Feature engineering
    if args.skip_features:
        print("Step 5/5 — Skipped (--skip-features)")
    else:
        print("Step 5/5 — Feature engineering...")
        if 'paper_texts' not in dir():
            paper_texts, collection = build_paper_texts(config)
        G = run_feature_engineering(config, G, mpm, paper_texts, collection)
    print()

    # Save
    elapsed = time.time() - t0
    print(f"{'='*60}")
    print(f"Final graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    print(f"Completed in {elapsed:.1f}s")
    print(f"{'='*60}")
    save(config, G)

    # Optional HGT retraining
    if args.with_hgt:
        print(f"\n{'='*60}\nHGT pipeline (schema → train → predict)\n{'='*60}")
        t1 = time.time()
        run_hgt_pipeline(config, G, epochs=args.hgt_epochs)
        print(f"\nHGT pipeline done in {time.time() - t1:.1f}s")

    print("\nRestart the backend to load the new graph.")


if __name__ == '__main__':
    main()
