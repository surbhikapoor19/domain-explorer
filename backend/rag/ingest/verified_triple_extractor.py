"""Evidence-quoted relation extraction — every semantic KG edge carries a
VERBATIM source quote, verified mechanically before it may become an edge.

Why: the KG's regex/heuristic extractors assert relations with near-zero
provenance (0 of 20k edges carried confidence, 18 carried a source sentence),
which conflicts with the product's click-to-verify honesty bar everywhere else.
This extractor asks the LLM, per chunk, for (relation, object, quote) triples
against a FIXED schema — and drops any triple whose quote is not literally a
substring of the chunk (same trick as the copilot's numeric-grounding
enforcement: the model cannot hallucinate a relation without forging a quote,
and forged quotes fail the substring check).

Output triples carry {relation, object, quote, chunk_id, paper_id}; the KG build
turns them into edges with extraction='verified_llm' + the quote as provenance.
"""
import json
import re

# Fixed relation schema — mirrors the KG's semantic edge types. The LLM may only
# pick from these; anything else is dropped.
RELATION_SCHEMA = {
    'uses_backbone':   'a neural network architecture/backbone THE PAPER\'S METHOD itself uses (not a baseline\'s)',
    'uses_loss':       'a loss function the method is trained with',
    'trained_on':      'a dataset the method is TRAINED on (not merely evaluated on)',
    'evaluated_on':    'a dataset/benchmark the method is evaluated on',
    'uses_hardware':   'a physical robot arm, gripper, or sensor used in experiments',
    'addresses_problem': 'the specific problem the method addresses',
    'has_limitation':  'a limitation the AUTHORS acknowledge about THEIR OWN method',
    'outperforms_claim': 'another named method the authors claim to outperform',
}

_PROMPT_HEADER = (
    "Extract factual relations about THE PAPER'S OWN METHOD from the passage. "
    "Respond with ONLY a JSON object {\"triples\": [{\"relation\": str, \"object\": str, "
    "\"quote\": str}]}.\n"
    "RULES:\n"
    "- relation MUST be one of: " + ", ".join(RELATION_SCHEMA) + "\n"
    + "".join(f"  - {k}: {v}\n" for k, v in RELATION_SCHEMA.items()) +
    "- quote MUST be copied VERBATIM from the passage (an exact substring, >= 15 chars) "
    "that states the relation. No paraphrasing — a paraphrased quote will be rejected.\n"
    "- object is the short canonical name (e.g. \"PointNet++\", \"YCB\", \"Franka Emika Panda\").\n"
    "- Extract only what the passage STATES about the paper's own method; skip claims "
    "about other papers' methods (except outperforms_claim, whose object is the other method).\n"
    "- If the passage states nothing extractable, return {\"triples\": []}."
)


def _norm_ws(s):
    return re.sub(r'\s+', ' ', str(s or '')).strip().lower()


def verify_quote(quote, chunk_text, min_len=15):
    """A quote counts only if it is literally in the chunk (whitespace-normalized,
    case-insensitive). This is the anti-hallucination contract."""
    q = _norm_ws(quote)
    return len(q) >= min_len and q in _norm_ws(chunk_text)


def parse_triples(raw):
    m = re.search(r'\{.*\}', str(raw or ''), re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except (json.JSONDecodeError, ValueError):
        return []
    out = []
    for t in data.get('triples', []):
        if not isinstance(t, dict):
            continue
        rel, obj, quote = t.get('relation'), t.get('object'), t.get('quote')
        if rel in RELATION_SCHEMA and obj and quote:
            out.append({'relation': rel, 'object': str(obj).strip(), 'quote': str(quote)})
    return out


def extract_verified_triples(chunks, llm_fn, max_chunks=60):
    """chunks: [{'chunk_id', 'paper_id', 'text', 'layer'?}] -> verified triples.
    Mid-layer chunks preferred (they carry the method/experiment detail). One bad
    chunk or LLM error never kills the run. Stats returned for auditability."""
    pool = [c for c in chunks if (c.get('layer') or c.get('metadata', {}).get('layer')) == 'mid'] or list(chunks)
    kept, rejected_quote, errors = [], 0, 0
    for c in pool[:max_chunks]:
        text = c.get('text') or ''
        if len(text.split()) < 30:
            continue
        try:
            raw = llm_fn([
                {'role': 'system', 'content': _PROMPT_HEADER},
                {'role': 'user', 'content': f'PASSAGE:\n{text[:4000]}'},
            ], max_tokens=800, temperature=0)
        except Exception:
            errors += 1
            continue
        for t in parse_triples(raw):
            if not verify_quote(t['quote'], text):
                rejected_quote += 1
                continue
            t['chunk_id'] = c.get('chunk_id') or c.get('id')
            t['paper_id'] = c.get('paper_id') or c.get('metadata', {}).get('paper_id')
            kept.append(t)
    return {'triples': kept,
            'stats': {'chunks_seen': min(len(pool), max_chunks), 'kept': len(kept),
                      'rejected_unverifiable_quote': rejected_quote, 'llm_errors': errors}}


def run_verified_triple_extraction(config_path, output_path=None, llm_fn=None,
                                   max_chunks_per_paper=25):
    """ChromaDB → verified_triples.json (next to extracted_entities.json).
    Resumable like run_entity_extraction: papers already in the output are skipped,
    so an interrupted CI run continues instead of re-paying LLM calls."""
    import os
    from ..config import load_config
    from .store import get_client, create_or_get_collection
    from .llm_entity_extractor import _create_llm_fn

    config = load_config(config_path)
    if output_path is None:
        output_path = os.path.join(config.chroma_persist_dir, 'verified_triples.json')
    llm_fn = llm_fn or _create_llm_fn('groq')

    existing = {'papers': {}, 'triples': [], 'stats': {}}
    if os.path.exists(output_path):
        with open(output_path) as f:
            existing = json.load(f)

    client = get_client(config)
    collection = create_or_get_collection(config, client)
    got = collection.get(include=['metadatas', 'documents'])
    by_paper = {}
    for meta, doc, cid in zip(got['metadatas'], got['documents'], got['ids']):
        pid = (meta or {}).get('paper_id')
        if not pid:
            continue
        by_paper.setdefault(pid, []).append({
            'chunk_id': cid, 'paper_id': pid, 'text': doc,
            'layer': (meta or {}).get('layer'),
        })

    done = set(existing.get('papers', {}))
    todo = [p for p in sorted(by_paper) if p not in done]
    print(f"  [triples] papers: {len(by_paper)} | already done: {len(done)} | to process: {len(todo)}")
    for pid in todo:
        out = extract_verified_triples(by_paper[pid], llm_fn, max_chunks=max_chunks_per_paper)
        existing['papers'][pid] = out['stats']
        existing['triples'].extend(out['triples'])
        with open(output_path, 'w') as f:      # checkpoint per paper (resume-safe)
            json.dump(existing, f, indent=1)
        print(f"  [triples] {pid}: +{out['stats']['kept']} verified "
              f"({out['stats']['rejected_unverifiable_quote']} quote-rejected)")
    total = len(existing.get('triples', []))
    existing['stats'] = {'n_triples': total, 'n_papers': len(existing.get('papers', {}))}
    with open(output_path, 'w') as f:
        json.dump(existing, f, indent=1)
    print(f"  [triples] total verified triples: {total}")
    return existing
