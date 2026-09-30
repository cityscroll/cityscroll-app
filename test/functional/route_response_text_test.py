#!/usr/bin/env python3
"""Regression for route.fetch HTML mutation under gzip bodies."""

from __future__ import annotations

import gzip
import pathlib
import sys
import unittest

ASSETS = pathlib.Path(__file__).parent / "assets"
sys.path.insert(0, str(ASSETS))
from route_response_text import (  # noqa: E402
    GZIP_MAGIC,
    fetch_uncompressed,
    fulfill_with_text,
    response_text,
)


class FakeResponse:
    def __init__(self, body: bytes, headers: dict[str, str] | None = None):
        self._body = body
        self.headers = headers or {}

    def body(self) -> bytes:
        return self._body

    def text(self) -> str:
        return self._body.decode("utf-8")


class FakeRequest:
    def __init__(self, headers: dict[str, str] | None = None):
        self.headers = headers or {
            "accept": "text/html",
            "accept-encoding": "gzip, deflate, br",
            "user-agent": "fixture",
        }


class FakeRoute:
    def __init__(self):
        self.request = FakeRequest()
        self.fetch_calls: list[dict] = []
        self.fulfill_calls: list[dict] = []

    def fetch(self, **kwargs):
        self.fetch_calls.append(kwargs)
        return FakeResponse(b"<html>ok</html>", {"content-type": "text/html"})

    def fulfill(self, **kwargs):
        self.fulfill_calls.append(kwargs)


class RouteResponseTextTests(unittest.TestCase):
    def test_plain_utf8_body(self) -> None:
        response = FakeResponse(b"<!doctype html><p>plain</p>")
        self.assertEqual(response_text(response), "<!doctype html><p>plain</p>")

    def test_gzip_body_without_content_encoding_matches_ci_failure(self) -> None:
        html = b'<!doctype html><nav class="near-place-suggestions"></nav>'
        compressed = gzip.compress(html)
        self.assertEqual(compressed[:2], GZIP_MAGIC)
        response = FakeResponse(compressed, {"content-type": "text/html; charset=utf-8"})
        with self.assertRaises(UnicodeDecodeError) as raised:
            response.text()
        self.assertIn("0x8b", str(raised.exception))
        self.assertEqual(response_text(response), html.decode("utf-8"))

    def test_already_decoded_body_keeps_content_encoding_header(self) -> None:
        # Playwright may gunzip while leaving Content-Encoding on the header map.
        html = b"<!doctype html><p>decoded upstream</p>"
        response = FakeResponse(html, {"content-encoding": "gzip", "content-type": "text/html"})
        self.assertEqual(response_text(response), html.decode("utf-8"))

    def test_fetch_uncompressed_forces_identity_encoding(self) -> None:
        route = FakeRoute()
        fetch_uncompressed(route, timeout=1_000)
        self.assertEqual(len(route.fetch_calls), 1)
        headers = route.fetch_calls[0]["headers"]
        self.assertEqual(headers["accept-encoding"], "identity")
        self.assertEqual(headers["accept"], "text/html")

    def test_fulfill_with_text_drops_content_encoding_and_length(self) -> None:
        route = FakeRoute()
        response = FakeResponse(
            b"<html/>",
            {
                "content-type": "text/html",
                "content-encoding": "gzip",
                "content-length": "99",
                "cache-control": "no-store",
            },
        )
        fulfill_with_text(route, response, "<html>mutated</html>")
        self.assertEqual(len(route.fulfill_calls), 1)
        call = route.fulfill_calls[0]
        self.assertEqual(call["body"], "<html>mutated</html>")
        self.assertEqual(call["headers"]["content-type"], "text/html")
        self.assertEqual(call["headers"]["cache-control"], "no-store")
        self.assertNotIn("content-encoding", {k.lower() for k in call["headers"]})
        self.assertNotIn("content-length", {k.lower() for k in call["headers"]})


if __name__ == "__main__":
    unittest.main()
