"""Circuit-breaker regression tests for the LLM extractors.

When every LLM provider is quota-exhausted, both extractors used to grind through ALL
papers (each chunk failing after retries), blowing the build's 150-min timeout so the
commit step never ran and nothing persisted -> the next build re-paid for all papers.
The breaker aborts after EXTRACT_ABORT_AFTER (default 3) papers-in-a-row that extract
nothing, so the build finishes and commits the papers that DID extract. Each paper is
paid for at most once.

Fully mocked (no ChromaDB, no LLM). AUTHORED BY ORCHESTRATOR.
"""
import json
import os
import tempfile
from unittest import mock

import backend.rag.ingest.llm_entity_extractor as E
import backend.rag.ingest.verified_triple_extractor as T


def _fake_collection(pids, with_docs=False):
    coll = mock.Mock()
    md = {'metadatas': [{'paper_id': p} for p in pids]}
    if with_docs:
        md['documents'] = ['some passage text ' * 20 for _ in pids]
        md['ids'] = [f'chunk_{p}' for p in pids]
    coll.get.return_value = md
    return coll


def _run_entities(fake_extract, n=10):
    calls = []

    def wrapped(paper_id, **kw):
        calls.append(paper_id)
        return fake_extract(len(calls) - 1)

    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'entities.json')
        with mock.patch('backend.rag.config.load_config', return_value=mock.Mock(chroma_persist_dir=td)), \
             mock.patch('backend.rag.ingest.store.get_client', return_value=None), \
             mock.patch('backend.rag.ingest.store.create_or_get_collection',
                        return_value=_fake_collection([f'p{i}' for i in range(n)])), \
             mock.patch.object(E, 'extract_entities_for_paper', side_effect=wrapped), \
             mock.patch.object(E, '_create_llm_fn', return_value=lambda *a, **k: ''):
            E.run_entity_extraction('dummy.yaml', output_path=out)
        saved = json.load(open(out)) if os.path.exists(out) else {}
    return calls, saved


def _run_triples(fake_extract, n=10):
    calls = []

    def wrapped(chunks, llm_fn, **kw):
        calls.append(1)
        return fake_extract(len(calls) - 1)

    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'verified_triples.json')
        with mock.patch('backend.rag.config.load_config', return_value=mock.Mock(chroma_persist_dir=td)), \
             mock.patch('backend.rag.ingest.store.get_client', return_value=None), \
             mock.patch('backend.rag.ingest.store.create_or_get_collection',
                        return_value=_fake_collection([f'p{i}' for i in range(n)], with_docs=True)), \
             mock.patch('backend.rag.ingest.llm_entity_extractor._create_llm_fn', return_value=lambda *a, **k: ''), \
             mock.patch.object(T, 'extract_verified_triples', side_effect=wrapped):
            T.run_verified_triple_extraction('dummy.yaml', output_path=out)
        saved = json.load(open(out)) if os.path.exists(out) else {'papers': {}}
    return calls, saved


_DEAD_E = lambda i: ([], 1)                                     # 0 entities, 1 LLM error
_OK_E = lambda i: ([{'type': 'dataset', 'value': 'x'}], 0)     # 1 entity, no error
_DEAD_T = lambda i: {'triples': [], 'stats': {'kept': 0, 'llm_errors': 1, 'rejected_unverifiable_quote': 0}}
_OK_T = lambda i: {'triples': [{'s': 'a'}], 'stats': {'kept': 1, 'llm_errors': 0, 'rejected_unverifiable_quote': 0}}


def test_entities_abort_when_quota_dead():
    calls, _ = _run_entities(_DEAD_E, n=10)
    assert len(calls) == 3, f"breaker should stop at 3, attempted {len(calls)}"


def test_entities_process_all_when_healthy():
    calls, saved = _run_entities(_OK_E, n=10)
    assert len(calls) == 10 and len(saved) == 10


def test_entities_counter_resets_on_success():
    seq = [_DEAD_E(0), _DEAD_E(0), _OK_E(0)] + [_DEAD_E(0)] * 7   # 2 dead, reset, then 3 dead
    calls, _ = _run_entities(lambda i: seq[i], n=10)
    assert len(calls) == 6, f"reset then trip should stop at 6, got {len(calls)}"


def test_entities_partial_progress_persists_on_abort():
    seq = [_OK_E(0)] + [_DEAD_E(0)] * 9
    calls, saved = _run_entities(lambda i: seq[i], n=10)
    assert len(saved) == 1, "the one successful paper must be saved before aborting"


def test_triples_abort_when_quota_dead():
    calls, _ = _run_triples(_DEAD_T, n=10)
    assert len(calls) == 3, f"breaker should stop at 3, attempted {len(calls)}"


def test_triples_process_all_when_healthy():
    calls, saved = _run_triples(_OK_T, n=10)
    assert len(calls) == 10 and len(saved['papers']) == 10


# --- The real-world failure: INTERMITTENT quota. Each paper gets a stray success but
#     also LLM errors (deferred = not committed). The old zero-result check never tripped
#     (the paper "had" a result), so it ground through all 57 papers for hours. The breaker
#     must bail on consecutive DEFERRED papers regardless of a stray success. ---
def test_entities_abort_on_intermittent_quota():
    intermittent = lambda i: ([{'type': 't', 'value': 'v'}], 1)   # 1 entity + 1 error -> deferred
    calls, saved = _run_entities(intermittent, n=10)
    assert len(calls) == 3, f"must bail at 3 deferred papers, got {len(calls)}"
    assert len(saved) == 0, "deferred papers must never be committed"


def test_triples_abort_on_intermittent_quota():
    intermittent = lambda i: {'triples': [{'s': 'a'}],
                              'stats': {'kept': 1, 'llm_errors': 1, 'rejected_unverifiable_quote': 0}}
    calls, saved = _run_triples(intermittent, n=10)
    assert len(calls) == 3, f"must bail at 3 deferred papers, got {len(calls)}"
    assert len(saved['papers']) == 0


# --- Per-run cap: the enrichment backlog (papers with facts but no entities/triples)
#     must NEVER grind the whole todo when quota is HEALTHY. If it does, step_rag runs
#     for hours and step_kg never rebuilds, so newly-added papers never integrate and
#     the build times out with nothing committed. A per-run cap
#     (EXTRACT_MAX_PAPERS_PER_RUN) bounds each build so step_kg always runs; the rest of
#     the backlog resumes on later builds. Distinct from the quota breaker: the cap fires
#     even when every paper SUCCEEDS. ---
import contextlib


@contextlib.contextmanager
def _cap(n):
    prev = os.environ.get('EXTRACT_MAX_PAPERS_PER_RUN')
    os.environ['EXTRACT_MAX_PAPERS_PER_RUN'] = str(n)
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop('EXTRACT_MAX_PAPERS_PER_RUN', None)
        else:
            os.environ['EXTRACT_MAX_PAPERS_PER_RUN'] = prev


def test_entities_cap_bounds_papers_per_run_when_healthy():
    with _cap(5):
        calls, saved = _run_entities(_OK_E, n=20)
    assert len(calls) == 5, f"per-run cap must stop at 5 healthy papers, processed {len(calls)}"
    assert len(saved) == 5, "the 5 processed papers must be committed (progress persists)"


def test_triples_cap_bounds_papers_per_run_when_healthy():
    with _cap(5):
        calls, saved = _run_triples(_OK_T, n=20)
    assert len(calls) == 5, f"per-run cap must stop at 5 healthy papers, processed {len(calls)}"
    assert len(saved['papers']) == 5


def test_entities_cap_not_hit_when_todo_below_cap():
    # A normal incremental build (few new papers) must process them all, not stall.
    with _cap(50):
        calls, saved = _run_entities(_OK_E, n=10)
    assert len(calls) == 10 and len(saved) == 10


if __name__ == '__main__':
    import sys
    sys.exit(__import__('pytest').main([__file__, '-q']))
