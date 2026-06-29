"""Protocol parsing — the #1 protocol-aware cell-keying core.

A grasp-benchmark number is only comparable to another under the SAME
experimental protocol. Leaderboards previously POOLED incomparable protocols
(simulation + real-world, fixed vs random camera view, gamma vs Gaussian depth
noise, in- vs out-of-distribution object sets) into one ranked column. The
protocol is STATED in each source's column header (``metric_raw``) and its table
caption, so we parse it from those two fields and fold it into the cell's
``condition`` token list — which is what the whole benchmark pipeline (cell
keying, cross-validation, head-to-head, coverage) already keys on. Folding
protocol into ``condition`` makes every downstream surface protocol-aware at once.

Honesty rules:
  - An axis we CANNOT determine from the text emits NO token. It therefore groups
    only with other sources that are also unknown on that axis; it is never
    assumed and never merged into a known protocol.
  - Tokens are APPENDED to the existing condition (scene/criterion) in a fixed
    canonical order, so two sources under the same setup always produce the same
    condition string, and a source with no protocol signal does not churn.
"""

import re

# Canonical axis order -> deterministic condition keys.
PROTOCOL_AXIS_ORDER = ['sim_real', 'view', 'noise', 'object_set', 'retrain']

# axis-value label -> the short token folded into the condition string. The
# frontend's parseConditionFacets decodes these same tokens into named facets.
_LABEL_TOKEN = {
    'sim': 'sim', 'real': 'real',
    'fixed_view': 'fixedview', 'random_view': 'randomview',
    'gamma_noise': 'gammanoise', 'gauss_noise': 'gaussnoise',
    'egad': 'egad', 'ycb': 'ycb', 'partnet': 'partnet',
    'no_retrain': 'noretrain',
}

# Ordered (label, pattern) lists per axis. First match wins, so put the more
# specific / higher-signal pattern first.
_AXIS_PATTERNS = {
    'sim_real': [
        ('real', r'real[\s-]?world|in the real world|real[\s-]?robot|'
                 r'physical (?:robot|experiment)|real world experiment'),
        ('sim',  r'simulat\w+|\bin simulation\b|pybullet|isaac'),
    ],
    'view': [
        ('fixed_view',  r'fixed[\s-]?(?:camera|view|pose)'),
        ('random_view', r'random[\s-]?(?:camera|view\s?point|view|pose)'),
    ],
    'noise': [
        ('gamma_noise', r'gamma[\s-]?noise'),
        ('gauss_noise', r'gaussian[\s-]?noise|\bgauss\w*'),
    ],
    'object_set': [
        ('egad',    r'\begad\b'),
        ('ycb',     r'\bycb\b'),
        ('partnet', r'\bpartnet\b'),
    ],
    'retrain': [
        ('no_retrain', r'not\s+(?:be\s+)?re-?trained|without re-?training|'
                       r'directly (?:tested|evaluated|applied)|zero-?shot'),
    ],
}


def _first_match(patterns, text):
    for label, pat in patterns:
        if re.search(pat, text, re.I):
            return label
    return None


def parse_protocol(metric_raw, table_caption):
    """Parse the experimental protocol from the column header + table caption.

    Returns ``{sim_real, view, noise, object_set, retrain}`` where each value is a
    canonical label string or ``None`` (undeterminable -> stays unknown, never
    assumed)."""
    blob = f"{metric_raw or ''} || {table_caption or ''}"
    return {axis: _first_match(pats, blob) for axis, pats in _AXIS_PATTERNS.items()}


def protocol_tokens(protocol):
    """Ordered condition tokens for a parsed protocol dict (skips unknown axes)."""
    toks = []
    for axis in PROTOCOL_AXIS_ORDER:
        label = (protocol or {}).get(axis)
        if label and label in _LABEL_TOKEN:
            toks.append(_LABEL_TOKEN[label])
    return toks


def append_protocol(condition, tokens):
    """Append protocol tokens to an existing condition string (set-union; existing
    tokens and their order are preserved). Returns None for an empty result."""
    existing = [t for t in (condition or '').split(':') if t]
    for t in tokens:
        if t not in existing:
            existing.append(t)
    return ':'.join(existing) or None


def enrich_condition(condition, metric_raw, table_caption):
    """Convenience: condition with the parsed protocol folded in."""
    return append_protocol(condition, protocol_tokens(parse_protocol(metric_raw, table_caption)))


# ── #3 caption-based copied-baseline detection ───────────────────────────────
# A re-quoted baseline number (copied from another paper) is NOT independent
# corroboration. The admission lives in the caption. We detect three modes:
#   'except'    "...results except A and B are from [20]..."  -> all but A,B copied
#   'all'       "...the results are from [9]."                -> every row copied
#   'ambiguous' "'*' denotes the results are from [2]..."     -> per-row marker,
#               stripped at extraction so we cannot attribute -> flag NOTHING here
#               (the byte-identical value+stddev detector still catches real copies)
#   None        a plain benchmark/dataset citation like "[5]" is NOT a copy

# A copy-admission phrase: results/numbers/values "are from", "taken from",
# "reported in/by", etc. A bare citation bracket alone never matches.
_COPY_PHRASE = re.compile(
    r'\bresults?\b[^.]{0,90}?\bare\s+from\b'
    r'|\b(?:taken|obtained|adopted|quoted|reproduced|copied|borrowed)\s+from\b'
    r'|\breported\s+(?:in|by)\b'
    r'|\bresults?\b[^.]{0,50}?\bfrom\s*\[\d+\]',
    re.I)

_EXCEPT_CLAUSE = re.compile(r'except\s+(.+?)\s+(?:are|is|were|was)\s+from', re.I)


def caption_copy_status(caption):
    """Return (mode, names) where mode in {None, 'all', 'except', 'ambiguous'} and
    names is a tuple of excepted method names for the 'except' mode (else None)."""
    c = caption or ''
    if not _COPY_PHRASE.search(c):
        return (None, None)
    m = _EXCEPT_CLAUSE.search(c)
    if m:
        raw = m.group(1)
        names = tuple(n.strip() for n in re.split(r'\s+and\s+|,', raw) if n.strip())
        return ('except', names)
    if '*' in c:                       # per-row marker, stripped at extraction
        return ('ambiguous', None)
    return ('all', None)


def _name_tokens(name):
    return set(re.findall(r'[a-z0-9]+', (name or '').lower()))


def _name_matches(method_id, excepted):
    """True when method_id refers to the excepted (own) method. Token/exact match
    only — substring is rejected so 'GIGA' is NOT exempted by 'EquiGIGA'."""
    m_flat = re.sub(r'[^a-z0-9]', '', (method_id or '').lower())
    e_flat = re.sub(r'[^a-z0-9]', '', (excepted or '').lower())
    if not m_flat or not e_flat:
        return False
    if m_flat == e_flat:
        return True
    return e_flat in _name_tokens(method_id) or m_flat in _name_tokens(excepted)


def is_caption_copied(method_id, caption):
    """True when THIS method's number in this table is a copied baseline per the
    caption. Conservative: the ambiguous '*' case attributes to nobody here."""
    mode, names = caption_copy_status(caption)
    if mode == 'all':
        return True
    if mode == 'except':
        return not any(_name_matches(method_id, n) for n in (names or ()))
    return False
