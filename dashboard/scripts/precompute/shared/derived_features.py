"""Derive domain-specific computed columns from raw CSV columns.

For grasp planning: Grasp Dimensionality, Learning Paradigm, etc.
For other domains: skipped (no derived columns defined).
"""
import pandas as pd

from .config import DERIVED_COLUMNS
from .csv_utils import smart_split


def _safe_str(df, i, col):
    if col not in df.columns:
        return ''
    v = df.at[i, col]
    return str(v) if pd.notna(v) else ''


def _compute_grasp_derived(df):
    n = len(df)
    result = {col: [''] * n for col in DERIVED_COLUMNS}
    for i in range(n):
        output = _safe_str(df, i, 'Output Pose')
        if '6-DoF' in output: result['Grasp Dimensionality'][i] = '6-DoF'
        elif '7-DoF' in output: result['Grasp Dimensionality'][i] = '7-DoF'
        elif '2D grasp' in output: result['Grasp Dimensionality'][i] = '2D'
        elif 'Grasp policy' in output: result['Grasp Dimensionality'][i] = 'Policy'
        elif 'Grasp success' in output: result['Grasp Dimensionality'][i] = 'Evaluation'
        else: result['Grasp Dimensionality'][i] = 'Other'

        method = _safe_str(df, i, 'Planning Method')
        training = _safe_str(df, i, 'Training Data')
        method_parts = [p.strip() for p in method.split(',')]
        if training == 'Training-less':
            result['Learning Paradigm'][i] = 'Classical'
        elif all(p in ('Analytical', 'Sampling', 'Optimization') for p in method_parts):
            result['Learning Paradigm'][i] = 'Classical'
        elif any('Reinforcement' in p for p in method_parts):
            result['Learning Paradigm'][i] = 'RL-based'
        elif any(p in ('Direct regression', 'Generative') for p in method_parts):
            result['Learning Paradigm'][i] = 'Learning-based'
        else:
            result['Learning Paradigm'][i] = 'Hybrid'

        input_data = _safe_str(df, i, 'Input Data')
        input_parts = smart_split(input_data)
        input_lower = input_data.lower()
        if 'natural language' in input_lower or len(input_parts) > 1:
            result['Sensor Complexity'][i] = 'Multimodal'
        elif any(k in input_lower for k in ('point cloud', 'tsdf', '3d', 'mesh', 'voxel')):
            result['Sensor Complexity'][i] = '3D'
        elif 'rgbd' in input_lower:
            result['Sensor Complexity'][i] = '2.5D'
        elif any(k in input_lower for k in ('rgb', 'depth')):
            result['Sensor Complexity'][i] = '2D'
        else:
            result['Sensor Complexity'][i] = 'Other'

        obj_config = _safe_str(df, i, 'Object Configuration')
        difficulty_map = {'Singulated': 1, 'Structured': 2, 'Cluttered': 3, 'Packed': 4, 'Piled': 5, 'Stacked': 5}
        label_map = {1: 'Singulated', 2: 'Structured', 3: 'Cluttered', 4: 'Packed', 5: 'Piled'}
        parts = smart_split(obj_config)
        max_diff = max((difficulty_map.get(p, 0) for p in parts), default=0)
        result['Scene Difficulty'][i] = label_map.get(max_diff, 'Unknown')

        hardware = _safe_str(df, i, 'End-effector Hardware')
        hw_parts = smart_split(hardware)
        if len(hw_parts) > 1: result['Gripper Type'][i] = 'Multi-gripper'
        elif any(k in hardware for k in ('Multi-finger', 'Three-finger')): result['Gripper Type'][i] = 'Dexterous'
        elif 'Suction' in hardware: result['Gripper Type'][i] = 'Suction'
        elif 'Two-finger' in hardware: result['Gripper Type'][i] = 'Parallel-jaw'
        else: result['Gripper Type'][i] = 'Unknown'

        lang = _safe_str(df, i, 'Language')
        if 'PyTorch' in lang: result['ML Framework'][i] = 'PyTorch'
        elif 'TensorFlow' in lang: result['ML Framework'][i] = 'TensorFlow'
        elif 'Keras' in lang: result['ML Framework'][i] = 'Keras'
        else: result['ML Framework'][i] = 'None'

        year_val = df.at[i, 'Year (Initial Release)'] if 'Year (Initial Release)' in df.columns else None
        if pd.notna(year_val) if year_val is not None else False:
            year = int(year_val)
            if year <= 2018: result['Method Era'][i] = 'Pioneer (2016-2018)'
            elif year <= 2021: result['Method Era'][i] = 'Growth (2019-2021)'
            else: result['Method Era'][i] = 'Modern (2022+)'
        else:
            result['Method Era'][i] = 'Unknown'
    return result


def compute_derived_features(df, domain_config=None):
    if domain_config is not None:
        if not domain_config.derived_columns:
            return {}
        if domain_config.domain == 'grasp_planning':
            return _compute_grasp_derived(df)
        return {}
    return _compute_grasp_derived(df)
