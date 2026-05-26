"""CLI entry point for the HGT training pipeline.

Usage:
    python -m hgt.run --schema-dir chroma_db/hgt_schema --epochs 300
    python -m hgt.run --predict-only --schema-dir chroma_db/hgt_schema
"""

import argparse
import logging

from .config import (
    DEFAULT_SCHEMA_DIR,
    DROPOUT,
    EPOCHS,
    HIDDEN_DIM,
    LEARNING_RATE,
    LOG_EVERY,
    NEG_RATIO,
    NUM_LAYERS,
    TEMPERATURE,
)


def main():
    parser = argparse.ArgumentParser(
        description="HGT training pipeline for heterogeneous link prediction"
    )
    parser.add_argument("--schema-dir", default=DEFAULT_SCHEMA_DIR,
                        help="Path to schema directory (default: chroma_db/hgt_schema)")
    parser.add_argument("--epochs", type=int, default=EPOCHS)
    parser.add_argument("--hidden-dim", type=int, default=HIDDEN_DIM)
    parser.add_argument("--num-layers", type=int, default=NUM_LAYERS)
    parser.add_argument("--dropout", type=float, default=DROPOUT)
    parser.add_argument("--lr", type=float, default=LEARNING_RATE)
    parser.add_argument("--neg-ratio", type=int, default=NEG_RATIO)
    parser.add_argument("--temperature", type=float, default=TEMPERATURE)
    parser.add_argument("--log-every", type=int, default=LOG_EVERY)
    parser.add_argument("--no-relation-weights", action="store_true")
    parser.add_argument("--metapath", action="store_true",
                        help="Enable metapath augmentation (Phase 2)")
    parser.add_argument("--edge-dropout", action="store_true",
                        help="Enable per-epoch edge dropout (Phase 2)")
    parser.add_argument("--edge-drop-rate", type=float, default=0.15)
    parser.add_argument("--pretrain", action="store_true",
                        help="Enable GraphCL contrastive pre-training (Phase 3)")
    parser.add_argument("--pretrain-epochs", type=int, default=100)
    parser.add_argument("--rebuild-schema", action="store_true",
                        help="Rebuild HGT schema from current knowledge_graph.json before training")
    parser.add_argument("--predict-only", action="store_true",
                        help="Skip training, only run prediction")
    parser.add_argument("--top-k", type=int, default=5,
                        help="Top-k predictions per source node per relation")
    parser.add_argument("--min-confidence", type=float, default=0.5)

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.rebuild_schema:
        import json
        import os
        from sentence_transformers import SentenceTransformer
        from .schema import build_and_save, load_kg_as_networkx

        chroma_dir = os.path.dirname(args.schema_dir.rstrip('/'))
        kg_path = os.path.join(chroma_dir, 'knowledge_graph.json')
        print(f"[Schema] Rebuilding from {kg_path}...")

        G = load_kg_as_networkx(kg_path)
        model = SentenceTransformer('all-MiniLM-L6-v2')
        tei_dir = os.path.join(chroma_dir, 'tei_xml')
        build_and_save(G, model, args.schema_dir, tei_dir=tei_dir)
        print("[Schema] Rebuild complete.\n")

    if args.predict_only:
        from .predict import run_prediction
        run_prediction(
            args.schema_dir,
            top_k=args.top_k,
            min_confidence=args.min_confidence,
        )
    else:
        from .train import train_and_evaluate
        train_and_evaluate(
            schema_dir=args.schema_dir,
            epochs=args.epochs,
            hidden_dim=args.hidden_dim,
            lr=args.lr,
            log_every=args.log_every,
            num_layers=args.num_layers,
            dropout=args.dropout,
            neg_ratio=args.neg_ratio,
            temperature=args.temperature,
            relation_weights=not args.no_relation_weights,
            use_metapath=args.metapath,
            use_edge_dropout=args.edge_dropout,
            edge_drop_rate=args.edge_drop_rate,
            use_pretrain=args.pretrain,
            pretrain_epochs=args.pretrain_epochs,
        )

        from .predict import run_prediction
        print("\n" + "="*60)
        print("RUNNING PREDICTIONS WITH TRAINED MODEL")
        print("="*60 + "\n")
        run_prediction(
            args.schema_dir,
            top_k=args.top_k,
            min_confidence=args.min_confidence,
        )


if __name__ == "__main__":
    main()
