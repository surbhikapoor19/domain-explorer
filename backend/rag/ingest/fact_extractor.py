"""Structured fact extraction from chunks.

Extracts:
  - Reported metrics (success rates, accuracy, etc.) with values
  - Architecture components (backbone, loss function, optimizer)
  - Equations and formulas (LaTeX or inline math)
  - Dataset and benchmark references
  - Hardware/gripper mentions with specs

Each fact is a dict with type, value, context (surrounding sentence), and source chunk_id.
"""

import re
from dataclasses import dataclass, field


# ─── Metric extraction ───

METRIC_PATTERNS = [
    # "success rate of 92.3%", "93% success rate", "accuracy of 0.87"
    re.compile(r'(?:success\s+rate|accuracy|precision|recall|F1|mAP|AP|IoU|mIoU|AUC)[\s:=]*(?:of\s+)?(\d+\.?\d*)\s*%', re.IGNORECASE),
    re.compile(r'(\d+\.?\d*)\s*%\s*(?:success\s+rate|accuracy|grasp\s+success|completion)', re.IGNORECASE),
    # "achieves 0.92 on ...", "reaches 94.5%"
    re.compile(r'(?:achieve[sd]?|reach(?:es|ed)?|obtain[sed]*|report[sed]*)\s+(?:a\s+)?(\d+\.?\d*)\s*%', re.IGNORECASE),
    re.compile(r'(?:achieve[sd]?|reach(?:es|ed)?)\s+(?:a\s+)?(?:success\s+rate\s+of\s+)?(\d+\.?\d*)', re.IGNORECASE),
]

METRIC_CONTEXT_RE = re.compile(
    r'[^.]*(?:success\s+rate|accuracy|precision|recall|performance|result|achieve|benchmark|evaluation)[^.]*\.',
    re.IGNORECASE
)


def extract_metrics(text: str) -> list:
    """Extract reported metric values with context."""
    metrics = []
    for pattern in METRIC_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(1)
            start = max(0, match.start() - 100)
            end = min(len(text), match.end() + 100)
            context = text[start:end].strip()
            # Clean context to nearest sentence boundaries
            if '.' in context:
                sentences = context.split('.')
                relevant = [s for s in sentences if value in s]
                context = '. '.join(relevant).strip() if relevant else context
            metrics.append({
                'type': 'metric',
                'value': value,
                'unit': '%' if '%' in text[match.start():match.end()+5] else '',
                'context': context[:200],
            })
    # Deduplicate by value
    seen = set()
    unique = []
    for m in metrics:
        if m['value'] not in seen:
            seen.add(m['value'])
            unique.append(m)
    return unique


# ─── Architecture extraction ───

ARCHITECTURE_PATTERNS = {
    'backbone': re.compile(
        r'\b(PointNet\+?\+?|ResNet-?\d*|VGG-?\d*|ViT|DINOv?\d?|CLIP|'
        r'transformer|U-Net|EfficientNet|MobileNet|Equiformer(?:V2)?|'
        r'convolutional|fully.connected|GCN|GAT|graph.neural)\b',
        re.IGNORECASE
    ),
    'loss_function': re.compile(
        r'\b(cross.entropy|binary.cross.entropy|MSE|L[12]\s+loss|'
        r'focal.loss|contrastive.loss|triplet.loss|InfoNCE|'
        r'reconstruction.loss|KL.divergence|adversarial.loss|'
        r'BCE|huber.loss)\b',
        re.IGNORECASE
    ),
    'optimizer': re.compile(
        r'\b(Adam(?:W)?|SGD|RMSprop|AdaGrad|LAMB|learning.rate\s*(?:of\s*)?\d+\.?\d*(?:e-?\d+)?)\b',
        re.IGNORECASE
    ),
    'training_size': re.compile(
        r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:K|M|million|thousand)?\s*(?:grasp|training|sample|example|scene|object)',
        re.IGNORECASE
    ),
}


def extract_architecture(text: str) -> list:
    """Extract architecture components mentioned in text."""
    facts = []
    for fact_type, pattern in ARCHITECTURE_PATTERNS.items():
        for match in pattern.finditer(text):
            value = match.group(0).strip()
            start = max(0, match.start() - 80)
            end = min(len(text), match.end() + 80)
            context = text[start:end].strip()
            facts.append({
                'type': fact_type,
                'value': value,
                'context': context[:200],
            })
    # Deduplicate
    seen = set()
    unique = []
    for f in facts:
        key = f'{f["type"]}:{f["value"].lower()}'
        if key not in seen:
            seen.add(key)
            unique.append(f)
    return unique


# ─── Equation extraction ───

EQUATION_PATTERNS = [
    # LaTeX block equations (highest quality)
    re.compile(r'\\begin\{(?:equation|align|gather)\*?\}(.+?)\\end\{(?:equation|align|gather)\*?\}', re.DOTALL),
    # Inline LaTeX: $...$
    re.compile(r'\$([^$]{5,80})\$'),
    # Named loss/objective definitions: L = ..., L_grasp = ..., J(θ) = ...
    re.compile(r'(?:^|\s)((?:L|J|E|R|V|Q)\s*(?:[_]\w+)?\s*(?:\([^)]*\))?\s*=\s*[^,.\n]{8,80})', re.MULTILINE),
]


def _is_valid_equation(eq: str) -> bool:
    """Filter out text that was mistakenly matched as an equation."""
    eq = eq.strip()
    if len(eq) < 5 or len(eq) > 300:
        return False
    # Must have at least one math operator or symbol
    math_chars = sum(1 for c in eq if c in '=+-*/^_{}\\∑∫∂∇αβγδεζηθλμνξπρστφχψω')
    if math_chars < 1:
        return False
    # Reject if it's mostly regular words (natural language, not math)
    words = eq.split()
    if len(words) > 3:
        alpha_words = sum(1 for w in words if w.isalpha() and len(w) > 3)
        if alpha_words / len(words) > 0.6:
            return False
    # Reject concatenated text (e.g., "mingbaselineEdgeGraspNet")
    if re.search(r'[a-z]{3}[A-Z][a-z]{3}', eq):
        return False
    # Reject if it contains reference patterns like [26] or Table V
    if re.search(r'\[\d+\]|Table\s+[IVX]+', eq):
        return False
    return True


def extract_equations(text: str) -> list:
    """Extract mathematical equations and formulas."""
    equations = []
    for pattern in EQUATION_PATTERNS:
        for match in pattern.finditer(text):
            eq = match.group(1) if match.lastindex else match.group(0)
            eq = eq.strip()
            if not _is_valid_equation(eq):
                continue
            start = max(0, match.start() - 60)
            context = text[start:match.start()].strip().split('.')[-1].strip()
            equations.append({
                'type': 'equation',
                'value': eq[:200],
                'context': context[:100] if context else '',
            })
    # Deduplicate
    seen = set()
    unique = []
    for e in equations:
        key = e['value']
        if key not in seen:
            seen.add(key)
            unique.append(e)
    return unique[:5]  # Cap at 5 per chunk


# ─── Dataset/benchmark extraction ───

_COMMON_DATASETS = (
    'YCB|ShapeNet|Isaac\\s*(?:Gym|Sim)|MuJoCo|PyBullet|'
    'Gazebo|CoppeliaSim|SAPIEN|Open3D|MoveIt|ROS|'
    'Panda|UR5|Franka|KUKA|'
    'GraspNet-1Billion|ACRONYM|ContactDB|BigBIRD|KIT|Cornell|'
    'Jacquard|EGAD|DexGraspNet|MultiDex|'
    'MotionBenchMaker|RoboBench|OMPL'
)

DATASET_RE = re.compile(
    r'\b(' + _COMMON_DATASETS + r')\b',
    re.IGNORECASE
)


def set_extra_datasets(patterns):
    """Extend DATASET_RE with domain-specific dataset names at runtime."""
    global DATASET_RE
    if not patterns:
        return
    extra = '|'.join(re.escape(p) for p in patterns)
    DATASET_RE = re.compile(
        r'\b(' + _COMMON_DATASETS + '|' + extra + r')\b',
        re.IGNORECASE
    )


def extract_datasets(text: str) -> list:
    """Extract dataset and benchmark references."""
    datasets = []
    seen = set()
    for match in DATASET_RE.finditer(text):
        value = match.group(0).strip()
        if value.lower() not in seen:
            seen.add(value.lower())
            start = max(0, match.start() - 60)
            end = min(len(text), match.end() + 60)
            datasets.append({
                'type': 'dataset',
                'value': value,
                'context': text[start:end].strip()[:200],
            })
    return datasets


# ─── Main extraction function ───

def extract_facts(text: str, chunk_id: str = '', paper_id: str = '') -> list:
    """Run all extractors on a chunk and return structured facts."""
    facts = []
    for fact in extract_metrics(text):
        fact['chunk_id'] = chunk_id
        fact['paper_id'] = paper_id
        facts.append(fact)
    for fact in extract_architecture(text):
        fact['chunk_id'] = chunk_id
        fact['paper_id'] = paper_id
        facts.append(fact)
    for fact in extract_equations(text):
        fact['chunk_id'] = chunk_id
        fact['paper_id'] = paper_id
        facts.append(fact)
    for fact in extract_datasets(text):
        fact['chunk_id'] = chunk_id
        fact['paper_id'] = paper_id
        facts.append(fact)
    return facts
