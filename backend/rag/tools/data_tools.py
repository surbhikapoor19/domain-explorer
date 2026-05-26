"""Data grounding tools: filtering, aggregation, cross-tabulation."""

from collections import Counter

from .registry import register_tool, ToolContext


@register_tool(
    name="filter_and_count",
    description="Filter the dataset by column values and return matching method names and count",
    parameters={
        "type": "object",
        "properties": {
            "filters": {
                "type": "object",
                "description": "Column-value pairs to filter by, e.g. {\"Planning Method\": \"Sampling\", \"Training Data\": \"Sim\"}",
            },
        },
        "required": ["filters"],
    },
    category="data",
)
def filter_and_count_tool(context: ToolContext, filters: dict) -> dict:
    df = context.df
    name_col = df.columns[0]
    mask = [True] * len(df)

    applied = []
    for col, value in filters.items():
        if col not in df.columns:
            continue
        col_mask = df[col].fillna('').astype(str).str.contains(value, case=False, na=False)
        mask = [m and c for m, c in zip(mask, col_mask)]
        applied.append(f"{col}={value}")

    matching = df.loc[mask, name_col].tolist()
    return {
        "filters_applied": applied,
        "count": len(matching),
        "methods": matching,
    }


@register_tool(
    name="cross_tabulate",
    description="Create a contingency table of two columns showing co-occurrence counts",
    parameters={
        "type": "object",
        "properties": {
            "column_a": {"type": "string", "description": "First column name"},
            "column_b": {"type": "string", "description": "Second column name"},
        },
        "required": ["column_a", "column_b"],
    },
    category="data",
)
def cross_tabulate_tool(context: ToolContext, column_a: str, column_b: str) -> dict:
    df = context.df
    if column_a not in df.columns:
        raise ValueError(f"Column '{column_a}' not found")
    if column_b not in df.columns:
        raise ValueError(f"Column '{column_b}' not found")

    # Build cross-tab handling multi-value cells
    table = {}
    for _, row in df.iterrows():
        vals_a = [p.strip() for p in str(row.get(column_a, '')).split(',') if p.strip()]
        vals_b = [p.strip() for p in str(row.get(column_b, '')).split(',') if p.strip()]
        for va in vals_a:
            for vb in vals_b:
                table.setdefault(va, {})
                table[va][vb] = table[va].get(vb, 0) + 1

    return {
        "column_a": column_a,
        "column_b": column_b,
        "table": table,
    }


@register_tool(
    name="value_distribution",
    description="Get value counts for a column, properly handling multi-value cells",
    parameters={
        "type": "object",
        "properties": {
            "column": {"type": "string", "description": "Column name to analyze"},
        },
        "required": ["column"],
    },
    category="data",
)
def value_distribution_tool(context: ToolContext, column: str) -> dict:
    if column not in context.df.columns:
        raise ValueError(f"Column '{column}' not found")

    all_values = []
    for val in context.df[column].fillna('').astype(str):
        for part in [p.strip() for p in val.split(',')]:
            if part:
                all_values.append(part)

    counts = dict(Counter(all_values).most_common())
    return {
        "column": column,
        "total_entries": len(context.df),
        "total_values": len(all_values),
        "unique_values": len(counts),
        "distribution": counts,
    }
