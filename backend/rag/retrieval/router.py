"""Query intent classifier for routing retrieval to the right chunks.

Keyword-based (no ML model). Maps query intent to ChromaDB metadata
filters so we search the right sections and layers.
"""

from enum import Enum


class QueryIntent(Enum):
    BROAD = "broad"
    TECHNICAL = "technical"
    EVALUATION = "evaluation"
    COMPARISON = "comparison"
    LIMITATION = "limitation"
    PEOPLE = "people"  # Author / institution / lab queries


INTENT_KEYWORDS = {
    QueryIntent.TECHNICAL: [
        "equation", "loss", "reward", "objective", "architecture", "algorithm",
        "network", "model", "training", "backbone", "policy", "dynamics",
        "controller", "optimization", "gradient", "inference", "pipeline",
    ],
    QueryIntent.EVALUATION: [
        "benchmark", "dataset", "result", "accuracy", "success rate",
        "real-world", "experiment", "ablation", "baseline", "metric",
        "performance", "evaluation", "table", "figure", "demo",
    ],
    QueryIntent.COMPARISON: [
        "compare", "comparison", "differ", "difference", "vs", "versus",
        "better", "worse", "advantage", "disadvantage", "trade-off",
    ],
    QueryIntent.LIMITATION: [
        "limitation", "failure", "gap", "future", "weakness", "drawback",
        "challenge", "issue", "problem", "cannot", "unable",
    ],
    QueryIntent.PEOPLE: [
        "author", "wrote", "published", "research group", "lab", "university",
        "institution", "team", "affiliation", "who", "researcher", "scientist",
        "faculty", "phd", "advised",
    ],
}

# Canonical section_type (set by GROBID-based parser). Prefer these over fragile
# raw section-name matching.
INTENT_SECTION_TYPES = {
    QueryIntent.BROAD:      None,   # no filter
    QueryIntent.TECHNICAL:  ["method", "introduction"],
    QueryIntent.EVALUATION: ["experiments", "ablation", "table"],
    QueryIntent.COMPARISON: ["related_work", "introduction", "experiments"],
    QueryIntent.LIMITATION: ["limitations", "conclusion"],
    QueryIntent.PEOPLE:     None,   # resolved via KG, not chunks
}

# Back-compat: raw section names as a fallback (for legacy PyMuPDF-ingested data)
INTENT_SECTIONS = {
    QueryIntent.BROAD:      {"layers": ["coarse"], "sections": None},
    QueryIntent.TECHNICAL:  {"layers": ["mid", "fine"],   "sections": ["Method", "Methods", "Methodology", "Approach", "Background"]},
    QueryIntent.EVALUATION: {"layers": ["mid", "fine"],   "sections": ["Experiments", "Results", "Evaluation", "Figures"]},
    QueryIntent.COMPARISON: {"layers": ["coarse", "mid"], "sections": ["Related Work", "Introduction", "Discussion"]},
    QueryIntent.LIMITATION: {"layers": ["mid"],           "sections": ["Discussion", "Conclusion", "Conclusions"]},
    QueryIntent.PEOPLE:     {"layers": ["coarse"],        "sections": None},
}


def classify_intent(query: str) -> QueryIntent:
    """Classify query intent based on keyword matching.

    Returns the intent with the highest keyword match count.
    Defaults to BROAD if no keywords match.
    """
    query_lower = query.lower()
    scores = {}

    for intent, keywords in INTENT_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in query_lower)
        if score > 0:
            scores[intent] = score

    if not scores:
        return QueryIntent.BROAD

    return max(scores, key=scores.get)


def build_metadata_filter(intent: QueryIntent, paper_ids: list = None) -> dict:
    """Build a ChromaDB where-clause from intent and optional paper filter.

    Returns a dict suitable for ChromaDB's `where` parameter.
    """
    routing = INTENT_SECTIONS[intent]
    conditions = []

    # Layer filter
    layers = routing["layers"]
    if layers:
        conditions.append({"layer": {"$in": layers}})

    # Section filter
    sections = routing.get("sections")
    if sections:
        conditions.append({"section": {"$in": sections}})

    # Paper filter
    if paper_ids:
        conditions.append({"paper_id": {"$in": paper_ids}})

    if not conditions:
        return {}
    if len(conditions) == 1:
        return conditions[0]
    return {"$and": conditions}
