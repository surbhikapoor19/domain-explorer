"""Mine GROBID TEI tables for direction-typed `outperforms` edges.

Why this exists: the rest of the pipeline gives us 7 hand-curated
`outperforms` edges, which is far below the threshold needed to train an
HGT relation head. Benchmark tables in the corpus papers are the natural
positive set — every comparison table publishes "method X scored Y on
metric Z, method W scored less" with explicit direction. Parsing them
yields hundreds of typed edges with full provenance.

Strategy per table:
  1. Detect the header row(s) and identify which columns are numeric
     metrics. A column is treated as a metric if its header carries a
     direction marker (↑/↓ or "higher is better"/"lower is better"), or
     if at least 70% of body cells parse as floats.
  2. Detect the method-name column. Default: first column. Fall back to
     "any non-numeric column whose body cells look like proper names".
  3. For each metric column, parse body cells to floats, drop rows we
     can't parse, and emit `outperforms(winner_row_method, loser_row_method)`
     for every winner-loser pair (winner = best for ↑, lowest for ↓).
  4. Resolve method-name strings to KG node ids using the existing
     paper/method roster — fuzzy match on lowercase + alpha-only key.
     Names that don't resolve are logged but do not produce edges.

Output: a list of dicts with src_id, tgt_id, metric, table_caption,
paper_id (the parent paper), winner_value, loser_value, confidence
(based on margin), so downstream code can write the edges into the KG
with full provenance and the side-panel can show the supporting cell.
"""
import json
import logging
import os
import re
from collections import defaultdict

logger = logging.getLogger(__name__)

NS = {'tei': 'http://www.tei-c.org/ns/1.0'}

# Direction markers in benchmark tables.
HIGHER_BETTER = ['↑', 'higher', '(↑)', '(higher is better)', '(higher)']
LOWER_BETTER = ['↓', 'lower', '(↓)', '(lower is better)', '(lower)']

# Method-name strings inside tables that mean "this paper" rather than a
# named external method. Resolved to the parent paper id at extraction time.
SELF_REFERENCES = {'ours', 'our', 'our method', 'proposed', 'proposed method',
                   'the proposed method', 'this paper', 'this work'}

# Strip trailing citation markers like "[31]" or "(2021)" so the surface
# string can be linked to a node by name alone.
_CITE_RE = re.compile(r'\s*\[\d+\]|\s*\(\d{4}[a-z]?\)')

# Float parser that tolerates percentage signs, ± uncertainty, and stray
# footnote markers. Returns None if no valid float can be extracted.
_NUM_RE = re.compile(r'-?\d+(?:\.\d+)?')


def _normalize_name(s: str) -> str:
    """Lowercase + strip non-alphanumeric for fuzzy method-name matching."""
    if not s:
        return ''
    s = _CITE_RE.sub('', s).strip()
    return re.sub(r'[^a-z0-9]', '', s.lower())


def _parse_number(cell: str):
    """Parse '85.7%', '0.392 ± 0.01', '≈80' → 85.7, 0.392, 80.0. Returns None for '-' / blank."""
    if not cell or cell.strip() in {'-', '–', '—', 'N/A', 'n/a', '', '–'}:
        return None
    m = _NUM_RE.search(cell)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def _detect_direction(header_text: str):
    """Return 'up' / 'down' / None given a metric column header."""
    h = header_text.lower()
    if any(tok in h for tok in HIGHER_BETTER):
        return 'up'
    if any(tok in h for tok in LOWER_BETTER):
        return 'down'
    return None


_PAREN_ABBREV_RE = re.compile(r'\(([A-Z][A-Za-z0-9\-\.]+)\)')
_SELF_SUFFIX_RE = re.compile(r'\s*\(ours?\)$', re.IGNORECASE)


def _build_name_index(G):
    """Lowercase-alphanumeric → node_id, for paper + method nodes.

    Indexes three forms per node:
      1. Full label/name/title  (e.g. "volumetricgraspingnetworkvgn")
      2. Parenthetical acronyms (e.g. "vgn" from "Volumetric Grasping Network (VGN)")
      3. Paper slug            (e.g. "edgegraspnetwork" from "paper:edge-grasp-network")
    """
    idx = {}

    def _add(key, nid):
        if key and key not in idx:
            idx[key] = nid

    for node in G.nodes(data=True):
        nid, ndata = node
        ntype = ndata.get('type')
        if ntype not in {'paper', 'method'}:
            continue

        # Index from label/name/title fields
        for field in ('label', 'name', 'title'):
            val = ndata.get(field)
            if not isinstance(val, str) or not val:
                continue
            _add(_normalize_name(val), nid)
            # Extract parenthetical abbreviations: "Volumetric Grasping Network (VGN)" → "vgn"
            for abbrev in _PAREN_ABBREV_RE.findall(val):
                _add(_normalize_name(abbrev), nid)

        # Index paper slug: "paper:edge-grasp-network" → "edgegraspnetwork"
        if ntype == 'paper' and nid.startswith('paper:'):
            slug = nid[len('paper:'):]
            _add(re.sub(r'[^a-z0-9]', '', slug.lower()), nid)
        elif ntype == 'method' and ':' in nid:
            raw_id = nid.split(':', 1)[1]
            _add(_normalize_name(raw_id), nid)

    return idx


def _link_method_name(name: str, name_index: dict, paper_id_for_self: str):
    """Resolve a table cell's method name to a KG node id, or None.

    Matching cascade:
      1. Self-reference ("ours", "proposed method", etc.)
      2. Self-reference with method name suffix ("NeuGraspNet (ours)")
      3. Exact normalized match
      4. Prefix match (query is a prefix of an index key, or vice versa)
    """
    if not name:
        return None
    raw = _CITE_RE.sub('', name).strip()
    low = raw.lower()
    if low in SELF_REFERENCES:
        return paper_id_for_self

    # "MethodName (ours)" or "Ours-NOCS" or "Ours+FT" → self-reference variant
    if _SELF_SUFFIX_RE.search(raw):
        return paper_id_for_self
    if re.match(r'^ours[\s\-\+]', low) or low == 'our dataset':
        return paper_id_for_self

    normed = _normalize_name(raw)
    if not normed:
        return None

    # Exact match
    hit = name_index.get(normed)
    if hit:
        return hit

    # Prefix match: "edgegraspnet" matches "edgegraspnetwork",
    # "orbitgrasp" matches "orbitgraspequiformerv2"
    candidates = []
    for key, nid in name_index.items():
        if len(normed) >= 3 and (key.startswith(normed) or normed.startswith(key)):
            candidates.append((key, nid))
    if len(candidates) == 1:
        return candidates[0][1]
    if len(candidates) > 1:
        # Prefer the shortest key (most specific match)
        candidates.sort(key=lambda x: abs(len(x[0]) - len(normed)))
        return candidates[0][1]

    return None


def _row_text(row, ns=NS):
    """Return list of cell strings for a TEI row."""
    cells = row.findall('tei:cell', ns)
    return [' '.join(c.itertext()).strip() for c in cells]


def _extract_tables_for_paper(tei_path: str, paper_id: str, name_index: dict):
    """Yield outperforms candidates for one TEI file."""
    try:
        from lxml import etree
    except ImportError:
        logger.error("lxml is required for tei_table_extractor")
        return []
    tree = etree.parse(tei_path)
    edges = []
    unresolved = []

    for tbl in tree.findall('.//tei:table', NS):
        caption_el = tbl.find('tei:head', NS)
        caption = ' '.join(caption_el.itertext()).strip() if caption_el is not None else ''
        rows = tbl.findall('.//tei:row', NS)
        if len(rows) < 3:
            continue  # need header rows + ≥2 method rows for a comparison

        # Multi-row headers: find the first row whose first cell parses as a
        # float — that's the start of body content. Everything above is
        # header. Direction arrows often live in the SECOND header row
        # (per-metric subheader), not the first (group header).
        header_end = 0
        for ri, r in enumerate(rows):
            txt = _row_text(r)
            first_cell = txt[0] if txt else ''
            if _parse_number(first_cell) is not None:
                header_end = ri
                break
            # Also stop if the first cell looks like a method name (long-ish
            # text with letters and not just a header keyword).
            if ri > 0 and re.search(r'[A-Za-z]{3,}', first_cell) and not _detect_direction(first_cell):
                # This may be the first body row, but only if other cells
                # in this row are mostly numeric.
                numeric = sum(1 for c in txt[1:] if _parse_number(c) is not None)
                if numeric >= max(1, (len(txt) - 1) // 2):
                    header_end = ri
                    break
        if header_end == 0:
            header_end = 1  # fallback: treat first row as the only header
        header_rows = [_row_text(r) for r in rows[:header_end]]
        # Concatenate header rows column-wise so arrow markers in any row count.
        ncols_h = max((len(h) for h in header_rows), default=0)
        header = []
        for ci in range(ncols_h):
            parts = [h[ci] for h in header_rows if ci < len(h) and h[ci]]
            header.append(' '.join(parts))

        if len(header) < 2:
            continue

        body = [_row_text(r) for r in rows[header_end:]]
        ncols = max(len(header), max((len(r) for r in body), default=0))
        directions = [None] * ncols
        for ci in range(ncols):
            head_text = header[ci] if ci < len(header) else ''
            d = _detect_direction(head_text)
            if d is None:
                # Fallback: numeric-density check on body cells.
                vals = [_parse_number(r[ci]) for r in body if ci < len(r)]
                numeric = sum(1 for v in vals if v is not None)
                if vals and numeric / len(vals) >= 0.7 and ci > 0:
                    # Without an explicit arrow we don't know direction;
                    # default to "up" (most ML metrics are higher-better).
                    # Mark as low-confidence so the downstream filter can
                    # treat these differently.
                    d = 'up?'
            directions[ci] = d

        # Method column = first column whose body cells are mostly text.
        method_col = 0

        # Gate: this table must look like a method comparison. Require ≥2
        # DISTINCT resolved method-or-paper ids in the first column. Without
        # this gate, ablation tables ("V1", "V2", "Both") and object-category
        # breakdowns ("Mug", "Cup", "Bowl") leak through as method names and
        # produce nonsense edges.
        resolved_in_first_col = set()
        for r in body:
            if not r:
                continue
            nid = _link_method_name(r[method_col], name_index, paper_id)
            if nid:
                resolved_in_first_col.add(nid)
        if len(resolved_in_first_col) < 2:
            continue

        # For each metric column, rank rows and emit pairwise edges.
        for ci, direction in enumerate(directions):
            if direction is None:
                continue
            up_better = direction.startswith('up')
            confident = direction in {'up', 'down'}
            scored = []
            for r in body:
                if ci >= len(r) or method_col >= len(r):
                    continue
                v = _parse_number(r[ci])
                if v is None:
                    continue
                method_text = r[method_col]
                node_id = _link_method_name(method_text, name_index, paper_id)
                if not node_id:
                    unresolved.append({'paper_id': paper_id, 'name': method_text, 'caption': caption})
                    continue
                scored.append((node_id, method_text, v))
            if len(scored) < 2:
                continue
            # Pairwise: every winner above every loser → an edge.
            for i in range(len(scored)):
                for j in range(len(scored)):
                    if i == j:
                        continue
                    a_id, a_name, a_val = scored[i]
                    b_id, b_name, b_val = scored[j]
                    if a_id == b_id:
                        continue
                    a_wins = (a_val > b_val) if up_better else (a_val < b_val)
                    if not a_wins:
                        continue
                    margin = abs(a_val - b_val) / max(abs(a_val), abs(b_val), 1e-6)
                    edges.append({
                        'src_id': a_id,
                        'tgt_id': b_id,
                        'metric': header[ci] if ci < len(header) else f'col{ci}',
                        'metric_direction': 'higher_is_better' if up_better else 'lower_is_better',
                        'metric_confident': confident,
                        'winner_value': a_val,
                        'loser_value': b_val,
                        'margin': round(margin, 4),
                        'paper_id': paper_id,
                        'table_caption': caption[:300],
                        'src_name': a_name,
                        'tgt_name': b_name,
                    })
    return edges, unresolved


def extract_outperforms_from_tei(tei_dir: str, G, output_dir: str = None):
    """Walk every TEI XML in `tei_dir` and emit outperforms candidates.

    Args:
        tei_dir: directory holding `<paper-slug>.tei.xml`
        G: networkx graph (used for name index)
        output_dir: where to write outperforms_extracted.json (defaults
            to the parent of tei_dir)

    Returns: list of edge dicts.
    """
    name_index = _build_name_index(G)
    edges_all = []
    unresolved_all = []
    files = sorted(f for f in os.listdir(tei_dir) if f.endswith('.xml'))
    for fname in files:
        slug = fname.replace('.tei.xml', '').replace('.xml', '')
        paper_id = f'paper:{slug}'
        if not G.has_node(paper_id):
            # Not a paper we know about — skip rather than orphaning edges.
            continue
        try:
            edges, unresolved = _extract_tables_for_paper(
                os.path.join(tei_dir, fname), paper_id, name_index,
            )
        except Exception as exc:
            logger.warning(f"  table parse failed for {fname}: {exc}")
            continue
        edges_all.extend(edges)
        unresolved_all.extend(unresolved)

    # Deduplicate (src, tgt, metric) keeping the highest-margin instance.
    best = {}
    for e in edges_all:
        key = (e['src_id'], e['tgt_id'], e['metric'])
        if key not in best or e['margin'] > best[key]['margin']:
            best[key] = e
    deduped = list(best.values())

    if output_dir:
        out_path = os.path.join(output_dir, 'outperforms_extracted.json')
        with open(out_path, 'w') as f:
            json.dump(deduped, f, indent=2)
        unresolved_path = os.path.join(output_dir, 'unlinked_table_methods.json')
        with open(unresolved_path, 'w') as f:
            json.dump(unresolved_all, f, indent=2)
        logger.info(f"  Wrote {len(deduped)} outperforms candidates to {out_path}")
        logger.info(f"  Wrote {len(unresolved_all)} unresolved method names to {unresolved_path}")

    return deduped, unresolved_all
