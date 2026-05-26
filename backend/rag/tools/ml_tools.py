"""ML grounding tools: nearest neighbors, cluster analysis, feature importance."""

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

from .registry import register_tool, ToolContext


def _get_method_index(context: ToolContext, method_name: str) -> int:
    """Find row index for a method name."""
    name_col = context.df.columns[0]
    matches = context.df[context.df[name_col] == method_name].index
    if len(matches) == 0:
        matches = context.df[context.df[name_col].str.lower() == method_name.lower()].index
    if len(matches) == 0:
        raise ValueError(f"Method '{method_name}' not found")
    return matches[0]


@register_tool(
    name="nearest_neighbors",
    description="Find the k most similar methods to a given method based on feature embeddings",
    parameters={
        "type": "object",
        "properties": {
            "method": {"type": "string", "description": "Name of the target method"},
            "k": {"type": "integer", "description": "Number of neighbors (default 5)"},
        },
        "required": ["method"],
    },
    category="ml",
)
def nearest_neighbors_tool(context: ToolContext, method: str, k: int = 5) -> dict:
    if context.feature_matrix is None:
        raise ValueError("Feature matrix not available")

    idx = _get_method_index(context, method)
    vec = context.feature_matrix[idx].reshape(1, -1)
    sims = cosine_similarity(vec, context.feature_matrix)[0]

    # Sort by similarity, exclude self
    name_col = context.df.columns[0]
    indices = np.argsort(sims)[::-1]
    neighbors = []
    for i in indices:
        if i == idx:
            continue
        neighbors.append({
            "name": context.df.iloc[i][name_col],
            "similarity": round(float(sims[i]), 4),
        })
        if len(neighbors) >= k:
            break

    return {"method": method, "k": k, "neighbors": neighbors}


@register_tool(
    name="cluster_membership",
    description="Get the cluster assignment for a method, including its co-members and cluster characteristics",
    parameters={
        "type": "object",
        "properties": {
            "method": {"type": "string", "description": "Name of the method"},
        },
        "required": ["method"],
    },
    category="ml",
)
def cluster_membership_tool(context: ToolContext, method: str) -> dict:
    if context.cluster_labels is None:
        raise ValueError("Cluster labels not available")

    idx = _get_method_index(context, method)
    cluster_id = context.cluster_labels[idx]
    name_col = context.df.columns[0]

    co_members = []
    for i, label in enumerate(context.cluster_labels):
        if label == cluster_id and i != idx:
            co_members.append(context.df.iloc[i][name_col])

    return {
        "method": method,
        "cluster_id": int(cluster_id),
        "cluster_size": len(co_members) + 1,
        "co_members": co_members,
    }


@register_tool(
    name="feature_importance",
    description="Identify which feature dimensions most distinguish a method from the dataset average",
    parameters={
        "type": "object",
        "properties": {
            "method": {"type": "string", "description": "Name of the method"},
            "top_n": {"type": "integer", "description": "Number of top features to return (default 10)"},
        },
        "required": ["method"],
    },
    category="ml",
)
def feature_importance_tool(context: ToolContext, method: str, top_n: int = 10) -> dict:
    if context.feature_matrix is None:
        raise ValueError("Feature matrix not available")

    idx = _get_method_index(context, method)
    vec = context.feature_matrix[idx]
    mean_vec = context.feature_matrix.mean(axis=0)
    std_vec = context.feature_matrix.std(axis=0)
    std_vec[std_vec == 0] = 1.0  # avoid division by zero

    # Z-score deviation from mean
    z_scores = (vec - mean_vec) / std_vec
    top_indices = np.argsort(np.abs(z_scores))[::-1][:top_n]

    features = []
    for i in top_indices:
        features.append({
            "dimension": int(i),
            "z_score": round(float(z_scores[i]), 3),
            "value": round(float(vec[i]), 4),
            "mean": round(float(mean_vec[i]), 4),
            "direction": "above average" if z_scores[i] > 0 else "below average",
        })

    return {"method": method, "top_features": features}


@register_tool(
    name="outlier_score",
    description="Compute how atypical a method is relative to the dataset (average distance to all other methods)",
    parameters={
        "type": "object",
        "properties": {
            "method": {"type": "string", "description": "Name of the method"},
        },
        "required": ["method"],
    },
    category="ml",
)
def outlier_score_tool(context: ToolContext, method: str) -> dict:
    if context.feature_matrix is None:
        raise ValueError("Feature matrix not available")

    idx = _get_method_index(context, method)
    vec = context.feature_matrix[idx].reshape(1, -1)
    sims = cosine_similarity(vec, context.feature_matrix)[0]

    # Exclude self
    other_sims = np.concatenate([sims[:idx], sims[idx + 1:]])
    avg_sim = float(other_sims.mean())
    min_sim = float(other_sims.min())

    # Compute outlier score for all methods to get percentile
    all_avg_sims = []
    for i in range(len(context.feature_matrix)):
        s = cosine_similarity(context.feature_matrix[i].reshape(1, -1), context.feature_matrix)[0]
        others = np.concatenate([s[:i], s[i + 1:]])
        all_avg_sims.append(others.mean())

    percentile = float(np.sum(np.array(all_avg_sims) > avg_sim) / len(all_avg_sims) * 100)
    interpretation = "typical" if percentile < 70 else "somewhat unusual" if percentile < 90 else "outlier"

    return {
        "method": method,
        "avg_similarity_to_others": round(avg_sim, 4),
        "min_similarity": round(min_sim, 4),
        "outlier_percentile": round(percentile, 1),
        "interpretation": interpretation,
    }
