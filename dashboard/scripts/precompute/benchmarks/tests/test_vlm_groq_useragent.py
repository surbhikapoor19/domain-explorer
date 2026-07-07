"""Regression: call_vlm_groq must send a non-default User-Agent — AUTHORED BY
ORCHESTRATOR. Implementers must NOT modify.

Groq's API is fronted by Cloudflare, which 403s urllib's default "Python-urllib/x.y"
User-Agent (CF error 1010). That block silently turned every CI benchmark extraction
into an empty output (runs 28857742075 / 28864909050). The request MUST carry a
browser-like UA so it reaches the Groq API.
"""
import json
import urllib.request
import benchmarks.extraction.vlm_extract as V


def test_call_vlm_groq_sets_non_default_user_agent(monkeypatch):
    captured = {}

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode()

    def _fake_urlopen(req, timeout=None):
        # urllib normalizes header keys to Title-Case in req.headers
        captured["ua"] = req.get_header("User-agent")
        return _Resp()

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    V.call_vlm_groq(b"\x89PNG\r\n", "test-key", model="meta-llama/llama-4-scout-17b-16e-instruct")

    ua = captured.get("ua")
    assert ua, "call_vlm_groq sent no User-Agent (Cloudflare will 403 it)"
    assert "python-urllib" not in ua.lower(), f"default urllib UA will be CF-blocked: {ua!r}"
