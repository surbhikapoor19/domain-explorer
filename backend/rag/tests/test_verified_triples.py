"""verified_triple_extractor + apply_verified_triples — AUTHORED BY ORCHESTRATOR.
The anti-hallucination contract: a triple survives ONLY if its quote is literally
in the chunk; surviving triples become KG edges that carry the quote."""
import json
import networkx as nx
from rag.ingest.verified_triple_extractor import (
    verify_quote, parse_triples, extract_verified_triples)
from rag.knowledge_graph import apply_verified_triples

CHUNK = {
    'chunk_id': 'c1', 'paper_id': 'dexdiffuser', 'layer': 'mid',
    'text': ('Our method uses a PointNet++ backbone to encode the scene point cloud. '
             'We train on the ACRONYM dataset and evaluate grasps in Isaac Gym. '
             'A limitation is that inference requires evaluator-guided sampling, '
             'which adds significant computation at test time. ' + 'pad ' * 20),
}

def _fake_llm(messages, **kw):
    # One verbatim quote, one PARAPHRASED quote (must be rejected), one bad relation.
    return json.dumps({'triples': [
        {'relation': 'uses_backbone', 'object': 'PointNet++',
         'quote': 'uses a PointNet++ backbone to encode the scene point cloud'},
        {'relation': 'trained_on', 'object': 'ACRONYM',
         'quote': 'the model is trained using the ACRONYM grasp corpus'},   # paraphrase!
        {'relation': 'invented_relation', 'object': 'X', 'quote': 'Our method uses a PointNet++'},
    ]})

def test_quote_verification_is_the_gate():
    assert verify_quote('uses a PointNet++ backbone to encode', CHUNK['text'])
    assert not verify_quote('the model is trained using the ACRONYM grasp corpus', CHUNK['text'])
    assert not verify_quote('short', CHUNK['text'])          # under min length

def test_extract_keeps_only_verbatim_schema_triples():
    out = extract_verified_triples([CHUNK], _fake_llm)
    assert out['stats']['kept'] == 1
    assert out['stats']['rejected_unverifiable_quote'] == 1   # the paraphrase died
    t = out['triples'][0]
    assert t['relation'] == 'uses_backbone' and t['paper_id'] == 'dexdiffuser'
    assert t['chunk_id'] == 'c1'

def test_apply_creates_provenance_carrying_edges_with_shared_node_ids():
    G = nx.DiGraph()
    G.add_node('paper:dexdiffuser', type='paper')
    G.add_node('paper:graspgen', type='paper')
    triples = [
        {'relation': 'uses_backbone', 'object': 'pointnet++',
         'quote': 'uses a PointNet++ backbone', 'chunk_id': 'c1', 'paper_id': 'dexdiffuser'},
        {'relation': 'outperforms_claim', 'object': 'outperforms GraspGen by 4%',
         'quote': 'outperforms GraspGen by 4%', 'chunk_id': 'c2', 'paper_id': 'dexdiffuser'},
    ]
    n = apply_verified_triples(G, triples, ['GraspGen', 'DexDiffuser'],
                               {'GraspGen': 'graspgen', 'DexDiffuser': 'dexdiffuser'})
    assert n == 2
    # backbone node uses the SAME id convention as the heuristic track (merges, no dupes)
    assert G.has_node('tech:backbone:PointNet++')
    e = G.get_edge_data('paper:dexdiffuser', 'tech:backbone:PointNet++')
    assert e['extraction'] == 'verified_llm' and 'PointNet++' in e['quote']
    # the outperforms claim resolved to the target paper and carries the quote
    op = G.get_edge_data('paper:dexdiffuser', 'paper:graspgen')
    assert op['type'] == 'outperforms' and op['extraction'] == 'verified_llm'

def test_parse_tolerates_junk():
    assert parse_triples('no json here') == []
    assert parse_triples('{"triples": "notalist"}') == []
