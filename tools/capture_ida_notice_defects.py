#!/usr/bin/env python3
"""Before/after evidence for the IDA public-hearing defect cluster.

Field case: #notice/20250227021 (homepage demo "Past IDA meetings").

Captures production (before) and the local site tree (after) for:
  - meetings list card participation affordance
  - notice detail modules (participation + absence of contract lifecycle)

Also writes an offline subsidy after-shell (City Record hearing derivation)
because that fix ships with the Worker, not the static site alone.

  python3 tools/capture_ida_notice_defects.py
"""

from __future__ import annotations

import functools
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "ida-notice-defects"
VIEWPORTS = ((390, 844), (1440, 900))
NOTICE_ID = "20250227021"
PROD = "https://cityscroll.org/"
MEETINGS_HASH = "#meetings?when=past&q=IDA"
NOTICE_HASH = f"#notice/{NOTICE_ID}"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def wait_list(page) -> None:
    page.wait_for_selector(".hcard, .fcard, #meetingsfeed .fcard", timeout=45000)
    # Prefer an IDA-related card when present
    page.wait_for_timeout(800)


def wait_notice(page) -> None:
    page.wait_for_selector(".rolename, #noticeview .panel", timeout=45000)
    # Lifecycle / subsidy slots paint async
    page.wait_for_timeout(2500)


def shot(page, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), full_page=True)


def capture_live(browser, base: str, phase: str) -> None:
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(base + "index.html" + MEETINGS_HASH, wait_until="domcontentloaded", timeout=60000)
        wait_list(page)
        # Scroll first card into view
        page.evaluate("() => { const c=document.querySelector('.hcard,.fcard'); if(c) c.scrollIntoView({block:'center'}); }")
        shot(page, OUT / f"{phase}-meetings-list-{width}.png")

        page.goto(base + "index.html" + NOTICE_HASH, wait_until="domcontentloaded", timeout=60000)
        wait_notice(page)
        page.evaluate("() => { const a=document.querySelector('.actions'); if(a) a.scrollIntoView({block:'center'}); }")
        shot(page, OUT / f"{phase}-notice-actions-{width}.png")
        page.evaluate(
            """() => {
              const el = document.querySelector('#nlifecycle,#dlifecycle,#nsubsidy,#dsubsidy');
              if (el) el.scrollIntoView({block:'start'});
              else window.scrollTo(0, 400);
            }"""
        )
        shot(page, OUT / f"{phase}-notice-modules-{width}.png")
        context.close()


SUBSIDY_AFTER_SHELL = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IDA subsidy after</title>
<style>
:root{--paper:#f4efe5;--ink:#161512;--muted:#69635a;--rule:#c8bfb0;--green:#285d49;--ox:#7b1f2b}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.45 ui-sans-serif,system-ui,sans-serif}
.page{max-width:880px;margin:0 auto;padding:20px}
.brand{font:900 24px/1 Georgia,serif}.brand span{color:var(--ox)}
.chain-h{font:700 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;margin:18px 0 10px}
.note{font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--muted);padding:10px 12px;background:#faf6ee;border-inline-start:3px solid var(--rule);border-radius:0 7px 7px 0;margin:8px 0}
.chain{display:flex;flex-wrap:wrap;gap:0;align-items:stretch}
.stage{flex:1 1 120px;min-width:110px}
.box{border:1px solid var(--rule);border-top:3px solid var(--green);border-radius:8px;background:#fff;padding:11px 12px;min-height:100px}
.stage-name{font:700 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--green)}
.when{font-size:13px;margin-top:4px}
.lc-norecord{font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin-top:6px}
.connector{display:flex;align-items:center;padding:0 4px;color:var(--muted)}
.fix{border:2px solid var(--green);background:#f0faf5;color:var(--green);font:700 11px/1.3 ui-sans-serif,system-ui,sans-serif;padding:6px 8px;border-radius:6px;margin:8px 0}
.act{display:inline-block;margin:4px 6px 4px 0;padding:8px 12px;border:1px solid var(--rule);border-radius:6px;background:#fff;text-decoration:none;color:var(--ink);font:600 13px/1 ui-sans-serif,system-ui,sans-serif}
</style></head><body><div class="page">
<div class="brand">City<span>Scroll</span></div>
<p class="fix">✓ After · #notice/20250227021 · one IDA meetings link · no contract modules · subsidy from City Record hearing</p>
<p><a class="act" href="https://edc.nyc/nycida-board-meetings-public-hearings">IDA meetings page</a></p>
<div class="chain-h">Subsidy lifecycle</div>
<div class="note">Linked project: <b>IDA March 20th, 2025 Public Hearing Notice</b> · company <b>NYM 145 Wolcott LLC</b> · stage Hearing.</div>
<div class="chain">
  <div class="stage"><div class="box"><div class="stage-name">Application</div><div class="when">2025-02-27</div></div></div>
  <div class="connector">→</div>
  <div class="stage"><div class="box"><div class="stage-name">Hearing</div><div class="when">2025-03-20</div></div></div>
  <div class="connector">→</div>
  <div class="stage"><div class="box" style="border-top-color:var(--rule)"><div class="stage-name" style="color:var(--muted)">Board decision</div><div class="when">—</div>
    <div class="lc-norecord">The city does not publish this — it would appear on Build NYC project documents if released.</div></div></div>
</div>
<div class="note">Stages join City Record notices to Build NYC and NYC Industrial Development Agency project records when a public match exists. Hearing stage here is from the City Record notice when the Build NYC feed is unreachable.</div>
</div></body></html>
"""


def capture_subsidy_after(browser) -> None:
    shell = OUT / "_subsidy_after.html"
    shell.parent.mkdir(parents=True, exist_ok=True)
    shell.write_text(SUBSIDY_AFTER_SHELL, encoding="utf-8")
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(shell.as_uri(), wait_until="load")
        shot(page, OUT / f"after-subsidy-shell-{width}.png")
        context.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        print("Capturing production (before)…")
        capture_live(browser, PROD, "before")
        print("Capturing local site (after)…")
        with StaticServer() as base:
            # Give the server a beat
            time.sleep(0.2)
            capture_live(browser, base, "after")
        print("Capturing subsidy after shell…")
        capture_subsidy_after(browser)
        browser.close()
    print(f"Wrote screenshots under {OUT.relative_to(ROOT)}")
    for path in sorted(OUT.glob("*.png")):
        print(f"  {path.name}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
