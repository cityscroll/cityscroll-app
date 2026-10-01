"""Served Near You membership journey observations for recovered venue edges.

Extends the place-slices production read-back with focused meeting ID/role
assertions at BK1503 and QN0602. Capture refuses until both the Pages artifact
manifest revision and the Worker health commit contain the recorded landed
delivery ancestor, and until the served deferred payloads carry the positive
venue rows.
"""

from __future__ import annotations

import hashlib
import html as html_lib
import json
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]

SCHEMA = "cityscroll.near_you_membership_served_read.v1"
ORIGIN = "https://cityscroll.org"
API_ORIGIN = "https://api.cityscroll.org"
USER_AGENT = "CityScrollEvidence/1.0 (+https://cityscroll.org)"
VIEWPORTS = (("desktop", 1440, 900), ("mobile", 390, 844))
PUBLIC_ALIAS = "ce08b21f46de9"

EVIDENCE_DIR = ROOT / "docs/evidence/near-you-place-slices"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
MEMBERSHIP_OUTPUT = EVIDENCE_DIR / "membership-served-read.json"

SEPT29_ID = (
    "meeting:community_board:nyc-calendar:brooklyn-cb-15:"
    "2026-09-29:general-board-meeting-in-person"
)
SEPT29_TITLE = "General Board Meeting (In Person)"
SEPT29_VENUE_NEEDLE = "2001 Oriental Boulevard"
SEPT29_HELD_IN_NEEDLE = "Held in Sheepshead"

FOREST_ID = (
    "meeting:community_board:0pue8uab456hejvloi8sikfpke@google.com::2026-09-08"
)
FOREST_TITLE = "Consumer Affairs"
FOREST_VENUE_NEEDLE = "104-01 Metropolitan"
FOREST_HELD_IN_NEEDLE = "Held in Forest Hills"

# District-wide BSA notice that appears under K15 broader activity for BK1503
# without claiming exact neighborhood membership.
BOARD_DISTRICT_ONLY_ID = "20260723030"

# Published virtual City Record hearing — must stay out of exact BK1503 membership.
VIRTUAL_ID = "meeting:city_record:20260826006"

UNSUPPORTED_FIXTURE = "BK0101"

JOURNEYS = (
    {
        "fixture": "BK1503",
        "label": "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
        "meeting_id": SEPT29_ID,
        "title_needle": SEPT29_TITLE,
        "held_in_needle": SEPT29_HELD_IN_NEEDLE,
        "venue_needle": SEPT29_VENUE_NEEDLE,
        "broader_district": "K15",
        "role": "venue",
    },
    {
        "fixture": "QN0602",
        "label": "Forest Hills",
        "meeting_id": FOREST_ID,
        "title_needle": FOREST_TITLE,
        "held_in_needle": FOREST_HELD_IN_NEEDLE,
        "venue_needle": FOREST_VENUE_NEEDLE,
        "broader_district": "Q06",
        "role": "venue",
    },
)


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n", encoding="utf-8")


def uncached_url(origin: str, route: str, token: str | None = None) -> str:
    separator = "&" if "?" in route else "?"
    cache_token = token or secrets.token_hex(12)
    return f"{origin}{route}{separator}_cityscroll_evidence={cache_token}"


def fetch_bytes(origin: str, route: str, accept: str = "application/json") -> tuple[int, bytes]:
    request = urllib.request.Request(
        uncached_url(origin, route),
        headers={
            "Accept": accept,
            "Cache-Control": "no-cache, no-store",
            "Pragma": "no-cache",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def fetch_json(origin: str, route: str) -> tuple[int, bytes, Any]:
    status, body = fetch_bytes(origin, route)
    return status, body, json.loads(body)


def page_route_for(fixture_id: str) -> str:
    return f"/near-you/?geo=nta2020%3A{fixture_id}&lens=meetings&surface=records"


def deferred_route_for(fixture_id: str) -> str:
    return (
        f"/near-you/deferred.json?geo=nta2020%3A{fixture_id}"
        "&lens=meetings&surface=records"
    )


def _balanced_section_inner(markup: str, *, class_name: str) -> str | None:
    """Return the inner HTML of the first section with ``class_name``, nesting-aware."""
    open_match = re.search(
        rf'<section\b[^>]*class="[^"]*\b{re.escape(class_name)}\b[^"]*"[^>]*>',
        markup,
    )
    if not open_match:
        return None
    start = open_match.end()
    depth = 1
    for match in re.finditer(r"</?section\b[^>]*>", markup[start:], re.I):
        token = match.group(0)
        if token.startswith("</"):
            depth -= 1
            if depth == 0:
                return markup[start : start + match.start()]
        elif not token.endswith("/>"):
            depth += 1
    return None


def _results_scope_html(markup: str) -> str:
    """Prefer the Near You results section so citywide/virtual bags are excluded.

    Deferred payloads and full page documents both render ``section.near-results``.
    That section nests ``section.near-broader-districts``, so extraction must
    balance section tags. Bag collections sit outside near-results and must not
    inflate exact neighborhood membership counts.
    """
    inner = _balanced_section_inner(markup, class_name="near-results")
    return inner if inner is not None else markup


def parse_near_records(results_html: str) -> list[dict[str, Any]]:
    """Split deferred/page results HTML into exact and broader Near You rows."""
    if not isinstance(results_html, str) or not results_html:
        raise AssertionError("deferred results_html missing")
    scoped = _results_scope_html(results_html)
    rows: list[dict[str, Any]] = []
    for match in re.finditer(r'<li class="near-record"([^>]*)>([\s\S]*?)</li>', scoped):
        attrs = match.group(1)
        body = match.group(2)
        record_id_match = re.search(r'data-record-id="([^"]+)"', attrs)
        if not record_id_match:
            continue
        record_id = html_lib.unescape(record_id_match.group(1))
        text = re.sub(r"\s+", " ", html_lib.unescape(re.sub(r"<[^>]+>", " ", body))).strip()
        href_match = re.search(
            r'class="[^"]*near-record-(?:title-link|full-record)[^"]*"[^>]*href="([^"]+)"'
            r'|href="([^"]+)"[^>]*class="[^"]*near-record-(?:title-link|full-record)',
            body,
        )
        href = None
        if href_match:
            href = html_lib.unescape(href_match.group(1) or href_match.group(2) or "")
        rows.append(
            {
                "id": record_id,
                "broader": "data-broader-scope" in attrs,
                "text": text,
                "held_in": "Held in" in text,
                "href": href,
            }
        )
    return rows


def classify_membership_rows(
    results_html: str,
    *,
    meeting_id: str,
) -> dict[str, Any]:
    rows = parse_near_records(results_html)
    exact_ids = [row["id"] for row in rows if not row["broader"]]
    broader_ids = [row["id"] for row in rows if row["broader"]]
    exact_row = next((row for row in rows if row["id"] == meeting_id and not row["broader"]), None)
    broader_row = next((row for row in rows if row["id"] == meeting_id and row["broader"]), None)
    return {
        "exact_ids": exact_ids,
        "broader_ids": broader_ids,
        "exact_count": len(exact_ids),
        "broader_count": len(broader_ids),
        "exact_row": exact_row,
        "broader_row": broader_row,
        "meeting_in_exact": exact_row is not None,
        "meeting_in_broader": broader_row is not None,
    }


def require_worker_commit_contains_delivery(
    api_origin: str,
    pin: str,
    *,
    cwd: Path,
    revision_contains_ancestor: Callable[..., bool],
    fetch_json_impl: Callable[[str, str], tuple[int, bytes, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    fetcher = fetch_json_impl or fetch_json
    status, _body, health = fetcher(api_origin, "/health")
    if status != 200 or not isinstance(health, dict):
        raise AssertionError("worker health did not return HTTP 200 JSON")
    commit = health.get("commit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise AssertionError("worker health has no serving commit")
    if not revision_contains_ancestor(pin, commit, cwd=cwd):
        from deployed_capture_ancestor import DeployPendingError

        raise DeployPendingError(
            f"worker commit {commit} does not contain required ancestor {pin}; "
            "wait for Worker deploy before capturing"
        )
    return commit, health


def require_served_membership_data(
    origin: str,
    *,
    fetch_json_impl: Callable[[str, str], tuple[int, bytes, Any]] | None = None,
) -> dict[str, Any]:
    """Refuse capture when served deferred payloads lack the positive venue rows."""
    from deployed_capture_ancestor import ServedDataMissingError

    fetcher = fetch_json_impl or fetch_json
    observed: dict[str, Any] = {}
    for journey in JOURNEYS:
        fixture = journey["fixture"]
        meeting_id = journey["meeting_id"]
        status, body, payload = fetcher(origin, deferred_route_for(fixture))
        if status != 200 or not isinstance(payload, dict):
            raise ServedDataMissingError(
                f"served deferred read for {fixture} returned HTTP {status}"
            )
        if payload.get("schema") != "cityscroll.near_you_deferred.v1":
            raise ServedDataMissingError(
                f"served deferred read for {fixture} has unexpected schema "
                f"{payload.get('schema')!r}"
            )
        results_html = payload.get("results_html")
        if not isinstance(results_html, str):
            raise ServedDataMissingError(f"served deferred read for {fixture} lacks results_html")
        classified = classify_membership_rows(results_html, meeting_id=meeting_id)
        if not classified["meeting_in_exact"]:
            raise ServedDataMissingError(
                f"served {fixture} exact Meetings lack venue row {meeting_id}"
            )
        exact_row = classified["exact_row"]
        assert exact_row is not None
        if journey["held_in_needle"] not in exact_row["text"]:
            raise ServedDataMissingError(
                f"served {fixture} row {meeting_id} lacks held-in venue label "
                f"{journey['held_in_needle']!r}"
            )
        if journey["venue_needle"] not in exact_row["text"]:
            raise ServedDataMissingError(
                f"served {fixture} row {meeting_id} lacks venue text "
                f"{journey['venue_needle']!r}"
            )
        broader_district = journey["broader_district"]
        if f'data-broader-district="{broader_district}"' not in results_html:
            raise ServedDataMissingError(
                f"served {fixture} lacks separately labeled broader district "
                f"{broader_district}"
            )
        observed[fixture] = {
            "deferred_response_sha256": sha256(body),
            "sections": payload.get("sections"),
            "classification": {
                "exact_count": classified["exact_count"],
                "broader_count": classified["broader_count"],
                "meeting_in_exact": True,
                "meeting_in_broader": classified["meeting_in_broader"],
                "held_in_present": True,
                "venue_text_present": True,
                "broader_district_labeled": True,
            },
            "exact_ids": classified["exact_ids"],
            "broader_ids": classified["broader_ids"],
            "full_record_href": exact_row.get("href"),
        }
    return observed


def observe_list_page(page, journey: dict[str, Any]) -> dict[str, Any]:
    meeting_id = journey["meeting_id"]
    page.wait_for_selector(
        "section.near-results .near-record, section.near-results .near-empty, "
        "section.near-broader-districts",
        timeout=90_000,
    )
    try:
        page.wait_for_selector(f'li.near-record[data-record-id="{meeting_id}"]', timeout=45_000)
    except Exception:
        pass
    html = page.content()
    classified = classify_membership_rows(html, meeting_id=meeting_id)
    exact_row = classified["exact_row"]
    focusable = page.eval_on_selector_all(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
        "nodes => nodes.filter(n => !!(n.offsetParent || n.getClientRects().length)).length",
    )
    broader_district = journey["broader_district"]
    return {
        "exact_meeting_present": classified["meeting_in_exact"],
        "meeting_in_broader": classified["meeting_in_broader"],
        "held_in_present": bool(exact_row and journey["held_in_needle"] in exact_row["text"]),
        "venue_text_present": bool(exact_row and journey["venue_needle"] in exact_row["text"]),
        "broader_district_labeled": (
            f'data-broader-district="{broader_district}"' in html
            and "near-geo-broader-label" in html
        ),
        "exact_count": classified["exact_count"],
        "broader_count": classified["broader_count"],
        "keyboard_focusable_count": int(focusable or 0),
        "full_record_href": exact_row.get("href") if exact_row else None,
        "no_horizontal_overflow": page.evaluate(
            """() => document.documentElement.scrollWidth === document.documentElement.clientWidth"""
        ),
    }


def open_full_record(page, journey: dict[str, Any]) -> dict[str, Any]:
    meeting_id = journey["meeting_id"]
    card_selector = f'li.near-record[data-record-id="{meeting_id}"]:not([data-broader-scope])'
    card = page.locator(card_selector).first
    card.wait_for(state="attached", timeout=45_000)
    try:
        card.scroll_into_view_if_needed(timeout=15_000)
    except Exception:
        pass

    href = page.eval_on_selector(
        f"{card_selector} a.near-record-full-record, {card_selector} a.near-record-title-link",
        "el => el && (el.href || el.getAttribute('href'))",
    )
    if not href:
        raise AssertionError(f"{meeting_id}: exact row has no full-record link")

    with page.expect_navigation(wait_until="networkidle", timeout=90_000) as nav_info:
        page.eval_on_selector(
            f"{card_selector} a.near-record-full-record, {card_selector} a.near-record-title-link",
            "el => el.click()",
        )
    response = nav_info.value
    landed = urllib.parse.unquote(page.url)
    if meeting_id not in landed and journey["title_needle"] not in page.content():
        raise AssertionError(f"full-record click did not land on {meeting_id}: {page.url!r}")

    page.wait_for_selector("h1, .meeting-hero, .civic-object-hero", timeout=60_000)
    detail_html = page.content()
    title_ok = journey["title_needle"] in detail_html or SEPT29_TITLE in detail_html
    location_ok = journey["venue_needle"] in detail_html
    identity_ok = meeting_id in urllib.parse.unquote(page.url) or meeting_id in detail_html
    return {
        "opened": True,
        "http_status": response.status if response else None,
        "url": page.url,
        "identity_matches": bool(identity_ok),
        "title_present": bool(title_ok),
        "location_present": bool(location_ok),
        "page_html_sha256": sha256(detail_html),
        "navigation": "clicked-from-list",
    }


def observe_boundaries(origin: str, bk_html: str) -> dict[str, Any]:
    classified = classify_membership_rows(bk_html, meeting_id=SEPT29_ID)
    board_in_exact = BOARD_DISTRICT_ONLY_ID in classified["exact_ids"]
    board_in_broader = BOARD_DISTRICT_ONLY_ID in classified["broader_ids"]
    virtual_in_exact = VIRTUAL_ID in classified["exact_ids"]

    status, body, payload = fetch_json(origin, deferred_route_for(UNSUPPORTED_FIXTURE))
    if status != 200 or not isinstance(payload, dict):
        raise AssertionError(f"unsupported fixture {UNSUPPORTED_FIXTURE} deferred read failed")
    unsupported_html = payload.get("results_html") or ""
    recovery = re.findall(r'data-near-local-recovery="([^"]+)"', unsupported_html)
    all_nyc = "All NYC" in unsupported_html
    if "unsupported" not in recovery or not all_nyc:
        raise AssertionError(
            f"{UNSUPPORTED_FIXTURE} must retain unsupported recovery with All NYC; "
            f"recovery={recovery!r} all_nyc={all_nyc}"
        )

    return {
        "board_district_only": {
            "meeting_id": BOARD_DISTRICT_ONLY_ID,
            "fixture": "BK1503",
            "observed_in_exact": board_in_exact,
            "observed_in_broader": board_in_broader,
            "result": "pass" if (not board_in_exact and board_in_broader) else "fail",
        },
        "virtual_or_unlocated": {
            "meeting_id": VIRTUAL_ID,
            "fixture": "BK1503",
            "observed_in_exact": virtual_in_exact,
            "result": "pass" if not virtual_in_exact else "fail",
        },
        "unsupported_all_nyc_recovery": {
            "fixture": UNSUPPORTED_FIXTURE,
            "recovery": recovery[0] if recovery else None,
            "all_nyc_present": all_nyc,
            "deferred_response_sha256": sha256(body),
            "result": "pass" if ("unsupported" in recovery and all_nyc) else "fail",
        },
    }


def capture_membership_served_read(
    *,
    origin: str = ORIGIN,
    api_origin: str = API_ORIGIN,
) -> dict[str, Any]:
    """Observe BK1503/QN0602 venue membership journeys on the served site."""
    import sys

    sys.path.insert(0, str(ROOT / "tools"))
    from deployed_capture_ancestor import (  # noqa: WPS433
        DeployPendingError,
        WrongPinError,
        load_recorded_delivery,
        require_served_page_revision_contains_delivery,
        revision_contains_ancestor,
    )
    from playwright.sync_api import sync_playwright

    try:
        required_ancestor = load_recorded_delivery(DELIVERY_PATH)
    except WrongPinError as error:
        raise SystemExit(str(error)) from error

    try:
        pages_revision = require_served_page_revision_contains_delivery(
            origin,
            required_ancestor,
            cwd=ROOT,
        )
    except (WrongPinError, DeployPendingError) as error:
        raise SystemExit(str(error)) from error

    try:
        worker_commit, health = require_worker_commit_contains_delivery(
            api_origin,
            required_ancestor,
            cwd=ROOT,
            revision_contains_ancestor=revision_contains_ancestor,
        )
    except DeployPendingError as error:
        raise SystemExit(str(error)) from error

    try:
        deferred_observations = require_served_membership_data(origin)
    except Exception as error:
        # ServedDataMissingError and AssertionError both mean refuse capture.
        raise SystemExit(str(error)) from error

    manifest_status, manifest_bytes, manifest = fetch_json(origin, "/artifact-manifest.json")
    if manifest_status != 200:
        raise SystemExit("artifact manifest did not return HTTP 200")

    activity_status, _activity_bytes, activity = fetch_json(origin, "/data/district_activity.json")
    activity_built_at = activity.get("built_at") if activity_status == 200 and isinstance(activity, dict) else None

    bk_status, bk_body, bk_payload = fetch_json(origin, deferred_route_for("BK1503"))
    if bk_status != 200:
        raise SystemExit("BK1503 deferred read failed during boundary observation")
    boundaries = observe_boundaries(origin, bk_payload.get("results_html") or "")
    if boundaries["board_district_only"]["result"] != "pass":
        raise SystemExit(f"board-district-only boundary failed: {boundaries['board_district_only']!r}")
    if boundaries["virtual_or_unlocated"]["result"] != "pass":
        raise SystemExit(f"virtual boundary failed: {boundaries['virtual_or_unlocated']!r}")
    if boundaries["unsupported_all_nyc_recovery"]["result"] != "pass":
        raise SystemExit(
            f"unsupported All NYC recovery failed: {boundaries['unsupported_all_nyc_recovery']!r}"
        )

    journeys_out: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version
        for journey in JOURNEYS:
            fixture = journey["fixture"]
            route = page_route_for(fixture)
            deferred = deferred_observations[fixture]
            viewport_reads: list[dict[str, Any]] = []
            route_token = secrets.token_hex(12)
            for viewport_name, width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    extra_http_headers={
                        "Cache-Control": "no-cache, no-store",
                        "Pragma": "no-cache",
                    },
                )
                page = context.new_page()
                response = page.goto(
                    uncached_url(origin, route, route_token),
                    wait_until="networkidle",
                    timeout=90_000,
                )
                page_status = response.status if response else None
                if page_status != 200:
                    raise SystemExit(f"{route} returned HTTP {page_status} at {viewport_name}")
                list_obs = observe_list_page(page, journey)
                if not list_obs["exact_meeting_present"]:
                    raise SystemExit(
                        f"{fixture} {viewport_name}: exact venue row missing for {journey['meeting_id']}"
                    )
                if not list_obs["held_in_present"] or not list_obs["venue_text_present"]:
                    raise SystemExit(
                        f"{fixture} {viewport_name}: venue held-in/address labels missing: {list_obs!r}"
                    )
                if not list_obs["broader_district_labeled"]:
                    raise SystemExit(
                        f"{fixture} {viewport_name}: broader district "
                        f"{journey['broader_district']} not separately labeled"
                    )
                if list_obs["exact_count"] != deferred["classification"]["exact_count"]:
                    raise SystemExit(
                        f"{fixture} {viewport_name}: rendered exact count "
                        f"{list_obs['exact_count']} != deferred "
                        f"{deferred['classification']['exact_count']}"
                    )
                if not list_obs["no_horizontal_overflow"]:
                    raise SystemExit(f"{route} has horizontal overflow at {viewport_name}")

                list_html = page.content()
                # Viewport screenshot: BK1503 exact lists are tall enough that
                # full-page capture can exceed Chromium's screenshot budget.
                try:
                    list_screenshot = page.screenshot(full_page=False, timeout=30_000)
                except Exception:
                    list_screenshot = page.screenshot(
                        clip={"x": 0, "y": 0, "width": width, "height": min(height, 900)},
                        timeout=30_000,
                    )
                detail_obs = open_full_record(page, journey)
                if detail_obs.get("http_status") not in (200, None):
                    raise SystemExit(
                        f"{fixture} {viewport_name}: full record returned HTTP "
                        f"{detail_obs.get('http_status')}"
                    )
                if not detail_obs["identity_matches"] or not detail_obs["location_present"]:
                    raise SystemExit(
                        f"{fixture} {viewport_name}: full record identity/location failed: "
                        f"{detail_obs!r}"
                    )

                # Return to list for a Back-path witness, then continue.
                page.go_back(wait_until="networkidle", timeout=90_000)
                page.wait_for_selector(
                    f'li.near-record[data-record-id="{journey["meeting_id"]}"]',
                    timeout=45_000,
                )
                back_present = page.locator(
                    f'li.near-record[data-record-id="{journey["meeting_id"]}"]:not([data-broader-scope])'
                ).count() > 0
                if not back_present:
                    raise SystemExit(
                        f"{fixture} {viewport_name}: Back from full record lost exact venue row"
                    )

                witness = {
                    "fixture": fixture,
                    "meeting_id": journey["meeting_id"],
                    "role": journey["role"],
                    "list": list_obs,
                    "detail": {
                        "identity_matches": detail_obs["identity_matches"],
                        "location_present": detail_obs["location_present"],
                        "title_present": detail_obs["title_present"],
                        "url": detail_obs["url"],
                    },
                    "back_retains_exact_row": True,
                }
                viewport_reads.append(
                    {
                        "name": viewport_name,
                        "width": width,
                        "height": height,
                        "http_status": page_status,
                        "role": journey["role"],
                        "exact_meeting_present": True,
                        "held_in_present": True,
                        "venue_text_present": True,
                        "broader_district_labeled": True,
                        "exact_count": list_obs["exact_count"],
                        "broader_count": list_obs["broader_count"],
                        "keyboard_focusable_count": list_obs["keyboard_focusable_count"],
                        "no_horizontal_overflow": True,
                        "full_record": detail_obs,
                        "back_retains_exact_row": True,
                        "page_html_sha256": sha256(list_html),
                        "screenshot_sha256": sha256(list_screenshot),
                        "witness_sha256": sha256(
                            json.dumps(witness, sort_keys=True, separators=(",", ":"))
                        ),
                        "result": "pass",
                    }
                )
                context.close()

            journeys_out.append(
                {
                    "fixture": fixture,
                    "label": journey["label"],
                    "meeting_id": journey["meeting_id"],
                    "role": journey["role"],
                    "broader_district": journey["broader_district"],
                    "route": deferred_route_for(fixture),
                    "page_route": route,
                    "deferred_response_sha256": deferred["deferred_response_sha256"],
                    "deferred_sections": deferred["sections"],
                    "exact_count": deferred["classification"]["exact_count"],
                    "broader_count": deferred["classification"]["broader_count"],
                    "viewports": viewport_reads,
                    "result": "pass",
                }
            )
        browser.close()

    final_status, final_manifest_bytes, _ = fetch_json(origin, "/artifact-manifest.json")
    if final_status != 200 or final_manifest_bytes != manifest_bytes:
        raise SystemExit("served Pages deployment changed during membership capture")
    final_health_status, _, final_health = fetch_json(api_origin, "/health")
    if final_health_status != 200 or final_health.get("commit") != worker_commit:
        raise SystemExit("served Worker deployment changed during membership capture")

    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": origin,
        "api_origin": api_origin,
        "required_ancestor": required_ancestor,
        "required_ancestor_contained": True,
        "deployment": {
            "pages": {
                "manifest_url": f"{origin}/artifact-manifest.json",
                "revision": pages_revision,
                "generated_at": manifest.get("generated_at"),
                "deployment_at": manifest.get("deployment_at"),
                "artifact_hash": manifest.get("artifact_hash"),
                "manifest_sha256": sha256(manifest_bytes),
                "contains_required_ancestor": True,
            },
            "worker": {
                "health_url": f"{api_origin}/health",
                "commit": worker_commit,
                "environment": health.get("environment"),
                "contains_required_ancestor": True,
            },
        },
        "data_generation": {
            "district_activity_built_at": activity_built_at,
            "pages_artifact_generated_at": manifest.get("generated_at"),
            "bk1503_deferred_sha256": sha256(bk_body),
        },
        "capture": {
            "tool": "tools/capture_near_you_place_slices_production_read.py",
            "browser": f"chromium {browser_version}",
            "viewports": [
                {"name": name, "width": width, "height": height}
                for name, width, height in VIEWPORTS
            ],
            "screenshot_binaries_committed": False,
        },
        "journeys": journeys_out,
        "boundaries": boundaries,
        "summary": {
            "result": "pass",
            "journeys_observed": len(journeys_out),
            "viewport_observations": sum(len(row["viewports"]) for row in journeys_out),
            "boundary_controls": 3,
        },
    }


def validate_membership_served_read(payload: dict[str, Any]) -> None:
    if payload.get("schema") != SCHEMA:
        raise AssertionError("membership served read schema mismatch")
    if payload.get("origin") != ORIGIN or payload.get("api_origin") != API_ORIGIN:
        raise AssertionError("membership served read is not from canonical production origins")
    if payload.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("membership served read public alias mismatch")
    required = payload.get("required_ancestor", "")
    if not re.fullmatch(r"[0-9a-f]{40}", required):
        raise AssertionError("membership served read missing required ancestor")
    if payload.get("required_ancestor_contained") is not True:
        raise AssertionError("membership served read does not record ancestor containment")

    pages = payload.get("deployment", {}).get("pages", {})
    worker = payload.get("deployment", {}).get("worker", {})
    if not re.fullmatch(r"[0-9a-f]{40}", pages.get("revision", "")):
        raise AssertionError("membership served read missing Pages revision")
    if not re.fullmatch(r"[0-9a-f]{40}", worker.get("commit", "")):
        raise AssertionError("membership served read missing Worker commit")
    if pages.get("contains_required_ancestor") is not True:
        raise AssertionError("Pages ancestry not recorded as contained")
    if worker.get("contains_required_ancestor") is not True:
        raise AssertionError("Worker ancestry not recorded as contained")

    if payload.get("capture", {}).get("screenshot_binaries_committed") is not False:
        raise AssertionError("membership served read must not commit screenshot binaries")

    journeys = payload.get("journeys") or []
    if [row.get("fixture") for row in journeys] != ["BK1503", "QN0602"]:
        raise AssertionError("membership served read must cover BK1503 and QN0602")

    expected_ids = {JOURNEYS[0]["meeting_id"], JOURNEYS[1]["meeting_id"]}
    observed_ids = {row.get("meeting_id") for row in journeys}
    if observed_ids != expected_ids:
        raise AssertionError("membership served read lost a positive meeting identity")

    if payload.get("summary") != {
        "result": "pass",
        "journeys_observed": 2,
        "viewport_observations": 4,
        "boundary_controls": 3,
    }:
        raise AssertionError("membership served read summary is incomplete")

    for journey, expected in zip(journeys, JOURNEYS):
        if journey.get("result") != "pass" or journey.get("role") != "venue":
            raise AssertionError(f"{journey.get('fixture')} journey did not pass as venue")
        if journey.get("broader_district") != expected["broader_district"]:
            raise AssertionError(f"{journey.get('fixture')} broader district mismatch")
        if not isinstance(journey.get("exact_count"), int) or journey["exact_count"] < 1:
            raise AssertionError(f"{journey.get('fixture')} exact count must be positive")
        if [(item.get("name"), item.get("width"), item.get("height")) for item in journey.get("viewports", [])] != list(VIEWPORTS):
            raise AssertionError(f"{journey.get('fixture')} viewport coverage mismatch")
        for viewport in journey["viewports"]:
            if viewport.get("result") != "pass":
                raise AssertionError(f"{journey.get('fixture')} {viewport.get('name')} did not pass")
            for flag in (
                "exact_meeting_present",
                "held_in_present",
                "venue_text_present",
                "broader_district_labeled",
                "back_retains_exact_row",
                "no_horizontal_overflow",
            ):
                if viewport.get(flag) is not True:
                    raise AssertionError(
                        f"{journey.get('fixture')} {viewport.get('name')} missing {flag}"
                    )
            detail = viewport.get("full_record") or {}
            if detail.get("opened") is not True or detail.get("navigation") != "clicked-from-list":
                raise AssertionError(
                    f"{journey.get('fixture')} {viewport.get('name')} full record was not clicked open"
                )
            if detail.get("identity_matches") is not True or detail.get("location_present") is not True:
                raise AssertionError(
                    f"{journey.get('fixture')} {viewport.get('name')} full record identity/location failed"
                )
            for field in ("page_html_sha256", "screenshot_sha256", "witness_sha256"):
                if not re.fullmatch(r"[0-9a-f]{64}", viewport.get(field, "")):
                    raise AssertionError(
                        f"{journey.get('fixture')} {viewport.get('name')} missing {field}"
                    )
            if not re.fullmatch(r"[0-9a-f]{64}", detail.get("page_html_sha256", "")):
                raise AssertionError(
                    f"{journey.get('fixture')} {viewport.get('name')} detail missing page hash"
                )

    boundaries = payload.get("boundaries") or {}
    board = boundaries.get("board_district_only") or {}
    if board.get("result") != "pass" or board.get("observed_in_exact") is not False:
        raise AssertionError("board-district-only row must stay out of exact membership")
    if board.get("observed_in_broader") is not True:
        raise AssertionError("board-district-only row must remain visible under broader activity")
    virtual = boundaries.get("virtual_or_unlocated") or {}
    if virtual.get("result") != "pass" or virtual.get("observed_in_exact") is not False:
        raise AssertionError("virtual/unlocated row must stay out of exact membership")
    recovery = boundaries.get("unsupported_all_nyc_recovery") or {}
    if recovery.get("result") != "pass" or recovery.get("all_nyc_present") is not True:
        raise AssertionError("unsupported exact coverage must retain All NYC recovery")
    if recovery.get("recovery") != "unsupported":
        raise AssertionError("unsupported recovery marker missing")

    serialized = json.dumps(payload)
    if "/Users/" in serialized or "file://" in serialized:
        raise AssertionError("membership served read contains a local path reference")


def check_membership_served_read() -> None:
    if not MEMBERSHIP_OUTPUT.is_file():
        raise AssertionError(
            f"membership served read missing at {MEMBERSHIP_OUTPUT.relative_to(ROOT)}; "
            "run the capture after Pages and Worker both contain the landed delivery"
        )
    validate_membership_served_read(read_json(MEMBERSHIP_OUTPUT))
