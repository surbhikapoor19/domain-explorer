"""Turn quarantined (unresolved) metric headers into REVIEWABLE registry proposals.

The benchmark aggregate reports every table header it could not map to a known
metric (`quarantine.unresolved_headers`). Instead of leaving those as a landfill,
this CLI clusters them by shared tokens and asks an LLM to propose, per cluster,
either an alias onto an EXISTING metric id or a NEW metric entry — written to a
proposals JSON for a human to review and merge into the domain config. Nothing is
ever auto-applied: the registry stays human-owned.

Usage:
    python -m benchmarks.aggregate.propose_aliases \
        --benchmarks <benchmark-comparisons.json> \
        --config <domain config json> \
        --output <proposals.json>
"""
import argparse
import json
import os
import re
import urllib.request

GROQ_MODEL = os.environ.get('GROQ_MODEL', 'openai/gpt-oss-120b')


def _norm_tokens(header):
    return set(re.findall(r'[a-z0-9]+', str(header or '').lower())) - {
        'the', 'of', 'in', 'on', 'per', 'rate', 'avg', 'average', 'mean'}


def cluster_headers(headers, min_shared=1):
    """Greedy token-overlap clustering: headers sharing >= min_shared informative
    tokens join one cluster. Deterministic (input order)."""
    clusters = []  # [{tokens:set, headers:[{raw,count}]}]
    for h in headers:
        toks = _norm_tokens(h.get('raw'))
        best = None
        for c in clusters:
            if len(toks & c['tokens']) >= min_shared and toks and c['tokens']:
                best = c
                break
        if best is None:
            clusters.append({'tokens': set(toks), 'headers': [h]})
        else:
            best['tokens'] |= toks
            best['headers'].append(h)
    return clusters


def build_prompt(cluster, known_metrics):
    known = '\n'.join(f"- {m['id']}: aliases {m.get('aliases', [])}" for m in known_metrics)
    headers = '\n'.join(f"- \"{h['raw']}\" (seen {h.get('count', 1)}x)" for h in cluster['headers'])
    return (
        "You maintain the metric registry of a robotics benchmark extractor. These RAW TABLE "
        "HEADERS could not be mapped to a known metric:\n"
        f"{headers}\n\nKNOWN METRICS:\n{known}\n\n"
        "For the cluster as a whole, respond with ONLY a JSON object:\n"
        '{"action": "alias" | "new_metric" | "not_a_metric",\n'
        ' "metric_id": "<existing id if alias, or a new snake_case id if new_metric>",\n'
        ' "aliases": ["header strings to add as aliases"],\n'
        ' "unit": "<unit or null>", "higher_is_better": true|false|null,\n'
        ' "reason": "<one line>"}\n'
        "Use \"not_a_metric\" for junk (dataset stats, row labels, fragments)."
    )


def _default_llm(prompt):
    key = os.environ.get('GROQ_API_KEY')
    if not key:
        raise RuntimeError('GROQ_API_KEY not set')
    body = json.dumps({
        'model': GROQ_MODEL, 'max_tokens': 500, 'temperature': 0,
        'reasoning_effort': 'low',
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()
    req = urllib.request.Request(
        'https://api.groq.com/openai/v1/chat/completions', data=body,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    return data['choices'][0]['message']['content'] or ''


def propose(benchmarks, cfg, llm=None, max_clusters=40):
    """-> {proposals: [...], skipped: int}. `llm` injectable for tests."""
    llm = llm or _default_llm
    headers = (benchmarks.get('quarantine', {}) or {}).get('unresolved_headers', []) or []
    known = cfg.get('metrics', [])
    clusters = cluster_headers(headers)
    proposals = []
    for c in clusters[:max_clusters]:
        try:
            raw = llm(build_prompt(c, known))
            m = re.search(r'\{.*\}', raw, re.DOTALL)
            if not m:
                continue
            p = json.loads(m.group(0))
            if p.get('action') not in ('alias', 'new_metric', 'not_a_metric'):
                continue
            p['cluster_headers'] = [h['raw'] for h in c['headers']]
            p['cluster_count'] = sum(h.get('count', 1) for h in c['headers'])
            proposals.append(p)
        except Exception as e:  # one bad cluster never kills the run
            proposals.append({'action': 'error', 'error': str(e)[:120],
                              'cluster_headers': [h['raw'] for h in c['headers']]})
    # Highest-impact first (most quarantined records recovered per approval).
    proposals.sort(key=lambda p: -p.get('cluster_count', 0))
    return {'proposals': proposals, 'skipped_clusters': max(0, len(clusters) - max_clusters)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--benchmarks', required=True)
    ap.add_argument('--config', required=True)
    ap.add_argument('--output', required=True)
    a = ap.parse_args(argv)
    with open(a.benchmarks) as f:
        bench = json.load(f)
    with open(a.config) as f:
        cfg = json.load(f)
    out = propose(bench, cfg)
    with open(a.output, 'w') as f:
        json.dump(out, f, indent=2)
    n = len([p for p in out['proposals'] if p.get('action') in ('alias', 'new_metric')])
    print(f"  wrote {a.output}: {len(out['proposals'])} cluster proposals "
          f"({n} actionable — review and merge into the domain config manually)")


if __name__ == '__main__':
    main()
