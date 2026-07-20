"""Per-PDF extraction memoization cache (Track b).

One JSON file per domain, keyed by (paper_id, sha256(pdf), salt). run_docling
consults it per paper so an unchanged PDF skips the expensive Docling pass, while
result-records.json is still ALWAYS fully regenerated from cache-hits + fresh
extractions (every downstream consumer stays untouched).

Schema:
    {"cache_format": 1,
     "papers": {"<paper_id>": {"pdf_sha256": "<64hex>", "salt": "<16hex>",
         "extracted_at": "<iso>", "n_records": 12, "records": [ {ResultRecord.__dict__} ]}}}

records == [] is a VALID hit ("extracted, no benchmark tables"): presence in
`papers` means done, not a positive record count. The salt is stored PER entry so
a salt change invalidates entries individually.

Pure stdlib; no docling import at module level (imported lazily inside compute_salt
only, and tolerant of docling being absent).
"""
import hashlib
import json
import os
from datetime import datetime, timezone

CACHE_FORMAT = 1

# Extraction-logic modules whose bytes define the "code version" folded into the
# salt: editing any of them invalidates every cached entry (-> full re-extract).
# Absolute paths derived from this file; any that don't exist are skipped. The
# methods CSV is DELIBERATELY excluded (see compute_salt) so a weekly CSV edit
# doesn't blow away the whole cache — method resolution is refreshed cheaply at
# load time instead (run_extraction._refresh_resolution).
_HERE = os.path.dirname(os.path.abspath(__file__))
SALT_SOURCE_FILES = [
    os.path.join(_HERE, 'run_extraction.py'),
    os.path.join(_HERE, 'docling_tables.py'),
    os.path.join(_HERE, 'tei_tables.py'),
    os.path.join(_HERE, 'vlm_extract.py'),
    os.path.join(_HERE, 'merge.py'),
    os.path.join(_HERE, 'locate.py'),
    os.path.join(_HERE, 'render.py'),
    os.path.join(_HERE, '..', 'types.py'),
    # Resolution/normalization code shapes record CONTENT (method_id, unit, metric
    # normalization), so a change here must invalidate the cache too.
    os.path.join(_HERE, '..', 'normalize', 'registries.py'),
    os.path.join(_HERE, '..', 'normalize', 'units.py'),
]


def sha256_file(path, chunk_size=1 << 20):
    """Streaming sha256 (hex) of a file's bytes."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(chunk_size), b''):
            h.update(chunk)
    return h.hexdigest()


def _source_digest():
    """sha256 (hex) over the concatenated bytes of the SALT_SOURCE_FILES that
    exist — an automatic version fingerprint of the extraction code."""
    h = hashlib.sha256()
    for p in SALT_SOURCE_FILES:
        if os.path.exists(p):
            with open(p, 'rb') as f:
                for chunk in iter(lambda: f.read(1 << 20), b''):
                    h.update(chunk)
    return h.hexdigest()


def compute_salt(cfg, *, engine="docling", vlm_enabled=False):
    """16-hex salt over cache_format + code-version + docling version + engine +
    vlm flag + the FULL parsed config dict. Any change -> a different salt ->
    a full re-extract; stable across dict key ordering (sort_keys)."""
    try:
        import docling
        docling_version = getattr(docling, '__version__', '') or ''
    except Exception:
        docling_version = ''
    payload = {
        "cache_format": CACHE_FORMAT,
        "source": _source_digest(),          # auto code-version
        "docling": docling_version,
        "engine": engine,
        "vlm": bool(vlm_enabled),            # born-digital vs VLM are different results
        "config": cfg,
    }
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def load_cache(path):
    """Return the cache dict, or {} on a missing / corrupt / wrong-cache_format
    file (with a printed warning for the last two). Never raises. A missing file
    is the normal first-run case, so it is returned silently."""
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"  [cache] WARNING: could not read {path} ({e}); starting empty")
        return {}
    if not isinstance(data, dict) or data.get('cache_format') != CACHE_FORMAT:
        print(f"  [cache] WARNING: {path} has an unexpected format; starting empty")
        return {}
    if not isinstance(data.get('papers'), dict):
        data['papers'] = {}
    return data


def save_cache(path, cache):
    """Atomically persist the cache: dump to path+'.tmp' then os.replace (so an
    interrupted write can never corrupt the committed artifact)."""
    cache.setdefault('cache_format', CACHE_FORMAT)
    cache.setdefault('papers', {})
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cache, f, indent=2, default=str)
    os.replace(tmp, path)


def get_hit(cache, paper_id, pdf_sha, salt):
    """None on a miss (absent id / changed pdf_sha / changed salt); the stored
    records list (possibly []) on a hit."""
    entry = (cache.get('papers') or {}).get(paper_id)
    if not entry:
        return None
    if entry.get('pdf_sha256') != pdf_sha or entry.get('salt') != salt:
        return None
    recs = entry.get('records')
    return recs if isinstance(recs, list) else []


def put_entry(cache, paper_id, pdf_sha, salt, records):
    """Insert/replace the entry for paper_id. records: list[ResultRecord] -> the
    same r.__dict__ dicts main() serializes to result-records.json."""
    dicts = [r.__dict__ for r in records]
    cache.setdefault('cache_format', CACHE_FORMAT)
    papers = cache.setdefault('papers', {})
    papers[paper_id] = {
        "pdf_sha256": pdf_sha,
        "salt": salt,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "n_records": len(dicts),
        "records": dicts,
    }


def prune_missing(cache, present_ids):
    """Drop cache entries whose paper_id is not in present_ids (their PDF is gone).
    Returns the list of pruned paper_ids."""
    papers = cache.get('papers') or {}
    pruned = [pid for pid in list(papers) if pid not in present_ids]
    for pid in pruned:
        del papers[pid]
    return pruned
