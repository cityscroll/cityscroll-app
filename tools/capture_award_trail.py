#!/usr/bin/env python3
"""Observe two real award trails by clicks, independently of required release gates.

Setup: full checkout, Python Playwright + Chromium, build_primary_documents.mjs
build_agency_constellation_documents.mjs and build_public_site.mjs (to _site). Images and source responses stay
under ignored .artifacts/. No prepared walk token is supplied to either journey.

Run --acquire explicitly to snapshot public City Record GET responses, then run
without it to replay those read models against the local candidate. Acquisition
is manual evidence collection, never a resident read or a required CI input.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

from capture_guide_product_access import serve

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".artifacts" / "award-trail"
SNAPSHOT = OUTPUT / "public-read-snapshot.json"
MANIFEST = ROOT / "docs/evidence/public-user-guide/award-trail/capture-manifest.json"
SOURCE = "https://data.cityofnewyork.us/resource/dg92-zbpx.json"
STEMS = ("LANTERN COMMUNITY SERVICES", "VOLUNTEERS OF AMERICA GREATER NEW YORK")
AGENCY = "/agencies/homeless-services/"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def acquire():
    observations = []
    profiles = {}
    for stem in STEMS:
        where = (f"upper(vendor_name) like '%{stem}%' AND "
                 "type_of_notice_description='Award' AND contract_amount < 10000000000")
        queries = {
            "aggregate": {"$where": where, "$select": "vendor_name,agency_name,count(1) as n,sum(contract_amount) as t,min(start_date) as first,max(start_date) as last", "$group": "vendor_name,agency_name", "$limit": "1000"},
            "notices": {"$where": where, "$order": "start_date DESC,request_id DESC", "$limit": "15"},
        }
        fetched = {}
        for kind, params in queries.items():
            url = SOURCE + "?" + urlencode(params)
            with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60) as response:
                raw = response.read()
            fetched[kind] = json.loads(raw)
            observations.append({"vendor": stem, "kind": kind, "url": url, "sha256": digest(raw), "rows": len(fetched[kind])})
        result = subprocess.run(
            ["node", "--input-type=module", "-e", "import {buildVendorProfiles} from './worker/src/vendor_profile.mjs'; let s=''; for await(const c of process.stdin)s+=c; process.stdout.write(JSON.stringify(buildVendorProfiles(JSON.parse(s))));"],
            cwd=ROOT, input=json.dumps(fetched["aggregate"]), text=True, capture_output=True, check=True,
        )
        profile = json.loads(result.stdout)[stem]
        # Restrict to the exact normalized publisher identity used by the profile.
        names = {variant["name"] for variant in profile["variants"]}
        profile["recentNotices"] = [row for row in fetched["notices"] if row["vendor_name"] in names]
        profile["forecasts"] = []
        assert profile["recentNotices"], f"No current award example for {stem}; select another observed chain."
        profiles[stem] = profile
    snapshot = {"captured_at": datetime.now(timezone.utc).isoformat(), "observations": observations, "profiles": profiles}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(json.dumps(snapshot, indent=2) + "\n")
    print("Public source responses snapshotted; no account mutations.", flush=True)


def path(url):
    parts = urlsplit(url)
    return parts.path + ("?" + parts.query if parts.query else "") + ("#" + parts.fragment if parts.fragment else "")


def state(url):
    token = parse_qs(urlsplit(url).query).get("walk", [""])[0]
    return json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))) if token else None


def install_reads(context, base, snapshot):
    mutations = []
    rows = {row["request_id"]: row for profile in snapshot["profiles"].values() for row in profile["recentNotices"]}

    def route_request(route):
        request = route.request
        url = urlsplit(request.url)
        query = parse_qs(url.query)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            mutations.append({"method": request.method, "path": url.path})
            route.fulfill(status=200, json={"ok": True})
        elif url.path == "/vendor-profile":
            profile = snapshot["profiles"].get(query.get("name", [""])[0])
            route.fulfill(status=200 if profile else 404, json={"ok": bool(profile), "profile": profile, "generated": snapshot["captured_at"]})
        elif url.path == "/notice":
            row = rows.get(query.get("id", [""])[0])
            route.fulfill(status=200 if row else 404, json={"row": row})
        elif url.netloc == urlsplit(base).netloc:
            route.continue_()
        else:
            # Optional enrichments are unavailable in this offline replay. No
            # browser request can acquire publisher data or mutate a real account.
            route.fulfill(status=200, json={"ok": True, "recognized": False, "hearings": [], "attachments": []})
    context.route("**/*", route_request)
    return mutations


def capture():
    snapshot = json.loads(SNAPSHOT.read_text())
    server, thread, base = serve(ROOT / "_site")
    captures = []
    journeys = []
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in ((390, 844), (1440, 900)):
                for ordinal, stem in enumerate(STEMS, 1):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    mutations = install_reads(context, base, snapshot)
                    page = context.new_page()
                    steps = []
                    page.goto(base.rstrip("/") + AGENCY, wait_until="domcontentloaded")
                    link = page.locator(f'a[data-pivot-schema][href="/vendors/{quote(stem, safe="")}/"]').first
                    link.wait_for()
                    steps.append({"action": "Open agency; select the named vendor under Connected records", "url": path(page.url), "control": link.inner_text()})
                    link.click()
                    page.locator('.traversal-path[data-traversal-hop-count="1"]').wait_for()
                    page.locator("#vendor-on-the-record").wait_for()
                    # Reveal the ordinary chronological list, then select its award title.
                    timeline = page.locator("#vendor-on-the-record")
                    summary = timeline.locator("details > summary").filter(has_text="Show all dates")
                    if summary.count():
                        summary.first.click()
                        steps.append({"action": "Expand Show all dates under On the record", "url": path(page.url), "control": summary.first.inner_text()})
                    expected = next(row for row in snapshot["profiles"][stem]["recentNotices"] if row["agency_name"] == "Homeless Services")
                    selector = f'a[data-pivot-target-kind="notice"][href="#notice/{expected["request_id"]}"]'
                    award = timeline.locator(selector).filter(visible=True).first
                    if not award.count():
                        timeline.locator("details > summary").first.click()
                        dates = timeline.locator("button[data-vendor-dates]").filter(visible=True)
                        if dates.count():
                            steps.append({"action": "Show award dates", "url": path(page.url), "control": dates.first.inner_text()})
                            dates.first.click()
                        award = timeline.locator(selector).filter(visible=True).first
                    steps.append({"action": "Select the award connection", "url": path(page.url), "control": award.inner_text(), "href": award.get_attribute("href")})
                    award.click()
                    page.wait_for_url("**/notices/**")
                    page.locator('.traversal-path[data-traversal-hop-count="2"]').wait_for()
                    page.locator("[data-notice-id] .rolename").wait_for()
                    copied = page.url
                    before = state(copied)
                    steps.append({"action": "Copy the complete browser address", "url": path(copied)})
                    context.close()

                    fresh = browser.new_context(viewport={"width": width, "height": height})
                    install_reads(fresh, base, snapshot)
                    replay = fresh.new_page()
                    replay.goto(copied, wait_until="domcontentloaded")
                    replay.locator('.traversal-path[data-traversal-hop-count="2"]').wait_for()
                    replay.locator("[data-notice-id] .rolename").wait_for()
                    assert state(replay.url) == before
                    trail = replay.locator(".traversal-path")
                    trail.scroll_into_view_if_needed()
                    image = OUTPUT / f"chain-{ordinal}-{width}.png"
                    replay.screenshot(path=str(image))
                    captures.append({"id": f"chain-{ordinal}-{width}", "route": path(replay.url), "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": snapshot["captured_at"], "assertion": "A fresh session restores the two-hop trail created by clicking agency, vendor and award connections.", "assertion_holds": True, "sha256": digest(image.read_bytes()), "file": None, "trail_text": trail.inner_text()})
                    steps.append({"action": "Paste the copied address into a fresh browser session", "url": path(replay.url)})
                    replay.locator(".traversal-path-back").click()
                    replay.locator('.traversal-path[data-traversal-hop-count="1"]').wait_for()
                    replay.locator(".traversal-path-restart").click()
                    replay.wait_for_url("**" + AGENCY)
                    assert not state(replay.url)
                    replay.goto(base.rstrip("/") + AGENCY + "?claim=example-unknown-connection", wait_until="domcontentloaded")
                    panel = replay.locator("[data-edge-provenance-panel]")
                    panel.wait_for(state="attached")
                    unknown_hidden = not panel.is_visible()
                    assert unknown_hidden
                    replay.goto(base + "#investigation", wait_until="domcontentloaded")
                    replay.get_by_text("0 pinned items", exact=False).wait_for()
                    journeys.append({"chain": ordinal, "viewport_width": width, "steps": steps, "hop_count": 2, "back_hop_count": 1, "restart": AGENCY, "unknown_connection_panel_hidden": unknown_hidden, "fresh_collection_empty": True, "blocked_mutations": mutations})
                    fresh.close()
                    print(f"Chain {ordinal}, {width}px: created, copied, reopened, back and restart passed.", flush=True)
            browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    modules = ("site/route_migration.mjs", "site/app/entities.mjs", "site/app/traversal.mjs")
    module_hashes = {name: digest((ROOT / name).read_bytes()) for name in modules}
    MANIFEST.write_text(json.dumps({"schema_version": 1, "capture_mode": "local_candidate_with_snapshotted_public_reads", "repository_revision": revision, "candidate_module_sha256": module_hashes, "source_observations": snapshot["observations"], "data_vintage": snapshot["captured_at"], "captures": captures, "journeys": journeys}, indent=2) + "\n")
    # Retain the existing access tool's assertions and hashes in a new receipt,
    # without carrying its historical record identity or local image locations.
    access_path = MANIFEST.parent / "guide-product-access.json"
    if access_path.exists():
        access = json.loads(access_path.read_text())
        access["record"] = "guide-product-access"
        for item in access["captures"]:
            item.pop("local_capture_path", None)
        access_path.write_text(json.dumps(access, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--acquire", action="store_true")
    args = parser.parse_args()
    if args.acquire:
        acquire()
    else:
        capture()
