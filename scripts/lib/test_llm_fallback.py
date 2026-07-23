"""Unit tests for the multi-provider LLM fallback (scripts/lib/llm_fallback.py).

The HTTP layer (urllib) is fully MOCKED — no real network calls. Anthropic uses an
SDK branch, so the text/vision cases here drive the urllib-based providers (Groq,
Gemini, HuggingFace) and leave ANTHROPIC_API_KEY unset so that provider is skipped.

Covered:
  - 429            -> QUOTA  -> rolls to the next provider
  - 401            -> AUTH   -> skips that key, uses the next provider
  - all providers fail       -> LLMUnavailable whose .summary names each one tried
  - unset key env            -> that provider is skipped (never requested)
  - 200-with-content on provider 2 after provider 1 QUOTAs -> returns that content
Plus: quota-marker body classification, EMPTY-200 fall-through, transient single retry.
"""
import io
import os
import sys
import json
import urllib.request
import urllib.error

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_fallback as LF


# ---------------------------------------------------------------------------
# Mock helpers
# ---------------------------------------------------------------------------

class _Resp:
    """Minimal stand-in for the urlopen context-manager response."""

    def __init__(self, content, status=200):
        self._body = json.dumps(
            {"choices": [{"message": {"content": content}}]}).encode()
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


def _http_error(code, body=b""):
    return urllib.error.HTTPError(
        url="http://x", code=code, msg="err", hdrs=None, fp=io.BytesIO(body))


def _install(monkeypatch, route):
    """Patch urllib.request.urlopen with a URL-routed fake; return the call log.

    `route(url)` returns either a _Resp (success) or an Exception (raised).
    """
    calls = []

    def _urlopen(req, timeout=None):
        url = req.full_url
        calls.append(url)
        action = route(url)
        if isinstance(action, Exception):
            raise action
        return action

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    # Never actually sleep on transient retries.
    monkeypatch.setattr(LF.time, "sleep", lambda *a, **k: None)
    return calls


def _only(monkeypatch, *set_keys):
    """Set exactly the given provider key envs; clear all the others."""
    for var in ("GROQ_API_KEY", "GEMINI_API_KEY", "GEMINI_API_KEY_2",
                "ANTHROPIC_API_KEY", "HF_API_TOKEN", "HF_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    for var in set_keys:
        monkeypatch.setenv(var, "test-key")
    # Deterministic vision dispatch in tests: no throttle wait and no quota retries, so
    # provider-rollover assertions see exactly one attempt per provider. The dedicated
    # throttle/backoff tests override these explicitly.
    monkeypatch.setenv("LLM_VISION_MIN_INTERVAL", "0")
    monkeypatch.setenv("LLM_VISION_QUOTA_RETRIES", "0")


MSGS = [{"role": "user", "content": "hi"}]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_429_quota_rolls_to_next_provider(monkeypatch):
    _only(monkeypatch, "GROQ_API_KEY", "GEMINI_API_KEY")
    calls = _install(monkeypatch, lambda url: (
        _http_error(429, b'{"error": "Too Many Requests"}') if "groq" in url
        else _Resp("FROM_GEMINI")))

    assert LF.call_text(MSGS) == "FROM_GEMINI"
    assert any("groq" in u for u in calls)                 # groq WAS attempted
    assert any("generativelanguage" in u for u in calls)   # ...then gemini used


def test_401_auth_skips_key_and_uses_next(monkeypatch):
    _only(monkeypatch, "GROQ_API_KEY", "GEMINI_API_KEY")
    _install(monkeypatch, lambda url: (
        _http_error(401, b"invalid api key") if "groq" in url
        else _Resp("FROM_GEMINI_AFTER_AUTH")))

    assert LF.call_text(MSGS) == "FROM_GEMINI_AFTER_AUTH"


def test_all_providers_fail_raises_naming_each_tried(monkeypatch):
    # groq + gemini + HF set (anthropic unset -> skipped, must NOT be named).
    _only(monkeypatch, "GROQ_API_KEY", "GEMINI_API_KEY", "HF_API_TOKEN")

    def route(url):
        if "groq" in url:
            return _http_error(429)               # QUOTA
        if "generativelanguage" in url:
            return _http_error(401)               # AUTH
        return _http_error(403)                   # HF -> AUTH

    _install(monkeypatch, route)

    with pytest.raises(LF.LLMUnavailable) as ei:
        LF.call_text(MSGS)
    summary = ei.value.summary
    assert "groq" in summary and "gemini" in summary and "huggingface" in summary
    assert "anthropic" not in summary             # unset key -> not tried, not named
    assert "QUOTA" in summary and "AUTH" in summary


def test_unset_key_provider_is_skipped(monkeypatch):
    # Only gemini configured: groq must be skipped entirely (never requested).
    _only(monkeypatch, "GEMINI_API_KEY")
    calls = _install(monkeypatch, lambda url: _Resp("ONLY_GEMINI"))

    assert LF.call_text(MSGS) == "ONLY_GEMINI"
    assert not any("groq" in u for u in calls)    # groq skipped (key unset)
    assert all("generativelanguage" in u for u in calls)


def test_200_with_content_on_provider2_after_provider1_quotas(monkeypatch):
    # Provider 1 (groq) QUOTAs via a quota-marker body on a non-429 status;
    # provider 2 (gemini) returns 200 with content.
    _only(monkeypatch, "GROQ_API_KEY", "GEMINI_API_KEY")
    _install(monkeypatch, lambda url: (
        _http_error(503, b'{"message": "insufficient_quota for this key"}') if "groq" in url
        else _Resp("RECOVERED_CONTENT")))

    assert LF.call_text(MSGS) == "RECOVERED_CONTENT"


def test_empty_200_falls_through(monkeypatch):
    # groq returns HTTP 200 but blank content -> EMPTY -> try gemini.
    _only(monkeypatch, "GROQ_API_KEY", "GEMINI_API_KEY")
    _install(monkeypatch, lambda url: (
        _Resp("   ") if "groq" in url else _Resp("NON_EMPTY")))

    assert LF.call_text(MSGS) == "NON_EMPTY"


def test_transient_5xx_retries_once_then_next(monkeypatch):
    # groq 500 on BOTH attempts (retry exhausted) -> roll to gemini.
    state = {"groq": 0}

    def route(url):
        if "groq" in url:
            state["groq"] += 1
            return _http_error(500)
        return _Resp("AFTER_TRANSIENT")

    _only(monkeypatch, "GROQ_API_KEY", "GEMINI_API_KEY")
    _install(monkeypatch, route)

    assert LF.call_text(MSGS) == "AFTER_TRANSIENT"
    assert state["groq"] == 2                      # initial + exactly one retry


def test_no_keys_raises_llm_unavailable(monkeypatch):
    _only(monkeypatch)  # nothing set
    monkeypatch.setattr(LF.time, "sleep", lambda *a, **k: None)
    with pytest.raises(LF.LLMUnavailable) as ei:
        LF.call_text(MSGS)
    assert "all keys unset" in ei.value.summary


def test_call_vision_routes_and_returns(monkeypatch):
    # Vision path (image sent as data URL): Gemini is the primary VLM and returns content.
    # (Docling stays the primary extractor; this VLM only reads image tables.)
    _only(monkeypatch, "GEMINI_API_KEY")
    _install(monkeypatch, lambda url: _Resp('{"rows": []}'))

    out = LF.call_vision(b"\x89PNG\r\n", "extract the table", max_tokens=2000)
    assert out == '{"rows": []}'


def test_vision_tries_gemini_first(monkeypatch):
    # Gemini is the PRIMARY vision provider: a 200-with-content from gemini is returned
    # (anthropic, the only other configured provider, is never reached).
    _only(monkeypatch, "GEMINI_API_KEY", "ANTHROPIC_API_KEY")
    calls = _install(monkeypatch, lambda url: _Resp("FROM_GEMINI_VISION"))

    out = LF.call_vision(b"\x89PNG\r\n", "extract the table", max_tokens=2000)
    assert out == "FROM_GEMINI_VISION"
    assert any("generativelanguage" in u for u in calls)   # gemini attempted first


def test_vision_gemini_key1_quota_falls_to_key2(monkeypatch):
    # Primary Gemini key 429s -> the SECOND Gemini key (GEMINI_API_KEY_2) is tried against
    # the same endpoint and succeeds. Both hit generativelanguage, so we assert TWO gemini
    # attempts (key1 then key2) and the recovered content.
    _only(monkeypatch, "GEMINI_API_KEY", "GEMINI_API_KEY_2")
    state = {"n": 0}

    def route(url):
        if "generativelanguage" in url:
            state["n"] += 1
            return _http_error(429) if state["n"] == 1 else _Resp("FROM_GEMINI_KEY2")
        return _http_error(500)

    calls = _install(monkeypatch, route)
    out = LF.call_vision(b"\x89PNG\r\n", "extract the table", max_tokens=2000)
    assert out == "FROM_GEMINI_KEY2"
    assert sum("generativelanguage" in u for u in calls) == 2   # key1 (429) then key2 (200)


def test_vision_groq_and_hf_absent_from_vision_path(monkeypatch):
    # Groq VLMs are decommissioned and HuggingFace is a TEXT-only fallback -> neither is a
    # vision provider even when its key is set. With only GROQ + HF keys, no vision
    # provider is configured -> LLMUnavailable, and neither is requested / named.
    _only(monkeypatch, "GROQ_API_KEY", "HF_API_TOKEN")
    calls = _install(monkeypatch, lambda url: _Resp("SHOULD_NOT_BE_CALLED"))
    with pytest.raises(LF.LLMUnavailable) as ei:
        LF.call_vision(b"\x89PNG\r\n", "extract the table", max_tokens=2000)
    assert not any("groq" in u or "huggingface" in u for u in calls)
    assert "groq" not in ei.value.summary and "huggingface" not in ei.value.summary


def test_text_hf_token_alias_selects_hf(monkeypatch):
    # HF is a TEXT fallback whose token may live in HF_TOKEN (the CI secret name) rather
    # than HF_API_TOKEN; the text HF provider must still be selected via the
    # (HF_API_TOKEN, HF_TOKEN) key alias.
    _only(monkeypatch, "HF_TOKEN")  # only the alias env is set
    calls = _install(monkeypatch, lambda url: _Resp("FROM_HF_TEXT"))

    assert LF.call_text(MSGS) == "FROM_HF_TEXT"
    assert all("huggingface" in u for u in calls)


def test_vision_quota_retry_backoff_before_rollover(monkeypatch):
    # With LLM_VISION_QUOTA_RETRIES=2, a 429 on the sole Gemini provider is retried twice
    # (initial + 2) before exhausting -> exactly 3 attempts. time.sleep is mocked.
    _only(monkeypatch, "GEMINI_API_KEY")
    monkeypatch.setenv("LLM_VISION_QUOTA_RETRIES", "2")
    monkeypatch.setenv("LLM_VISION_MIN_INTERVAL", "0")
    calls = _install(monkeypatch, lambda url: _http_error(429))
    with pytest.raises(LF.LLMUnavailable):
        LF.call_vision(b"\x89PNG\r\n", "extract the table", max_tokens=2000)
    assert sum("generativelanguage" in u for u in calls) == 3   # initial + 2 backoff retries


def test_throttle_spaces_successive_calls(monkeypatch):
    # _throttle sleeps for the remaining interval when the previous call was too recent,
    # and is a no-op when the interval is disabled.
    slept = []
    monkeypatch.setattr(LF.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(LF.time, "sleep", lambda s: slept.append(s))
    LF._last_throttled_ts[0] = 98.0            # last attempt 2s ago
    LF._throttle(5.0)                          # need 5s spacing -> sleep the remaining 3s
    assert slept and abs(slept[0] - 3.0) < 1e-6
    slept.clear()
    LF._throttle(0.0)                          # disabled -> no sleep
    assert slept == []


if __name__ == "__main__":
    sys.exit(pytest.main([os.path.abspath(__file__), "-v"]))
