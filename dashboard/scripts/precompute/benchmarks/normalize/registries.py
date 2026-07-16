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
    s = (s or '').lower()
    s = re.sub(r'\[[\d,\s\-]+\]', ' ', s)            # citation refs: [12], [1, 2]
    s = re.sub(r'\(\s*n\s*=\s*\d+\s*\)', ' ', s)     # (N=1) qualifiers
    s = re.sub(r'[*†‡✓✗]', ' ', s)  # markers: * † ‡ ✓ ✗
    s = re.sub(r'[()%]', ' ', s)                     # paren chars (keep inner tokens), percent
    s = re.sub(r'[\-_/]', ' ', s)                    # unify separators - _ /
    s = re.sub(r'\bbaselines?\b', ' ', s)            # drop trailing 'baseline(s)'
    s = re.sub(r'\s+', ' ', s).strip()
    return s

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
        # Explicit unit token in the RAW string wins over the metric's default
        # unit (e.g. a timing metric printed in seconds must not be tagged 'ms').
        # Only override when a token is clearly present; else keep the default.
        unit = m.get('unit')
        rl = raw.lower()
        if re.search(r'\(ms\)|\bms\b', rl):
            unit = 'ms'
        elif re.search(r'\(s\)|\bs\b|\(sec\)|\bseconds?\b', rl):
            unit = 's'
        elif re.search(r'\(fps\)|\bfps\b', rl):
            unit = 'fps'
        return MetricHit(mid, unit, m.get('higher_is_better'), m.get('type', 'unknown'), raw)

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
    """exact/alias -> high; separator-insensitive exact (>=5 chars) -> high;
    fuzzy-contains -> medium; none -> low (kept, flagged)."""
    def __init__(self, method_names, alias_seeds=None):
        self._exact = {_norm(m): m for m in method_names}
        self._alias = {_norm(k): v for k, v in (alias_seeds or {}).items()}
        self._exact_ns = {k.replace(' ', ''): v for k, v in self._exact.items()
                          if len(k.replace(' ', '')) >= 5}
        self._alias_ns = {k.replace(' ', ''): v for k, v in self._alias.items()
                          if len(k.replace(' ', '')) >= 5}

    def resolve(self, raw):
        n = _norm(raw)
        # A cell that normalizes to NOTHING (citation refs, "baselines", "(n=5)",
        # markers like ✓/*†, bare whitespace) must NEVER crown a method. The fuzzy
        # `n in key` branch below treats '' as a substring of every name, so an
        # empty n would silently attribute junk cells to the first-listed method
        # at medium confidence — injecting foreign values into a real leaderboard.
        if not n:
            return MethodHit(None, 'low', raw)
        if n in self._exact:
            return MethodHit(self._exact[n], 'high', raw)
        if n in self._alias:
            return MethodHit(self._alias[n], 'high', raw)
        ns = n.replace(' ', '')
        if len(ns) >= 5:
            if ns in self._exact_ns:
                return MethodHit(self._exact_ns[ns], 'high', raw)
            if ns in self._alias_ns:
                return MethodHit(self._alias_ns[ns], 'high', raw)
        # A candidate with no alphabetic character (bare index numbers like "1"/"42",
        # config tuples) must never fuzzy-match a real method — it silently steals
        # another row's values. Exact/alias/no-space matches above already handle every
        # legitimate short name (e.g. "S4G", "GPD"), so this only gates the fuzzy branch.
        if not re.search(r'[a-z]', n):
            return MethodHit(None, 'low', raw)
        # Conservative fuzzy-contains: never let a short cell fragment steal a
        # longer method's identity. Only attempt a fuzzy match when the candidate
        # itself is substantial (>=5 chars), which kills 3-char fragments ("reg").
        # Direction A: a full method name (>=5 chars) sitting inside a longer
        # descriptive cell (e.g. "NeuGraspNet (ours)") -> medium.
        for key, full in self._exact.items():
            if len(key) >= 5 and key in n:
                return MethodHit(full, 'medium', raw)
        # Direction B: candidate == a whole, space-delimited token of EXACTLY
        # ONE method name (unique acronym/name token: vgn/gpd/giga/orbitgrasp).
        # A substring of a token (reg in region/regnet, point in pointnetgpd)
        # or a token shared by multiple methods (grasp) must NOT match.
        owners = {full for key, full in self._exact.items() if n in key.split()}
        if len(owners) == 1:
            return MethodHit(next(iter(owners)), 'medium', raw)
        return MethodHit(None, 'low', raw)
