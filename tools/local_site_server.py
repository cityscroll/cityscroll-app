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
        if self.path.split("?", 1)[0].startswith("/notices/"):
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
