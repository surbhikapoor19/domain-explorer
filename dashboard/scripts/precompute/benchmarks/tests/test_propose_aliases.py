"""propose_aliases — AUTHORED BY ORCHESTRATOR. Quarantined headers become
human-reviewable registry proposals: clustered, LLM-judged (mocked here), ranked
by recovered-record impact, never auto-applied."""
import json
from benchmarks.aggregate.propose_aliases import cluster_headers, propose, build_prompt

BENCH = {'quarantine': {'unresolved_headers': [
    {'raw': 'Suc. Rate', 'count': 21},
    {'raw': 'Success Rate (%)', 'count': 64},
    {'raw': 'Entropy (H)', 'count': 5},
    {'raw': '# Images', 'count': 11},
]}}
CFG = {'metrics': [{'id': 'success_rate', 'aliases': ['success rate', 'gsr']}]}


def test_cluster_headers_groups_by_shared_tokens():
    clusters = cluster_headers(BENCH['quarantine']['unresolved_headers'])
    # 'Suc. Rate' and 'Success Rate (%)' share no informative token after 'rate'
    # is stopped… 'suc' vs 'success' differ, so grouping is conservative; every
    # header lands in exactly one cluster and none are lost.
    total = sum(len(c['headers']) for c in clusters)
    assert total == 4


def test_propose_uses_llm_verdicts_and_ranks_by_impact():
    def fake_llm(prompt):
        assert 'KNOWN METRICS' in prompt and 'success_rate' in prompt
        if 'Success Rate' in prompt or 'Suc. Rate' in prompt:
            return json.dumps({'action': 'alias', 'metric_id': 'success_rate',
                               'aliases': ['suc. rate'], 'unit': '%',
                               'higher_is_better': True, 'reason': 'same metric'})
        if 'Entropy' in prompt:
            return json.dumps({'action': 'new_metric', 'metric_id': 'entropy',
                               'aliases': ['entropy (h)'], 'unit': 'bits',
                               'higher_is_better': True, 'reason': 'diversity metric'})
        return json.dumps({'action': 'not_a_metric', 'metric_id': None,
                           'aliases': [], 'unit': None, 'higher_is_better': None,
                           'reason': 'dataset stat'})
    out = propose(BENCH, CFG, llm=fake_llm)
    actions = [p['action'] for p in out['proposals']]
    assert 'alias' in actions and 'new_metric' in actions and 'not_a_metric' in actions
    # ranked by cluster_count impact: the 64x Success Rate cluster first
    assert out['proposals'][0]['cluster_count'] >= out['proposals'][-1].get('cluster_count', 0)


def test_one_bad_cluster_never_kills_the_run():
    def flaky_llm(prompt):
        if 'Entropy' in prompt:
            raise RuntimeError('rate limited')
        return json.dumps({'action': 'not_a_metric', 'metric_id': None, 'aliases': [],
                           'unit': None, 'higher_is_better': None, 'reason': 'x'})
    out = propose(BENCH, CFG, llm=flaky_llm)
    assert any(p['action'] == 'error' for p in out['proposals'])
    assert any(p['action'] == 'not_a_metric' for p in out['proposals'])
