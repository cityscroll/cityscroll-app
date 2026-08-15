#!/usr/bin/env python3
"""Compare retained SPA routes with a reconstructed pre-split inline-script build.

Now, Browse defaults, and notice documents have response-HTML/no-JS contracts in
primary_document_routes.test.mjs, so DOM equivalence no longer owns those renderers.
"""

from __future__ import annotations

import functools
import pathlib
import re
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
SITE = ROOT / "site"

import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import HEARING_ROW, install_routes  # noqa: E402

FOOTER = "\n// Publish live bindings for neighboring modules and legacy inline handlers."
STATIC_PARENT_IMPORT = re.compile(
    r'import\s+\{[^}]+\}\s+from\s+["\']\.\./([^"\']+)["\'];?',
    re.MULTILINE,
)
STATIC_LOCAL_IMPORT = re.compile(
    r'import\s+\{[^}]+\}\s+from\s+["\']\./([^"\']+)["\'];?',
    re.MULTILINE,
)
NAMESPACE_PARENT_IMPORT = re.compile(
    r'globalThis\.([A-Za-z_$][\w$]*)\s*=\s*await import\(["\']\.\./([^"\']+)["\']\);?'
)
EXPORTED_DECLARATION = re.compile(
    r'\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)'
)
EXPORTED_NAME = re.compile(
    r'\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)'
)


def flatten_helper(
    path: pathlib.Path,
    stack: tuple[pathlib.Path, ...] = (),
    flattened: set[pathlib.Path] | None = None,
) -> str:
    """Inline a pure helper's local named-import graph for the pre-split fixture."""
    if flattened is None:
        flattened = set()
    assert path not in stack, f"circular inline helper import: {path.name}"
    if path in flattened:
        return ""
    flattened.add(path)
    source = path.read_text()
    nested_sources = []  # Source: local helper imports matched by STATIC_LOCAL_IMPORT.
    for helper_name in STATIC_LOCAL_IMPORT.findall(source):
        helper_path = path.parent / helper_name
        assert helper_path.is_file(), f"nested helper import missing: {helper_name}"
        dependency = flatten_helper(helper_path, (*stack, path), flattened)
        dependency = EXPORTED_DECLARATION.sub("", dependency)
        dependency = re.sub(
            r"\bexport\s*\{[^}]+\}\s*(?:from\s+[\"'][^\"']+[\"'])?\s*;?",
            "",
            dependency,
        )
        assert not re.search(r"\bexport\s", dependency), (
            f"inline reconstruction cannot flatten this export in {helper_name}"
        )
        nested_sources.append(dependency)
    return "\n".join([*nested_sources, STATIC_LOCAL_IMPORT.sub("", source)])


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
    names = re.findall(r'import\("\./(.+?)"\)', loader)
    assert names, "module loader has no imports"
    chunks = []
    helpers = []
    seen_helpers = set()
    flattened_static_helpers: set[pathlib.Path] = set()
    for namespace, helper_name in NAMESPACE_PARENT_IMPORT.findall(loader):
        helper_path = SITE / helper_name
        assert helper_path.is_file(), f"namespace helper import missing: {helper_name}"
        # Namespace helpers are wrapped in their own IIFE, so each one needs
        # its transitive dependencies available inside that closure.
        helper_source = flatten_helper(helper_path)
        export_source = helper_path.read_text()
        exports = []  # Source: export declarations parsed from the helper's own module.
        for name in EXPORTED_NAME.findall(export_source):
            exports.append((name, name))
        for export_list in re.findall(r"\bexport\s*\{([^}]+)\}\s*;?", export_source):
            for item in export_list.split(","):
                aliases = re.split(r"\s+as\s+", item.strip())
                exports.append((aliases[0], aliases[-1]))
        assert exports, f"namespace helper has no named exports: {helper_name}"
        helper_source = EXPORTED_DECLARATION.sub("", helper_source)
        helper_source = re.sub(
            r"\bexport\s*\{[^}]+\}\s*(?:from\s+[\"'][^\"']+[\"'])?\s*;?",
            "",
            helper_source,
        )
        assert not re.search(r"\bexport\s", helper_source), (
            f"inline reconstruction cannot flatten this export in {helper_name}"
        )
        namespace_members = ",".join(
            f"{public_name}:{binding}" for binding, public_name in exports
        )
        helpers.append(
            f"const {namespace}=(()=>{{\n{helper_source}\n"
            f"return Object.freeze({{{namespace_members}}});\n}})();\n"
            f"globalThis.{namespace}={namespace};"
        )
        seen_helpers.add(helper_name)
    for name in names:
        source = (SITE / "app" / name).read_text()
        for helper_name in STATIC_PARENT_IMPORT.findall(source):
            if helper_name in seen_helpers:
                continue
            helper_path = SITE / helper_name
            assert helper_path.is_file(), f"static helper import missing: {helper_name}"
            helper_source = flatten_helper(helper_path, flattened=flattened_static_helpers)
            helper_source = EXPORTED_DECLARATION.sub("", helper_source)
            assert not re.search(r"^\s*export\s", helper_source, re.MULTILINE), (
                f"inline reconstruction cannot flatten this export in {helper_name}"
            )
            helpers.append(helper_source)
            seen_helpers.add(helper_name)
        source = STATIC_PARENT_IMPORT.sub("", source)
        chunks.append(source.split(FOOTER)[0].replace('import("../', 'import("./'))
    inline = "\n".join([*helpers, *chunks])
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


def capture(page, base: str, route: str, ready: str, root: str, action=None, errors=None) -> str:
    # A merge-group runner can lose one module-graph wakeup while Chromium is
    # cold. Retry the bounded readiness check once; a persistent syntax or
    # rendering error still fails below with the collected page errors.
    for attempt in range(2):
        try:
            page.goto(base + route, wait_until="load", timeout=30_000)
            page.locator(ready).first.wait_for(state="visible", timeout=20_000)
            break
        except PlaywrightTimeoutError as error:
            if attempt == 1:
                detail = f"; page errors: {errors}" if errors else ""
                raise AssertionError(
                    f"{route}: readiness selector {ready!r} did not settle after a retry{detail}"
                ) from error
            print(f"WARN {route}: readiness timeout; retrying once", flush=True)
    if route == "#notice/20241112003":
        assert page.locator('#nactions .next-action-list > a[href*="zola.planning.nyc.gov"]').count() == 1, (
            "Property deep link painted before its BBL-backed action was hydrated"
        )
    if action:
        page.locator(action).click()
        page.locator("#apreviewbox .emailmock").wait_for(state="visible", timeout=20_000)
    return normalized_html(page, root)


SURFACES = [
    ("retained-task", "#task/can-i-bid", "#taskview .task-card", "#taskview", None),
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
                    before = capture(pages[0][1], pages[0][0], route, ready, root, action, pages[0][2])
                    after = capture(pages[1][1], pages[1][0], route, ready, root, action, pages[1][2])
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
