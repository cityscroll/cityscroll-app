#!/usr/bin/env python3
"""Capture the deployed default-local-home journeys in real Chromium.

The run is fail-closed: it reads the Pages artifact manifest, requires the
recorded delivery commit to be an ancestor of the served revision, observes
the production page at desktop and phone widths, and verifies that the served
revision does not change during the run. Screenshot binaries stay in an
ignored, repository-local run directory; the committed manifest retains their
digests and textual browser observations.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "test" / "browser"))
from browser_support import launched_chromium  # noqa: E402
from deployed_capture_ancestor import (  # noqa: E402
    DeployPendingError,
    WrongPinError,
    load_recorded_delivery,
    require_served_page_revision_contains_delivery,
)

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "default-local-home-journey"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
PUBLIC_ALIAS = "c27355579ade0"
DEFAULT_BASE = "https://cityscroll.org/"
REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY_PATH)
LAND_HASH = "#land/2022M0258"
UNKNOWN_HASH = "#not-a-cityscroll-route"
MIDWOOD_GEO = "nta2020:BK1403"
KENSINGTON_GEO = "nta2020:BK1203"
MIDWOOD_RECORD_NEEDLE = "housing-and-land-use-committee-meeting-september-2026"
VIEWPORTS = (("desktop", 1440, 900), ("phone", 390, 844))
HEADER_KEYS = ("date", "cf-ray", "cf-cache-status", "age", "last-modified", "etag")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "cityscroll-default-local-home-capture/2"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"served JSON is not an object: {url}")
    return payload


def deployment_manifest(base: str) -> dict:
    url = urljoin(base.rstrip("/") + "/", "artifact-manifest.json")
    payload = fetch_json(url)
    revision = str(payload.get("source_commit_sha") or "")
    artifact_hash = str(payload.get("artifact_hash") or "")
    source_receipt = payload.get("source_receipt") or {}
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit(f"served artifact manifest lacks a 40-hex source_commit_sha: {payload!r}")
    if not re.fullmatch(r"[0-9a-f]{64}", artifact_hash):
        raise SystemExit(f"served artifact manifest lacks a 64-hex artifact_hash: {payload!r}")
    if not re.fullmatch(r"[0-9a-f]{64}", str(source_receipt.get("sha256") or "")):
        raise SystemExit("served artifact manifest lacks a source-receipt digest; production data is not pinned")
    if not source_receipt.get("generated_at"):
        raise SystemExit("served artifact manifest lacks source-receipt generated_at; production data vintage is absent")
    return {"url": url, **payload}


def require_deployed_revision(base: str, deployment: dict) -> str:
    try:
        return require_served_page_revision_contains_delivery(
            base,
            REQUIRED_ANCESTOR,
            cwd=ROOT,
            fetch_json=lambda _url: deployment,
        )
    except (WrongPinError, DeployPendingError) as error:
        raise SystemExit(str(error)) from error


def grounded_origin_main() -> str:
    result = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "origin/main"],
        check=True,
        capture_output=True,
        text=True,
    )
    revision = result.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit(f"origin/main did not resolve to a full commit: {revision!r}")
    return revision


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def page_load_receipt(response, served_revision: str) -> dict:  # noqa: ANN001
    raw_headers = response.headers if response is not None else {}
    return {
        "url": response.url if response is not None else None,
        "http_status": response.status if response is not None else None,
        "served_revision": served_revision,
        "headers": {key: raw_headers.get(key) or None for key in HEADER_KEYS},
    }


def navigation_log(page) -> list[dict]:  # noqa: ANN001
    events: list[dict] = []

    def on_navigation(frame) -> None:  # noqa: ANN001
        if frame == page.main_frame and str(frame.url).startswith("http"):
            events.append({"observed_at": now_iso(), "url": frame.url})

    page.on("framenavigated", on_navigation)
    return events


def wait_shell_ready(page) -> None:  # noqa: ANN001
    page.wait_for_selector("[data-near-you-root]", state="visible", timeout=60_000)
    page.wait_for_selector("#near-geo-search-input", state="visible", timeout=60_000)


def measure_shell(page) -> dict:  # noqa: ANN001
    return page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          const search = document.querySelector('[data-geography-search], form.near-geo-search');
          const locationBtn = document.querySelector('[data-use-location], .near-location-action');
          const styles = [...document.styleSheets].map((sheet) => {
            try { return sheet.href; } catch { return null; }
          }).filter(Boolean);
          const map = document.querySelector('.near-map, [data-geography-map], #near-map, .geography-map');
          const selectedKey = document.querySelector('[data-geography-selected-key]')
            ?.dataset?.geographySelectedKey || null;
          const mapRect = map ? map.getBoundingClientRect() : null;
          const shellRect = root ? root.getBoundingClientRect() : null;
          return {
            measured_css: styles.length > 0,
            stylesheet_hrefs: styles,
            has_shell: Boolean(root),
            has_search: Boolean(search),
            has_location_control: Boolean(locationBtn) && !locationBtn.hidden,
            has_following_link: Boolean(document.querySelector('a[href*="/following"]')),
            has_browse_link: Boolean(document.querySelector('a[href*="/browse"]')),
            viewport_width_px: window.innerWidth,
            viewport_height_px: window.innerHeight,
            map_or_shell_height_px: Math.round((mapRect || shellRect || { height: 0 }).height || 0),
            overflow_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            geo: root?.dataset?.geo || null,
            selected_geo: selectedKey?.replace(/^geography:/, '') || null,
            results_count: document.querySelector('[data-results-count]')?.dataset?.resultsCount || null,
            title: document.title,
          };
        }"""
    )


def measure_land_hash(page) -> dict:  # noqa: ANN001
    return page.evaluate(
        """() => {
          const styles = [...document.styleSheets].map((sheet) => {
            try { return sheet.href; } catch { return null; }
          }).filter(Boolean);
          return {
            measured_css: styles.length > 0,
            stylesheet_hrefs: styles,
            viewport_width_px: window.innerWidth,
            viewport_height_px: window.innerHeight,
            overflow_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            app_ready: document.body.dataset.appReady === 'true',
            land_item_present: Boolean(document.querySelector('#land-item-card')),
            project_connections_present: Boolean(document.querySelector('#project-connections')),
            project_id_present: Boolean(
              document.querySelector('#land-item-card a[href*="#land/2022M0258"]')
            ) && location.hash === '#land/2022M0258',
            title: document.title,
          };
        }"""
    )


def deny_geolocation_permission(page, origin: str) -> None:  # noqa: ANN001
    client = page.context.new_cdp_session(page)
    client.send(
        "Browser.setPermission",
        {"permission": {"name": "geolocation"}, "setting": "denied", "origin": origin.rstrip("/")},
    )


def require_assertions(name: str, assertions: dict[str, bool]) -> None:
    failed = [key for key, value in assertions.items() if value is not True]
    if failed:
        raise SystemExit(f"{name}: runtime assertions failed: {failed}")


def capture_row(
    *, page, response, screenshot_dir: Path, name: str, route: str,
    width: int, height: int, revision: str, data_vintage: dict,
    assertion: str, assertions: dict[str, bool], snapshot: dict,
    capture_run_id: str, observed_url_before: str, navigation_events: list[dict],
) -> dict:
    require_assertions(name, assertions)
    captured_at = now_iso()
    image_name = f"{name}.png"
    png = page.screenshot(full_page=True, type="png", animations="disabled")
    (screenshot_dir / image_name).write_bytes(png)
    page_load = page_load_receipt(response, revision)
    if page_load["http_status"] != 200:
        raise SystemExit(f"{name}: production page load did not return 200: {page_load!r}")
    return {
        "name": name,
        "route": route,
        "source": "headless-playwright-production-served-site",
        "viewport": {"width": width, "height": height},
        "revision": revision,
        "data_vintage": data_vintage,
        "assertion": assertion,
        "assertions": assertions,
        "sha256": sha256_bytes(png),
        "file": None,
        "screenshot_url": None,
        "local_image_name": image_name,
        "capture_run_id": capture_run_id,
        "snapshot": snapshot,
        "run_receipt": {
            "capture_run_id": capture_run_id,
            "captured_at": captured_at,
            "served_revision": revision,
            "observed_url_before": observed_url_before,
            "observed_url_after": page.url,
            "navigation_events": navigation_events,
            "page_load": page_load,
        },
    }


def capture(base: str) -> dict:
    base = base.rstrip("/") + "/"
    deployment = deployment_manifest(base)
    revision = require_deployed_revision(base, deployment)
    capture_run_id = str(uuid.uuid4())
    run_started_at = now_iso()
    screenshot_rel = Path(".artifacts") / "default-local-home-journey" / capture_run_id
    screenshot_dir = ROOT / screenshot_rel
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    data_vintage = {
        "artifact_generated_at": deployment.get("generated_at"),
        "deployment_at": deployment.get("deployment_at"),
        "source_receipt_generated_at": deployment["source_receipt"]["generated_at"],
        "source_receipt_sha256": deployment["source_receipt"]["sha256"],
    }
    captures: list[dict] = []
    origin = base.rstrip("/")
    print(f"production base={base} revision={revision} capture_run_id={capture_run_id}", flush=True)

    with launched_chromium() as browser:
        for viewport_name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/2",
            )
            page = context.new_page()
            events = navigation_log(page)
            response = page.goto(base, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page)
            initial = measure_shell(page)
            captures.append(capture_row(
                page=page, response=response, screenshot_dir=screenshot_dir,
                name=f"root-shell-initial-{viewport_name}", route="/", width=width, height=height,
                revision=revision, data_vintage=data_vintage,
                assertion="Bare production root remains on the Near You shell with local entry and global navigation available.",
                assertions={
                    "near_you_shell_visible": initial["has_shell"],
                    "place_search_visible": initial["has_search"],
                    "location_control_visible": initial["has_location_control"],
                    "following_link_present": initial["has_following_link"],
                    "browse_link_present": initial["has_browse_link"],
                    "viewport_matches": initial["viewport_width_px"] == width and initial["viewport_height_px"] == height,
                    "horizontal_overflow_at_most_one_px": initial["overflow_x"] <= 1,
                    "bare_root_remained_near_you": page.url == base,
                },
                snapshot=initial, capture_run_id=capture_run_id,
                observed_url_before=base, navigation_events=list(events),
            ))

            before_midwood = page.url
            page.fill("#near-geo-search-input", "810 East 16th Street Brooklyn")
            page.click("form.near-geo-search button[type='submit']")
            page.wait_for_function(
                """() => (document.querySelector('[data-near-you-root]')?.dataset?.geo || '').includes('BK1403') || location.href.includes('BK1403')""",
                timeout=60_000,
            )
            page.wait_for_selector(
                f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"]', state="attached", timeout=60_000,
            )
            midwood = measure_shell(page)
            record_present = page.locator(f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"]').count() > 0
            captures.append(capture_row(
                page=page, response=response, screenshot_dir=screenshot_dir,
                name=f"root-midwood-result-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="Typing the Midwood address from production root selects BK1403 and returns the named retained meeting row.",
                assertions={
                    "near_you_shell_visible": midwood["has_shell"],
                    "selected_midwood_geo": midwood["selected_geo"] == MIDWOOD_GEO,
                    "midwood_geo_in_url": "BK1403" in page.url,
                    "served_midwood_record_present": record_present,
                    "horizontal_overflow_at_most_one_px": midwood["overflow_x"] <= 1,
                },
                snapshot={**midwood, "named_record_present": record_present},
                capture_run_id=capture_run_id, observed_url_before=before_midwood,
                navigation_events=list(events),
            ))
            context.close()

            context2 = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/2",
            )
            page2 = context2.new_page()
            events2 = navigation_log(page2)
            denial_response = page2.goto(base, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page2)
            deny_geolocation_permission(page2, origin)
            before_denial = page2.url
            page2.click("[data-use-location]")
            page2.wait_for_function(
                """() => /permission was not granted|choose an area/i.test(document.querySelector('[data-map-status]')?.textContent || '')""",
                timeout=30_000,
            )
            denial = measure_shell(page2)
            denial_status = page2.locator("[data-map-status]").text_content() or ""
            captures.append(capture_row(
                page=page2, response=denial_response, screenshot_dir=screenshot_dir,
                name=f"root-geolocation-denial-{viewport_name}", route="/", width=width, height=height,
                revision=revision, data_vintage=data_vintage,
                assertion="A denied production geolocation request keeps the Near You shell and typed place recovery available.",
                assertions={
                    "near_you_shell_visible": denial["has_shell"],
                    "permission_denial_visible": bool(re.search(r"permission was not granted|choose an area", denial_status, re.I)),
                    "place_search_still_visible": denial["has_search"],
                    "url_unchanged_after_denial": page2.url == before_denial,
                },
                snapshot={**denial, "location_status": denial_status.strip()},
                capture_run_id=capture_run_id, observed_url_before=before_denial,
                navigation_events=list(events2),
            ))

            before_recovery = page2.url
            page2.fill("#near-geo-search-input", "Kensington")
            page2.click("form.near-geo-search button[type='submit']")
            page2.wait_for_function(
                """() => (document.querySelector('[data-near-you-root]')?.dataset?.geo || '').includes('BK1203') || location.href.includes('BK1203')""",
                timeout=60_000,
            )
            recovery = measure_shell(page2)
            captures.append(capture_row(
                page=page2, response=denial_response, screenshot_dir=screenshot_dir,
                name=f"root-failure-recovery-kensington-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="After geolocation denial on production root, typing Kensington selects BK1203 without losing the shell.",
                assertions={
                    "near_you_shell_visible": recovery["has_shell"],
                    "selected_kensington_geo": recovery["selected_geo"] == KENSINGTON_GEO,
                    "kensington_geo_in_url": "BK1203" in page2.url,
                    "place_search_still_visible": recovery["has_search"],
                    "horizontal_overflow_at_most_one_px": recovery["overflow_x"] <= 1,
                },
                snapshot=recovery, capture_run_id=capture_run_id,
                observed_url_before=before_recovery, navigation_events=list(events2),
            ))
            context2.close()

            context3 = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/2",
            )
            page3 = context3.new_page()
            events3 = navigation_log(page3)
            land_url = f"{base}{LAND_HASH}"
            land_response = page3.goto(land_url, wait_until="domcontentloaded", timeout=90_000)
            page3.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=60_000)
            page3.wait_for_selector("#land-item-card", state="visible", timeout=60_000)
            page3.wait_for_selector("#project-connections", state="attached", timeout=60_000)
            land = measure_land_hash(page3)
            expected_land_url = f"{base}app/{LAND_HASH}"
            captures.append(capture_row(
                page=page3, response=land_response, screenshot_dir=screenshot_dir,
                name=f"root-registered-land-hash-{viewport_name}", route=f"/{LAND_HASH}",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="The registered production Land hash crosses from root to /app/ and renders the project connections section.",
                assertions={
                    "registered_hash_reached_app_document": page3.url == expected_land_url,
                    "topic_app_ready": land["app_ready"],
                    "land_item_present": land["land_item_present"],
                    "project_connections_present": land["project_connections_present"],
                    "project_id_present": land["project_id_present"],
                    "horizontal_overflow_at_most_one_px": land["overflow_x"] <= 1,
                },
                snapshot=land, capture_run_id=capture_run_id,
                observed_url_before=land_url, navigation_events=list(events3),
            ))
            context3.close()

            context4 = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/2",
            )
            page4 = context4.new_page()
            events4 = navigation_log(page4)
            unknown_url = f"{base}{UNKNOWN_HASH}"
            unknown_response = page4.goto(unknown_url, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page4)
            unknown = measure_shell(page4)
            captures.append(capture_row(
                page=page4, response=unknown_response, screenshot_dir=screenshot_dir,
                name=f"root-unknown-hash-{viewport_name}", route=f"/{UNKNOWN_HASH}",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="An unknown production root hash remains on Near You and does not boot the topic application.",
                assertions={
                    "unknown_hash_remained_near_you": page4.url == unknown_url,
                    "near_you_shell_visible": unknown["has_shell"],
                    "place_search_visible": unknown["has_search"],
                    "topic_app_not_ready": page4.locator("body[data-app-ready='true']").count() == 0,
                    "horizontal_overflow_at_most_one_px": unknown["overflow_x"] <= 1,
                },
                snapshot=unknown, capture_run_id=capture_run_id,
                observed_url_before=unknown_url, navigation_events=list(events4),
            ))
            context4.close()

    deployment_after = deployment_manifest(base)
    if deployment_after.get("source_commit_sha") != revision:
        raise SystemExit(f"served revision changed during capture: {revision} -> {deployment_after.get('source_commit_sha')}")
    if deployment_after.get("artifact_hash") != deployment.get("artifact_hash"):
        raise SystemExit("served artifact hash changed during capture; discard this mixed run")

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "default-local-home-journey",
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": "headless-playwright-production-served-site",
        "capture_run_id": capture_run_id,
        "base": base,
        "repository_revision": revision,
        "grounded_at": grounded_origin_main(),
        "revision": revision,
        "revision_format": "served artifact-manifest source_commit_sha",
        "required_ancestor": REQUIRED_ANCESTOR,
        "required_ancestor_contained": True,
        "data_vintage": data_vintage,
        "deployment": {
            "artifact_manifest_url": deployment["url"],
            "schema": deployment.get("schema"),
            "source_commit_sha": revision,
            "artifact_hash": deployment.get("artifact_hash"),
            "generated_at": deployment.get("generated_at"),
            "deployment_at": deployment.get("deployment_at"),
            "source_receipt": deployment.get("source_receipt"),
        },
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshot binaries are retained in the ignored repository-local run directory and are not committed. "
            "Each row records its image digest, runtime assertions, and in-run URL/revision receipt; "
            "the retained files can be uploaded later if externally viewable images are required."
        ),
        "local_image_dir_ignored": screenshot_rel.as_posix(),
        "route": "/",
        "exact_links": [
            "/", f"/{LAND_HASH}", f"/app/{LAND_HASH}", f"/{UNKNOWN_HASH}",
            "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
        ],
        "run_receipt": {
            "capture_run_id": capture_run_id,
            "run_started_at": run_started_at,
            "run_finished_at": now_iso(),
            "served_revision_before": revision,
            "served_revision_after": deployment_after.get("source_commit_sha"),
            "artifact_hash_before": deployment.get("artifact_hash"),
            "artifact_hash_after": deployment_after.get("artifact_hash"),
        },
        "captures": captures,
    }
    validate_manifest(manifest)
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "captures": len(captures),
        "capture_run_id": capture_run_id,
        "revision": revision,
        "local_images": screenshot_rel.as_posix(),
    }, indent=2))
    return manifest


def validate_manifest(manifest: dict) -> None:
    if manifest.get("schema") != "cityscroll.render_capture_manifest.v1":
        raise SystemExit("unexpected capture manifest schema")
    if manifest.get("capture_mode") != "headless-playwright-production-served-site":
        raise SystemExit("capture manifest is not a production served-site run")
    if manifest.get("required_ancestor") != REQUIRED_ANCESTOR:
        raise SystemExit("capture manifest required ancestor does not match delivery.json")
    if manifest.get("required_ancestor_contained") is not True:
        raise SystemExit("capture manifest does not prove the required ancestor was served")
    if manifest.get("image_binaries_committed") is not False:
        raise SystemExit("capture manifest must keep image binaries out of git")
    serialized = json.dumps(manifest)
    if "127.0.0.1" in serialized or "localhost" in serialized:
        raise SystemExit("production capture manifest contains a loopback observation")
    revision = str(manifest.get("revision") or "")
    run_id = str(manifest.get("capture_run_id") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit("capture manifest revision is not a full commit")
    if not run_id:
        raise SystemExit("capture manifest lacks capture_run_id")
    captures = manifest.get("captures") or []
    if len(captures) < len(VIEWPORTS) * 6:
        raise SystemExit(f"capture manifest has only {len(captures)} rows")
    for row in captures:
        name = str(row.get("name") or "<unnamed>")
        if row.get("source") != "headless-playwright-production-served-site":
            raise SystemExit(f"{name}: source is not production served-site")
        if row.get("capture_run_id") != run_id or row.get("revision") != revision:
            raise SystemExit(f"{name}: run id or revision diverges from manifest")
        if row.get("file") is not None or row.get("screenshot_url") is not None:
            raise SystemExit(f"{name}: committed or hosted image reference is not allowed in this packet")
        if not re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256") or "")):
            raise SystemExit(f"{name}: missing image sha256")
        require_assertions(name, row.get("assertions") or {})
        receipt = row.get("run_receipt") or {}
        if receipt.get("capture_run_id") != run_id or receipt.get("served_revision") != revision:
            raise SystemExit(f"{name}: in-run receipt diverges from manifest")
        if not receipt.get("captured_at"):
            raise SystemExit(f"{name}: in-run receipt lacks timestamp")
        for key in ("observed_url_before", "observed_url_after"):
            if not str(receipt.get(key) or "").startswith("https://"):
                raise SystemExit(f"{name}: {key} is not a production URL")
        if receipt.get("page_load", {}).get("http_status") != 200:
            raise SystemExit(f"{name}: page load receipt is not 200")
        if receipt.get("page_load", {}).get("served_revision") != revision:
            raise SystemExit(f"{name}: page load receipt revision diverges")
        if not receipt.get("navigation_events"):
            raise SystemExit(f"{name}: in-run receipt lacks browser navigation events")
    names = {row["name"] for row in captures}
    for viewport_name, _width, _height in VIEWPORTS:
        for prefix in (
            "root-shell-initial", "root-midwood-result", "root-geolocation-denial",
            "root-failure-recovery-kensington", "root-registered-land-hash", "root-unknown-hash",
        ):
            expected = f"{prefix}-{viewport_name}"
            if expected not in names:
                raise SystemExit(f"capture manifest lacks {expected}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--check", action="store_true", help="validate the retained manifest without network access")
    args = parser.parse_args()
    if args.check:
        validate_manifest(json.loads(MANIFEST_PATH.read_text(encoding="utf-8")))
        print("ok")
        return 0
    capture(args.base)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
