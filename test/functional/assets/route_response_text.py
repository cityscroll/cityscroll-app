"""Decode Playwright route.fetch bodies for HTML/text mutation.

route.fetch() reuses the browser request headers, which advertise gzip (and
often br). A compressed body without a usable Content-Encoding header makes
APIResponse.text() raise UnicodeDecodeError; Playwright's error rewriter then
raises TypeError when it tries to rebuild UnicodeDecodeError with one argument.

Harness handlers that mutate documents must request identity encoding and decode
defensively from the raw body. Gzip magic (1f 8b) is the authority for whether
decompression is still needed: Playwright may already have gunzipped while
leaving Content-Encoding on the header map.
"""

from __future__ import annotations

import gzip
from typing import Any

GZIP_MAGIC = b"\x1f\x8b"


def fetch_uncompressed(route: Any, **fetch_kwargs: Any) -> Any:
    """Fetch through the route with Accept-Encoding: identity."""
    headers = {**route.request.headers, **(fetch_kwargs.pop("headers", None) or {})}
    headers["accept-encoding"] = "identity"
    return route.fetch(headers=headers, **fetch_kwargs)


def response_text(response: Any) -> str:
    """UTF-8 text from an APIResponse, gunzipping when the body still starts with gzip magic."""
    raw = response.body()
    if raw.startswith(GZIP_MAGIC):
        raw = gzip.decompress(raw)
    return raw.decode("utf-8")


def fulfill_with_text(route: Any, response: Any, body: str, **fulfill_kwargs: Any) -> None:
    """Fulfill with mutated text, dropping content-encoding and content-length."""
    headers = {
        key: value
        for key, value in (response.headers or {}).items()
        if key.lower() not in {"content-encoding", "content-length"}
    }
    headers.update(fulfill_kwargs.pop("headers", None) or {})
    route.fulfill(response=response, body=body, headers=headers, **fulfill_kwargs)
