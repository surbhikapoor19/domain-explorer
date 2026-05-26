"""Tool calling: registry and domain-agnostic statistical/ML/data/RAG tools."""

# Import all tool modules to trigger @register_tool decorators
from . import statistical
from . import ml_tools
from . import data_tools
from . import rag_tool
