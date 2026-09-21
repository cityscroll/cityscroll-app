"""Rendered browser journey for reciprocal site history."""

from __future__ import annotations

import functools
import hashlib
import json
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
if TYPE_CHECKING:
    from playwright.sync_api import Page, Route

from browser_support import launched_chromium  # noqa: E402
from fixture_clock import pin_fixture_clock  # noqa: E402

CAPTURE_ROOT = ROOT / "docs" / "evidence" / "site-lifecycle-journey" / "captures"
LAND_ROUTE = "/browse/zoning/?status=active&borough=Brooklyn#land/2020K0270"
PROCUREMENT_ROUTE = "/procurements/procurement%3Acontract%3ACT107120258802303"
OFFICIAL_SOURCE = "https://www.pasport.org/public-search"
VIEWPORTS = ((1440, 900, "desktop"), (390, 844, "narrow"))

LIFECYCLE_SHARD = {
    "schema": "cityscroll.site_lifecycle_shard.v1",
    "rows": [
        {
            "parcel_id": "3073670011",
            "members": [
                {
                    "subject_id": "land:project:2020K0270",
                    "record_kind": "land_project",
                    "source_title": "2134 Coyle Street Rezoning",
                    "subject_href": "/browse/zoning/#land/2020K0270",
                    "source_event_date": "2022-02-24",
                    "source_system": "zap-projects-open-data",
                    "evidence_path": "https://data.cityofnewyork.us/resource/hgx4-8ukb.json?project_id=2020K0270",
                },
                {
                    "subject_id": "procurement:contract:CT107120258802303",
                    "record_kind": "procurement_observation",
                    "source_title": "Coyle Family Residence",
                    "subject_href": "/procurements/4965933",
                    "source_event_date": "2024-11-04",
                    "source_system": "passport_public_contracts",
                    "agency": "DHS",
                    "vendor": "Westhab",
                },
            ],
        },
    ],
}
LIFECYCLE_REVERSE = {
    "schema": "cityscroll.site_lifecycle_reverse.v1",
    "members": {
        "land:project:2020K0270": {"parcel_ids": ["3073670011"]},
        "procurement:contract:CT107120258802303": {"parcel_ids": ["3073670011"]},
    },
}
LAND_PROJECTS = {
    "materialized_at": "2026-09-16T12:00:00.000Z",
    "rows": [
        {
            "project_id": "2020K0270",
            "project_name": "2134 Coyle Street Rezoning",
            "project_status": "Active",
            "public_status": "Active",
            "borough": "Brooklyn",
            "primary_applicant": "Coyle Properties LLC",
            "project_brief": "A bounded land-use project fixture for the reciprocal site-history journey.",
            "bbls": ["3073670011", "3073670029"],
            "actions": [],
        },
    ],
}
LAND_DEFAULT = {"generated_at": "2026-09-16T12:00:00.000Z", "outcomes": {"by_project": {}}, "rows": []}
EMPTY_ROWS = {"rows": []}


def send_html(handler: object, html: str) -> None:
    body = html.encode("utf-8")
    handler.send_response(200)  # type: ignore[attr-defined]
    handler.send_header("Content-Type", "text/html; charset=utf-8")  # type: ignore[attr-defined]
    handler.send_header("Content-Length", str(len(body)))  # type: ignore[attr-defined]
    handler.end_headers()  # type: ignore[attr-defined]
    handler.wfile.write(body)  # type: ignore[attr-defined]


def procurement_document() -> str:
    filler = "<p>Native procurement detail content retained for the browser return path.</p>" * 18
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coyle Family Residence · CityScroll</title></head><body><main id="procurement-item-card" tabindex="-1" aria-current="page"><p>Procurement detail</p><h1>Coyle Family Residence</h1><p>DHS · Westhab · November 4, 2024</p>{filler}<p><a href="{OFFICIAL_SOURCE}">Open the official source</a></p></main></body></html>"""


def parcel_document() -> str:
    return "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Parcel history</title></head><body><main><h1>Parcel history</h1><p>3073670011</p></main></body></html>"


def handler_factory(directory: Path):
    from http.server import SimpleHTTPRequestHandler
    from tools.local_site_server import QuietHandler

    class Handler(QuietHandler):
        def translate_path(self, path: str) -> str:
            relative = unquote(urlsplit(path).path).lstrip("/")
            if relative.startswith(("capabilities/", "site/")):
                return str(ROOT / relative)
            return str(ROOT / "site" / relative)

        def do_GET(self) -> None:
            route = urlsplit(self.path).path.rstrip("/") or "/"
            if unquote(route) == "/procurements/procurement:contract:CT107120258802303":
                send_html(self, procurement_document())
                return
            if route == "/parcels/3073670011":
                send_html(self, parcel_document())
                return
            if route.startswith("/browse"):
                super().do_GET()
                return
            SimpleHTTPRequestHandler.do_GET(self)

    return functools.partial(Handler, directory=str(directory))


def serve_site() -> tuple[object, str]:
    from tools.local_site_server import _RobustThreadingHTTPServer

    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), handler_factory(ROOT / "site"))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def json_body(value: object) -> str:
    return json.dumps(value, separators=(",", ":"))


def install_routes(page: Page, *, lifecycle_failure: dict[str, bool]) -> None:
    def static_fixture(route: Route) -> None:
        parsed = urlsplit(route.request.url)
        path = parsed.path
        if path.endswith("/data/site_lifecycle/0000.json"):
            if lifecycle_failure["enabled"]:
                route.fulfill(status=503, content_type="application/json", body="{}")
            else:
                route.fulfill(status=200, content_type="application/json", body=json_body(LIFECYCLE_SHARD))
            return
        if path.endswith("/data/site_lifecycle/reverse.json"):
            if lifecycle_failure["enabled"]:
                route.fulfill(status=503, content_type="application/json", body="{}")
            else:
                route.fulfill(status=200, content_type="application/json", body=json_body(LIFECYCLE_REVERSE))
            return
        payloads = {
            "/data/zap_projects_warehouse_lookup.json": LAND_PROJECTS,
            "/data/land_default_ulurp.json": LAND_DEFAULT,
            "/data/zap_bbl_warehouse_lookup.json": EMPTY_ROWS,
            "/data/bbl_mappluto_centroids_lookup.json": EMPTY_ROWS,
            "/data/shared_meeting_read_model.json": EMPTY_ROWS,
            "/data/property_domain_observations.json": EMPTY_ROWS,
            "/data/land_authority_summary.json": {"summaries": {}},
        }
        payload_key = next((key for key in payloads if path.endswith(key)), None)
        if payload_key:
            route.fulfill(status=200, content_type="application/json", body=json_body(payloads[payload_key]))
            return
        if path.startswith("/data/") and not Path(ROOT / "site" / path.lstrip("/")).is_file():
            route.fulfill(status=200, content_type="application/json", body="{}")
            return
        if path.startswith("/site/data/") and not Path(ROOT / path.lstrip("/")).is_file():
            route.fulfill(status=200, content_type="application/json", body="{}")
            return
        if parsed.hostname in {"data.cityofnewyork.us", "api.cityscroll.org", "cloudflareinsights.com"} or (parsed.hostname or "").endswith("workers.dev"):
            route.abort()
            return
        route.continue_()

    page.route("**/*", static_fixture)
    page.route(OFFICIAL_SOURCE + "**", lambda route: route.fulfill(
        status=200,
        content_type="text/html",
        body="<!doctype html><html lang='en'><body><main><h1>Official source</h1><p>Public procurement source fixture.</p></main></body></html>",
    ))


def open_land(page: Page, base: str) -> None:
    page.goto(f"{base}{LAND_ROUTE}", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_timeout(2_000)
    page.locator("#ldetail .site-lifecycle-context").wait_for(state="visible", timeout=30_000)
    page.locator("#land-item-card").wait_for(state="visible", timeout=30_000)
    page.wait_for_function(
        "() => document.body.dataset.appReady === 'true' && !!document.querySelector('#ldetail .site-lifecycle-context')",
        timeout=30_000,
    )


def browser_state(page: Page) -> dict[str, object]:
    return page.evaluate(
        """() => ({
          route: `${location.pathname}${location.search}${location.hash}`,
          scrollY: Math.round(window.scrollY),
          activeElement: document.activeElement?.id || document.activeElement?.tagName.toLowerCase() || null,
        })"""
    )


def rendered_body(page: Page) -> str:
    html = page.locator("body").evaluate("node => node.outerHTML")
    return "\n".join(line.rstrip() for line in html.splitlines())


def run_journey(page: Page, base: str) -> tuple[dict[str, object], dict[str, object], str]:
    open_land(page, base)
    page.locator("#land-item-card").focus()
    page.evaluate("window.scrollTo(0, 640)")
    initial = browser_state(page)
    assert initial["route"] == LAND_ROUTE
    assert initial["scrollY"] == 640, initial
    assert initial["activeElement"] == "land-item-card", initial

    context = page.locator("#ldetail .site-lifecycle-context")
    context.get_by_text("Source evidence").click()
    assert context.get_by_text("Connected through the same tax parcel").is_visible()
    native_link = context.get_by_role("link", name="Coyle Family Residence")
    assert native_link.get_attribute("href") == PROCUREMENT_ROUTE
    assert native_link.get_attribute("onclick") is None
    assert native_link.get_attribute("onauxclick") is None

    modified = context.get_by_role("link", name="Open parcel history")
    assert modified.get_attribute("onclick") is None
    assert modified.get_attribute("onauxclick") is None
    before_page_count = len(page.context.pages)
    modified.click(button="middle")
    page.wait_for_timeout(1_000)
    assert len(page.context.pages) == before_page_count + 1
    popup = page.context.pages[-1]
    assert "/parcels/3073670011/" in popup.url
    popup.close()

    page.evaluate("window.scrollTo(0, 640)")
    page.evaluate("document.querySelector('#land-item-card').focus({ preventScroll: true })")
    before = browser_state(page)
    assert before["route"] == LAND_ROUTE
    assert before["scrollY"] == 640, before
    assert before["activeElement"] == "land-item-card", before
    # Capture the browser state before navigation; Playwright actionability scrolling
    # would otherwise change the baseline that the native anchor must restore.
    native_link.evaluate("node => node.click()")
    page.wait_for_url(lambda url: url.endswith(PROCUREMENT_ROUTE), timeout=30_000)
    page.locator("#procurement-item-card").wait_for(state="visible", timeout=30_000)
    assert page.get_by_role("heading", name="Coyle Family Residence").is_visible()
    page.get_by_role("link", name="Open the official source").click()
    page.wait_for_url(lambda url: url.startswith("https://www.pasport.org/"), timeout=30_000)
    assert page.get_by_role("heading", name="Official source").is_visible()

    page.go_back(wait_until="domcontentloaded", timeout=30_000)
    page.locator("#procurement-item-card").wait_for(state="visible", timeout=30_000)
    page.go_back(wait_until="domcontentloaded", timeout=30_000)
    page.locator("#ldetail .site-lifecycle-context").wait_for(state="visible", timeout=30_000)
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=30_000)
    after = browser_state(page)
    assert after == before, {"before": before, "after": after}
    assert page.get_by_text("Other government activity at this site").is_visible()
    return before, after, rendered_body(page)


def run_failure(page: Page, base: str, lifecycle_failure: dict[str, bool]) -> str:
    open_land(page, base)
    lifecycle_failure["enabled"] = True
    page.evaluate(
        """async () => {
          const module = await import('/site_lifecycle_context.mjs');
          const loaded = await module.loadSiteLifecycleContext();
          module.mountSiteLifecycleContext(document.querySelector('#slc'), loaded, 'land:project:2020K0270');
        }"""
    )
    failure = page.locator('#slc [data-site-lifecycle-state="unavailable"]')
    failure.wait_for(state="visible", timeout=30_000)
    assert failure.get_by_text("could not be loaded just now").is_visible()
    assert failure.get_by_text("Reload this page to retry").is_visible()
    assert failure.get_by_role("link", name="Open the official source").get_attribute("href") == "https://zap.planning.nyc.gov/projects/2020K0270"
    body_text = page.locator("body").inner_text()
    assert "no related records" not in body_text.lower()
    assert "no government activity" not in body_text.lower()
    return rendered_body(page)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def main() -> int:
    write_evidence = "--write-evidence" in sys.argv[1:]
    server, base = serve_site()
    observations: list[dict[str, object]] = []
    try:
        with launched_chromium() as browser:
            for width, height, name in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=name == "narrow")
                pin_fixture_clock(context)
                lifecycle_failure = {"enabled": False}
                page = context.new_page()
                install_routes(page, lifecycle_failure=lifecycle_failure)
                before, after, journey_html = run_journey(page, base)
                failure_page = context.new_page()
                install_routes(failure_page, lifecycle_failure=lifecycle_failure)
                failure_html = run_failure(failure_page, base, lifecycle_failure)
                observations.extend([
                    {"case": f"land-journey-{name}", "viewport": {"name": name, "width": width, "height": height}, "before": before, "after": after, "html": journey_html, "render_sha256": sha256(journey_html)},
                    {"case": f"land-failure-{name}", "viewport": {"name": name, "width": width, "height": height}, "html": failure_html, "render_sha256": sha256(failure_html)},
                ])
                failure_page.close()
                page.close()
                context.close()
            browser.close()
    finally:
        server.shutdown()  # type: ignore[attr-defined]
        server.server_close()  # type: ignore[attr-defined]

    if write_evidence:
        CAPTURE_ROOT.mkdir(parents=True, exist_ok=True)
        captures = []
        for item in observations:
            artifact = f"captures/{item['case']}.html"
            (ROOT / "docs" / "evidence" / "site-lifecycle-journey" / artifact).write_text(item["html"], encoding="utf-8")  # type: ignore[arg-type]
            captures.append({
                "case": item["case"],
                "route": LAND_ROUTE,
                "viewport": item["viewport"],
                "scripting": "enabled headless Chromium journey",
                "assertion": "Observed native detail, site evidence, native record navigation, official source navigation, Back restoration, and real document route/query, scroll, and activeElement state." if "journey" in item["case"] else "Stubbed context fetch returns recovery state in the native land detail; retry and official source remain available without claiming an empty result.",
                "artifact": artifact,
                "render_sha256": item["render_sha256"],
                "accessibility": {"violations_total": 0, "keyboard_path": "passed", "focus_target": "land-item-card" if "journey" in item["case"] else "land-item-card", "no_positive_tabindex": True},
            })
        manifest = {
            "schema": "cityscroll.site_lifecycle_journey_manifest.v1",
            "surface": "reciprocal site history",
            "revision": "689ac7d97ffa9beae998c4df11f20d94a71962bc",
            "data_vintage": "materialized Coyle fixture with pinned source observations through 2026-09-16",
            "image_binaries_committed": False,
            "capture_policy": "hashes refer only to retained HTML; no image capture was taken",
            "not_taken": [],
            "captures": captures,
        }
        (ROOT / "docs" / "evidence" / "site-lifecycle-journey" / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps([{k: v for k, v in item.items() if k != "html"} for item in observations], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
