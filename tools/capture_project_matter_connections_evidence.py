#!/usr/bin/env python3
"""Headless read-back of the project/matter connection on the served pages.

Both directions of the connection are read back from pages as they are served,
at a desktop and a narrow viewport, with the positive and the negative example
in each direction:

  matter -> project   the real `/matters/:id/` response bodies rendered by
                      tools/render_project_matter_connection_fixtures.mjs
  project -> matter   the built site's own land detail, rendered by the shipped
                      browser module from the Worker read model's payload

Each page is checked for the connection itself, for keyboard reachability of
every connection link, for native link behaviour (an href the browser owns, no
new-tab target, so a modified click and the back button work), and with the
vendored axe-core rule set. The matter document is also read back with
JavaScript disabled, because it is server-rendered and must not depend on it.
The land detail is read back once more against a failing API response, to prove
a failed load leaves no half-built connection furniture.

Screenshots stay under an ignored path. The receipt is the evidence: route,
viewport, revision, data vintage, assertion, and the sha256 of each capture.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / ".artifacts" / "project-matter-connections" / "fixtures"
OUT = ROOT / ".artifacts" / "project-matter-connections"
SITE = ROOT / "_site"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
API_ORIGINS = ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev")


class RepoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def revision() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT,
                          capture_output=True, text=True, check=True).stdout.strip()


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22 = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22)
    return {"failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
            "passes": len(gate) == 0}


KEYBOARD_PROBE = """(selector) => {
  const links = [...document.querySelectorAll(selector)];
  if (!links.length) return {count: 0, reachable: 0, native: true, new_tab: 0};
  let reachable = 0;
  for (const link of links) {
    link.focus();
    if (document.activeElement === link) reachable += 1;
  }
  return {
    count: links.length,
    reachable,
    native: links.every((link) => link.tagName === 'A' && (link.getAttribute('href') || '').length > 0),
    new_tab: links.filter((link) => link.hasAttribute('target')).length,
  };
}"""


def capture_matter_pages(browser, port, manifest, rev, vintage, receipts):
    for case in manifest["matters"]:
        url = f"http://127.0.0.1:{port}/{case['file']}"
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(url, wait_until="domcontentloaded")
            section = page.locator("section[data-council-land-project-id]")
            present = section.count() > 0
            project_link = page.locator("a[data-council-land-project]")
            companions = page.locator("a[data-council-land-companion]")
            keyboard = page.evaluate(
                KEYBOARD_PROBE, "a[data-council-land-project], a[data-council-land-companion]")
            shot = OUT / f"{case['id']}-{width}x{height}.png"
            page.screenshot(path=str(shot), full_page=True)
            axe = run_axe(page)
            receipts.append({
                "surface": "matter_document",
                "case": case["id"],
                "route": case["route"],
                "viewport": {"width": width, "height": height},
                "revision": rev,
                "data_vintage": vintage,
                "javascript": "enabled",
                "observed": {
                    "land_project_section": present,
                    "project_links": project_link.count(),
                    "companion_links": companions.count(),
                    "keyboard": keyboard,
                    "decision_claim": section.get_attribute("data-council-land-decision") if present else None,
                },
                "assertion": f"{case['route']} at {width}x{height}: {case['expectation']}",
                "screenshot": str(shot.relative_to(ROOT)),
                "screenshot_sha256": sha256_of(shot),
                "axe": axe,
            })
            page.close()

        # Server-rendered: the same connection must survive with no JavaScript.
        context = browser.new_context(java_script_enabled=False,
                                      viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded")
        present = page.locator("#matter-land-project").count() > 0
        links = page.locator("a[data-council-land-project], a[data-council-land-companion]").count()
        receipts.append({
            "surface": "matter_document",
            "case": case["id"],
            "route": case["route"],
            "viewport": {"width": 390, "height": 844},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "disabled",
            "observed": {"land_project_section": present, "connection_links": links},
            "assertion": (f"{case['route']} at 390x844 with JavaScript disabled: "
                          f"{case['expectation']}"),
        })
        context.close()


def stub_api(page, project_id, payload, status=200):
    body = json.dumps(payload)
    for origin in API_ORIGINS:
        page.route(f"{origin}/zap-outcomes?id={project_id}", lambda route: route.fulfill(
            status=status, content_type="application/json", body=body))


def capture_project_pages(browser, port, manifest, rev, vintage, receipts):
    base = f"http://127.0.0.1:{port}/"
    for case in manifest["projects"]:
        record = json.loads((ROOT / case["file"]).read_text())
        payload = {
            "ok": True,
            "cached": True,
            "sections": {"project_connections": {"schema_version": 1, "status": "available"}},
            "record": record,
        }
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            stub_api(page, case["project_id"], payload)
            page.goto(f"{base}browse/zoning/#land/{case['project_id']}",
                      wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_selector("#project-connections", state="attached", timeout=60_000)
            page.wait_for_timeout(2_500)
            group = page.locator('.pc-group[data-project-group="council_matters"]')
            rendered = group.count() > 0
            links = page.locator('.pc-group[data-project-group="council_matters"] a[href^="/matters/"]')
            keyboard = page.evaluate(
                KEYBOARD_PROBE, '.pc-group[data-project-group="council_matters"] a[href^="/matters/"]')
            heading = group.locator("h3").inner_text() if rendered else None
            shot = OUT / f"{case['id']}-{width}x{height}.png"
            page.screenshot(path=str(shot), full_page=True)
            axe = run_axe(page)
            receipts.append({
                "surface": "land_project_detail",
                "case": case["id"],
                "route": case["route"],
                "viewport": {"width": width, "height": height},
                "revision": rev,
                "data_vintage": vintage,
                "javascript": "enabled",
                "observed": {
                    "council_matters_group": rendered,
                    "matter_links": links.count(),
                    "heading": heading,
                    "keyboard": keyboard,
                },
                "assertion": f"{case['route']} at {width}x{height}: {case['expectation']}",
                "screenshot": str(shot.relative_to(ROOT)),
                "screenshot_sha256": sha256_of(shot),
                "axe": axe,
            })
            page.close()

    # The journey the connection exists for: a project, one of its matters, a
    # companion matter, and the browser's own Back. The matter routes are served
    # here by the same response bodies the edge handler produced.
    connected = manifest["projects"][0]
    record = json.loads((ROOT / connected["file"]).read_text())
    payload = {"ok": True, "cached": True,
               "sections": {"project_connections": {"schema_version": 1, "status": "available"}},
               "record": record}
    bodies = {case["route"]: (ROOT / case["file"]).read_text() for case in manifest["matters"]}
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        stub_api(page, connected["project_id"], payload)
        page.route("**/matters/*/", lambda route: route.fulfill(
            status=200, content_type="text/html; charset=utf-8",
            body=bodies.get(urlparse(route.request.url).path, "<h1>not captured</h1>")))
        page.goto(f"{base}browse/zoning/#land/{connected['project_id']}",
                  wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector('.pc-group[data-project-group="council_matters"] a[href^="/matters/"]',
                               timeout=60_000)
        steps = []
        page.locator('.pc-group[data-project-group="council_matters"] a[href^="/matters/"]').first.click()
        page.wait_for_selector("section[data-council-land-project-id]", timeout=60_000)
        steps.append({"step": "project_to_matter", "path": urlparse(page.url).path,
                      "project_back_link": page.locator("a[data-council-land-project]").count()})
        companion = page.locator("a[data-council-land-companion]").first
        companion.focus()
        page.keyboard.press("Enter")
        page.wait_for_selector("section[data-council-land-project-id]", timeout=60_000)
        steps.append({"step": "matter_to_companion_by_keyboard", "path": urlparse(page.url).path,
                      "project_back_link": page.locator("a[data-council-land-project]").count()})
        page.go_back()
        page.wait_for_load_state("domcontentloaded")
        steps.append({"step": "browser_back_to_matter", "path": urlparse(page.url).path})
        page.go_back()
        page.wait_for_load_state("domcontentloaded")
        steps.append({"step": "browser_back_to_project", "path": urlparse(page.url).path,
                      "hash": urlparse(page.url).fragment})
        shot = OUT / f"project-journey-{width}x{height}.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append({
            "surface": "journey",
            "case": "project-matter-companion-back",
            "route": connected["route"],
            "viewport": {"width": width, "height": height},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": {"steps": steps},
            "assertion": (f"at {width}x{height}: the land detail opens a Council matter, the matter "
                          "opens a companion from the keyboard, and Back returns through both"),
            "screenshot": str(shot.relative_to(ROOT)),
            "screenshot_sha256": sha256_of(shot),
        })
        page.close()

    # A failed load must leave no half-built connection behind.
    failing = manifest["projects"][0]
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    stub_api(page, failing["project_id"], {"ok": False, "error": "unavailable"}, status=503)
    page.goto(f"{base}browse/zoning/#land/{failing['project_id']}",
              wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("#project-connections", state="attached", timeout=60_000)
    page.wait_for_timeout(2_500)
    receipts.append({
        "surface": "land_project_detail",
        "case": "project-failed-load",
        "route": failing["route"],
        "viewport": {"width": 1440, "height": 900},
        "revision": rev,
        "data_vintage": vintage,
        "javascript": "enabled",
        "observed": {
            "council_matters_group": page.locator(
                '.pc-group[data-project-group="council_matters"]').count() > 0,
            "matter_links": page.locator(
                '.pc-group[data-project-group="council_matters"] a').count(),
        },
        "assertion": (f"{failing['route']} at 1440x900 with the read model returning 503: "
                      "no Council matter connection furniture is rendered"),
    })
    page.close()

    # Every shipping language renders the group under its own heading, with the
    # publisher's own matter titles left in the source language.
    connected = manifest["projects"][0]
    record = json.loads((ROOT / connected["file"]).read_text())
    payload = {"ok": True, "cached": True,
               "sections": {"project_connections": {"schema_version": 1, "status": "available"}},
               "record": record}
    languages = json.loads(
        subprocess.run(
            ["node", "-e",
             "global.window={};require(process.argv[1]);"
             "console.log(JSON.stringify(window.SHIPPING_LANGS))",
             str(ROOT / "site" / "i18n.js")],
            capture_output=True, text=True, check=True).stdout)
    for language in ["en", *languages]:
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        stub_api(page, connected["project_id"], payload)
        page.goto(f"{base}browse/zoning/?lang={language}#land/{connected['project_id']}",
                  wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector("#project-connections", state="attached", timeout=60_000)
        page.wait_for_timeout(2_500)
        group = page.locator('.pc-group[data-project-group="council_matters"]')
        rendered = group.count() > 0
        heading = group.locator("h3").inner_text() if rendered else None
        titles = page.locator(
            '.pc-group[data-project-group="council_matters"] a[href^="/matters/"]').all_inner_texts()
        receipts.append({
            "surface": "land_project_detail",
            "case": f"project-language-{language}",
            "route": f"{connected['route']} (lang={language})",
            "viewport": {"width": 1440, "height": 900},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": {
                "council_matters_group": rendered,
                "heading": heading,
                "matter_links": len(titles),
                "source_titles_preserved": all("LU 0" in title for title in titles) if titles else None,
            },
            "assertion": (f"land detail in {language}: the Council matter group renders under its "
                          "own translated heading with the publisher's matter titles unchanged"),
        })
        page.close()


def main() -> None:
    if not (FIXTURES / "manifest.json").exists():
        print("run node tools/render_project_matter_connection_fixtures.mjs first", file=sys.stderr)
        sys.exit(1)
    if not SITE.exists():
        print("run tools/prepare_functional_site.sh first", file=sys.stderr)
        sys.exit(1)
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    rev = revision()
    vintage = manifest["data_vintage"]

    repo_server, repo_port = serve(RepoHandler)
    site_server, site_port = serve(SiteHandler)
    receipts: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            capture_matter_pages(browser, repo_port, manifest, rev, vintage, receipts)
            capture_project_pages(browser, site_port, manifest, rev, vintage, receipts)
            browser.close()
    finally:
        repo_server.shutdown()
        site_server.shutdown()

    receipt = {
        "schema": "cityscroll.project_matter_connection_capture.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "revision": rev,
        "data_vintage": vintage,
        "captures": receipts,
        "axe_all_pass": all(entry.get("axe", {}).get("passes", True) for entry in receipts),
    }
    path = OUT / "capture-manifest.json"
    path.write_text(f"{json.dumps(receipt, indent=2)}\n")
    print(f"wrote {path.relative_to(ROOT)} ({len(receipts)} captures, axe_all_pass={receipt['axe_all_pass']})")


if __name__ == "__main__":
    main()
