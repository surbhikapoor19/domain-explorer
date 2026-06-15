"""SciCite-style citation-intent classifier for the domain-explorer KG.

For every citation context string (both internal `cites` edges in
``knowledge_graph.json`` and external back-citations in ``s2_enrichment.json``),
predict its intent using the Allen AI SciCite model:

  https://huggingface.co/allenai/scicite

3-class classification:
  - background : citing the prior work as context
  - method     : using the prior work's method/technique
  - result     : comparing or contrasting results

Persists results to ``<chroma_persist_dir>/citation_intents.json`` with two
top-level lists: ``internal`` and ``external_back``.

Resumable: existing entries (keyed on
(src, tgt|external_paper_id, context_idx)) are skipped on re-run.

Run:
    python -m rag.citation_intent_classifier --config rag_config.yaml
    python -m rag.citation_intent_classifier --config rag_config.yaml --limit 50
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Iterator, Optional

# Make ``rag`` importable when run as a script.
THIS_DIR = Path(__file__).resolve().parent
BACKEND_DIR = THIS_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from rag.config import load_config  # noqa: E402


logger = logging.getLogger("citation_intent_classifier")


# Verified public SciBERT fine-tuned on the SciCite dataset. 3-class output:
#   0 -> background, 1 -> method, 2 -> result
# The model class itself reads its id2label from the config at load time, so
# this comment is for human readers; the code does not hardcode the labels.
SCICITE_MODEL_ID = "lostelf/scibert_scivocab_uncased_scicite_finetuned"
DEFAULT_BATCH_SIZE = 16
# SciCite was trained on short citing sentences; cap at 256 tokens.
MAX_TOKEN_LEN = 256


# ----------------------------------------------------------------------
# Output file I/O
# ----------------------------------------------------------------------
def load_existing_output(out_path: Path) -> dict:
    """Load prior results so the run is resumable. Missing file => empty shell."""
    if not out_path.exists():
        return {"internal": [], "external_back": []}
    try:
        with out_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            logger.warning("existing %s is not a dict; starting fresh", out_path)
            return {"internal": [], "external_back": []}
        data.setdefault("internal", [])
        data.setdefault("external_back", [])
        return data
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("could not read existing %s: %s", out_path, e)
        return {"internal": [], "external_back": []}


def save_atomic(out_path: Path, data: dict) -> None:
    """Atomic JSON write so a crash mid-write can't corrupt the file."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, out_path)


def _internal_key(entry: dict) -> tuple:
    return (entry.get("src"), entry.get("tgt"), entry.get("context_idx"))


def _external_key(entry: dict) -> tuple:
    return (
        entry.get("src"),
        entry.get("external_paper_id"),
        entry.get("context_idx"),
    )


# ----------------------------------------------------------------------
# Source iteration
# ----------------------------------------------------------------------
def iter_internal_contexts(kg_path: Path) -> Iterator[dict]:
    """Yield {src, tgt, context_idx, context} per internal cites-edge context.

    Handles both the ``contexts`` (list) and the legacy ``context`` (str) fields
    that appear on ``cites`` edges in the persisted KG.
    """
    with kg_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    # NetworkX node_link_data uses "links" by default.
    edges = data.get("links") or data.get("edges") or []
    for edge in edges:
        if edge.get("type") != "cites":
            continue
        src = edge.get("source")
        tgt = edge.get("target")
        if not src or not tgt:
            continue
        ctxs = edge.get("contexts")
        if ctxs is None and edge.get("context"):
            ctxs = [edge["context"]]
        if not ctxs:
            continue
        for i, ctx in enumerate(ctxs):
            if not isinstance(ctx, str) or not ctx.strip():
                continue
            yield {
                "src": src,
                "tgt": tgt,
                "context_idx": i,
                "context": ctx,
            }


def iter_external_contexts(s2_path: Path) -> Iterator[dict]:
    """Yield {src, external_paper_id, context_idx, context} per S2 citation context.

    ``s2_enrichment.json`` is a dict keyed by slug. Each record carries a
    ``citations`` list (papers that cite us); each citation has a ``contexts``
    list of strings.
    """
    with s2_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return
    for slug, record in data.items():
        if not isinstance(record, dict):
            continue
        src = f"paper:{slug}"
        for citing in record.get("citations") or []:
            if not isinstance(citing, dict):
                continue
            ext_pid = citing.get("paperId")
            if not ext_pid:
                continue
            for i, ctx in enumerate(citing.get("contexts") or []):
                if not isinstance(ctx, str) or not ctx.strip():
                    continue
                yield {
                    "src": src,
                    "external_paper_id": ext_pid,
                    "context_idx": i,
                    "context": ctx,
                }


# ----------------------------------------------------------------------
# Classifier
# ----------------------------------------------------------------------
class SciCiteClassifier:
    """Thin wrapper around the allenai/scicite HF model. CPU only."""

    def __init__(self, model_id: str = SCICITE_MODEL_ID, batch_size: int = DEFAULT_BATCH_SIZE):
        # Imported lazily so listing --help doesn't pay the import cost.
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        logger.info("loading SciCite model %s ...", model_id)
        self._torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModelForSequenceClassification.from_pretrained(model_id)
        self.model.eval()
        # Force CPU per task constraints.
        self.device = torch.device("cpu")
        self.model.to(self.device)
        self.batch_size = batch_size

        # Confirm id2label at runtime; don't hardcode.
        id2label_raw = getattr(self.model.config, "id2label", None) or {}
        # HF stores keys as ints OR strings depending on version; normalize.
        self.id2label = {int(k): str(v).lower() for k, v in id2label_raw.items()}
        logger.info("model id2label: %s", self.id2label)

    def classify_batch(self, texts: list) -> list:
        """Return [{intent, confidence} ...] aligned with ``texts``."""
        if not texts:
            return []
        torch = self._torch
        results = []
        for start in range(0, len(texts), self.batch_size):
            chunk = texts[start : start + self.batch_size]
            enc = self.tokenizer(
                chunk,
                padding=True,
                truncation=True,
                max_length=MAX_TOKEN_LEN,
                return_tensors="pt",
            )
            enc = {k: v.to(self.device) for k, v in enc.items()}
            with torch.no_grad():
                logits = self.model(**enc).logits
            probs = torch.softmax(logits, dim=-1)
            confs, preds = probs.max(dim=-1)
            for p, c in zip(preds.tolist(), confs.tolist()):
                results.append(
                    {
                        "intent": self.id2label.get(int(p), str(p)),
                        "confidence": round(float(c), 4),
                    }
                )
        return results


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------
def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="SciCite citation-intent classification over the domain-explorer KG.",
    )
    parser.add_argument(
        "--config",
        default="rag_config.yaml",
        help="RAG config YAML (for chroma_persist_dir).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap total NEW contexts classified this run (for smoke testing).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="Inference batch size (default 16).",
    )
    parser.add_argument(
        "--save-every",
        type=int,
        default=200,
        help="Save partial results to disk every N new classifications.",
    )
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # Resolve paths anchored on the config file's parent (repo root).
    config_path = Path(args.config).resolve()
    repo_root = config_path.parent
    cfg = load_config(str(config_path))
    chroma_dir = (repo_root / cfg.chroma_persist_dir).resolve()

    kg_path = chroma_dir / "knowledge_graph.json"
    s2_path = chroma_dir / "s2_enrichment.json"
    out_path = chroma_dir / "citation_intents.json"

    if not kg_path.exists():
        logger.error("knowledge_graph.json not found at %s", kg_path)
        return 2
    if not s2_path.exists():
        logger.error("s2_enrichment.json not found at %s", s2_path)
        return 2

    out = load_existing_output(out_path)
    seen_internal = {_internal_key(e) for e in out["internal"]}
    seen_external = {_external_key(e) for e in out["external_back"]}
    logger.info(
        "resuming with %d internal + %d external entries already on disk",
        len(seen_internal),
        len(seen_external),
    )

    # Build the work queue (internal first, then external) — limit applies
    # across both so a tiny smoke test doesn't get stuck in just one source.
    pending: list = []
    for item in iter_internal_contexts(kg_path):
        if (item["src"], item["tgt"], item["context_idx"]) in seen_internal:
            continue
        pending.append(("internal", item))
        if args.limit is not None and len(pending) >= args.limit:
            break
    if args.limit is None or len(pending) < args.limit:
        for item in iter_external_contexts(s2_path):
            key = (item["src"], item["external_paper_id"], item["context_idx"])
            if key in seen_external:
                continue
            pending.append(("external", item))
            if args.limit is not None and len(pending) >= args.limit:
                break

    if not pending:
        logger.info("nothing to do — all contexts already classified.")
        # Still emit a summary from what's on disk.
        _print_summary(out, runtime_s=0.0)
        return 0

    logger.info("queued %d new contexts for classification", len(pending))

    clf = SciCiteClassifier(batch_size=args.batch_size)

    t0 = time.time()
    new_since_save = 0
    # Process in classifier batches.
    for start in range(0, len(pending), args.batch_size):
        chunk = pending[start : start + args.batch_size]
        texts = [item["context"] for _kind, item in chunk]
        preds = clf.classify_batch(texts)
        for (kind, item), pred in zip(chunk, preds):
            if kind == "internal":
                out["internal"].append(
                    {
                        "src": item["src"],
                        "tgt": item["tgt"],
                        "context_idx": item["context_idx"],
                        "intent": pred["intent"],
                        "confidence": pred["confidence"],
                    }
                )
            else:
                out["external_back"].append(
                    {
                        "src": item["src"],
                        "external_paper_id": item["external_paper_id"],
                        "context_idx": item["context_idx"],
                        "intent": pred["intent"],
                        "confidence": pred["confidence"],
                    }
                )
            new_since_save += 1
        if new_since_save >= args.save_every:
            save_atomic(out_path, out)
            logger.info("checkpoint saved (%d new entries)", new_since_save)
            new_since_save = 0

    # Final write.
    save_atomic(out_path, out)
    runtime_s = time.time() - t0

    logger.info("wrote results to %s", out_path)
    _print_summary(out, runtime_s=runtime_s, new_count=len(pending))
    return 0


def _print_summary(out: dict, runtime_s: float, new_count: Optional[int] = None) -> None:
    n_internal = len(out["internal"])
    n_external = len(out["external_back"])
    all_intents = [e["intent"] for e in out["internal"]] + [
        e["intent"] for e in out["external_back"]
    ]
    breakdown = Counter(all_intents)
    print("=" * 60)
    print("Citation-intent classification summary")
    print("=" * 60)
    print(f"internal contexts classified : {n_internal}")
    print(f"external contexts classified : {n_external}")
    if new_count is not None:
        print(f"new this run                 : {new_count}")
        if runtime_s > 0:
            rate = new_count / runtime_s if runtime_s else 0.0
            print(f"wall time                    : {runtime_s:.2f}s ({rate:.2f} ctx/s)")
    if all_intents:
        total = sum(breakdown.values())
        print("breakdown by class:")
        for label in sorted(breakdown):
            n = breakdown[label]
            pct = 100.0 * n / total if total else 0.0
            print(f"  {label:<12} {n:>6}  ({pct:5.1f}%)")


if __name__ == "__main__":
    raise SystemExit(main())
