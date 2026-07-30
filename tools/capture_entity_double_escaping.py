#!/usr/bin/env python3
"""Before/after evidence for notice-entity double-escaping on preview cards.

Field case: notice 20220525018 — full view vs meetings card excerpt for &ldquo;Agency&rdquo;.
Captures production (before) and the local site tree (after) at 390 and 1440, then writes
annotated pairs under docs/screenshots/entity-double-escaping/.
"""

from __future__ import annotations

import functools
import json
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "entity-double-escaping"
VIEWPORTS = ((390, 844), (1440, 900))
NOTICE_ID = "20220525018"
PROD = "https://cityscroll.org/"
SODA = (
    "https://data.cityofnewyork.us/resource/buex-bi6w.json"
    f"?$where=request_id='{NOTICE_ID}'"
    "&$select=request_id,short_title,additional_description_1,agency_name,"
    "event_date,section_name,type_of_notice_description,start_date,"
    "street_address_1,street_address_2,city,state,zip_code,building_name,"
    "other_info_1,printout_1"
)


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


def fetch_notice() -> dict:
    with urllib.request.urlopen(SODA, timeout=30) as resp:
        assert resp.status == 200, resp.status
        rows = json.loads(resp.read().decode("utf-8"))
    assert rows, "SODA returned no row for field-case notice"
    return rows[0]


def annotate(page, label: str, find_text: str | None) -> None:
    page.evaluate(
        """([label, findText]) => {
          const ban = document.getElementById('entity-escape-annotate');
          if (ban) ban.remove();
          const el = document.createElement('div');
          el.id = 'entity-escape-annotate';
          el.style.cssText = 'position:fixed;z-index:99999;left:8px;right:8px;bottom:8px;'
            + 'background:#1b140f;color:#fbf7ed;font:600 12px/1.35 ui-sans-serif,system-ui,sans-serif;'
            + 'padding:10px 12px;border-radius:8px;box-shadow:0 8px 28px #0006;pointer-events:none';
          el.textContent = label;
          document.body.appendChild(el);
          if (findText) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (node.nodeValue && node.nodeValue.includes(findText)) {
                const span = document.createElement('mark');
                span.style.cssText = 'background:#ffe08a;outline:2px solid #c45c26;padding:0 2px';
                const range = document.createRange();
                range.selectNode(node);
                range.surroundContents(span);
                span.scrollIntoView({block:'center'});
                break;
              }
            }
          }
        }""",
        [label, find_text],
    )


def shot(page, base: str, path: str, out: Path, label: str, find_text: str | None) -> None:
    page.goto(base.rstrip("/") + "/index.html" + path, wait_until="domcontentloaded", timeout=60000)
    # Live SODA/worker traffic never reaches networkidle; wait for surface content instead.
    try:
        if path.startswith("#notice/"):
            page.wait_for_selector(".scope, #detail .actions, #detail .empty", timeout=45000)
        else:
            page.wait_for_selector(".hcard, .fcard, #meetingsfeed .empty, #hearingssummary", timeout=45000)
    except Exception:
        pass
    page.wait_for_timeout(2500)
    annotate(page, label, find_text)
    page.wait_for_timeout(200)
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out), full_page=True)


def main() -> None:
    notice = fetch_notice()
    desc = notice.get("additional_description_1") or ""
    assert "&ldquo;" in desc or "“" in desc or "Agency" in desc, "field case text missing from SODA row"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "raw-notice.json").write_text(json.dumps(notice, indent=2)[:8000], encoding="utf-8")
    (OUT / "urls.txt").write_text(
        "\n".join(
            [
                f"soda_raw=200 {SODA}",
                f"prod_index=200 {PROD}index.html",
                f"prod_notice={PROD}index.html#notice/{NOTICE_ID}",
                f"prod_meetings={PROD}index.html#meetings?when=past&q=IDA",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with sync_playwright() as p, StaticServer() as local:
        browser = p.chromium.launch()
        for width, height in VIEWPORTS:
            for phase, base in (("before", PROD), ("after", local)):
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                # Full notice
                find = "Agency" if phase == "after" else "&ldquo;"
                # Full view always decoded; look for curly quote after, entity literal only on broken cards
                shot(
                    page,
                    base,
                    f"#notice/{NOTICE_ID}",
                    OUT / f"{phase}-notice-{width}.png",
                    f"{phase.upper()} · notice {NOTICE_ID} · {width}px — full view should show “Agency”",
                    "Agency",
                )
                # Meetings past IDA
                card_find = "&ldquo;" if phase == "before" else "Agency"
                shot(
                    page,
                    base,
                    "#meetings?when=past&q=IDA",
                    OUT / f"{phase}-meetings-{width}.png",
                    f"{phase.upper()} · meetings past q=IDA · {width}px — card excerpt must not show literal &ldquo;",
                    card_find,
                )
                context.close()
        browser.close()
    print(f"wrote screenshots under {OUT}")


if __name__ == "__main__":
    main()
