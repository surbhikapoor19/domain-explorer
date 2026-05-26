"""Constants shared by every page builder.

Mirrors frontend/src/constants.js — keep in sync.
When a --domain YAML is supplied, values are loaded from that config
instead of these built-in grasp-planning defaults.
"""
import os

import yaml

_HERE = os.path.abspath(__file__)
REPO_ROOT = os.path.dirname(  # grasp-explorer/
    os.path.dirname(  # dashboard/
        os.path.dirname(  # scripts/
            os.path.dirname(  # precompute/
                os.path.dirname(_HERE)  # shared/
            )
        )
    )
)

DEFAULT_OUTPUT_DIR = os.path.join(REPO_ROOT, 'dashboard', 'public', 'data')
DEFAULT_PAPERS_DEST = os.path.join(REPO_ROOT, 'dashboard', 'public', 'papers')
DEFAULT_CSV = os.path.join(REPO_ROOT, 'datasets', 'csv-gp-combined.csv')
DEFAULT_PAPERS_SRC = os.path.join(REPO_ROOT, 'papers')
DEFAULT_CHROMA = os.path.join(REPO_ROOT, 'chroma_db')
DEFAULT_EMBEDDINGS_CACHE = os.path.join(REPO_ROOT, 'backend', '.description_embeddings.npy')

# --- Grasp-planning built-in defaults (used when no --domain is given) ---

DEFAULT_WEIGHTS = {
    'Planning Method': 10, 'Training Data': 8, 'End-effector Hardware': 6,
    'Object Configuration': 10, 'Input Data': 6, 'Output Pose': 10,
    'Corresponding Dataset (see repository linked above)': 5,
    'Simulator (see repository linked above)': 3, 'Backbone': 5,
    'Metric(s) Used ': 5, 'Camera Position(s)': 4, 'Language': 4, 'Description': 7,
}

DERIVED_COLUMNS = [
    'Grasp Dimensionality', 'Learning Paradigm', 'Sensor Complexity',
    'Scene Difficulty', 'Gripper Type', 'ML Framework', 'Method Era',
]

SHORT_COLUMN_NAMES = {
    'Planning Method': 'Plan', 'Training Data': 'Train', 'End-effector Hardware': 'Gripper',
    'Object Configuration': 'Objects', 'Input Data': 'Input', 'Output Pose': 'Output',
    'Corresponding Dataset (see repository linked above)': 'Dataset',
    'Simulator (see repository linked above)': 'Sim', 'Backbone': 'Backbone',
    'Metric(s) Used ': 'Metrics', 'Camera Position(s)': 'Camera', 'Language': 'Lang',
    'Description': 'Desc',
}

UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.1
UMAP_METRIC = 'cosine'

# --- Role-to-weight defaults when a domain YAML doesn't specify weights ---

_ROLE_DEFAULT_WEIGHT = {
    'method.family': 10, 'method.backbone': 5, 'method.middleware': 6,
    'method.ik_controller': 4,
    'train.regime': 8, 'train.simulator': 3,
    'hardware.platform': 6,
    'env.context': 10,
    'input.modality': 6, 'input.sensor': 4,
    'output.shape': 10,
    'eval.benchmark': 5, 'eval.metric': 5,
    'meta.language': 4, 'meta.license': 2,
    'identity.description': 7,
}

_ROLE_SHORT_NAME = {
    'method.family': 'Method', 'method.backbone': 'Backbone',
    'method.middleware': 'Middleware', 'method.ik_controller': 'IK/Ctrl',
    'train.regime': 'Train', 'train.simulator': 'Sim',
    'hardware.platform': 'Hardware',
    'env.context': 'Scene',
    'input.modality': 'Input', 'input.sensor': 'Sensor',
    'output.shape': 'Output',
    'eval.benchmark': 'Benchmark', 'eval.metric': 'Metrics',
    'meta.language': 'Lang', 'meta.license': 'License',
    'meta.maintainer': 'Maint',
    'identity.description': 'Desc',
}

_FACET_SKIP = {'identifier', 'url', 'text'}


class DomainConfig:
    """Encapsulates all domain-specific precompute parameters."""

    def __init__(self, domain_name, csv_path, papers_dir, weights,
                 short_names, derived_columns, priority_dims,
                 display_name='Explorer', method_noun='method',
                 column_roles=None, columns_config=None,
                 branding=None):
        self.domain = domain_name
        self.csv_path = csv_path
        self.papers_dir = papers_dir
        self.weights = weights
        self.short_names = short_names
        self.derived_columns = derived_columns
        self.priority_dims = priority_dims
        self.display_name = display_name
        self.method_noun = method_noun
        self.column_roles = column_roles or {}
        self.columns_config = columns_config or {}
        self.branding = branding or {}

    @property
    def table_columns(self):
        """Columns shown in MethodTable — categorical/numeric/url, no aliases."""
        _TABLE_FACETS = {'categorical', 'numeric', 'url'}
        _SKIP_ROLES = {'identity.name', 'identity.description', 'identity.citation'}
        cols = []
        for col_name, col_cfg in self.columns_config.items():
            if col_cfg.get('alias_of'):
                continue
            if col_cfg.get('facet') not in _TABLE_FACETS:
                continue
            if col_cfg.get('role') in _SKIP_ROLES:
                continue
            cols.append(col_name)
        return cols

    @property
    def color_by_options(self):
        """Options for the color-by dropdown."""
        opts = [{'value': 'cluster', 'label': 'Cluster'}]
        for col_name, col_cfg in self.columns_config.items():
            if col_cfg.get('alias_of'):
                continue
            if col_cfg.get('facet') != 'categorical':
                continue
            if col_cfg.get('role', '').startswith('identity.'):
                continue
            label = self.short_names.get(col_name, col_name)
            opts.append({'value': col_name, 'label': label})
        for dc in self.derived_columns:
            label = self.short_names.get(dc, dc)
            opts.append({'value': dc, 'label': label})
        return opts

    @classmethod
    def from_yaml(cls, yaml_path):
        with open(yaml_path) as f:
            cfg = yaml.safe_load(f)

        columns = cfg.get('columns', {})
        csv_rel = cfg.get('csv_path', '')
        papers_rel = cfg.get('papers_dir', '')
        csv_path = os.path.join(REPO_ROOT, csv_rel) if csv_rel else DEFAULT_CSV
        papers_dir = os.path.join(REPO_ROOT, papers_rel) if papers_rel else DEFAULT_PAPERS_SRC

        weights = {}
        short_names = {}
        priority_dims = []
        column_roles = {}
        columns_config = {}

        for col_name, col_cfg in columns.items():
            role = col_cfg.get('role', '')
            facet = col_cfg.get('facet', '')
            column_roles[col_name] = role
            columns_config[col_name] = {
                'role': role,
                'facet': facet,
                'alias_of': col_cfg.get('alias_of'),
            }

            if facet in _FACET_SKIP and role != 'identity.description':
                continue

            w = _ROLE_DEFAULT_WEIGHT.get(role, 4)
            weights[col_name] = w
            short_names[col_name] = _ROLE_SHORT_NAME.get(role, col_name[:8])

            if role.startswith(('method.', 'train.', 'hardware.', 'env.',
                                'input.', 'output.', 'eval.')):
                alias = col_cfg.get('alias_short', col_name)
                priority_dims.append((col_name, alias))

        is_grasp = cfg.get('domain') == 'grasp_planning'
        derived = DERIVED_COLUMNS if is_grasp else []

        display_name = cfg.get('display_name', 'Explorer')
        method_noun = cfg.get('method_noun', 'method')
        branding = {
            'productName': display_name,
            'productShort': cfg.get('display_subject', f'{method_noun}s'),
            'productSubject': cfg.get('display_short', cfg.get('domain', '').replace('_', ' ')),
            'ecosystem': cfg.get('ecosystem', 'COMPARE Ecosystem'),
            'tagline': cfg.get('tagline', 'AI-in-the-Loop'),
            'queryHint': cfg.get('query_hint', f'Ask about {method_noun}s...'),
            'methodNoun': method_noun,
        }

        return cls(
            domain_name=cfg.get('domain', 'unknown'),
            csv_path=csv_path,
            papers_dir=papers_dir,
            weights=weights,
            short_names=short_names,
            derived_columns=derived,
            priority_dims=priority_dims,
            display_name=display_name,
            method_noun=method_noun,
            column_roles=column_roles,
            columns_config=columns_config,
            branding=branding,
        )

    @classmethod
    def default_grasp(cls):
        priority_dims = [
            ('Object Configuration', 'Scene / Object Config'),
            ('Planning Method', 'Planning Method'),
            ('Training Data', 'Training Data'),
            ('End-effector Hardware', 'End-effector Hardware'),
            ('Input Data', 'Input / Sensor'),
            ('Corresponding Dataset (see repository linked above)', 'Dataset'),
            ('Simulator (see repository linked above)', 'Simulator'),
            ('Metric(s) Used ', 'Metrics'),
        ]
        column_roles = {
            'Name': 'identity.name',
            'Description': 'identity.description',
            'Planning Method': 'method.family',
            'Training Data': 'train.regime',
            'End-effector Hardware': 'hardware.platform',
            'Object Configuration': 'env.context',
            'Input Data': 'input.modality',
            'Output Pose': 'output.shape',
            'Corresponding Dataset (see repository linked above)': 'eval.benchmark',
            'Simulator (see repository linked above)': 'train.simulator',
            'Backbone': 'method.backbone',
            'Metric(s) Used ': 'eval.metric',
            'Camera Position(s)': 'input.sensor',
            'Language': 'meta.language',
            'License': 'meta.license',
            'Maintainer(s)': 'meta.maintainer',
            'Citation': 'identity.citation',
            'Year (Initial Release)': 'identity.year',
            'Link(s)': 'identity.code',
        }
        columns_config = {}
        _FACET_MAP = {
            'identity.name': 'identifier', 'identity.description': 'text',
            'identity.citation': 'text', 'identity.year': 'numeric',
            'identity.code': 'url', 'meta.maintainer': 'text',
        }
        for col, role in column_roles.items():
            columns_config[col] = {
                'role': role,
                'facet': _FACET_MAP.get(role, 'categorical'),
            }
        branding = {
            'productName': 'Grasp Explorer',
            'productShort': 'grasp planning methods',
            'productSubject': 'grasp planning',
            'ecosystem': 'COMPARE Ecosystem',
            'tagline': 'AI-in-the-Loop',
            'queryHint': 'Ask about grasp planning methods, e.g., "methods for cluttered scenes with multi-finger grippers"',
            'methodNoun': 'method',
        }
        return cls(
            domain_name='grasp_planning',
            csv_path=DEFAULT_CSV,
            papers_dir=DEFAULT_PAPERS_SRC,
            weights=DEFAULT_WEIGHTS,
            short_names=SHORT_COLUMN_NAMES,
            derived_columns=DERIVED_COLUMNS,
            priority_dims=priority_dims,
            display_name='Grasp Explorer',
            method_noun='method',
            column_roles=column_roles,
            columns_config=columns_config,
            branding=branding,
        )
