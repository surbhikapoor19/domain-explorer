# HGT — Heterogeneous Graph Transformer Pipeline

Link prediction on the Grasp Explorer knowledge graph.

## Quick Start

```bash
cd grasp-explorer
source backend/venv/bin/activate

# Train + predict (Phase 1 defaults: InfoNCE, DistMult, 64 neg/pos)
python -m hgt.run --schema-dir chroma_db/hgt_schema --epochs 300

# Predict only (uses saved model)
python -m hgt.run --predict-only --schema-dir chroma_db/hgt_schema
```

## Architecture

```
hgt/
  config.py     — All hyperparameters (single source of truth)
  schema.py     — Graph consolidation + feature engineering
  model.py      — GNN encoder (SAGEConv + to_hetero) + DistMult decoder
  train.py      — Training loop (InfoNCE, type-constrained negs, early stopping)
  evaluate.py   — Per-relation metrics (semantic vs bibliometric split)
  predict.py    — Missing edge prediction using trained embeddings
  augment.py    — Metapath augmentation + edge dropout (Phase 2)
  run.py        — CLI entry point
```

## Phase 1 Changes (from original)

| Fix | What Changed |
|-----|-------------|
| Bibliometric exclusion | co_authored, co_cited etc. kept for message passing but excluded from loss |
| DistMult decoder | Per-relation diagonal weights replace relation-agnostic dot-product |
| Scoring alignment | Prediction uses same DistMult scoring as training (no L2 normalization) |
| Data leakage | Edge types with <5 edges go to train only, not all splits |
| InfoNCE loss | Replaces BCE; temperature-scaled contrastive with 64 negatives |
| Type-constrained negs | Negatives sampled only from valid target type |
| Reduced capacity | 2 layers, hidden=64, dropout=0.3 (was 3 layers, hidden=128, no dropout) |
| Early stopping | Patience=30 on validation MRR |

## Dependencies

- torch, torch-geometric (PyG)
- numpy, scikit-learn
- networkx (for schema building only)
