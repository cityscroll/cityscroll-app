#!/usr/bin/env python3
"""Verify and capture the explicit-tap Land location flow at review widths.

The current checkout is the after state. Pass the revision immediately before the
location change for the comparison state:

    python3 tools/capture_location_awareness.py --before HEAD^
"""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Browser, BrowserContext, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "location-awareness"
VIEWPORTS = ((390, 844), (1440, 900))
LOCATED_HASH = "#land?boro=Queens&cd=Q04"
AUTO_PROMPT_KEY = "crol_land_location_auto_asked_v1"
LAND_NOTICE = {
    "project_id": "P2026Q0004",
    "project_name": "Elmhurst neighborhood rezoning",
    "project_brief": "A mixed-use proposal with new homes and ground-floor shops.",
    "primary_applicant": "Neighborhood Development Partners",
    "public_status": "In Public Review",
    "project_status": "Active",
    "borough": "Queens",
    "community_district": "Q04",
    "actions": "Community Board Review",
    "mih_flag": "true",
    "current_milestone": "Community Board Review",
    "current_milestone_date": "2026-08-12T00:00:00.000",
    "ulurp_numbers": "260004ZMQ",
}
GEOSEARCH_RESPONSE = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-73.883189, 40.747305]},
        "properties": {
            "label": "40-12 83 Street, Elmhurst, NY, USA",
            "borough": "Queens",
            "neighbourhood": "Elmhurst",
            "addendum": {"pad": {"bbl": "4014930012"}},
        },
    }],
}
LOT_GEOJSON = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"BBL": "4014930012"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-73.8834, 40.7471],
                [-73.8830, 40.7471],
                [-73.8830, 40.7475],
                [-73.8834, 40.7475],
                [-73.8834, 40.7471],
            ]],
        },
    }],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def revision_snapshot(revision: str, destination: Path) -> None:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route("https://api.crol-list.org/**", lambda route: json_response(route, {}))
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: json_response(route, {}),
    )
    page.route(
        "https://geosearch.planninglabs.nyc/v2/reverse*",
        lambda route: json_response(route, GEOSEARCH_RESPONSE),
    )

    def map_pluto(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        if query.get("f") == ["json"]:
            json_response(route, {"features": [{"attributes": {"CD": 404}}]})
        else:
            json_response(route, LOT_GEOJSON)

    page.route("https://services5.arcgis.com/**", map_pluto)

    def city_data(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path.endswith("/2iga-a6mk.json"):
            json_response(route, [])
            return
        if parsed.path.endswith("/hgx4-8ukb.json"):
            query = parse_qs(parsed.query)
            where = query.get("$where", [""])[0]
            json_response(route, [LAND_NOTICE] if "Q04" in where or "borough='Queens'" in where else [LAND_NOTICE])
            return
        json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)


def mock_location(context: BrowserContext, denied: bool = False) -> None:
    body = (
        "error({code:1,message:'denied'});"
        if denied
        else "success({coords:{latitude:40.7473,longitude:-73.8832}});"
    )
    context.add_init_script(
        f"""
        (() => {{
          window.__locationRequests = 0;
          Object.defineProperty(navigator, "geolocation", {{
            configurable: true,
            value: {{
              getCurrentPosition(success, error) {{
                window.__locationRequests++;
                {body}
              }}
            }}
          }});
        }})();
        """
    )


def mock_permissions(
    context: BrowserContext,
    state: str | None,
    asked_before: bool = False,
) -> None:
    permission_value = (
        "undefined"
        if state is None
        else (
            "{query: async descriptor => {"
            "window.__permissionQueries.push(descriptor);"
            f"return {{state:{json.dumps(state)}}};"
            "}}"
        )
    )
    seed = (
        f"try {{ localStorage.setItem({json.dumps(AUTO_PROMPT_KEY)}, '1'); }} catch (_error) {{}}"
        if asked_before
        else ""
    )
    context.add_init_script(
        f"""
        (() => {{
          window.__permissionQueries = [];
          Object.defineProperty(navigator, "permissions", {{
            configurable: true,
            value: {permission_value}
          }});
          {seed}
        }})();
        """
    )


def open_land(page: Page, base_url: str) -> None:
    page.goto(base_url + "#land", wait_until="domcontentloaded")
    page.locator("#llist .row").first.wait_for(state="visible")
    if page.viewport_size and page.viewport_size["width"] <= 680:
        toggle = page.locator("#tab-land .filtertoggle")
        if toggle.count() and page.locator("#tab-land .controls").is_hidden():
            toggle.click()


def position_capture(page: Page) -> None:
    page.locator("#tab-land .nlbox").scroll_into_view_if_needed()
    page.evaluate(
        """
        () => {
          const box=document.querySelector("#tab-land .nlbox");
          window.scrollTo(0, Math.max(0, box.getBoundingClientRect().top + scrollY - 70));
        }
        """
    )
    page.wait_for_timeout(100)


def annotate(page: Page, state: str) -> None:
    selectors = (
        [("#tab-land .controls", "BEFORE · MANUAL AREA CONTROLS")]
        if state == "before"
        else [
            ("#landlocation", "EXPLICIT TAP"),
            ("#searchstate-land .searchactive", "RESOLVED TO QUEENS CD 4"),
        ]
    )
    page.evaluate(
        """
        items => {
          const colors=["#b42318","#16794b"];
          items.forEach((item,index) => {
            const target=document.querySelector(item.selector);
            if(!target) return;
            const rect=target.getBoundingClientRect();
            const left=Math.max(5,rect.left-6);
            const top=Math.max(5,rect.top-6);
            const width=Math.min(innerWidth-left-5,rect.width+12);
            const height=Math.min(innerHeight-top-5,rect.height+12);
            const color=colors[index % colors.length];
            const mark=document.createElement("div");
            Object.assign(mark.style,{
              position:"fixed",left:`${left}px`,top:`${top}px`,
              width:`${width}px`,height:`${height}px`,
              border:`4px solid ${color}`,borderRadius:"8px",
              boxSizing:"border-box",zIndex:"99998",pointerEvents:"none"
            });
            const label=document.createElement("div");
            label.textContent=item.label;
            Object.assign(label.style,{
              position:"fixed",left:`${left}px`,
              top:`${Math.max(5,top-31-(index*2))}px`,
              maxWidth:`${Math.min(Math.max(width,180),innerWidth-left-5)}px`,
              background:color,color:"#fff",padding:"6px 9px",
              borderRadius:"5px",font:"800 11px/1.2 system-ui,sans-serif",
              zIndex:"99999",pointerEvents:"none"
            });
            document.body.append(mark,label);
          });
        }
        """,
        [{"selector": selector, "label": label} for selector, label in selectors],
    )


def capture_state(
    browser: Browser,
    tree: Path,
    state: str,
    width: int,
    height: int,
) -> None:
    with StaticServer(tree) as base_url:
        context = browser.new_context(viewport={"width": width, "height": height})
        mock_location(context)
        mock_permissions(context, "prompt", asked_before=True)
        page = context.new_page()
        errors: list[str] = []  # fixture: synthetic test data, no external source
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        open_land(page, base_url)
        assert page.evaluate("window.__locationRequests") == 0
        if state == "after":
            page.locator("#landlocation").click()
            page.wait_for_function(f"location.hash === {json.dumps(LOCATED_HASH)}")
            page.locator("#searchstate-land .searchactive").wait_for(state="visible")
            state_text = page.locator("#searchstate-land").inner_text()
            assert "near you → queens cd 4" in state_text.lower(), state_text
            share = page.locator("#searchactions-land [data-search-share]")
            href = share.get_attribute("href") or ""
            assert href == base_url + LOCATED_HASH
            assert not any(token in href.lower() for token in ("lat", "lon", "40.7473", "-73.8832", "4014930012"))
            size = page.locator("#landlocation").bounding_box()
            assert size and size["height"] >= 32 and size["width"] >= 24
            page.keyboard.press("Tab")
            page.keyboard.press("Shift+Tab")
            assert page.evaluate("document.activeElement && document.activeElement.id") == "landlocation"
            focus_style = page.locator("#landlocation").evaluate(
                "el => ({style:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth})"
            )
            assert focus_style["style"] != "none" and float(
                focus_style["width"].replace("px", "")
            ) >= 2
        else:
            assert page.locator("#landlocation").count() == 0
        position_capture(page)
        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=str(raw), animations="disabled")
        annotate(page, state)
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(annotated), animations="disabled")
        assert raw.stat().st_size > 10_000
        assert annotated.stat().st_size > 10_000
        assert not errors, errors
        context.close()


def verify_permission_states(browser: Browser) -> None:
    with StaticServer(ROOT) as base_url:
        granted_context = browser.new_context(viewport={"width": 390, "height": 844})
        mock_location(granted_context)
        mock_permissions(granted_context, "granted")
        granted = granted_context.new_page()
        install_routes(granted)
        open_land(granted, base_url)
        granted.wait_for_function("window.__locationRequests === 1")
        granted.wait_for_function(f"location.hash === {json.dumps(LOCATED_HASH)}")
        assert granted.evaluate("window.__permissionQueries") == [{"name": "geolocation"}]  # fixture: synthetic test data, no external source
        assert granted.evaluate(f"localStorage.getItem({json.dumps(AUTO_PROMPT_KEY)})") is None
        granted_context.close()

        prompt_context = browser.new_context(viewport={"width": 390, "height": 844})
        mock_location(prompt_context, denied=True)
        mock_permissions(prompt_context, "prompt")
        prompt = prompt_context.new_page()
        install_routes(prompt)
        open_land(prompt, base_url)
        prompt.wait_for_function("window.__locationRequests === 1")
        assert prompt.locator("#landlocation").is_enabled()
        assert prompt.evaluate(
            f"localStorage.getItem({json.dumps(AUTO_PROMPT_KEY)})"
        ) == "1"
        prompt.reload(wait_until="domcontentloaded")
        prompt.locator("#llist .row").first.wait_for(state="visible")
        assert prompt.evaluate("window.__locationRequests") == 0
        prompt_context.close()

        for permission_state in ("denied", None):
            manual_context = browser.new_context(viewport={"width": 390, "height": 844})
            mock_location(manual_context)
            mock_permissions(manual_context, permission_state)
            manual = manual_context.new_page()
            install_routes(manual)
            open_land(manual, base_url)
            assert manual.evaluate("window.__locationRequests") == 0
            manual_context.close()


def verify_denial_and_replay(browser: Browser) -> None:
    with StaticServer(ROOT) as base_url:
        denied_context = browser.new_context(viewport={"width": 390, "height": 844})
        mock_location(denied_context, denied=True)
        mock_permissions(denied_context, "denied")
        denied = denied_context.new_page()
        install_routes(denied)
        open_land(denied, base_url)
        before = {
            "url": denied.url,
            "borough": denied.locator("#lboro").input_value(),
            "keyword": denied.locator("#lkw").input_value(),
            "state": denied.locator("#searchstate-land").inner_text(),
        }
        denied.locator("#landlocation").click()
        denied.wait_for_function("window.__locationRequests === 1")
        assert denied.locator("#landlocation").is_enabled()
        assert {
            "url": denied.url,
            "borough": denied.locator("#lboro").input_value(),
            "keyword": denied.locator("#lkw").input_value(),
            "state": denied.locator("#searchstate-land").inner_text(),
        } == before
        denied_context.close()

        replay_context = browser.new_context(viewport={"width": 390, "height": 844})
        mock_location(replay_context)
        mock_permissions(replay_context, "prompt", asked_before=True)
        replay = replay_context.new_page()
        install_routes(replay)
        replay.goto(base_url + LOCATED_HASH, wait_until="domcontentloaded")
        replay.locator("#llist .row").first.wait_for(state="visible")
        assert replay.evaluate("window.__locationRequests") == 0
        state_text = replay.locator("#searchstate-land").inner_text()
        assert "queens" in state_text.lower() and "cd 4" in state_text.lower()
        assert "near you" not in state_text.lower()
        share = replay.locator("#searchactions-land [data-search-share]")
        assert share.get_attribute("href") == base_url + LOCATED_HASH
        replay.locator("#searchactions-land [data-search-save]").click()
        stored = replay.evaluate("localStorage.getItem('crd_nlq_presets_v1')")
        assert stored and "40.7473" not in stored and "-73.8832" not in stored
        replay_context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--before",
        default="HEAD^",
        help="revision immediately before the location-awareness change",
    )
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-location-awareness-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    capture_state(browser, before_tree, "before", width, height)
                    capture_state(browser, ROOT, "after", width, height)
                verify_permission_states(browser)
                verify_denial_and_replay(browser)
            finally:
                browser.close()

    print("Location-awareness browser checks passed.")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
