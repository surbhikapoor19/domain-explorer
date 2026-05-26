"""Canonical role vocabulary + domain config loader/validator.

The dashboard pipeline reads CSV data through a layer of *roles* rather
than literal column names. A domain config (YAML in `domains/`) maps
its CSV columns onto these roles. The same code path then serves any
domain whose config conforms.

This module is the single source of truth for what roles exist and what
facets they may carry. The docs at `docs/role-schema.md` document the
same vocabulary in narrative form; if you add a role here, add it
there too.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

import yaml


# ── Role vocabulary ─────────────────────────────────────────────────────
# Namespaced. Adding a new role: add the string here, document it in
# docs/role-schema.md, and any domain config that references it will
# validate.
ROLE_VOCABULARY: Set[str] = {
    # identity
    'identity.name',
    'identity.description',
    'identity.year',
    'identity.code',
    'identity.citation',
    # method
    'method.family',
    'method.backbone',
    # input / output
    'input.modality',
    'input.sensor',
    'output.shape',
    # training
    'train.regime',
    'train.simulator',
    # evaluation
    'eval.benchmark',
    'eval.metric',
    # hardware + environment
    'hardware.platform',
    'env.context',
    # meta
    'meta.license',
    'meta.maintainer',
    'meta.language',
}

# Roles that every domain must declare a column for. Missing any of
# these is treated as a config error rather than an absent-but-allowed
# role.
REQUIRED_ROLES: Set[str] = {
    'identity.name',
    'identity.year',
}

# Allowed `facet` values on a column entry. These hint at how the
# column is rendered / filtered in the dashboard UI.
VALID_FACETS: Set[str] = {
    'categorical',
    'numeric',
    'text',
    'url',
    'identifier',
}

# Top-level YAML keys every domain config must define.
REQUIRED_TOP_LEVEL: Set[str] = {
    'domain',
    'display_name',
    'display_subject',
    'csv_path',
    'papers_dir',
    'columns',
}


@dataclass
class DomainConfig:
    """Parsed and validated domain config."""
    domain: str
    display_name: str
    display_subject: str
    display_short: Optional[str]
    ecosystem: Optional[str]
    tagline: Optional[str]
    query_hint: Optional[str]
    method_noun: Optional[str]
    csv_path: str
    papers_dir: str
    columns: Dict[str, Dict[str, Any]]
    llm: Dict[str, Any] = field(default_factory=dict)
    default_color_by_roles: List[str] = field(default_factory=list)

    # Parsed convenience map: role -> list of CSV column names that play
    # that role. A role can be played by zero or more columns.
    roles_to_columns: Dict[str, List[str]] = field(default_factory=dict)

    def column_for(self, role: str) -> Optional[str]:
        """Return the first CSV column mapped to `role`, or None."""
        cols = self.roles_to_columns.get(role, [])
        return cols[0] if cols else None

    def all_columns_for(self, role: str) -> List[str]:
        return list(self.roles_to_columns.get(role, []))


def load_domain_config(path: str, repo_root: Optional[str] = None) -> DomainConfig:
    """Load and validate a domain YAML.

    Raises ConfigError with a clear message on any validation failure.
    """
    if not os.path.isfile(path):
        raise ConfigError(f"domain config not found: {path}")
    with open(path, 'r') as f:
        raw = yaml.safe_load(f)
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: top-level YAML must be a mapping")
    _validate(raw, source=path)

    # Build roles_to_columns reverse index.
    roles_to_columns: Dict[str, List[str]] = {}
    for col_name, spec in raw['columns'].items():
        role = spec.get('role')
        if role:
            roles_to_columns.setdefault(role, []).append(col_name)

    return DomainConfig(
        domain=raw['domain'],
        display_name=raw['display_name'],
        display_subject=raw['display_subject'],
        display_short=raw.get('display_short'),
        ecosystem=raw.get('ecosystem'),
        tagline=raw.get('tagline'),
        query_hint=raw.get('query_hint'),
        method_noun=raw.get('method_noun'),
        csv_path=raw['csv_path'],
        papers_dir=raw['papers_dir'],
        columns=raw['columns'],
        llm=raw.get('llm') or {},
        default_color_by_roles=raw.get('default_color_by_roles') or [],
        roles_to_columns=roles_to_columns,
    )


class ConfigError(ValueError):
    """Raised on any domain-config validation failure."""


def _validate(raw: Dict[str, Any], source: str) -> None:
    # required top-level keys
    missing = REQUIRED_TOP_LEVEL - set(raw.keys())
    if missing:
        raise ConfigError(f"{source}: missing required top-level keys: {sorted(missing)}")
    # types
    if not isinstance(raw['columns'], dict):
        raise ConfigError(f"{source}: `columns` must be a mapping of CSV column name -> spec")
    if not isinstance(raw['display_name'], str) or not raw['display_name'].strip():
        raise ConfigError(f"{source}: `display_name` must be a non-empty string")
    if not isinstance(raw['display_subject'], str) or not raw['display_subject'].strip():
        raise ConfigError(f"{source}: `display_subject` must be a non-empty string")
    if not isinstance(raw['domain'], str) or not raw['domain'].strip():
        raise ConfigError(f"{source}: `domain` must be a non-empty string")

    # column specs
    declared_roles: Set[str] = set()
    for col_name, spec in raw['columns'].items():
        if not isinstance(spec, dict):
            raise ConfigError(f"{source}: column {col_name!r} spec must be a mapping, got {type(spec).__name__}")
        role = spec.get('role')
        if role is None:
            raise ConfigError(f"{source}: column {col_name!r} is missing a `role`")
        if role not in ROLE_VOCABULARY:
            raise ConfigError(
                f"{source}: column {col_name!r} declares role {role!r} which is NOT in the role "
                f"vocabulary. Add it to ROLE_VOCABULARY in backend/rag/role_schema.py and document "
                f"it in docs/role-schema.md, or fix the typo."
            )
        declared_roles.add(role)
        facet = spec.get('facet')
        if facet is not None and facet not in VALID_FACETS:
            raise ConfigError(
                f"{source}: column {col_name!r} declares facet {facet!r}; valid options are "
                f"{sorted(VALID_FACETS)}."
            )
    # required roles
    missing_roles = REQUIRED_ROLES - declared_roles
    if missing_roles:
        raise ConfigError(
            f"{source}: required roles missing from the column mapping: {sorted(missing_roles)}"
        )

    # llm block (optional but if present must shape correctly)
    llm = raw.get('llm')
    if llm is not None:
        if not isinstance(llm, dict):
            raise ConfigError(f"{source}: `llm` must be a mapping if present")
        ds = llm.get('domain_subject')
        if ds is not None and (not isinstance(ds, str) or not ds.strip()):
            raise ConfigError(f"{source}: `llm.domain_subject` must be a non-empty string if present")
        focus = llm.get('claim_extraction_focus')
        if focus is not None:
            if not isinstance(focus, list) or not all(isinstance(x, str) and x.strip() for x in focus):
                raise ConfigError(
                    f"{source}: `llm.claim_extraction_focus` must be a list of non-empty strings"
                )

    # default_color_by_roles must reference roles in the vocabulary
    color_by = raw.get('default_color_by_roles') or []
    if not isinstance(color_by, list):
        raise ConfigError(f"{source}: `default_color_by_roles` must be a list")
    for r in color_by:
        if r not in ROLE_VOCABULARY:
            raise ConfigError(
                f"{source}: default_color_by_roles references unknown role {r!r}"
            )
