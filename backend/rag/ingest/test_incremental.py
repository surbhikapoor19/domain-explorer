"""RAG incremental-memoization acceptance tests (criteria 14-17) — AUTHORED BY
ORCHESTRATOR SPEC.

Pure logic, no real ChromaDB / embeddings / parsing: a dict-backed stub collection
stands in for a Chroma collection, and the expensive PDF-parse / chunk / embed /
fact-extraction steps are monkeypatched out so each test exercises exactly the
incremental logic (skip preamble, metadata stamp, orphan cleanup, facts merge).
"""
import json

import numpy as np

from rag.config import RAGConfig
from rag.ingest import pipeline


# --------------------------------------------------------------------------- #
# Stubs / fakes                                                               #
# --------------------------------------------------------------------------- #
class StubCollection:
    """Dict-backed stand-in supporting the subset of the Chroma API the pipeline
    uses: upsert / get(where,limit,include) / delete(where) / count / peek."""

    def __init__(self):
        self.records = {}          # chunk_id -> {"document": str, "metadata": dict}
        self.delete_calls = []     # list of `where` dicts passed to delete()

    def upsert(self, ids, embeddings, documents, metadatas):
        for i, cid in enumerate(ids):
            self.records[cid] = {"document": documents[i], "metadata": metadatas[i]}

    def get(self, where=None, limit=None, include=None):
        items = list(self.records.items())
        if where:
            key, val = next(iter(where.items()))
            items = [(cid, r) for cid, r in items if r["metadata"].get(key) == val]
        if limit is not None:
            items = items[:limit]
        out = {"ids": [cid for cid, _ in items]}
        inc = include or ["metadatas"]
        if "metadatas" in inc:
            out["metadatas"] = [r["metadata"] for _, r in items]
        if "documents" in inc:
            out["documents"] = [r["document"] for _, r in items]
        return out

    def delete(self, where=None):
        self.delete_calls.append(where)
        if where:
            key, val = next(iter(where.items()))
            self.records = {
                cid: r for cid, r in self.records.items()
                if r["metadata"].get(key) != val
            }

    def count(self):
        return len(self.records)

    def peek(self, limit=5):
        return {"ids": list(self.records)[:limit]}


class FakeChunk:
    def __init__(self, chunk_id, paper_id, text="chunk text"):
        self.chunk_id = chunk_id
        self.paper_id = paper_id
        self.paper_title = "Fake Title"
        self.layer = "mid"
        self.chunk_type = "mid"
        self.section = "Method"
        self.subsection = ""
        self.section_type = ""
        self.page = 1
        self.position = 0
        self.token_count = 10
        self.domain_topics = []
        self.rhetorical_role = ""
        self.content_type = ""
        self.text = text
        self.metadata = {}


class FakePaper:
    title = "Fake Title"
    sections = []
    figures = []
    abstract = "abstract text"


class FakeEmbedder:
    def __init__(self, *a, **k):
        self.model = None

    def embed_chunks(self, chunks):
        return np.zeros((len(chunks), 4), dtype=float)


def _make_config(chroma_dir=None):
    cfg = RAGConfig()
    if chroma_dir is not None:
        cfg.chroma_persist_dir = str(chroma_dir)
    return cfg


def _patch_full_parse(monkeypatch, chunks):
    """Make the parse -> chunk -> extract_facts path cheap and deterministic so a
    cache MISS in ingest_single reaches the real upsert (which stamps metadata)."""
    monkeypatch.setattr(pipeline, "_parse_with_config", lambda *a, **k: FakePaper())
    monkeypatch.setattr(pipeline, "chunk_paper", lambda paper, chunking, model=None: chunks)
    monkeypatch.setattr(pipeline, "extract_facts", lambda *a, **k: [])


def _patch_run_ingestion(monkeypatch, stub, fake_single):
    """Isolate run_ingestion's merge/orphan logic: stub the collection, avoid
    loading a real embedding model, and replace ingest_single with a fake."""
    monkeypatch.setattr(pipeline, "ChunkEmbedder", lambda *a, **k: FakeEmbedder())
    monkeypatch.setattr(pipeline, "get_client", lambda config: None)
    monkeypatch.setattr(pipeline, "create_or_get_collection", lambda config, client=None: stub)
    monkeypatch.setattr(pipeline, "ingest_single", fake_single)


# --------------------------------------------------------------------------- #
# 14 — skip when hash + salt match                                            #
# --------------------------------------------------------------------------- #
def test_14_skip_when_hash_and_salt_match(monkeypatch):
    config = _make_config()
    salt = pipeline.compute_ingest_salt(config)
    stub = StubCollection()
    stub.upsert(
        ids=["dexnet-c1"],
        embeddings=[[0, 0, 0, 0]],
        documents=["x"],
        metadatas=[{"paper_id": "dexnet", "pdf_sha256": "HASH", "ingest_salt": salt}],
    )

    # If the skip fires the parser must never run.
    def _boom(*a, **k):
        raise AssertionError("parser should not be called on a cache hit")

    monkeypatch.setattr(pipeline, "_parse_with_config", _boom)

    result = pipeline.ingest_single(
        "/x/DexNet.pdf", config, None, stub,
        content_hash="HASH", skip_if_unchanged=True,
    )
    assert result == {"paper_id": "dexnet", "status": "cached", "n_chunks": 0, "facts": None}


# --------------------------------------------------------------------------- #
# 15 — re-ingest on hash OR salt mismatch; new metadata stamped               #
# --------------------------------------------------------------------------- #
def test_15_reingest_on_hash_mismatch_stamps_new_metadata(monkeypatch):
    config = _make_config()
    salt = pipeline.compute_ingest_salt(config)
    stub = StubCollection()
    # Stored under an OLD hash -> content changed -> must re-ingest.
    stub.upsert(
        ids=["changed-old"],
        embeddings=[[0, 0, 0, 0]],
        documents=["old"],
        metadatas=[{"paper_id": "changed", "pdf_sha256": "OLDHASH", "ingest_salt": salt}],
    )
    _patch_full_parse(monkeypatch, [FakeChunk("changed-c1", "changed")])

    result = pipeline.ingest_single(
        "/x/changed.pdf", config, FakeEmbedder(), stub,
        content_hash="NEWHASH", skip_if_unchanged=True,
    )
    assert result["status"] == "success"
    meta = stub.records["changed-c1"]["metadata"]
    assert meta["pdf_sha256"] == "NEWHASH"
    assert meta["ingest_salt"] == salt


def test_15_reingest_on_salt_mismatch_stamps_new_metadata(monkeypatch):
    config = _make_config()
    salt = pipeline.compute_ingest_salt(config)
    stub = StubCollection()
    # Same hash, STALE salt (e.g. embedding model changed) -> must re-ingest.
    stub.upsert(
        ids=["changed-old"],
        embeddings=[[0, 0, 0, 0]],
        documents=["old"],
        metadatas=[{"paper_id": "changed", "pdf_sha256": "SAMEHASH", "ingest_salt": "STALESALT"}],
    )
    _patch_full_parse(monkeypatch, [FakeChunk("changed-c1", "changed")])

    result = pipeline.ingest_single(
        "/x/changed.pdf", config, FakeEmbedder(), stub,
        content_hash="SAMEHASH", skip_if_unchanged=True,
    )
    assert result["status"] == "success"
    meta = stub.records["changed-c1"]["metadata"]
    assert meta["pdf_sha256"] == "SAMEHASH"
    assert meta["ingest_salt"] == salt          # freshly recomputed, not the stale one


# --------------------------------------------------------------------------- #
# 16 — orphan cleanup                                                         #
# --------------------------------------------------------------------------- #
def test_16_orphan_cleanup(monkeypatch, tmp_path):
    papers = tmp_path / "papers"
    papers.mkdir()
    (papers / "keep.pdf").write_bytes(b"keep-bytes")
    chroma = tmp_path / "chroma"
    chroma.mkdir()
    facts_path = chroma / "extracted_facts.json"
    facts_path.write_text(json.dumps({
        "orphan": [{"type": "metric", "id": "o"}],
        "keep": [{"type": "metric", "id": "old"}],
    }))
    config = _make_config(chroma)

    stub = StubCollection()
    # A paper still in the collection but whose PDF is gone from disk.
    stub.upsert(
        ids=["orphan-c1"],
        embeddings=[[0, 0, 0, 0]],
        documents=["x"],
        metadatas=[{"paper_id": "orphan"}],
    )

    def fake_single(pdf_path, cfg, embedder, collection, *, content_hash=None, skip_if_unchanged=False):
        pid = pipeline.paper_id_from_path(pdf_path)
        return {"paper_id": pid, "status": "success", "n_chunks": 1,
                "facts": [{"type": "metric", "id": "fresh"}]}

    _patch_run_ingestion(monkeypatch, stub, fake_single)
    pipeline.run_ingestion(str(papers), config, skip_unchanged=True)

    assert {"paper_id": "orphan"} in stub.delete_calls
    saved = json.loads(facts_path.read_text())
    assert "orphan" not in saved
    assert saved["keep"] == [{"type": "metric", "id": "fresh"}]


# --------------------------------------------------------------------------- #
# 17 — facts preservation across cached / re-ingested papers                  #
# --------------------------------------------------------------------------- #
def test_17_facts_preservation(monkeypatch, tmp_path):
    papers = tmp_path / "papers"
    papers.mkdir()
    (papers / "cachedpaper.pdf").write_bytes(b"c")
    (papers / "changedpaper.pdf").write_bytes(b"ch")
    chroma = tmp_path / "chroma"
    chroma.mkdir()
    facts_path = chroma / "extracted_facts.json"
    facts_path.write_text(json.dumps({
        "cachedpaper": [{"type": "metric", "id": "prior-cached"}],
        "changedpaper": [{"type": "metric", "id": "prior-changed"}],
    }))
    config = _make_config(chroma)

    stub = StubCollection()
    canned = {
        "cachedpaper": {"paper_id": "cachedpaper", "status": "cached", "n_chunks": 0, "facts": None},
        "changedpaper": {"paper_id": "changedpaper", "status": "success", "n_chunks": 1,
                         "facts": [{"type": "metric", "id": "fresh-changed"}]},
    }

    def fake_single(pdf_path, cfg, embedder, collection, *, content_hash=None, skip_if_unchanged=False):
        return canned[pipeline.paper_id_from_path(pdf_path)]

    _patch_run_ingestion(monkeypatch, stub, fake_single)
    pipeline.run_ingestion(str(papers), config, skip_unchanged=True)

    saved = json.loads(facts_path.read_text())
    # Cached paper keeps its previously extracted facts...
    assert saved["cachedpaper"] == [{"type": "metric", "id": "prior-cached"}]
    # ...while the re-ingested paper gets the fresh ones.
    assert saved["changedpaper"] == [{"type": "metric", "id": "fresh-changed"}]


# --------------------------------------------------------------------------- #
# FIX 2 — a transient re-ingest failure must NOT drop a paper's prior facts    #
# --------------------------------------------------------------------------- #
def test_transient_failure_keeps_prior_facts(monkeypatch, tmp_path):
    """A paper that is re-ingested (not skipped) but whose ingest_single yields no
    fresh facts (e.g. a transient parse/extract error returning empty facts) keeps
    its prior facts as long as the PDF is still on disk — the KG must not be starved
    for that paper."""
    papers = tmp_path / "papers"
    papers.mkdir()
    (papers / "flaky.pdf").write_bytes(b"flaky-bytes")
    chroma = tmp_path / "chroma"
    chroma.mkdir()
    facts_path = chroma / "extracted_facts.json"
    facts_path.write_text(json.dumps({"flaky": [{"type": "metric", "id": "prior-flaky"}]}))
    config = _make_config(chroma)

    stub = StubCollection()

    def fake_single(pdf_path, cfg, embedder, collection, *, content_hash=None, skip_if_unchanged=False):
        # Re-ingested this run (not "cached"), but produced NO fresh facts.
        return {"paper_id": pipeline.paper_id_from_path(pdf_path), "status": "success",
                "n_chunks": 0, "facts": []}

    _patch_run_ingestion(monkeypatch, stub, fake_single)
    pipeline.run_ingestion(str(papers), config, skip_unchanged=True)

    saved = json.loads(facts_path.read_text())
    assert saved["flaky"] == [{"type": "metric", "id": "prior-flaky"}]


def test_transient_raise_keeps_prior_facts(monkeypatch, tmp_path):
    """The raise path of FIX 2: if ingest_single RAISES for a paper (transient
    error) it never reaches `results`, but its prior facts must still survive since
    the PDF is on disk — the failure is recorded, the facts are not lost."""
    papers = tmp_path / "papers"
    papers.mkdir()
    (papers / "boom.pdf").write_bytes(b"boom-bytes")
    chroma = tmp_path / "chroma"
    chroma.mkdir()
    facts_path = chroma / "extracted_facts.json"
    facts_path.write_text(json.dumps({"boom": [{"type": "metric", "id": "prior-boom"}]}))
    config = _make_config(chroma)

    stub = StubCollection()

    def fake_single(pdf_path, cfg, embedder, collection, *, content_hash=None, skip_if_unchanged=False):
        raise RuntimeError("transient extract failure")

    _patch_run_ingestion(monkeypatch, stub, fake_single)
    summary = pipeline.run_ingestion(str(papers), config, skip_unchanged=True)

    assert summary["errors"]  # the failure was recorded, not swallowed
    saved = json.loads(facts_path.read_text())
    assert saved["boom"] == [{"type": "metric", "id": "prior-boom"}]


# --------------------------------------------------------------------------- #
# FIX 3 — facts/Chroma desync: a stamped-but-factless paper must be re-ingested #
# --------------------------------------------------------------------------- #
def test_desync_forces_reingest(monkeypatch, tmp_path):
    """A paper whose Chroma (pdf_sha256, ingest_salt) stamp matches — so the stamp
    alone would authorise a skip — but which is ABSENT from the prior
    extracted_facts.json must NOT be skipped. The skip is tied to facts
    availability, so ingest_single runs its full parse path and the facts are
    regenerated rather than silently lost."""
    papers = tmp_path / "papers"
    papers.mkdir()
    (papers / "desync.pdf").write_bytes(b"desync-bytes")
    chroma = tmp_path / "chroma"
    chroma.mkdir()
    # Prior facts file EXISTS but is desynced: it does not contain "desync".
    facts_path = chroma / "extracted_facts.json"
    facts_path.write_text(json.dumps({"other": [{"type": "metric", "id": "x"}]}))
    config = _make_config(chroma)

    # Stamp the collection so the Chroma hash+salt WOULD match (a stamp-only skip
    # decision would fire and drop the paper's facts).
    content_hash = pipeline._sha256_file(str(papers / "desync.pdf"))
    salt = pipeline.compute_ingest_salt(config)
    stub = StubCollection()
    stub.upsert(
        ids=["desync-c1"],
        embeddings=[[0, 0, 0, 0]],
        documents=["x"],
        metadatas=[{"paper_id": "desync", "pdf_sha256": content_hash, "ingest_salt": salt}],
    )

    # Real ingest_single, but its expensive parse path is a recording sentinel.
    parse_calls = []

    def _record_parse(pdf_path, paper_id, cfg):
        parse_calls.append(paper_id)
        return FakePaper()

    monkeypatch.setattr(pipeline, "_parse_with_config", _record_parse)
    monkeypatch.setattr(pipeline, "chunk_paper",
                        lambda paper, chunking, model=None: [FakeChunk("desync-c1", "desync")])
    monkeypatch.setattr(pipeline, "extract_facts",
                        lambda *a, **k: [{"type": "metric", "id": "regen"}])
    monkeypatch.setattr(pipeline, "ChunkEmbedder", lambda *a, **k: FakeEmbedder())
    monkeypatch.setattr(pipeline, "get_client", lambda config: None)
    monkeypatch.setattr(pipeline, "create_or_get_collection", lambda config, client=None: stub)

    pipeline.run_ingestion(str(papers), config, skip_unchanged=True)

    # The skip must NOT have fired: the full parse ran for the desynced paper...
    assert parse_calls == ["desync"]
    # ...and its facts were regenerated rather than silently lost.
    saved = json.loads(facts_path.read_text())
    assert saved.get("desync") == [{"type": "metric", "id": "regen"}]
