"""Map CSV method names to paper IDs (PDF filenames).

Builds a bidirectional mapping so:
  - method_to_paper["Contact-GraspNet"] → "contact-graspnet"
  - paper_to_methods["contact-graspnet"] → ["Contact-GraspNet"]
"""

import os
import re
import pandas as pd


def _slugify(name: str) -> str:
    """Convert a method name to a slug for matching against PDF filenames."""
    name = name.replace('🤖 ', '').strip()
    slug = name.lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug


def build_method_paper_map(csv_path: str, papers_dir: str) -> dict:
    """Build method ↔ paper mapping.

    Returns dict with:
        method_to_paper: {method_name: paper_id}
        paper_to_methods: {paper_id: [method_names]}
        unmatched_methods: [method_names with no paper]
        unmatched_papers: [paper_ids with no method]
    """
    df = pd.read_csv(csv_path)
    paper_ids = [f.replace('.pdf', '').replace('_', '-').lower() for f in sorted(os.listdir(papers_dir)) if f.endswith('.pdf')]

    method_to_paper = {}
    paper_to_methods = {pid: [] for pid in paper_ids}

    # Manual overrides for tricky names
    MANUAL_MAP = {
        'Grasp detection via Implicit Geometry and Affordance (GIGA)': 'grasp-detection-via-implicit-geometry-and-affordance-giga',
        'Grasp Pose Detection (GPD)': 'grasp-pose-detection-gpd',
        'Goal-Auxiliary Deep Deterministic Policy Gradient (GA-DDPG)': 'goal-auxiliary-deep-deterministic-policy-gradient-ga-ddpg',
        'REgion-based Grasp Network (REGNet)': 'region-based-grasp-network-regnet',
        'Single-Shot SE(3) Grasp Detection (S4G)': 'single-shot-se-3-grasp-detection-s4g',
        'Volumetric Grasping Network (VGN)': 'volumetric-grasping-network-vgn',
        'Robust Grasp Planning Over Uncertain Shape Completions': 'robust-grasp-planning-over-uncertain-shape-completions',
        # Probablistic Multi-fingered Grasp Planner: previously had no PDF, now
        # ingested from Lu et al. 2020 (Probabilistic Inference variant). Slug
        # match works once the PDF is in papers/, so we drop the override.
        'UniGrasp': None,
    }

    for _, row in df.iterrows():
        name = str(row['Name']).replace('🤖 ', '').strip()

        # Check manual map first
        if name in MANUAL_MAP:
            pid = MANUAL_MAP[name]
            if pid:
                method_to_paper[name] = pid
                paper_to_methods[pid].append(name)
            continue

        # Try exact slug match
        slug = _slugify(name)
        if slug in paper_ids:
            method_to_paper[name] = slug
            paper_to_methods[slug].append(name)
            continue

        # Try partial match: paper_id contains method slug or vice versa
        matched = False
        for pid in paper_ids:
            name_words = set(re.findall(r'[a-z]+', slug))
            pid_words = set(re.findall(r'[a-z]+', pid))
            common = name_words & pid_words
            long_common = [w for w in common if len(w) > 3]
            if len(common) >= 2 or long_common:
                method_to_paper[name] = pid
                paper_to_methods[pid].append(name)
                matched = True
                break
        # Not matched — no paper for this method

    unmatched_methods = [str(row['Name']).replace('🤖 ', '').strip()
                         for _, row in df.iterrows()
                         if str(row['Name']).replace('🤖 ', '').strip() not in method_to_paper]
    unmatched_papers = [pid for pid, methods in paper_to_methods.items() if not methods]

    return {
        'method_to_paper': method_to_paper,
        'paper_to_methods': paper_to_methods,
        'unmatched_methods': unmatched_methods,
        'unmatched_papers': unmatched_papers,
    }
