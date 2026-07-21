"""Pure, importable helpers for the sheet-poll new-vs-edited decision.

Extracted from .github/workflows/sheet-poll.yml so the trigger logic is
unit-testable (inline YAML heredoc Python is not). Given the old (committed)
and new (freshly fetched) CSV text for a domain, decide whether the change is a
NEW/REMOVED paper -- a row was added or removed by identity name, which needs a
full 'new-paper' rebuild (fetch PDF + full pipeline + benchmark, or prune a
removed paper) -- or an edit-only change (descriptions etc.), which only needs a
cheap CSV-only 'precompute' refresh.

The identity-name column is resolved from the domain YAML (role ==
identity.name, e.g. "Name"), with a fallback to the committed header's first
column. The '🤖 ' auto-prefix is stripped so a '🤖 '-prefixed rename is not
mistaken for a new paper (mirrors slugify's emoji normalization).
"""
import csv
import io

# Google-Sheet auto-suggest prefix stamped onto AI-proposed rows. Stripped
# before diffing so it never registers as a new/removed paper (mirrors slugify).
EMOJI_PREFIX = '🤖 '


def name_col_from_config(cfg):
    """Column name whose role is identity.name (e.g. 'Name'), else None.

    `cfg` is a parsed domain YAML dict. The first column mapped to
    role == 'identity.name' wins; alias columns are irrelevant because only the
    identity.name role is matched.
    """
    cols = (cfg or {}).get('columns') or {}
    for col, meta in cols.items():
        if isinstance(meta, dict) and meta.get('role') == 'identity.name':
            return col
    return None


def _col_index(header, name_col, first_col_fallback):
    """Index of the identity-name column in `header`.

    Prefer name_col (from the domain YAML); fall back to the committed header's
    first column; finally to column 0. Returns None for an empty header.
    """
    if not header:
        return None
    for cand in (name_col, first_col_fallback):
        if cand and cand in header:
            return header.index(cand)
    return 0


def name_set(csv_text, name_col, first_col_fallback=None):
    """Set of normalized method names in `csv_text`'s identity-name column.

    The '🤖 ' auto-prefix is stripped and values are whitespace-trimmed; empty
    cells are ignored. Malformed / empty input yields an empty set.
    """
    try:
        rows = list(csv.reader(io.StringIO(csv_text or '')))
    except Exception:
        return set()
    if not rows:
        return set()
    ni = _col_index(rows[0], name_col, first_col_fallback)
    if ni is None:
        return set()
    names = set()
    for r in rows[1:]:
        if len(r) > ni:
            v = r[ni].replace(EMOJI_PREFIX, '').strip()
            if v:
                names.add(v)
    return names


def classify(old_csv_text, new_csv_text, name_col, first_col_fallback=None):
    """Classify a CSV change as 'new-paper' or 'precompute'.

    Returns ``{'kind', 'added', 'removed'}`` where `added`/`removed` are sorted
    lists of identity names. A row added OR removed is a 'new-paper' build
    (fetch + full pipeline + benchmark, or prune a removed paper); anything else
    (edits to existing rows) is a cheap 'precompute' refresh.
    """
    old_names = name_set(old_csv_text, name_col, first_col_fallback)
    new_names = name_set(new_csv_text, name_col, first_col_fallback)
    added = sorted(new_names - old_names)
    removed = sorted(old_names - new_names)
    kind = 'new-paper' if (added or removed) else 'precompute'
    return {'kind': kind, 'added': added, 'removed': removed}
