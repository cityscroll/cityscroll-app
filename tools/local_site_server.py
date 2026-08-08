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

    def do_GET(self):
        # Pages supplies the shared shell for edge-rendered notice documents. Local browser
        # gates exercise the enhancement island against that shell; response HTML is tested
        # separately against the edge renderer.
        raw = self.path
        route = raw.split("?", 1)[0].rstrip("/")
        query = raw.split("?", 1)[1] if "?" in raw else ""

        # Prefer static agency constellation documents when present (production edge
        # does the same). ?tab= keeps the interactive SPA profile.
        if route.startswith("/agencies/") and "tab=" not in query:
            root = Path(self.directory)
            agency_id = route.split("/")[2] if len(route.split("/")) >= 3 else ""
            if agency_id:
                document = root / "agencies" / agency_id / "index.html"
                if document.is_file():
                    try:
                        probe = document.read_text(encoding="utf-8", errors="ignore")
                    except OSError:
                        probe = ""
                    if 'data-civic-object-kind="agency-constellation"' in probe:
                        # Keep the query string (e.g. ?claim=) on the static document.
                        self.path = f"/agencies/{agency_id}/index.html" + (f"?{query}" if query else "")
                        return super().do_GET()

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
