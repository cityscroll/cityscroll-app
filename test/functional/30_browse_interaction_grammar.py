"""Facet-exhaustive browser gate for the six-lens object-card interaction grammar."""

from __future__ import annotations

import functools
import http.server
import os
import pathlib
import sys
import threading

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))

from browse_interaction_grammar import LENSES, assert_lens_grammar, open_lens  # noqa: E402


def main() -> None:
    from playwright.sync_api import sync_playwright

    base = os.environ.get("CROL_BASE", "")
    server = None
    if not base:
        from tools.local_site_server import QuietHandler

        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for lens in LENSES:
                context = browser.new_context(
                    viewport={"width": 1440, "height": 1000},
                    permissions=["clipboard-read", "clipboard-write"],
                )
                page = context.new_page()
                open_lens(page, base, lens)
                result = assert_lens_grammar(page, lens)
                print(
                    f"OK {lens.name}: {result['cards_inspected']} cards; "
                    f"canonical target {result['canonical_target']}",
                    flush=True,
                )
                context.close()
            browser.close()
    finally:
        if server:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
