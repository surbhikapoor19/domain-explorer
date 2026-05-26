"""Thin Semantic Scholar Graph API client.

Endpoints used (see https://api.semanticscholar.org/api-docs/graph):
  - GET /graph/v1/paper/search/match           (best title-match lookup)
  - GET /graph/v1/paper/search                 (fallback fuzzy search)
  - GET /graph/v1/paper/{paper_id}             (paper details, accepts DOI:..., ARXIV:..., etc.)
  - GET /graph/v1/paper/{paper_id}/references  (cited works; up to 1000 per page)
  - GET /graph/v1/paper/{paper_id}/citations   (citing works; carries `contexts` array)

Rate limit: S2 free tier allows 1 req/sec across all endpoints. We throttle to
one request every ~1.05s (≈0.95 req/sec) cumulative across all calls.

The API key is read from the environment variable ``SEMANTIC_SCHOLAR_API_KEY``.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Iterable, Optional

import requests


logger = logging.getLogger(__name__)

S2_BASE_URL = "https://api.semanticscholar.org/graph/v1"
DEFAULT_MIN_INTERVAL_SEC = 1.05  # ~0.95 req/sec, safely under 1 req/sec
DEFAULT_TIMEOUT_SEC = 30
DEFAULT_MAX_RETRIES = 3


class S2Client:
    """Polite client for the Semantic Scholar Graph API.

    All HTTP calls funnel through ``_get`` which serialises requests behind a
    process-wide lock and enforces ``min_interval_sec`` between calls. That
    guarantee holds even if the caller interleaves ``get_paper`` / ``get_references``
    / ``get_citations`` — the throttle is cumulative across endpoints, as the
    S2 docs require.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        min_interval_sec: float = DEFAULT_MIN_INTERVAL_SEC,
        timeout_sec: float = DEFAULT_TIMEOUT_SEC,
        max_retries: int = DEFAULT_MAX_RETRIES,
        session: Optional[requests.Session] = None,
    ):
        self.api_key = api_key or os.environ.get("SEMANTIC_SCHOLAR_API_KEY")
        self.min_interval_sec = float(min_interval_sec)
        self.timeout_sec = float(timeout_sec)
        self.max_retries = int(max_retries)
        self.session = session or requests.Session()

        # Throttle state. Initialise so the first request fires immediately.
        self._lock = threading.Lock()
        self._last_request_ts = 0.0

        # Counters surfaced for the smoke-test report.
        self.rate_limit_events = 0
        self.server_error_events = 0

    # ------------------------------------------------------------------
    # Internal HTTP helpers
    # ------------------------------------------------------------------
    def _headers(self) -> dict:
        # S2 accepts the key under x-api-key. We never log this header.
        if self.api_key:
            return {"x-api-key": self.api_key, "Accept": "application/json"}
        return {"Accept": "application/json"}

    def _wait_for_slot(self) -> None:
        """Block until at least ``min_interval_sec`` has passed since the last call."""
        now = time.monotonic()
        delta = now - self._last_request_ts
        if delta < self.min_interval_sec:
            time.sleep(self.min_interval_sec - delta)
        self._last_request_ts = time.monotonic()

    def _get(self, path: str, params: Optional[dict] = None) -> Optional[dict]:
        """Throttled GET with exponential backoff on 429/5xx.

        Returns parsed JSON on success, ``None`` on permanent failure.
        """
        url = f"{S2_BASE_URL}{path}"
        backoff = 2.0
        for attempt in range(1, self.max_retries + 1):
            with self._lock:
                self._wait_for_slot()
                try:
                    resp = self.session.get(
                        url,
                        params=params,
                        headers=self._headers(),
                        timeout=self.timeout_sec,
                    )
                except requests.RequestException as e:
                    logger.warning("S2 request error on %s (attempt %d/%d): %s",
                                   path, attempt, self.max_retries, e)
                    if attempt == self.max_retries:
                        return None
                    time.sleep(backoff)
                    backoff *= 2
                    continue

            status = resp.status_code
            if status == 200:
                try:
                    return resp.json()
                except ValueError:
                    logger.warning("S2 returned non-JSON for %s", path)
                    return None
            if status == 404:
                # Not found is a permanent miss — don't retry.
                logger.info("S2 404 for %s (params=%s)", path, params)
                return None
            if status == 429:
                self.rate_limit_events += 1
                logger.warning("S2 429 rate-limited on %s (attempt %d/%d); backing off %.1fs",
                               path, attempt, self.max_retries, backoff)
                if attempt == self.max_retries:
                    return None
                time.sleep(backoff)
                backoff *= 2
                continue
            if 500 <= status < 600:
                self.server_error_events += 1
                logger.warning("S2 %d on %s (attempt %d/%d); backing off %.1fs",
                               status, path, attempt, self.max_retries, backoff)
                if attempt == self.max_retries:
                    return None
                time.sleep(backoff)
                backoff *= 2
                continue
            # Other 4xx: log + give up. Body may carry useful debug info.
            body_preview = (resp.text or "")[:200]
            logger.warning("S2 %d on %s; giving up. body=%s", status, path, body_preview)
            return None
        return None

    # ------------------------------------------------------------------
    # Public lookup methods
    # ------------------------------------------------------------------
    DEFAULT_PAPER_FIELDS = (
        "paperId,externalIds,title,authors,year,venue,abstract,"
        "citationCount,referenceCount"
    )

    def get_paper(self, title_or_doi: str, fields: Optional[str] = None) -> Optional[dict]:
        """Resolve a paper by DOI/arXiv id or by title-match.

        Order of attempts:
          1. If the input looks like a DOI / arXiv id, hit /paper/{id} directly.
          2. Otherwise call /paper/search/match (S2's best-title-match endpoint).
          3. If match returns nothing, fall back to /paper/search (fuzzy).

        Each attempt is one throttled request.
        """
        if not title_or_doi:
            return None
        fields = fields or self.DEFAULT_PAPER_FIELDS
        q = title_or_doi.strip()

        # Heuristic: looks like a DOI?
        lowered = q.lower()
        looks_like_id = (
            lowered.startswith("10.")
            or lowered.startswith("doi:")
            or lowered.startswith("arxiv:")
            or lowered.startswith("arxiv ")
        )
        if looks_like_id:
            ident = q
            if lowered.startswith("10."):
                ident = f"DOI:{q}"
            data = self._get(f"/paper/{ident}", params={"fields": fields})
            if data:
                return data
            # Fall through to title search if the id-style lookup misses.

        # /paper/search/match → best single match for a title.
        data = self._get(
            "/paper/search/match",
            params={"query": q, "fields": fields},
        )
        if data and isinstance(data.get("data"), list) and data["data"]:
            return data["data"][0]

        # Fuzzy fallback. Bound results to keep it cheap.
        data = self._get(
            "/paper/search",
            params={"query": q, "limit": 1, "fields": fields},
        )
        if data and isinstance(data.get("data"), list) and data["data"]:
            return data["data"][0]
        return None

    DEFAULT_REFERENCE_FIELDS = (
        "paperId,externalIds,title,authors,year,venue,abstract,"
        "citationCount,referenceCount"
    )

    def get_references(
        self,
        paper_id: str,
        fields: Optional[str] = None,
        limit: int = 100,
    ) -> Optional[list]:
        """Fetch up to ``limit`` references (works the paper cites).

        Endpoint: GET /graph/v1/paper/{paper_id}/references — the response
        wraps each cited paper inside {"citedPaper": {...}}. We unwrap and
        return the list of citedPaper dicts (only those that exist).

        Note: contexts on this endpoint refer to where the *cited* paper was
        cited from the source paper. Per S2 docs, the richer per-citation
        context strings live on the /citations endpoint instead.
        """
        if not paper_id:
            return None
        fields_param = fields or self.DEFAULT_REFERENCE_FIELDS
        # Per S2 docs, fields on /references must be prefixed with `citedPaper.`
        # except for `contexts`, which is a sibling of citedPaper at the row level.
        wrapped_parts = [
            f if f == "contexts" or f.startswith("citedPaper.") else f"citedPaper.{f}"
            for f in (p.strip() for p in fields_param.split(",")) if f
        ]
        if "contexts" not in wrapped_parts:
            wrapped_parts.insert(0, "contexts")
        wrapped = ",".join(wrapped_parts)
        data = self._get(
            f"/paper/{paper_id}/references",
            params={"fields": wrapped, "limit": limit},
        )
        if not data or not isinstance(data.get("data"), list):
            return None
        out = []
        for item in data["data"]:
            cited = item.get("citedPaper") or {}
            if not cited:
                continue
            ctx = item.get("contexts")
            if ctx:
                cited = {**cited, "contexts": ctx}
            out.append(cited)
        return out

    DEFAULT_CITATION_FIELDS = (
        "paperId,externalIds,title,authors,year,venue,abstract,"
        "citationCount,referenceCount"
    )

    def get_citations(
        self,
        paper_id: str,
        fields: Optional[str] = None,
        limit: int = 100,
    ) -> Optional[list]:
        """Fetch up to ``limit`` citations (works that cite the paper).

        Endpoint: GET /graph/v1/paper/{paper_id}/citations — wraps each citing
        paper inside {"citingPaper": {...}, "contexts": [...]}. We merge the
        citation contexts onto the citingPaper dict so downstream code sees a
        flat record per citing paper.
        """
        if not paper_id:
            return None
        fields_param = fields or self.DEFAULT_CITATION_FIELDS
        # Per S2 docs, fields on /citations must be prefixed with `citingPaper.`
        # except for `contexts`, which is a sibling of citingPaper at the row level.
        wrapped_parts = [
            f if f == "contexts" or f.startswith("citingPaper.") else f"citingPaper.{f}"
            for f in (p.strip() for p in fields_param.split(",")) if f
        ]
        if "contexts" not in wrapped_parts:
            wrapped_parts.insert(0, "contexts")
        wrapped = ",".join(wrapped_parts)
        data = self._get(
            f"/paper/{paper_id}/citations",
            params={"fields": wrapped, "limit": limit},
        )
        if not data or not isinstance(data.get("data"), list):
            return None
        out = []
        for item in data["data"]:
            citing = item.get("citingPaper") or {}
            if not citing:
                continue
            ctx = item.get("contexts") or []
            citing = {**citing, "contexts": ctx}
            out.append(citing)
        return out


def load_dotenv_value(env_path: str, key: str) -> Optional[str]:
    """Tiny, dependency-free .env reader. Returns None if file missing or key absent.

    Used so this module can be invoked without ``python-dotenv`` being imported
    explicitly by the caller. Values are not echoed anywhere.
    """
    if not env_path or not os.path.isfile(env_path):
        return None
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                if k.strip() == key:
                    v = v.strip()
                    if (v.startswith('"') and v.endswith('"')) or (
                        v.startswith("'") and v.endswith("'")
                    ):
                        v = v[1:-1]
                    return v
    except OSError:
        return None
    return None
