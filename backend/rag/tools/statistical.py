"""Statistical grounding tools.

These let the LLM request real computations instead of hallucinating numbers.
"""

import numpy as np
from collections import Counter
from sklearn.metrics.pairwise import cosine_similarity as sk_cosine

from .registry import register_tool, ToolContext


def _get_method_index(context: ToolContext, method_name: str) -> int:
    """Find row index for a method name. Raises ValueError if not found."""
    matches = context.df[context.df[context.df.columns[0]] == method_name].index
    if len(matches) == 0:
        # Try case-insensitive
        name_col = context.df.columns[0]
        matches = context.df[context.df[name_col].str.lower() == method_name.lower()].index
    if len(matches) == 0:
        raise ValueError(f"Method '{method_name}' not found in dataset")
    return matches[0]


@register_tool(
    name="cosine_similarity",
    description="Compute cosine similarity between two methods based on their weighted feature embeddings",
    parameters={
        "type": "object",
        "properties": {
            "method_a": {"type": "string", "description": "Name of first method"},
            "method_b": {"type": "string", "description": "Name of second method"},
        },
        "required": ["method_a", "method_b"],
    },
    category="statistical",
)
def cosine_similarity_tool(context: ToolContext, method_a: str, method_b: str) -> dict:
    if context.feature_matrix is None:
        raise ValueError("Feature matrix not available")
    idx_a = _get_method_index(context, method_a)
    idx_b = _get_method_index(context, method_b)
    vec_a = context.feature_matrix[idx_a].reshape(1, -1)
    vec_b = context.feature_matrix[idx_b].reshape(1, -1)
    sim = float(sk_cosine(vec_a, vec_b)[0, 0])
    interpretation = "very similar" if sim > 0.8 else "moderately similar" if sim > 0.5 else "dissimilar"
    return {
        "method_a": method_a,
        "method_b": method_b,
        "cosine_similarity": round(sim, 4),
        "interpretation": interpretation,
    }


@register_tool(
    name="pairwise_distances",
    description="Compute pairwise cosine distances between a set of methods",
    parameters={
        "type": "object",
        "properties": {
            "methods": {"type": "array", "items": {"type": "string"}, "description": "List of method names (2-10)"},
        },
        "required": ["methods"],
    },
    category="statistical",
)
def pairwise_distances_tool(context: ToolContext, methods: list) -> dict:
    if context.feature_matrix is None:
        raise ValueError("Feature matrix not available")
    if len(methods) > 10:
        methods = methods[:10]

    indices = [_get_method_index(context, m) for m in methods]
    vecs = context.feature_matrix[indices]
    sim_matrix = sk_cosine(vecs)
    dist_matrix = 1.0 - sim_matrix

    pairs = []
    for i in range(len(methods)):
        for j in range(i + 1, len(methods)):
            pairs.append({
                "method_a": methods[i],
                "method_b": methods[j],
                "distance": round(float(dist_matrix[i, j]), 4),
            })

    pairs.sort(key=lambda p: p["distance"])
    return {"methods": methods, "pairs": pairs}


@register_tool(
    name="distribution_stats",
    description="Get value distribution for a dataset column, with optional grouping",
    parameters={
        "type": "object",
        "properties": {
            "column": {"type": "string", "description": "Column name to analyze"},
            "group_by": {"type": "string", "description": "Optional column to group by"},
        },
        "required": ["column"],
    },
    category="statistical",
)
def distribution_stats_tool(context: ToolContext, column: str, group_by: str = None) -> dict:
    if column not in context.df.columns:
        raise ValueError(f"Column '{column}' not found. Available: {list(context.df.columns)}")

    values = []
    for val in context.df[column].fillna('').astype(str):
        for part in [p.strip() for p in val.split(',')]:
            if part:
                values.append(part)

    counts = dict(Counter(values).most_common(20))
    n_unique = len(set(values))

    result = {
        "column": column,
        "total_values": len(values),
        "unique_values": n_unique,
        "distribution": counts,
    }

    if group_by and group_by in context.df.columns:
        groups = {}
        for _, row in context.df.iterrows():
            g = str(row.get(group_by, ''))
            v = str(row.get(column, ''))
            for part in [p.strip() for p in v.split(',')]:
                if part:
                    groups.setdefault(g, []).append(part)
        result["grouped"] = {g: dict(Counter(vs).most_common(5)) for g, vs in groups.items()}

    return result
