#!/usr/bin/env python3
"""Capture what each served route reports itself as, as text.

The defect this records is invisible in a screenshot: a page that renders perfectly while
telling the measurement system it is a different page. So this capture never looks at pixels.
It loads each route with every off-origin request denied except the event intake, which it
intercepts, and records the dimensions the collector actually tried to send.

Each entry carries the route, the viewport, the repository revision, the source blobs of the
two files that decide a surface, the data vintage of the served coverage, the assertion, and
the sha256 of the rendered scope. No image is written and none is committed.

    python3 tools/capture_route_attribution.py
    python3 tools/capture_route_attribution.py --base http://127.0.0.1:8000/
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "evidence" / "measurement-accountability" / "capture-manifest.json"
SETTLE_MS = 1500
VIEWPORT = {"name": "desktop", "width": 1440, "height": 900}

# Every route the built site serves that ships the collector, plus the record routes the public
# Stats page teaches. `expected` is what the surface vocabulary says the route is; the point of
# the capture is that the browser agrees.
ROUTES = (
    ("/", "home", "The homepage, the only route that was ever correctly attributed."),
    ("/index.html", "home", "The homepage's document form."),
    ("/stats.html", "stats", "The public Stats document, previously reported as the homepage."),
    ("/about.html", "about", "Previously reported as the homepage."),
    ("/api.html", "api", "Previously reported as the homepage."),
    ("/search/", "search", "The canonical Search document, previously reported as the homepage."),
    ("/now/", "now", "A primary document that already had its own surface."),
    ("/near-you/", "near-you", "A primary document that already had its own surface."),
    ("/following/", "following", "A primary document that already had its own surface."),
    ("/browse/", "browse", "The browse index."),
    ("/browse/contracts/", "browse-contracts", "Previously collapsed into the browse index."),
    ("/browse/zoning/", "browse-zoning",
     "Previously collapsed into the browse index; also the route of a worked path on the Stats page."),
    ("/browse/meetings/", "browse-meetings", "Previously collapsed into the browse index."),
    ("/browse/people/", "browse-people", "Previously collapsed into the browse index."),
    ("/browse/property/", "browse-property", "Previously collapsed into the browse index."),
    ("/browse/rules/", "browse-rules", "Previously collapsed into the browse index."),
    ("/browse/staffing/", "browse-staffing", "Previously collapsed into the browse index."),
    ("/browse/exams/", "browse-exams", "Previously collapsed into the browse index."),
    ("/browse/places/", "browse-places", "Previously collapsed into the browse index."),
    ("/notices/20231222103", "notice",
     "The award notice the Stats page's procurement path ends on, previously reported as the homepage."),
    ("/notices/20260605008", "notice",
     "The rule notice the Stats page's legislation path starts from, previously reported as the homepage."),
)

# Documents the built site now serves as a redirect to another page. Each still ships the
# collector, so what matters is that every surface it reports is its own or its destination's --
# and that neither is the homepage.
REDIRECTED_ROUTES = (
    ("/data.html", ("data", "api"), "Redirects to the API guide's upstream section."),
    ("/changelog.html", ("changelog", "about"), "Redirects to the About page."),
    ("/standards.html", ("standards", "about"), "Redirects to the About page's accessibility section."),
)

# Routes the built static site does not serve: one is rendered by the Pages edge worker, one is
# a private experiment kept out of the public build. The browser cannot be asked about them
# here, so the surface vocabulary's own answer is recorded instead, and the entry says so rather
# than implying a page was loaded.
RESOLVER_ONLY_ROUTES = (
    ("/mandates/64116-001", "mandate",
     "The mandate the Stats page's legislation path ends on. Rendered by the Pages edge worker, "
     "so the static build does not serve it."),
    ("/experimental/worth-a-look/", "worth-a-look",
     "A private experiment kept out of the public build."),
)

# Routes that must produce no event at all. An unregistered route is an observability gap; the
# old behaviour was to report it as the homepage, which is a false measurement.
UNREGISTERED_ROUTES = (
    "/not-a-route/",
    "/browse/nothing/",
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def repository_revision() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout.strip()


def source_blob() -> dict:
    paths = ["site/analytics.js", "site/analytics_surface_taxonomy.mjs"]
    out = subprocess.run(["git", "hash-object", *paths], cwd=ROOT, check=True,
                         capture_output=True, text=True).stdout.split()
    return dict(zip(paths, out))


def resolve_surface(route: str) -> str | None:
    """The surface vocabulary's own answer, taken from the module both halves read."""
    script = (
        "import { resolveAnalyticsSurface } from './site/analytics_surface_taxonomy.mjs';"
        f"process.stdout.write(String(resolveAnalyticsSurface({json.dumps(route)}).surface));"
    )
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True,
                         capture_output=True, text=True).stdout.strip()
    return None if out in ("", "null") else out


def coverage_vintage() -> dict:
    snapshot = json.loads((ROOT / "site" / "data" / "served_coverage_snapshot.json").read_text())
    return {
        "served_coverage_evidence_oldest": snapshot["evidence_vintage"]["oldest"],
        "served_coverage_evidence_newest": snapshot["evidence_vintage"]["newest"],
    }


def start_site_server(temp_dir: Path) -> tuple[subprocess.Popen, str]:
    ready = temp_dir / "site-url.txt"
    process = subprocess.Popen(
        ["python3", "tools/local_site_server.py", "--directory", "_site",
         "--port", "0", "--ready-file", str(ready)],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(200):
        if ready.exists() and ready.read_text().strip():
            return process, ready.read_text().strip()
        if process.poll() is not None:
            raise RuntimeError(f"local site server exited early: {process.stdout.read()}")
        time.sleep(0.05)
    process.terminate()
    raise TimeoutError("local site server did not become ready")


def install_network_policy(page: Page, base: str, events: list, attempted: list[str]) -> None:
    """Same-origin passes; the event intake is answered locally and its body recorded; every
    other off-origin request is denied and named. One handler, so no two routes race to settle
    the same request."""
    origin = base.rstrip("/")

    def handler(route):
        request = route.request
        url = request.url.split("?")[0]
        if url.endswith("/events"):
            try:
                events.append(json.loads(request.post_data or "null"))
            except ValueError:
                events.append({"unparseable_body": True})
            return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*"}, body="")
        if request.url.startswith(origin):
            return route.continue_()
        attempted.append(url)
        return route.abort()

    page.route("**/*", handler)


def observe(page: Page, events: list, attempted: list[str]) -> dict:
    scope = "main" if page.locator("main").count() else "body"
    page_views = [event for event in events if isinstance(event, dict) and event.get("event") == "page_view"]
    return {
        "document_language": page.evaluate("document.documentElement.getAttribute('lang')"),
        "collector_present": page.evaluate(
            "Boolean(document.querySelector('script[src*=\\'analytics.js\\']'))"),
        "collector_is_module": page.evaluate(
            "document.querySelector('script[src*=\\'analytics.js\\']')?.type || null") == "module",
        "events_attempted": events,
        "page_view_surface": page_views[0].get("surface") if page_views else None,
        "page_view_count": len(page_views),
        "off_origin_requests_attempted": sorted(set(attempted)),
        "render_scope": f"innerHTML of {scope}",
        "render_sha256": sha256_text(page.locator(scope).inner_html()),
    }


def capture(base: str) -> list[dict]:
    revision = repository_revision()
    blob = source_blob()
    vintage = coverage_vintage()
    captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for route, expected, why in ROUTES:
                context = browser.new_context(
                    viewport={"width": VIEWPORT["width"], "height": VIEWPORT["height"]})
                page = context.new_page()
                events: list = []
                attempted: list[str] = []
                install_network_policy(page, base, events, attempted)
                response = page.goto(f"{base.rstrip('/')}{route}",
                                     wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(SETTLE_MS)
                observed = observe(page, events, attempted)
                observed["http_status"] = response.status if response else None
                captures.append({
                    "id": f"route{route.replace('/', '-').rstrip('-') or '-root'}",
                    "route": route,
                    "route_note": why,
                    "viewport": dict(VIEWPORT),
                    "repository_revision": revision,
                    "source_blob": blob,
                    "data_vintage": vintage,
                    "expected_surface": expected,
                    "assertion": (
                        f"Loading {route} attempts exactly one page view, and it names the "
                        f"surface {expected} rather than the homepage."
                    ),
                    "assertion_holds": (
                        observed["http_status"] == 200
                        and observed["page_view_count"] == 1
                        and observed["page_view_surface"] == expected
                    ),
                    "observed": observed,
                    "render_sha256": observed["render_sha256"],
                    "render_scope": observed["render_scope"],
                    "file": None,
                })
                context.close()

            for route, allowed, why in REDIRECTED_ROUTES:
                context = browser.new_context(
                    viewport={"width": VIEWPORT["width"], "height": VIEWPORT["height"]})
                page = context.new_page()
                events = []
                attempted = []
                install_network_policy(page, base, events, attempted)
                response = page.goto(f"{base.rstrip('/')}{route}",
                                     wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(SETTLE_MS)
                observed = observe(page, events, attempted)
                observed["http_status"] = response.status if response else None
                surfaces = [event.get("surface") for event in observed["events_attempted"]
                            if isinstance(event, dict) and event.get("event") == "page_view"]
                observed["page_view_surfaces"] = surfaces
                captures.append({
                    "id": f"redirected{route.replace('/', '-').rstrip('-')}",
                    "route": route,
                    "route_note": why,
                    "viewport": dict(VIEWPORT),
                    "repository_revision": revision,
                    "source_blob": blob,
                    "data_vintage": vintage,
                    "expected_surface": list(allowed),
                    "assertion": (
                        f"Loading {route} reports only {' or '.join(allowed)} — its own surface "
                        "or the one it redirects to — and never the homepage."
                    ),
                    "assertion_holds": (
                        observed["http_status"] == 200
                        and bool(surfaces)
                        and all(surface in allowed for surface in surfaces)
                    ),
                    "observed": observed,
                    "render_sha256": observed["render_sha256"],
                    "render_scope": observed["render_scope"],
                    "file": None,
                })
                context.close()

            for route in UNREGISTERED_ROUTES:
                context = browser.new_context(
                    viewport={"width": VIEWPORT["width"], "height": VIEWPORT["height"]})
                page = context.new_page()
                events = []
                attempted = []
                install_network_policy(page, base, events, attempted)
                response = page.goto(f"{base.rstrip('/')}{route}",
                                     wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(SETTLE_MS)
                observed = observe(page, events, attempted)
                observed["http_status"] = response.status if response else None
                captures.append({
                    "id": f"unregistered{route.replace('/', '-').rstrip('-')}",
                    "route": route,
                    "route_note": "A route the map does not register.",
                    "viewport": dict(VIEWPORT),
                    "repository_revision": revision,
                    "source_blob": blob,
                    "data_vintage": vintage,
                    "expected_surface": None,
                    "assertion": (
                        f"Loading {route} attempts no page view at all, rather than reporting "
                        "the homepage."
                    ),
                    "assertion_holds": observed["page_view_count"] == 0,
                    "observed": observed,
                    "render_sha256": observed["render_sha256"],
                    "render_scope": observed["render_scope"],
                    "file": None,
                })
                context.close()
        finally:
            browser.close()

    for route, expected, why in RESOLVER_ONLY_ROUTES:
        resolved = resolve_surface(route)
        captures.append({
            "id": f"resolver-only{route.replace('/', '-').rstrip('-')}",
            "route": route,
            "route_note": why,
            "viewport": None,
            "repository_revision": revision,
            "source_blob": blob,
            "data_vintage": vintage,
            "expected_surface": expected,
            "assertion": (
                f"The surface vocabulary resolves {route} to {expected}. No page was loaded: the "
                "built static site does not serve this route."
            ),
            "assertion_holds": resolved == expected,
            "observed": {
                "resolved_surface": resolved,
                "method": "site/analytics_surface_taxonomy.mjs resolveAnalyticsSurface",
                "page_loaded": False,
            },
            "render_sha256": None,
            "render_scope": None,
            "file": None,
        })
    return captures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=None,
                        help="Serve from this base instead of starting a local server over _site.")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()

    server = None
    temp = None
    base = args.base
    try:
        if not base:
            temp = tempfile.TemporaryDirectory()
            server, base = start_site_server(Path(temp.name))
        captures = capture(base)
    finally:
        if server is not None:
            server.terminate()
        if temp is not None:
            temp.cleanup()

    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps({
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "route attribution for first-party measurement",
        "condition": (
            "Served from the repository's own built site directory. Every off-origin request is "
            "denied and named except the event intake, which is answered locally so the "
            "dimensions the collector attempted to send can be recorded. No production traffic "
            "is involved and no image is written."
        ),
        "extensionless_alias_note": (
            "The platform answers 308 from each .html document to its extensionless path, so a "
            "reader's browser sits on /stats rather than /stats.html. The local static server "
            "does not perform that redirect, so the aliases are exercised through the shared "
            "resolver in test/analytics_surface_taxonomy.test.mjs instead of here. The observed "
            "production redirect table is in docs/evidence/stats-public-experience/README.md."
        ),
        "image_binaries_committed": False,
        "captures": captures,
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    failed = [entry["id"] for entry in captures if not entry.get("assertion_holds")]
    for entry in captures:
        observed = entry["observed"]
        answer = (observed.get("page_view_surfaces")
                  or observed.get("page_view_surface")
                  or observed.get("resolved_surface"))
        print(f"{'OK  ' if entry.get('assertion_holds') else 'FAIL'} {entry['route']} -> {answer}")
    if failed:
        print(f"assertions did not hold: {failed}")
        return 1
    print(f"wrote {args.manifest.relative_to(ROOT)} — {len(captures)} capture(s), no image committed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
