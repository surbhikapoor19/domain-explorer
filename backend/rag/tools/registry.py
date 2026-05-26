"""Tool registry with decorator-based registration.

Tools are Python functions that the LLM can request via its JSON response.
The registry generates JSON schemas for prompt injection and dispatches
tool calls safely with error handling.
"""

import json
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd


@dataclass
class ToolContext:
    """Shared context passed to all tool functions."""
    df: pd.DataFrame
    feature_matrix: np.ndarray = None
    cluster_labels: list = None
    weights: dict = None
    st_model: object = None  # SentenceTransformer instance


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict
    function: Callable
    category: str


# Global registry
_TOOL_REGISTRY: dict = {}


def register_tool(name: str, description: str, parameters: dict, category: str = "general"):
    """Decorator to register a callable as an LLM-invocable tool."""
    def decorator(fn):
        _TOOL_REGISTRY[name] = ToolSpec(
            name=name,
            description=description,
            parameters=parameters,
            function=fn,
            category=category,
        )
        return fn
    return decorator


def get_tool_schemas() -> list:
    """Return JSON-schema descriptions of all registered tools (for LLM prompt)."""
    return [
        {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
            "category": t.category,
        }
        for t in _TOOL_REGISTRY.values()
    ]


def get_tool_prompt_section() -> str:
    """Format tool schemas as a text section for the LLM system prompt."""
    schemas = get_tool_schemas()
    if not schemas:
        return ""

    lines = [
        "AVAILABLE TOOLS:",
        "You may request computations by including a \"tools\" array in your JSON response.",
        "Each tool call: {\"name\": \"tool_name\", \"arguments\": {...}}",
        "Only request tools when the query genuinely needs computed results. Most queries don't need tools.",
        "",
    ]
    for s in schemas:
        params_desc = []
        props = s["parameters"].get("properties", {})
        for pname, pdef in props.items():
            req = "(required)" if pname in s["parameters"].get("required", []) else "(optional)"
            params_desc.append(f"    {pname}: {pdef.get('description', pdef.get('type', ''))} {req}")

        lines.append(f"- {s['name']}: {s['description']}")
        if params_desc:
            lines.extend(params_desc)
        lines.append("")

    return '\n'.join(lines)


def execute_tool(name: str, arguments: dict, context: ToolContext) -> dict:
    """Dispatch a tool call. Returns {success, result, error}."""
    tool = _TOOL_REGISTRY.get(name)
    if not tool:
        return {"success": False, "result": None, "error": f"Unknown tool: {name}"}
    try:
        result = tool.function(context=context, **arguments)
        return {"success": True, "result": result, "error": None}
    except Exception as e:
        return {"success": False, "result": None, "error": str(e)}


def execute_tool_calls(tool_calls: list, context: ToolContext, max_calls: int = 5) -> list:
    """Execute a list of tool calls from the LLM response.

    Args:
        tool_calls: List of {"name": str, "arguments": dict}.
        context: Shared ToolContext with dataset and features.
        max_calls: Safety limit on number of tool calls per query.

    Returns:
        List of {"name", "arguments", "success", "result", "error"}.
    """
    results = []
    for call in tool_calls[:max_calls]:
        name = call.get("name", "")
        arguments = call.get("arguments", {})
        result = execute_tool(name, arguments, context)
        results.append({
            "name": name,
            "arguments": arguments,
            **result,
        })
    return results
