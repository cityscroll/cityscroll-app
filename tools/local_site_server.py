#!/usr/bin/env python3
"""Serve the static site on an atomically allocated local port."""

from __future__ import annotations

import argparse
import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def _static_document(self, route: str, query: str) -> bool:
        """Serve a generated clean-route document when the artifact provides one."""
        if not route or ".." in route:
            return False
        # Agency constellation documents share the /agencies/<id>/index.html
        # filesystem shape, but ?tab= links must reach the interactive SPA
        # profile. Leave that route family to _static_agency_constellation,
        # which already distinguishes the static and interactive variants.
        if route.startswith("/agencies/"):
            return False
        document = Path(self.directory) / route.lstrip("/") / "index.html"
        if not document.is_file():
            return False
        self.path = f"{route}/" + (f"?{query}" if query else "")
        super().do_GET()
        return True

    def _static_agency_constellation(self, route: str, query: str) -> bool:
        """Serve build-generated agency constellation documents like production edge.

        HTML lives under site/agencies/<id>/index.html after
        `node tools/build_agency_constellation_documents.mjs` (gitignored;
        production emits them at deploy). Interactive SPA profiles stay
        available via ?tab= or when no static constellation page exists.
        """
        if not route.startswith("/agencies/"):
            return False
        if "tab=" in query:
            return False
        # Path segments for /agencies/<id> only (routing grammar, not a data table).
        segments = [segment for segment in route.split("/") if segment]  # source: URL path grammar
        if len(segments) != 2 or segments[0] != "agencies":
            return False
        agency_id = segments[1]
        if not agency_id or ".." in agency_id or "/" in agency_id:
            return False
        directory = Path(self.directory)
        document = directory / "agencies" / agency_id / "index.html"
        if not document.is_file():
            return False
        try:
            probe = document.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return False
        return 'data-civic-object-kind="agency-constellation"' in probe

    def do_GET(self):
        # Pages supplies the shared shell for edge-rendered notice documents. Local browser
        # gates exercise the enhancement island against that shell; response HTML is tested
        # separately against the edge renderer.
        raw = self.path
        path_only, _, query = raw.partition("?")
        route = path_only.rstrip("/")
        if self._static_document(route, query):
            return
        if self._static_agency_constellation(route, query):
            # Preserve query string (as_of, claim) for shareable views; serve
            # the directory index under /agencies/<id>/.
            self.path = f"{route}/" + (f"?{query}" if query else "")
            super().do_GET()
            return
        if (
            route.startswith("/notices/")
            or route.startswith("/agencies/")
            or route.startswith("/vendors/")
            or route.startswith("/officials/")
            or route == "/now"
            or route == "/browse"
            or route.startswith("/browse/")
        ):
            self.path = "/index.html"
        super().do_GET()


def port_number(value: str) -> int:
    port = int(value)
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 0 and 65535")
    return port


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="site")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=port_number,
        default=port_number(os.environ.get("CROL_TEST_PORT", "0")),
        help="local port; 0 asks the operating system for an available port",
    )
    parser.add_argument("--ready-file", type=Path)
    args = parser.parse_args()

    handler = functools.partial(QuietHandler, directory=args.directory)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    base = f"http://{args.host}:{server.server_port}/"
    if args.ready_file:
        args.ready_file.write_text(f"{base}\n", encoding="utf-8")
    print(base, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
