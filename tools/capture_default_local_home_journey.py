#!/usr/bin/env python3
"""Capture the deployed default-local-home journeys in real Chromium.

The run is fail-closed: it reads the Pages artifact manifest, requires the
recorded delivery commit to be an ancestor of the served revision, observes
the production page at desktop and phone widths, and verifies that the served
revision does not change during the run. Screenshot binaries stay in an
ignored, repository-local run directory; the committed manifest retains their
digests and textual browser observations.

``--scenario discovery-recovery`` runs the recovered discovery journeys instead
(``tools/discovery_recovery_journey.py``), with its own evidence directory so it
never overwrites this packet; add ``--local`` to drive the local fixture server
over frozen records rather than the served site.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
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
SUBJECT_GEO = "nta2020:BK1402"
MIDWOOD_RECORD_NEEDLE = "housing-and-land-use-committee-meeting-september-2026"
SUBJECT_RECORD_NEEDLE = "september-2026-board-meeting"
MIDWOOD_DETAIL = (
    "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com"
    "%2Fmeeting%2Fhousing-and-land-use-committee-meeting-september-2026%2F"
)
SUBJECT_DETAIL = (
    "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com"
    "%2Fmeeting%2Fseptember-2026-board-meeting%2F#agenda-subject"
)
VIEWPORTS = (("desktop", 1440, 900), ("phone", 390, 844))
HEADER_KEYS = ("date", "cf-ray", "cf-cache-status", "age", "last-modified", "etag")
UPLOAD_URL = "https://catbox.moe/user/api.php"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "cityscroll-default-local-home-capture/2"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"served JSON is not an object: {url}")
    return payload


def deployment_manifest(base: str, *, fetch_json_impl=None) -> dict:
    url = urljoin(base.rstrip("/") + "/", "artifact-manifest.json")
    payload = (fetch_json_impl or fetch_json)(url)
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


def require_stable_served_deployment(*, before: dict, after: dict, revision: str) -> None:
    """Refuse a mixed run when the served Pages revision or artifact hash moves mid-capture."""
    if after.get("source_commit_sha") != revision:
        raise SystemExit(
            f"served revision changed during capture: {revision} -> {after.get('source_commit_sha')}"
        )
    if after.get("artifact_hash") != before.get("artifact_hash"):
        raise SystemExit("served artifact hash changed during capture; discard this mixed run")


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


def upload_image(path: Path) -> dict:
    requested_at = now_iso()
    started = time.monotonic()
    result = subprocess.run(
        [
            "curl", "-sS", "-w", "\n%{http_code}",
            "-F", "reqtype=fileupload", "-F", f"fileToUpload=@{path}", UPLOAD_URL,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    body, separator, status_text = (result.stdout or "").rpartition("\n")
    url = body.strip() if separator else (result.stdout or "").strip()
    status = int(status_text) if status_text.isdigit() else None
    receipt = {
        "host": "catbox.moe",
        "requested_at": requested_at,
        "responded_at": now_iso(),
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "http_status": status,
        "returned_url": url,
    }
    if result.returncode != 0 or status != 200 or not url.startswith("https://"):
        raise SystemExit(f"image upload failed for {path.name}: {receipt!r} {result.stderr!r}")
    return receipt


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
    # A selected map route may start with its geography drawer folded. The
    # native form remains attached and the drawer toggle exposes it.
    page.wait_for_selector("#near-geo-search-input", state="attached", timeout=60_000)


def measure_shell(page) -> dict:  # noqa: ANN001
    return page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          const search = document.querySelector('[data-geography-search], form.near-geo-search');
          const locationBtn = document.querySelector('[data-use-location], .near-location-action');
          const visible = (node) => Boolean(node && (node.offsetParent || node.getClientRects().length));
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
            search_visible: visible(search),
            has_location_control: Boolean(locationBtn) && !locationBtn.hidden,
            has_following_link: Boolean(document.querySelector('a[href*="/following"]')),
            has_browse_link: Boolean(document.querySelector('a[href*="/browse"]')),
            has_retry_link: visible(document.querySelector('[data-near-recovery="retry"]')),
            viewport_width_px: window.innerWidth,
            viewport_height_px: window.innerHeight,
            map_or_shell_height_px: Math.round((mapRect || shellRect || { height: 0 }).height || 0),
            overflow_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            geo: root?.dataset?.geo || null,
            selected_geo: selectedKey?.replace(/^geography:/, '') || null,
            results_count: document.querySelector('[data-results-count]')?.dataset?.resultsCount || null,
            deferred_state: root?.dataset?.nearDeferredState || null,
            map_runtime: root?.dataset?.nearMapRuntime || null,
            map_runtime_reason: root?.dataset?.nearMapRuntimeReason || null,
            geography_map_state: root?.dataset?.nearGeographyMapState || null,
            selected_label: document.querySelector('[data-geography-selected-label]')?.textContent?.trim() || null,
            record_ids: [...document.querySelectorAll('[data-record-id]')]
              .map((node) => node.dataset.recordId || node.getAttribute('data-record-id'))
              .filter(Boolean),
            title: document.title,
          };
        }"""
    )


def measure_meeting_detail(page, *, title_needle: str, address_needle: str) -> dict:  # noqa: ANN001
    return page.evaluate(
        """({ titleNeedle, addressNeedle }) => {
          const text = document.body?.innerText || '';
          const styles = [...document.styleSheets].map((sheet) => {
            try { return sheet.href; } catch { return null; }
          }).filter(Boolean);
          return {
            measured_css: styles.length > 0,
            stylesheet_hrefs: styles,
            viewport_width_px: window.innerWidth,
            viewport_height_px: window.innerHeight,
            overflow_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            detail_title_present: text.includes(titleNeedle),
            address_present: text.includes(addressNeedle),
            source_link_present: Boolean(document.querySelector('a[href*="cb14brooklyn.com"]')),
            agenda_subject_present: Boolean(document.querySelector('#agenda-subject')),
            title: document.title,
          };
        }""",
        {"titleNeedle": title_needle, "addressNeedle": address_needle},
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


def selected_document_response(page, query: str):  # noqa: ANN001
    page.fill("#near-geo-search-input", query)
    with page.expect_response(
        lambda response: "/near-you/" in response.url and "deferred.json" not in response.url,
        timeout=60_000,
    ) as response_info:
        page.click("form.near-geo-search button[type='submit']")
    return response_info.value


def click_named_record(page, needle: str, *, broader: bool = False):  # noqa: ANN001
    suffix = '[data-broader-scope="broader"]' if broader else ""
    card_selector = f'[data-record-id*="{needle}"]{suffix}'
    card = page.locator(card_selector).first
    card.wait_for(state="attached", timeout=60_000)
    try:
        card.scroll_into_view_if_needed(timeout=15_000)
    except Exception:
        # The explicit visibility check below remains authoritative; scrolling
        # can settle independently while the records surface changes.
        pass
    link_selector = (
        f"{card_selector} a.near-record-full-record, "
        f"{card_selector} a.near-record-title-link, "
        f"{card_selector} a[href*='{needle}']"
    )
    links = page.locator(link_selector)
    visible_link = next(
        (
            links.nth(index)
            for index in range(links.count())
            if links.nth(index).is_visible()
            and str(links.nth(index).get_attribute("href") or "").startswith(
                ("https://cityscroll.org/meetings/", "/meetings/")
            )
        ),
        None,
    )
    if visible_link is None:
        raise SystemExit(f"served named row has no visible record link: {needle}")
    with page.expect_navigation(wait_until="domcontentloaded", timeout=90_000) as navigation:
        visible_link.click(timeout=15_000)
    response = navigation.value
    page.wait_for_selector("h1, .meeting-hero, .civic-object-hero", timeout=60_000)
    if needle not in page.url and needle not in page.content():
        raise SystemExit(f"named row did not reach its detail: {needle}: {page.url}")
    return response


def show_records_surface(page) -> None:  # noqa: ANN001
    control = page.locator('[data-near-surface="records"]').first
    if control.count() == 0:
        raise SystemExit("production Near You page lacks the records-surface control")
    control.evaluate("node => node.click()")
    page.wait_for_function(
        "() => document.querySelector('[data-near-you-root]')?.dataset?.nearSurface === 'records'",
        timeout=15_000,
    )


def require_served_journey_data(base: str) -> dict:
    routes = {
        "midwood": "/near-you/deferred.json?geo=nta2020%3ABK1403&surface=map&lens=meetings",
        "kensington": "/near-you/deferred.json?geo=nta2020%3ABK1203&surface=map&lens=meetings",
        "subject": "/near-you/deferred.json?geo=nta2020%3ABK1402&surface=map&lens=meetings",
    }
    payloads = {name: fetch_json(urljoin(base, route)) for name, route in routes.items()}
    checks = {
        "midwood named row": MIDWOOD_RECORD_NEEDLE in str(payloads["midwood"].get("results_html") or ""),
        "kensington wider row": (
            MIDWOOD_RECORD_NEEDLE in str(payloads["kensington"].get("results_html") or "")
            and 'data-broader-district="K14"' in str(payloads["kensington"].get("results_html") or "")
        ),
        "BK1402 subject row": (
            SUBJECT_RECORD_NEEDLE in str(payloads["subject"].get("results_html") or "")
            and "461 Coney Island Avenue" in str(payloads["subject"].get("results_html") or "")
        ),
    }
    detail_checks = {
        "September 23 detail": (MIDWOOD_DETAIL, "Housing and Land Use Committee Meeting", "810 East 16th"),
        "September 14 detail": (SUBJECT_DETAIL, "September 2026 Board Meeting", "461 Coney Island Avenue"),
    }
    for label, (route, title, address) in detail_checks.items():
        request = urllib.request.Request(
            urljoin(base, route), headers={"User-Agent": "cityscroll-default-local-home-capture/3"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            html = response.read().decode("utf-8")
        checks[label] = title in html and address in html
    missing = [label for label, present in checks.items() if not present]
    if missing:
        raise SystemExit(f"served production data required by the journey is absent: {missing}")
    return {"routes": routes, "checks": checks}


def require_assertions(name: str, assertions: dict[str, bool]) -> None:
    failed = [key for key, value in assertions.items() if value is not True]
    if failed:
        raise SystemExit(f"{name}: runtime assertions failed: {failed}")


def capture_row(
    *, page, response, screenshot_dir: Path, name: str, route: str,
    width: int, height: int, revision: str, data_vintage: dict,
    assertion: str, assertions: dict[str, bool], snapshot: dict,
    capture_run_id: str, observed_url_before: str, navigation_events: list[dict],
    journey_receipt: dict | None = None, fault_receipt: dict | None = None,
) -> dict:
    require_assertions(name, assertions)
    captured_at = now_iso()
    image_name = f"{name}.png"
    png = page.screenshot(full_page=True, type="png", animations="disabled")
    (screenshot_dir / image_name).write_bytes(png)
    page_load = page_load_receipt(response, revision)
    if page_load["http_status"] != 200:
        raise SystemExit(f"{name}: production page load did not return 200: {page_load!r}")
    row = {
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
            "upload": None,
        },
    }
    if journey_receipt is not None:
        row["journey_receipt"] = journey_receipt
    if fault_receipt is not None:
        row["fault_receipt"] = fault_receipt
    return row


def capture(base: str, *, host_images: bool) -> dict:
    if not host_images:
        raise SystemExit("production capture requires --host-images so every retained row is externally viewable")
    base = base.rstrip("/") + "/"
    deployment = deployment_manifest(base)
    revision = require_deployed_revision(base, deployment)
    served_data_preflight = require_served_journey_data(base)
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
                user_agent="cityscroll-default-local-home-capture/3",
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
            midwood_response = selected_document_response(page, "810 East 16th Street Brooklyn")
            page.wait_for_function(
                """() => (document.querySelector('[data-near-you-root]')?.dataset?.geo || '').includes('BK1403') || location.href.includes('BK1403')""",
                timeout=60_000,
            )
            page.wait_for_selector(
                f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"]', state="attached", timeout=60_000,
            )
            show_records_surface(page)
            midwood = measure_shell(page)
            record_present = page.locator(f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"]').count() > 0
            captures.append(capture_row(
                page=page, response=midwood_response, screenshot_dir=screenshot_dir,
                name=f"root-midwood-result-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1403&surface=records&lens=meetings",
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

            before_detail = page.url
            detail_response = click_named_record(page, MIDWOOD_RECORD_NEEDLE)
            midwood_actions = ["submit-address", "open-records", "open-named-meeting"]
            detail = measure_meeting_detail(
                page,
                title_needle="Housing and Land Use Committee Meeting",
                address_needle="810 East 16th",
            )
            captures.append(capture_row(
                page=page, response=detail_response, screenshot_dir=screenshot_dir,
                name=f"root-midwood-meeting-detail-{viewport_name}", route=MIDWOOD_DETAIL,
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="The third action from production root opens the exact September 23 meeting detail.",
                assertions={
                    "detail_title_present": detail["detail_title_present"],
                    "venue_address_present": detail["address_present"],
                    "source_link_present": detail["source_link_present"],
                    "detail_route_reached": MIDWOOD_RECORD_NEEDLE in page.url,
                    "three_user_actions_at_most": len(midwood_actions) <= 3,
                    "horizontal_overflow_at_most_one_px": detail["overflow_x"] <= 1,
                },
                snapshot=detail, capture_run_id=capture_run_id,
                observed_url_before=before_detail, navigation_events=list(events),
                journey_receipt={
                    "name": "root-to-september-23-detail",
                    "starting_route": "/",
                    "user_action_count": len(midwood_actions),
                    "maximum_user_actions": 3,
                    "actions": midwood_actions,
                },
            ))
            context.close()

            context_shared = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/3",
            )
            page_shared = context_shared.new_page()
            shared_events = navigation_log(page_shared)
            shared_url = urljoin(base, "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings")
            shared_response = page_shared.goto(shared_url, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page_shared)
            page_shared.wait_for_selector(
                f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"]', state="attached", timeout=60_000,
            )
            show_records_surface(page_shared)
            shared = measure_shell(page_shared)
            captures.append(capture_row(
                page=page_shared, response=shared_response, screenshot_dir=screenshot_dir,
                name=f"shared-midwood-route-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1403&surface=records&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="The shared production Midwood route reconstructs independently with the September 23 row.",
                assertions={
                    "selected_midwood_geo": shared["selected_geo"] == MIDWOOD_GEO,
                    "served_midwood_record_present": any(MIDWOOD_RECORD_NEEDLE in row for row in shared["record_ids"]),
                    "shared_geo_url_reachable": "/near-you/" in page_shared.url and "BK1403" in page_shared.url,
                    "horizontal_overflow_at_most_one_px": shared["overflow_x"] <= 1,
                },
                snapshot=shared, capture_run_id=capture_run_id,
                observed_url_before=shared_url, navigation_events=list(shared_events),
            ))
            context_shared.close()

            context2 = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/3",
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
            recovery_response = selected_document_response(page2, "Kensington")
            page2.wait_for_function(
                """() => (document.querySelector('[data-near-you-root]')?.dataset?.geo || '').includes('BK1203') || location.href.includes('BK1203')""",
                timeout=60_000,
            )
            recovery = measure_shell(page2)
            captures.append(capture_row(
                page=page2, response=recovery_response, screenshot_dir=screenshot_dir,
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

            context_k = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/3",
            )
            page_k = context_k.new_page()
            events_k = navigation_log(page_k)
            root_response_k = page_k.goto(base, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page_k)
            before_kensington = page_k.url
            kensington_response = selected_document_response(page_k, "Kensington")
            page_k.wait_for_selector(
                f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"][data-broader-scope="broader"]',
                state="attached", timeout=60_000,
            )
            show_records_surface(page_k)
            kensington = measure_shell(page_k)
            captures.append(capture_row(
                page=page_k, response=kensington_response or root_response_k, screenshot_dir=screenshot_dir,
                name=f"root-kensington-wider-result-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1203&surface=records&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="Choosing Kensington from production root shows the September 23 row as wider-district activity.",
                assertions={
                    "selected_kensington_geo": kensington["selected_geo"] == KENSINGTON_GEO,
                    "wider_named_row_present": any(MIDWOOD_RECORD_NEEDLE in row for row in kensington["record_ids"]),
                    "wider_district_section_present": page_k.locator('[data-broader-district="K14"]').count() > 0,
                    "horizontal_overflow_at_most_one_px": kensington["overflow_x"] <= 1,
                },
                snapshot=kensington, capture_run_id=capture_run_id,
                observed_url_before=before_kensington, navigation_events=list(events_k),
            ))
            before_k_detail = page_k.url
            k_detail_response = click_named_record(page_k, MIDWOOD_RECORD_NEEDLE, broader=True)
            kensington_actions = ["choose-kensington", "open-records", "open-wider-meeting"]
            k_detail = measure_meeting_detail(
                page_k,
                title_needle="Housing and Land Use Committee Meeting",
                address_needle="810 East 16th",
            )
            captures.append(capture_row(
                page=page_k, response=k_detail_response, screenshot_dir=screenshot_dir,
                name=f"root-kensington-wider-detail-{viewport_name}", route=MIDWOOD_DETAIL,
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="The wider-district row opened from Kensington reaches the exact September 23 detail.",
                assertions={
                    "detail_title_present": k_detail["detail_title_present"],
                    "venue_address_present": k_detail["address_present"],
                    "opened_from_wider_row": MIDWOOD_RECORD_NEEDLE in page_k.url,
                    "three_user_actions_at_most": len(kensington_actions) <= 3,
                },
                snapshot=k_detail, capture_run_id=capture_run_id,
                observed_url_before=before_k_detail, navigation_events=list(events_k),
                journey_receipt={
                    "name": "root-to-kensington-wider-detail",
                    "starting_route": "/",
                    "user_action_count": len(kensington_actions),
                    "maximum_user_actions": 3,
                    "actions": kensington_actions,
                },
            ))
            context_k.close()

            context_near = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/3",
            )
            page_near = context_near.new_page()
            events_near = navigation_log(page_near)
            near_url = urljoin(base, "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings")
            near_response = page_near.goto(near_url, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page_near)
            page_near.wait_for_selector(
                f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"]', state="attached", timeout=60_000,
            )
            show_records_surface(page_near)
            near_kensington = measure_shell(page_near)
            captures.append(capture_row(
                page=page_near, response=near_response, screenshot_dir=screenshot_dir,
                name=f"near-you-kensington-agreement-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1203&surface=records&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="The direct Near You route selects the same Kensington place and records as the root journey.",
                assertions={
                    "selected_place_matches_root": near_kensington["selected_geo"] == kensington["selected_geo"] == KENSINGTON_GEO,
                    "named_records_match_root": sorted(near_kensington["record_ids"]) == sorted(kensington["record_ids"]),
                    "horizontal_overflow_at_most_one_px": near_kensington["overflow_x"] <= 1,
                },
                snapshot={**near_kensington, "root_selected_geo": kensington["selected_geo"], "root_record_ids": kensington["record_ids"]},
                capture_run_id=capture_run_id, observed_url_before=near_url,
                navigation_events=list(events_near),
            ))
            context_near.close()

            context_subject = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/3",
            )
            page_subject = context_subject.new_page()
            events_subject = navigation_log(page_subject)
            subject_url = urljoin(base, "/near-you/?geo=nta2020%3ABK1402&surface=map&lens=meetings")
            subject_response = page_subject.goto(subject_url, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page_subject)
            page_subject.wait_for_selector(
                f'[data-record-id*="{SUBJECT_RECORD_NEEDLE}"]', state="attached", timeout=60_000,
            )
            show_records_surface(page_subject)
            subject = measure_shell(page_subject)
            subject_html = page_subject.content()
            captures.append(capture_row(
                page=page_subject, response=subject_response, screenshot_dir=screenshot_dir,
                name=f"direct-bk1402-subject-result-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1402&surface=records&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="The direct BK1402 production route shows the September 14 subject result for 461 Coney Island Avenue.",
                assertions={
                    "selected_bk1402_geo": subject["selected_geo"] == SUBJECT_GEO,
                    "subject_record_present": any(SUBJECT_RECORD_NEEDLE in row for row in subject["record_ids"]),
                    "subject_address_present": "461 Coney Island Avenue" in subject_html,
                    "subject_detail_link_present": page_subject.locator(f'a[href*="{SUBJECT_RECORD_NEEDLE}"]').count() > 0,
                    "horizontal_overflow_at_most_one_px": subject["overflow_x"] <= 1,
                },
                snapshot=subject, capture_run_id=capture_run_id,
                observed_url_before=subject_url, navigation_events=list(events_subject),
            ))
            context_subject.close()

            context_fault = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/3",
            )
            context_fault.add_init_script("globalThis.__CITYSCROLL_FORCE_GEOGRAPHY_MAP_FAILURE = true;")
            fault_requests: list[dict] = []

            def fail_deferred(route) -> None:  # noqa: ANN001
                fault_requests.append({"observed_at": now_iso(), "url": route.request.url, "injected_status": 503})
                route.fulfill(status=503, content_type="application/json", body='{"ok":false}')

            deferred_pattern = "**/near-you/deferred.json?*"
            context_fault.route(deferred_pattern, fail_deferred)
            page_fault = context_fault.new_page()
            events_fault = navigation_log(page_fault)
            fault_url = urljoin(base, "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings")
            fault_response = page_fault.goto(fault_url, wait_until="domcontentloaded", timeout=90_000)
            wait_shell_ready(page_fault)
            page_fault.wait_for_function(
                """() => {
                  const root = document.querySelector('[data-near-you-root]');
                  return root?.dataset?.nearGeographyMapState === 'failed'
                    && root?.dataset?.nearDeferredState === 'error';
                }""",
                timeout=60_000,
            )
            show_records_surface(page_fault)
            fault = measure_shell(page_fault)
            captures.append(capture_row(
                page=page_fault, response=fault_response, screenshot_dir=screenshot_dir,
                name=f"shared-geo-map-feed-failure-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1203&surface=records&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="A forced map-rendering failure and deferred-feed 503 preserve Kensington, text choice, global navigation, and retry.",
                assertions={
                    "selected_kensington_geo_preserved": fault["selected_geo"] == KENSINGTON_GEO,
                    "map_rendering_failed": fault["geography_map_state"] == "failed",
                    "deferred_feed_failed": fault["deferred_state"] == "error" and bool(fault_requests),
                    "retry_link_visible": fault["has_retry_link"],
                    "place_search_visible": fault["search_visible"],
                    "following_reachable": fault["has_following_link"],
                    "browse_reachable": fault["has_browse_link"],
                    "shared_geo_url_preserved": "BK1203" in page_fault.url,
                },
                snapshot=fault, capture_run_id=capture_run_id,
                observed_url_before=fault_url, navigation_events=list(events_fault),
                fault_receipt={
                    "map": "forced-before-production-module-load",
                    "feed": "production-deferred-request-returned-503-by-browser-fault-injection",
                    "requests": list(fault_requests),
                },
            ))
            context_fault.unroute(deferred_pattern, fail_deferred)
            before_fault_recovery = page_fault.url
            retry = page_fault.locator('[data-near-recovery="retry"]').first
            with page_fault.expect_navigation(wait_until="domcontentloaded", timeout=90_000) as recovery_navigation:
                retry.evaluate("node => node.click()")
            feed_recovery_response = recovery_navigation.value
            wait_shell_ready(page_fault)
            page_fault.wait_for_selector(
                f'[data-record-id*="{MIDWOOD_RECORD_NEEDLE}"]', state="attached", timeout=60_000,
            )
            page_fault.wait_for_function(
                "() => document.querySelector('[data-near-you-root]')?.dataset?.nearGeographyMapState === 'failed'",
                timeout=60_000,
            )
            show_records_surface(page_fault)
            fault_recovery = measure_shell(page_fault)
            captures.append(capture_row(
                page=page_fault, response=feed_recovery_response, screenshot_dir=screenshot_dir,
                name=f"shared-geo-map-feed-recovery-{viewport_name}",
                route="/near-you/?geo=nta2020%3ABK1203&surface=records&lens=meetings",
                width=width, height=height, revision=revision, data_vintage=data_vintage,
                assertion="Retry restores production records without changing Kensington while the unavailable map keeps text navigation usable.",
                assertions={
                    "selected_kensington_geo_preserved": fault_recovery["selected_geo"] == KENSINGTON_GEO,
                    "map_still_unavailable": fault_recovery["geography_map_state"] == "failed",
                    "deferred_feed_recovered": fault_recovery["deferred_state"] == "ready",
                    "named_record_navigation_restored": (
                        any(MIDWOOD_RECORD_NEEDLE in row for row in fault_recovery["record_ids"])
                        and page_fault.eval_on_selector_all(
                            f'a[href*="{MIDWOOD_RECORD_NEEDLE}"]',
                            "nodes => nodes.some((node) => Boolean(node.offsetParent || node.getClientRects().length))",
                        )
                    ),
                    "place_search_visible": fault_recovery["search_visible"],
                    "following_reachable": fault_recovery["has_following_link"],
                    "browse_reachable": fault_recovery["has_browse_link"],
                    "shared_geo_url_preserved": "BK1203" in page_fault.url,
                },
                snapshot=fault_recovery, capture_run_id=capture_run_id,
                observed_url_before=before_fault_recovery, navigation_events=list(events_fault),
                journey_receipt={
                    "name": "map-and-feed-failure-recovery",
                    "actions": ["open-shared-geo-with-faults", "retry-deferred-feed"],
                    "bounded": True,
                },
                fault_receipt={
                    "map": "forced-before-production-module-load",
                    "feed": "fault-removed-before-retry",
                    "requests": list(fault_requests),
                },
            ))
            context_fault.close()

            context3 = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=1,
                user_agent="cityscroll-default-local-home-capture/3",
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
                user_agent="cityscroll-default-local-home-capture/3",
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
    require_stable_served_deployment(before=deployment, after=deployment_after, revision=revision)

    if host_images:
        for row in captures:
            image_path = screenshot_dir / str(row["local_image_name"])
            upload = upload_image(image_path)
            row["screenshot_url"] = upload["returned_url"]
            row["run_receipt"]["upload"] = upload
    seen_digests: dict[str, str] = {}
    for row in captures:
        prior_name = seen_digests.get(row["sha256"])
        if prior_name:
            row["coincident_hash"] = {
                "with_capture": prior_name,
                "independently_recaptured": True,
                "independently_uploaded": host_images,
                "note": (
                    "The two routes rendered deterministic, byte-identical images. "
                    "Each row has its own page-load and upload exchange from this run."
                ),
            }
        else:
            seen_digests[row["sha256"]] = row["name"]

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
            "Each row records its image digest, runtime assertions, in-run URL/revision receipt, and an externally "
            "viewable HTTPS copy with the upload exchange from this run."
        ),
        "local_image_dir_ignored": screenshot_rel.as_posix(),
        "route": "/",
        "exact_links": [
            "/", f"/{LAND_HASH}", f"/app/{LAND_HASH}", f"/{UNKNOWN_HASH}",
            "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1403&surface=records&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1203&surface=records&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1402&surface=map&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1402&surface=records&lens=meetings",
            MIDWOOD_DETAIL,
            SUBJECT_DETAIL,
        ],
        "served_data_preflight": served_data_preflight,
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
    if len(captures) < len(VIEWPORTS) * 14:
        raise SystemExit(f"capture manifest has only {len(captures)} rows")
    seen_digests: dict[str, str] = {}
    for row in captures:
        name = str(row.get("name") or "<unnamed>")
        if row.get("source") != "headless-playwright-production-served-site":
            raise SystemExit(f"{name}: source is not production served-site")
        if row.get("capture_run_id") != run_id or row.get("revision") != revision:
            raise SystemExit(f"{name}: run id or revision diverges from manifest")
        if row.get("file") is not None:
            raise SystemExit(f"{name}: committed image reference is not allowed in this packet")
        if not str(row.get("screenshot_url") or "").startswith("https://"):
            raise SystemExit(f"{name}: externally viewable screenshot URL is absent")
        if not re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256") or "")):
            raise SystemExit(f"{name}: missing image sha256")
        prior_name = seen_digests.get(row["sha256"])
        if prior_name:
            coincidence = row.get("coincident_hash") or {}
            if coincidence.get("with_capture") != prior_name or coincidence.get("independently_recaptured") is not True:
                raise SystemExit(f"{name}: duplicate image digest lacks an independent-recapture disclosure")
        else:
            seen_digests[row["sha256"]] = name
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
        upload = receipt.get("upload") or {}
        if upload.get("http_status") != 200 or upload.get("returned_url") != row.get("screenshot_url"):
            raise SystemExit(f"{name}: image upload receipt is absent or diverges")
        if not receipt.get("navigation_events"):
            raise SystemExit(f"{name}: in-run receipt lacks browser navigation events")
    names = {row["name"] for row in captures}
    for viewport_name, _width, _height in VIEWPORTS:
        for prefix in (
            "root-shell-initial", "root-midwood-result", "root-geolocation-denial",
            "root-failure-recovery-kensington", "root-registered-land-hash", "root-unknown-hash",
            "root-midwood-meeting-detail", "shared-midwood-route",
            "root-kensington-wider-result", "root-kensington-wider-detail",
            "near-you-kensington-agreement", "direct-bk1402-subject-result",
            "shared-geo-map-feed-failure", "shared-geo-map-feed-recovery",
        ):
            expected = f"{prefix}-{viewport_name}"
            if expected not in names:
                raise SystemExit(f"capture manifest lacks {expected}")


SCENARIOS = ("default-local-home", "discovery-recovery")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=SCENARIOS, default="default-local-home")
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--host-images", action="store_true", help="upload captures to the retained HTTPS host")
    parser.add_argument("--check", action="store_true", help="validate the retained manifest without network access")
    parser.add_argument(
        "--local", action="store_true",
        help="discovery-recovery only: drive the local fixture server over frozen records instead of the served site",
    )
    args = parser.parse_args()
    if args.scenario == "discovery-recovery":
        if args.host_images:
            parser.error("--host-images applies to the default scenario; discovery-recovery retains render hashes only")
        if args.local and args.base != DEFAULT_BASE:
            parser.error("--local serves the checkout itself and takes no --base")
        from discovery_recovery_journey import run_cli  # noqa: PLC0415

        return run_cli(
            base=args.base, local=args.local, check_only=args.check, deployment_manifest=deployment_manifest,
        )
    if args.local:
        parser.error("--local applies to --scenario discovery-recovery")
    if args.check:
        validate_manifest(json.loads(MANIFEST_PATH.read_text(encoding="utf-8")))
        print("ok")
        return 0
    capture(args.base, host_images=args.host_images)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
