"""Precompute package — generates static JSON for the Vercel dashboard.

Three page-level builders, each with a documented coverage contract:
  - explorer.build  → methods, tfidf, description-embeddings, umap-default,
                       term-dictionary, query-keywords
  - rag.build       → rag-chunks (with 2D UMAP), papers-index, /papers/*.pdf
  - graph.build     → kg-full, kg-macro, kg-landing, kg-predictions, kg-contradictions

Run with: python -m precompute [--page explorer|rag|graph|all]
"""
