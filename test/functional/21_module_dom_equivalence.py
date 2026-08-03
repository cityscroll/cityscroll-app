#!/usr/bin/env python3
"""Compare the modular site with a reconstructed pre-split inline-script build."""

from __future__ import annotations

import functools
import pathlib
import re
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
SITE = ROOT / "site"

import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import HEARING_ROW, install_routes  # noqa: E402

FOOTER = "\n// Publish live bindings for neighboring modules and legacy inline handlers."


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


def start_server(directory: pathlib.Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/"


def reconstruct_inline_site(target: pathlib.Path) -> None:
    shutil.copytree(SITE, target)
    loader = (SITE / "app" / "main.mjs").read_text()
    names = re.findall(r'await import\("\./(.+?)"\);', loader)
    assert names, "module loader has no imports"
    chunks = []
    for name in names:
        source = (SITE / "app" / name).read_text()
        chunks.append(source.split(FOOTER)[0].replace('import("../', 'import("./'))
    inline = "\n".join(chunks)
    index_path = target / "index.html"
    index = index_path.read_text()
    marker = '<script type="module" src="app/main.mjs"></script>'
    assert marker in index, "module loader tag missing"
    index_path.write_text(index.replace(marker, f"<script>\n{inline}\n</script>"))


def install_meeting_notice_route(page) -> None:
    def exact_notice(route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        where = " ".join(query.get("$where", []))
        if f"request_id='{HEARING_ROW['request_id']}'" in where:
            route.fulfill(status=200, content_type="application/json", body=__import__("json").dumps([HEARING_ROW]))
        else:
            route.fallback()

    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", exact_notice)


def normalized_html(page, selector: str) -> str:
    return page.locator(selector).evaluate(
        r"""element => {
          const normalize = value => String(value)
            .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://local.test')
            .replace(/127\.0\.0\.1(?:%3A|:)\d+/gi, 'local.test')
            .replace(/\s+/g, ' ')
            .trim();
          const serialize = node => {
            if (node.nodeType === Node.TEXT_NODE) {
              const text = normalize(node.textContent || '');
              return text ? ['#text', text] : null;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return null;
            if (node.matches('.loading, .skl, .empty.skel')) return null;
            const attrs = [...node.attributes]
              .map(attribute => [attribute.name, normalize(attribute.value)])
              .sort((left, right) => left[0].localeCompare(right[0]));
            const children = [...node.childNodes].map(serialize).filter(Boolean);
            return [node.tagName.toLowerCase(), attrs, children];
          };
          return JSON.stringify(serialize(element));
        }"""
    )


def capture(page, base: str, route: str, ready: str, root: str, action=None) -> str:
    page.goto(base + route, wait_until="load", timeout=30_000)
    page.locator(ready).first.wait_for(state="visible", timeout=20_000)
    if action:
        page.locator(action).click()
        page.locator("#apreviewbox .emailmock").wait_for(state="visible", timeout=20_000)
    page.wait_for_timeout(1_200)
    return normalized_html(page, root)


SURFACES = [
    ("home", "#money?mode=open&closing=week", "#list .row", "#tab-money", None),
    ("rules-lens", "#rules", "#rulesfeed .fcard", "#tab-rules", None),
    ("notice-money", "#notice/20260701099", "#noticeview .rolename", "#noticeview", None),
    ("notice-land", "#notice/20230912001", "#noticeview .rolename", "#noticeview", None),
    ("notice-property", "#notice/20241112003", "#noticeview .rolename", "#noticeview", None),
    ("notice-rules", "#notice/20260714029", "#noticeview .rolename", "#noticeview", None),
    ("notice-meetings", f"#notice/{HEARING_ROW['request_id']}", "#noticeview .rolename", "#noticeview", None),
    ("digest", "#alerts", "#apreview", "#apreviewbox", "#apreview"),
]


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cityscroll-module-equivalence-") as temp:
        baseline = pathlib.Path(temp) / "site"
        reconstruct_inline_site(baseline)
        modular_server, modular_base = start_server(SITE)
        baseline_server, baseline_base = start_server(baseline)
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                pages = []
                for base in (baseline_base, modular_base):
                    page = browser.new_page(viewport={"width": 1280, "height": 900})
                    errors = []
                    page.on("pageerror", lambda error, errors=errors: errors.append(str(error)))
                    install_routes(page)
                    install_meeting_notice_route(page)
                    pages.append((base, page, errors))

                for name, route, ready, root, action in SURFACES:
                    before = capture(pages[0][1], pages[0][0], route, ready, root, action)
                    after = capture(pages[1][1], pages[1][0], route, ready, root, action)
                    if before != after:
                        offset = next(
                            (index for index, pair in enumerate(zip(before, after)) if pair[0] != pair[1]),
                            min(len(before), len(after)),
                        )
                        context = (
                            f"inline={before[max(0, offset-300):offset+700]!r}\n"
                            f"modules={after[max(0, offset-300):offset+700]!r}"
                        )
                        raise AssertionError(
                            f"{name}: rendered DOM differs after module split at byte {offset}\n{context}"
                        )
                    print(f"OK {name}: rendered DOM identical")

                for _base, _page, errors in pages:
                    assert not errors, f"browser page errors: {errors}"
                browser.close()
        finally:
            modular_server.shutdown()
            baseline_server.shutdown()


if __name__ == "__main__":
    main()
