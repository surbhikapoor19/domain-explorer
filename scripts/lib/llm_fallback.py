"""Multi-provider LLM fallback (text + vision) — shared convention [A].

A single entry point per modality (``call_text`` / ``call_vision``) iterates a
FIXED priority list of providers, SKIPPING any whose key env is unset/empty, and
returns the first non-empty response. Per-attempt failures are classified so the
right recovery happens (skip a dead key, roll to the next provider, or retry a
transient blip once). Only when EVERY configured provider is exhausted is
``LLMUnavailable`` raised — carrying a ``.summary`` that names each provider tried
with its category + status, so a build's error marker can surface *why* it failed.

Design constraints:
  - stdlib-only HTTP (urllib) for the OpenAI-compatible providers — no new deps.
  - Provider SDKs (anthropic) are imported LAZILY inside their branch; an
    ImportError means "skip this provider", never a crash.
  - Groq's edge is fronted by Cloudflare, which 403s urllib's default
    "Python-urllib/x.y" User-Agent (CF error 1010). Every request therefore carries
    a browser-like UA.

Provider priority:
  text:   Groq -> Gemini -> Gemini(fallback key) -> Anthropic -> HuggingFace
  vision: Gemini -> Gemini(fallback key) -> Anthropic

Vision notes:
  - Docling remains the PRIMARY table extractor; this vision fallback only reads the
    handful of image tables Docling can't (no text layer). Gemini is the VLM.
  - A second Gemini key (GEMINI_API_KEY_2) is tried after the primary quota's (429),
    doubling the effective free-tier headroom without swapping the primary key.
  - Groq and HuggingFace vision are intentionally absent: Groq's VLMs are decommissioned,
    and HuggingFace serves only as a TEXT fallback here.
  - call_vision throttles calls (LLM_VISION_MIN_INTERVAL, default 4s apart) and retries a
    429 with bounded backoff (LLM_VISION_QUOTA_RETRIES, default 2) before rolling over,
    to stay under free-tier RPM limits.
"""
import os
import json
import time
import base64
import urllib.request
import urllib.error

__all__ = ["LLMUnavailable", "call_text", "call_vision"]

# Browser-like UA: Groq's Cloudflare edge 403s the default urllib UA (CF 1010).
_UA = "Mozilla/5.0 (compatible; grasp-explorer/1.0)"

_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
_HF_URL = "https://router.huggingface.co/v1/chat/completions"


def _hf_token():
    """The HF token (TEXT fallback), accepting either env name. The CI historically wired
    the secret to HF_TOKEN while the code read HF_API_TOKEN; support both so HuggingFace
    is never silently skipped for a name mismatch."""
    return os.environ.get("HF_API_TOKEN") or os.environ.get("HF_TOKEN") or ""

# Per-attempt error categories.
AUTH = "AUTH"            # 401/403 -> the key is bad; skip it
QUOTA = "QUOTA"          # 429 or quota-ish body -> roll to the next provider
TRANSIENT = "TRANSIENT"  # 5xx/timeout -> retry once, then next
BADREQUEST = "BADREQUEST"  # other 4xx -> record, next
EMPTY = "EMPTY"          # HTTP 200 with empty/whitespace content -> next

_QUOTA_MARKERS = ("quota", "insufficient", "credit", "rate limit")


class LLMUnavailable(Exception):
    """Raised only after ALL configured providers are exhausted.

    ``.summary`` lists each provider that was actually tried with its category and
    HTTP status (providers skipped for an unset key are not listed).
    """

    def __init__(self, summary):
        super().__init__(summary)
        self.summary = summary


class _ProviderError(Exception):
    """Internal: a single provider attempt failed with a classified category."""

    def __init__(self, category, status):
        super().__init__("%s %s" % (category, status))
        self.category = category
        self.status = status


class _SkipProvider(Exception):
    """Internal: this provider is not usable (e.g. SDK not importable); skip it
    silently without recording an attempt."""


def _classify(status, body):
    """Map an HTTP status + response body to an error category.

    Order matters: 401/403 -> AUTH wins over a quota-ish body; then 429/quota
    markers -> QUOTA; then 5xx -> TRANSIENT; then other 4xx -> BADREQUEST.
    """
    b = (body or "").lower()
    if status in (401, 403):
        return AUTH
    if status == 429 or any(m in b for m in _QUOTA_MARKERS):
        return QUOTA
    if status is not None and 500 <= status < 600:
        return TRANSIENT
    if status is not None and 400 <= status < 500:
        return BADREQUEST
    return BADREQUEST


def _http_post(url, headers, body, timeout=120):
    """POST JSON via urllib. Returns (status, text) on 2xx; raises _ProviderError
    (classified) on an HTTP error, timeout, or connection failure."""
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = getattr(r, "status", None) or getattr(r, "code", None) or 200
            raw = r.read()
        text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
        return status, text
    except urllib.error.HTTPError as e:  # subclass of URLError -> catch first
        status = e.code
        try:
            body_txt = e.read().decode("utf-8", "replace")
        except Exception:
            body_txt = ""
        raise _ProviderError(_classify(status, body_txt), str(status))
    except (urllib.error.URLError, TimeoutError, OSError):
        # No HTTP status (DNS/connect/read timeout) -> transient.
        raise _ProviderError(TRANSIENT, "timeout")


def _openai_compat(url, api_key, payload, timeout=120):
    """Call an OpenAI-compatible chat endpoint (Groq / Gemini / HF). Returns the
    message content string, or raises _ProviderError (incl. EMPTY on blank content)."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + api_key,
        "User-Agent": _UA,
    }
    status, body = _http_post(url, headers, json.dumps(payload).encode(), timeout)
    try:
        data = json.loads(body)
        content = ((((data.get("choices") or [{}])[0]) or {}).get("message") or {}).get("content")
    except (ValueError, TypeError, KeyError, IndexError):
        content = None
    if content is None or not str(content).strip():
        raise _ProviderError(EMPTY, str(status))
    return str(content)


def _openai_vision_payload(model, png_bytes, prompt, max_tokens):
    """Vision payload in OpenAI-compatible shape (image as a data: URL). Mirrors the
    original Groq-vision call: system carries the instruction, the user turn carries
    the image + a short 'Extract this table.' nudge."""
    b64 = base64.standard_b64encode(png_bytes).decode()
    return {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
                {"type": "text", "text": "Extract this table."},
            ]},
        ],
    }


def _anthropic_text_of(resp):
    """Pull the first text block out of an Anthropic messages response, tolerantly."""
    try:
        return resp.content[0].text
    except (AttributeError, IndexError, TypeError):
        return ""


def _classify_anthropic(e):
    """Map an anthropic SDK exception to a _ProviderError."""
    name = type(e).__name__.lower()
    status = getattr(e, "status_code", None)
    if status is None and ("timeout" in name or "connection" in name):
        return _ProviderError(TRANSIENT, "timeout")
    cat = _classify(status, str(e))
    return _ProviderError(cat, str(status if status is not None else "err"))


# ---------------------------------------------------------------------------
# Text providers
# ---------------------------------------------------------------------------

def _groq_text(messages, max_tokens, temperature):
    model = os.environ.get("GROQ_MODEL") or "openai/gpt-oss-120b"
    payload = {"model": model, "messages": messages,
               "max_tokens": max_tokens, "temperature": temperature}
    # gpt-oss are reasoning models: hidden reasoning consumes max_tokens, so cap it
    # or long prompts return truncated/empty extractions.
    if "gpt-oss" in model:
        payload["reasoning_effort"] = "low"
    return _openai_compat(_GROQ_URL, os.environ["GROQ_API_KEY"], payload)


def _gemini_text(messages, max_tokens, temperature, key_env="GEMINI_API_KEY"):
    model = os.environ.get("GEMINI_MODEL") or "gemini-flash-latest"
    payload = {"model": model, "messages": messages,
               "max_tokens": max_tokens, "temperature": temperature}
    return _openai_compat(_GEMINI_URL, os.environ[key_env], payload)


def _hf_text(messages, max_tokens, temperature):
    model = os.environ.get("HF_MODEL") or os.environ.get("AI_MODEL") or "Qwen/Qwen2.5-72B-Instruct"
    payload = {"model": model, "messages": messages,
               "max_tokens": max_tokens, "temperature": temperature}
    return _openai_compat(_HF_URL, _hf_token(), payload)


def _anthropic_text(messages, max_tokens, temperature):
    try:
        import anthropic
    except ImportError:
        raise _SkipProvider()
    model = os.environ.get("CLAUDE_MODEL") or "claude-haiku-4-5"
    system_msg = ""
    user_msgs = []
    for m in messages:
        if m.get("role") == "system":
            system_msg = m.get("content", "")
        else:
            user_msgs.append(m)
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    try:
        resp = client.messages.create(
            model=model, max_tokens=max_tokens,
            system=system_msg if system_msg else "",
            messages=user_msgs, temperature=temperature)
    except Exception as e:
        raise _classify_anthropic(e)
    text = _anthropic_text_of(resp)
    if not str(text or "").strip():
        raise _ProviderError(EMPTY, "200")
    return str(text)


# ---------------------------------------------------------------------------
# Vision providers
# ---------------------------------------------------------------------------

def _groq_vision(png_bytes, prompt, max_tokens):
    # Retained for completeness only — NOT in the vision priority list: every Groq VLM
    # (llama-4-scout/maverick, llama-3.2-vision previews) is 404/decommissioned.
    model = os.environ.get("VLM_GROQ_MODEL") or "meta-llama/llama-4-scout-17b-16e-instruct"
    return _openai_compat(_GROQ_URL, os.environ["GROQ_API_KEY"],
                          _openai_vision_payload(model, png_bytes, prompt, max_tokens))


def _gemini_vision(png_bytes, prompt, max_tokens, key_env="GEMINI_API_KEY"):
    model = os.environ.get("VLM_GEMINI_MODEL") or "gemini-flash-latest"
    return _openai_compat(_GEMINI_URL, os.environ[key_env],
                          _openai_vision_payload(model, png_bytes, prompt, max_tokens))


def _anthropic_vision(png_bytes, prompt, max_tokens):
    try:
        import anthropic
    except ImportError:
        raise _SkipProvider()
    model = os.environ.get("VLM_ANTHROPIC_MODEL") or os.environ.get("CLAUDE_VISION_MODEL") or "claude-sonnet-4-6"
    b64 = base64.standard_b64encode(png_bytes).decode()
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    try:
        msg = client.messages.create(
            model=model, max_tokens=max_tokens,
            system=[{"type": "text", "text": prompt,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64",
                                             "media_type": "image/png", "data": b64}},
                {"type": "text", "text": "Extract this table."}]}])
    except Exception as e:
        raise _classify_anthropic(e)
    text = _anthropic_text_of(msg)
    if not str(text or "").strip():
        raise _ProviderError(EMPTY, "200")
    return str(text)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

# Process-global timestamp of the last throttled attempt (vision only). A list so the
# closure can mutate it; monotonic clock so it is immune to wall-clock jumps.
_last_throttled_ts = [0.0]


def _throttle(min_interval):
    """Space successive (vision) attempts >= min_interval seconds apart, so a burst of
    table crops stays under a free-tier RPM ceiling. No-op when min_interval <= 0."""
    if min_interval <= 0:
        return
    wait = min_interval - (time.monotonic() - _last_throttled_ts[0])
    if wait > 0:
        time.sleep(wait)
    _last_throttled_ts[0] = time.monotonic()


def _run_once_with_retry(fn, *, min_interval=0.0, quota_retries=0):
    """Run one provider attempt, spacing it by min_interval. Retries:
      - TRANSIENT (5xx/timeout): sleep 2s and retry exactly once.
      - QUOTA (429/quota body): retry up to quota_retries times with bounded exponential
        backoff (2s, 4s, ... capped 30s) to ride out a per-minute rate limit before the
        caller rolls over to the next provider.
    A category not retried (or its budget exhausted) propagates."""
    transient_used = False
    quota_used = 0
    while True:
        _throttle(min_interval)
        try:
            return fn()
        except _ProviderError as e:
            if e.category == TRANSIENT and not transient_used:
                transient_used = True
                time.sleep(2)
                continue
            if e.category == QUOTA and quota_used < quota_retries:
                quota_used += 1
                time.sleep(min(2 * (2 ** (quota_used - 1)), 30))
                continue
            raise


def _keys_present(key_env):
    """True if ANY of the provider's candidate key envs is set/non-empty. key_env is a
    single env name or a tuple of alternatives (e.g. ('HF_API_TOKEN', 'HF_TOKEN'))."""
    envs = (key_env,) if isinstance(key_env, str) else tuple(key_env)
    return any((os.environ.get(e) or "").strip() for e in envs)


def _dispatch(providers, *, min_interval=0.0, quota_retries=0):
    """Iterate (name, key_env, fn) in order, skipping providers whose key(s) are all
    unset, returning the first non-empty content. Raise LLMUnavailable with a
    per-provider summary once all are exhausted."""
    tried = []
    for name, key_env, fn in providers:
        if not _keys_present(key_env):
            continue  # key unset/empty -> skip (not recorded as an attempt)
        try:
            content = _run_once_with_retry(fn, min_interval=min_interval, quota_retries=quota_retries)
        except _SkipProvider:
            continue
        except _ProviderError as e:
            tried.append("%s=%s(%s)" % (name, e.category, e.status))
            continue
        except Exception as e:  # defensive: an unexpected provider-side error
            tried.append("%s=ERROR(%s)" % (name, type(e).__name__))
            continue
        if content and content.strip():
            return content
        tried.append("%s=%s(200)" % (name, EMPTY))
    summary = "; ".join(tried) if tried else "no LLM provider configured (all keys unset/empty)"
    raise LLMUnavailable(summary)


def call_text(messages, max_tokens=1024, temperature=0.0):
    """Chat-completion with multi-provider fallback (Groq -> Gemini -> Anthropic ->
    HuggingFace). ``messages`` is OpenAI-format [{role, content}, ...]. Returns the
    response text; raises LLMUnavailable if every configured provider fails."""
    providers = [
        ("groq", "GROQ_API_KEY", lambda: _groq_text(messages, max_tokens, temperature)),
        ("gemini", "GEMINI_API_KEY", lambda: _gemini_text(messages, max_tokens, temperature, "GEMINI_API_KEY")),
        ("gemini-2", "GEMINI_API_KEY_2", lambda: _gemini_text(messages, max_tokens, temperature, "GEMINI_API_KEY_2")),
        ("anthropic", "ANTHROPIC_API_KEY", lambda: _anthropic_text(messages, max_tokens, temperature)),
        ("huggingface", ("HF_API_TOKEN", "HF_TOKEN"), lambda: _hf_text(messages, max_tokens, temperature)),
    ]
    return _dispatch(providers)


def call_vision(png_bytes, prompt, max_tokens=2000):
    """Vision completion (a PNG crop + instruction) with multi-provider fallback
    (Gemini -> Gemini(fallback key) -> Anthropic). Docling stays the PRIMARY extractor;
    this VLM only reads the image tables Docling can't. A second Gemini key backs up the
    first on a 429, doubling free-tier headroom without swapping the primary key. Groq and
    HuggingFace are absent from the vision path (Groq's VLMs are decommissioned; HF is a
    text-only fallback here). Calls are throttled and 429s are backoff-retried before
    rolling over. Returns the model's raw text; raises LLMUnavailable if every provider
    fails."""
    min_interval = float(os.environ.get("LLM_VISION_MIN_INTERVAL", "4"))
    quota_retries = int(os.environ.get("LLM_VISION_QUOTA_RETRIES", "2"))
    providers = [
        ("gemini", "GEMINI_API_KEY", lambda: _gemini_vision(png_bytes, prompt, max_tokens, "GEMINI_API_KEY")),
        ("gemini-2", "GEMINI_API_KEY_2", lambda: _gemini_vision(png_bytes, prompt, max_tokens, "GEMINI_API_KEY_2")),
        ("anthropic", "ANTHROPIC_API_KEY", lambda: _anthropic_vision(png_bytes, prompt, max_tokens)),
    ]
    return _dispatch(providers, min_interval=min_interval, quota_retries=quota_retries)
