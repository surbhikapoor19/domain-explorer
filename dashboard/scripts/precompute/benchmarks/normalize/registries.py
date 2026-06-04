import json, os

def load_config(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), '..', 'config', 'grasp_planning.json')
    with open(path) as f:
        return json.load(f)

import re
from dataclasses import dataclass
from typing import Optional

def _norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[()%]', ' ', (s or '').lower())).strip()

@dataclass
class MetricHit:
    id: Optional[str]; unit: Optional[str]; higher_is_better: Optional[bool]; type: str; raw: str

class MetricRegistry:
    def __init__(self, cfg):
        self._by_alias = {}
        self._meta = {}
        for m in cfg['metrics']:
            self._meta[m['id']] = m
            for a in [m['id']] + m.get('aliases', []):
                self._by_alias[_norm(a)] = m['id']

    def resolve(self, raw):
        n = _norm(raw)
        mid = self._by_alias.get(n)
        if mid is None:
            best = None
            for alias, cand in self._by_alias.items():
                if len(alias) >= 4 and alias in n:
                    if best is None or len(alias) > best[0]:
                        best = (len(alias), cand)
            mid = best[1] if best else None
        if mid is None:
            return MetricHit(None, None, None, 'unknown', raw)
        m = self._meta[mid]
        return MetricHit(mid, m.get('unit'), m.get('higher_is_better'), m.get('type', 'unknown'), raw)

class ConditionRegistry:
    def __init__(self, cfg):
        self._by_alias = {}
        for c in cfg.get('conditions', []):
            for a in [c['id']] + c.get('aliases', []):
                self._by_alias[_norm(a)] = c['id']

    def resolve(self, raw):
        n = _norm(raw)
        if n in self._by_alias:
            return self._by_alias[n]
        for alias, cid in self._by_alias.items():
            if len(alias) >= 4 and alias in n:
                return cid
        return None

@dataclass
class MethodHit:
    method_id: Optional[str]; confidence: str; raw: str

class MethodResolver:
    """Confidence-scored: exact/alias -> high, fuzzy-contains -> medium, none -> low (kept, flagged)."""
    def __init__(self, method_names, alias_seeds=None):
        self._exact = {_norm(m): m for m in method_names}
        self._alias = {_norm(k): v for k, v in (alias_seeds or {}).items()}

    def resolve(self, raw):
        n = _norm(raw)
        if n in self._exact:
            return MethodHit(self._exact[n], 'high', raw)
        if n in self._alias:
            return MethodHit(self._alias[n], 'high', raw)
        for key, full in self._exact.items():
            if len(key) >= 5 and (key in n or n in key):
                return MethodHit(full, 'medium', raw)
        return MethodHit(None, 'low', raw)
