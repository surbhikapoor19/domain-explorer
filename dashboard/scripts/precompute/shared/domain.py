"""Active-domain loader for the precompute pipeline.

Every precompute script imports `active_domain` from this module and
reads CSV columns through role lookups, not literal column names. This
is what makes the pipeline domain-agnostic: swap `domain.yaml` and the
same code runs against a different CSV with different column names.

Resolution order for the active domain config:
  1. env var DOMAIN_CONFIG (absolute or repo-relative path to a YAML)
  2. default: domains/grasp_planning.yaml (the legacy GRASP behavior)

The backend's role_schema validator is the single source of truth for
the vocabulary; this module just delegates to it. We import it via a
sys.path tweak because the precompute scripts run from the dashboard
side but the validator lives in backend (it is shared between the
ingest pipeline and the dashboard build).
"""
from __future__ import annotations

import os
import sys

# Repo root = three levels up from this file (scripts/precompute/shared/domain.py)
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
_BACKEND = os.path.join(_REPO_ROOT, 'backend')
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from rag.role_schema import load_domain_config, DomainConfig, ConfigError  # noqa: E402


_DEFAULT_CONFIG_REL = 'domains/grasp_planning.yaml'


def _resolve_config_path() -> str:
    env = os.environ.get('DOMAIN_CONFIG')
    if env:
        # Allow either absolute or repo-relative paths.
        if os.path.isabs(env):
            return env
        return os.path.join(_REPO_ROOT, env)
    return os.path.join(_REPO_ROOT, _DEFAULT_CONFIG_REL)


def _load() -> DomainConfig:
    path = _resolve_config_path()
    return load_domain_config(path, repo_root=_REPO_ROOT)


# Module-level singleton: loaded once when the first precompute script
# imports it. If env changes mid-run (it shouldn't), restart the process.
active_domain: DomainConfig = _load()

# Convenience exports
REPO_ROOT = _REPO_ROOT


def column_for(role: str) -> str | None:
    """Shorthand for active_domain.column_for(role). Returns None when
    the active domain has no column mapped to this role.
    """
    return active_domain.column_for(role)


def require_column(role: str) -> str:
    """Same as column_for but raises if the role is absent. Use when
    the script genuinely cannot proceed without that role.
    """
    col = active_domain.column_for(role)
    if col is None:
        raise ConfigError(
            f"Active domain {active_domain.domain!r} has no column mapped to role "
            f"{role!r}. The current script requires it."
        )
    return col


__all__ = ['active_domain', 'column_for', 'require_column', 'REPO_ROOT', 'ConfigError']
