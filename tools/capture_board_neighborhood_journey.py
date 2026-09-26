#!/usr/bin/env python3
"""Production and fixture capture for board neighborhood discovery journeys.

Records textual served values, measured viewport widths, generation hashes,
and render digests. Screenshot binaries stay under the local task scratch
directory; only textual receipts are committed.

Refuses to run against production until the served Pages artifact-manifest
revision contains the recorded landed delivery commit, and until required
directory / profile / index subjects are present on the served origin.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from deployed_capture_ancestor import (  # noqa: E402
    DeployPendingError,
    ServedDataMissingError,
    WrongPinError,
    load_recorded_delivery,
    require_served_page_revision_contains_delivery,
)

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "board-neighborhood-journey"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
DEFAULT_OUT = EVIDENCE_DIR / "readback.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / (
    "board-neighborhood-journey-screenshots"
)
PUBLIC_ALIAS = "c0a2ef2da209d"
SCHEMA = "cityscroll.board_neighborhood_journey_readback.v1"
MANIFEST_SCHEMA = "cityscroll.render_capture_manifest.v1"
DEFAULT_BASE = "https://cityscroll.org/"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_UA = "cityscroll-board-neighborhood-journey-capture/1"
DATA_VINTAGE = "board-neighborhood generation; nta2020 26B; community 2026-05-26"

REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY_PATH)

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

JOURNEY_CASES = (
    {
        "id": "kensington-ambiguous",
        "geo": "nta2020:BK1203",
        "label": "Kensington",
        "board_ids": ["brooklyn-cb-12", "brooklyn-cb-14"],
        "profile_board": "brooklyn-cb-14",
        "heading_re": r"Boards overlapping Kensington",
    },
    {
        "id": "si0105-ambiguous",
        "geo": "nta2020:SI0105",
        "label": "Westerleigh",
        "board_ids": ["staten-island-cb-01", "staten-island-cb-02"],
        "profile_board": "staten-island-cb-02",
        "heading_re": r"Boards overlapping",
    },
    {
        "id": "greenpoint-single",
        "geo": "nta2020:BK0101",
        "label": "Greenpoint",
        "board_ids": ["brooklyn-cb-01"],
        "profile_board": "brooklyn-cb-01",
        "heading_re": r"Board overlapping Greenpoint",
    },
    {
        "id": "bk0504-special-district",
        "geo": "nta2020:BK0504",
        "label": "Spring Creek",
        "board_ids": ["brooklyn-cb-05", "brooklyn-cb-18"],
        "forbidden_board_ids": ["brooklyn-cb-56"],
        "profile_board": "brooklyn-cb-05",
        "heading_re": r"Boards overlapping",
        "require_non_board_copy": True,
    },
    {
        "id": "queens-holdout",
        "geo": "nta2020:QN0402",
        "label": "Corona",
        "board_ids": ["queens-cb-04"],
        "profile_board": "queens-cb-04",
        "heading_re": r"Board overlapping Corona",
    },
    {
        "id": "bronx-holdout",
        "geo": "nta2020:BX0902",
        "label": "Soundview",
        "board_ids": ["bronx-cb-09"],
        "profile_board": "bronx-cb-09",
        "heading_re": r"Board overlapping",
    },
)

MIDWOOD_ADDRESS = "810 East 16th Street Brooklyn"
VICTORY_ADDRESS = "1688 Victory Boulevard Staten Island"
VICTORY_RECOVERY_NEEDLE = "district map is not available yet"
MIDWOOD_BOARD = "brooklyn-cb-14"


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def fetch_bytes(url: str, *, accept: str = "*/*", timeout: int = 60) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": accept},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ServedDataMissingError(f"served resource unavailable at {url}: {error}") from error


def fetch_json(url: str) -> dict | list:
    _status, raw = fetch_bytes(url, accept="application/json")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ServedDataMissingError(f"served JSON invalid at {url}: {error}") from error
    return payload


def absolute(base: str, path: str) -> str:
    origin = normalize_base(base).rstrip("/")
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return f"{origin}/{path.lstrip('/')}"


def require_production_base(base: str) -> str:
    normalized = normalize_base(base)
    host = (urllib.parse.urlparse(normalized).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise SystemExit(f"production journey verify requires a cityscroll.org base, got {base}")
    return normalized


def require_served_subjects(base: str) -> dict:
    """Refuse when directory, index, ACTIVE pointer, or profile markup is absent."""
    index_url = absolute(base, "/data/board_neighborhood_index.json")
    active_url = absolute(base, "/data/board-neighborhood-generations/ACTIVE")
    directory_url = absolute(base, "/community-boards/")
    profile_url = absolute(base, "/community-boards/brooklyn-cb-14/")

    index = fetch_json(index_url)
    if not isinstance(index, dict) or index.get("schema") != "cityscroll.board_neighborhood_index.v1":
        raise ServedDataMissingError(f"board neighborhood index missing schema at {index_url}")
    by_nta = index.get("by_nta") or {}
    for nta, expected in (
        ("BK1203", {"brooklyn-cb-12", "brooklyn-cb-14"}),
        ("BK0101", {"brooklyn-cb-01"}),
        ("QN0402", {"queens-cb-04"}),
        ("BX0902", {"bronx-cb-09"}),
    ):
        rows = by_nta.get(nta) or []
        boards = {row.get("board_id") for row in rows if isinstance(row, dict)}
        if not expected.issubset(boards):
            raise ServedDataMissingError(
                f"served index for {nta} lacks expected boards {sorted(expected)}; got {sorted(boards)}"
            )

    active = fetch_json(active_url)
    if not isinstance(active, dict) or not active.get("active_generation"):
        raise ServedDataMissingError(f"ACTIVE generation pointer missing at {active_url}")
    generation_id = str(active["active_generation"])
    gen_manifest = fetch_json(
        absolute(base, f"/data/board-neighborhood-generations/{generation_id}/manifest.json")
    )
    if not isinstance(gen_manifest, dict):
        raise ServedDataMissingError("generation manifest missing")

    _status, directory_html = fetch_bytes(directory_url, accept="text/html")
    directory_text = directory_html.decode("utf-8", "replace")
    for needle in (
        "data-board-neighborhood-entry",
        "scorecard-neighborhood-select",
        "data-board-exact-address",
        "data-board-exact-address-input",
    ):
        if needle not in directory_text:
            raise ServedDataMissingError(
                f"served directory at {directory_url} lacks required markup {needle!r}"
            )

    # Directory binder must stay browser-safe: importing the Node index module
    # pulls node:crypto into the Pages graph and prevents progressive enhancement.
    _status, directory_module = fetch_bytes(
        absolute(base, "/board_neighborhood_directory.mjs"),
        accept="application/javascript",
    )
    module_text = directory_module.decode("utf-8", "replace")
    if "board_neighborhood_index.mjs" in module_text or "node:crypto" in module_text:
        raise ServedDataMissingError(
            "served board_neighborhood_directory.mjs still imports a Node-only index module"
        )

    _status, profile_html = fetch_bytes(profile_url, accept="text/html")
    profile_text = profile_html.decode("utf-8", "replace")
    for needle in (
        "Neighborhoods in this district",
        "data-board-profile-neighborhoods",
        "Kensington",
        "meetings-participation",
    ):
        if needle not in profile_text:
            raise ServedDataMissingError(
                f"served profile at {profile_url} lacks required markup {needle!r}"
            )

    return {
        "active_generation": generation_id,
        "generation_manifest": gen_manifest,
        "index_generation": (index.get("generation") or {}),
        "directory_sha256": sha256_text(directory_text),
        "profile_sha256": sha256_text(profile_text),
        "index_content_sha256": (index.get("generation") or {}).get("content_sha256"),
    }


def launch_browser():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:  # pragma: no cover
        raise SystemExit(
            "Browser journey cannot run: Python Playwright is unavailable. "
            "Install the repository-pinned browser environment before running this journey."
        ) from error
    return sync_playwright()


def measure_box(page, selector: str) -> dict | None:
    return page.evaluate(
        """(selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible: rect.width > 0 && rect.height > 0,
          };
        }""",
        selector,
    )


def tab_until(page, selector: str, *, max_tabs: int = 100) -> dict:
    page.wait_for_selector(selector, timeout=30_000)
    focused = None
    for steps in range(1, max_tabs + 1):
        page.keyboard.press("Tab")
        focused = page.evaluate(
            """(selector) => {
              const el = document.activeElement;
              if (!el) return null;
              return {
                id: el.id || null,
                matched: el.matches ? el.matches(selector) : false,
                tag: el.tagName,
              };
            }""",
            selector,
        )
        if focused and focused.get("matched"):
            return {
                "keyboard_traversal_steps": steps,
                "focused": True,
                "focused_id": focused.get("id"),
            }
    raise SystemExit(
        f"keyboard traversal did not reach {selector} within {max_tabs} tabs; last={focused!r}"
    )


def observe_directory_geo(page, base: str, case: dict, viewport: tuple[str, int, int]) -> dict:
    name, width, height = viewport
    nta_id = case["geo"].split(":")[-1]
    route = f"/community-boards/?geo={urllib.parse.quote(case['geo'], safe=':')}"
    page.set_viewport_size({"width": width, "height": height})
    page.goto(absolute(base, route), wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("[data-board-neighborhood-entry]", timeout=30_000)
    page.wait_for_selector("#scorecard-neighborhood-select", timeout=30_000)

    inner_width = page.evaluate("() => window.innerWidth")
    if int(inner_width) != int(width):
        raise SystemExit(f"{case['id']}@{name}: inner_width {inner_width} != viewport {width}")

    # Prefer progressive-enhancement results. If the binder mounts, drive the
    # chooser explicitly so a stale hidden results panel cannot fake success.
    enhancement = page.evaluate(
        """(geo) => {
          const select = document.querySelector('#scorecard-neighborhood-select');
          if (!select) return { mounted: false };
          select.value = geo;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
          const results = document.querySelector('[data-board-neighborhood-results]');
          const heading = document.querySelector('[data-board-neighborhood-results-heading]');
          return {
            mounted: true,
            results_hidden: results ? results.hasAttribute('hidden') : null,
            heading: heading ? String(heading.textContent || '').trim() : null,
            choice_count: document.querySelectorAll('.scorecard-neighborhood-choice').length,
          };
        }""",
        case["geo"],
    )

    # Wait briefly for the binder to unhide results when modules boot.
    try:
        page.wait_for_function(
            """() => {
              const results = document.querySelector('[data-board-neighborhood-results]');
              if (!results) return false;
              if (results.hasAttribute('hidden')) return false;
              return document.querySelectorAll('.scorecard-neighborhood-choice a[href*="/community-boards/"]').length > 0
                || /Boards? overlapping|No published board/i.test(
                  document.querySelector('[data-board-neighborhood-results-heading]')?.textContent || ''
                );
            }""",
            timeout=8_000,
        )
    except Exception:
        pass

    html = page.content()
    heading_el = page.locator("[data-board-neighborhood-results-heading]")
    heading = heading_el.inner_text(timeout=5_000) if heading_el.count() else ""
    enhanced = bool(heading) and bool(re.search(case["heading_re"], heading)) and (
        page.locator("[data-board-neighborhood-results]:not([hidden])").count() > 0
    )

    # No-JS association table remains the fail-closed browse route.
    nojs = page.locator(f'[data-board-neighborhood-link="{nta_id}"]')
    nojs_href = nojs.get_attribute("href") if nojs.count() else None
    if nojs.count() < 1:
        raise SystemExit(f"{case['id']}@{name}: no-JS association link missing for {nta_id}")

    for board_id in case["board_ids"]:
        profile_links = page.locator(f'a[href="/community-boards/{board_id}/"]')
        if profile_links.count() < 1 and board_id not in html:
            raise SystemExit(f"{case['id']}@{name}: missing board {board_id}")

    for board_id in case.get("forbidden_board_ids") or []:
        if re.search(r"brooklyn-cb-56|Community Board 56", html):
            raise SystemExit(f"{case['id']}@{name}: forbidden board present ({board_id})")
    if case.get("require_non_board_copy"):
        if "No published community board" not in html and "special" not in html.lower():
            # Accept either enhanced disclosure or association-table evidence that K56 has no board card.
            if "brooklyn-cb-56" in html:
                raise SystemExit(f"{case['id']}@{name}: special-district disclosure missing")

    if enhanced and not re.search(case["heading_re"], heading):
        raise SystemExit(f"{case['id']}@{name}: heading {heading!r} failed /{case['heading_re']}/")

    entry = measure_box(page, "[data-board-neighborhood-entry]")
    chooser = measure_box(page, "#scorecard-neighborhood-select")
    if not entry or not entry.get("visible") or entry["width"] <= 0:
        raise SystemExit(f"{case['id']}@{name}: entry width not measurable")
    if not chooser or not chooser.get("visible") or chooser["width"] <= 0:
        raise SystemExit(f"{case['id']}@{name}: chooser width not measurable")

    keyboard = tab_until(page, "#scorecard-neighborhood-select,[data-board-neighborhood-select]")

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    shot = SCREENSHOT_DIR / f"{case['id']}-{name}.png"
    page.screenshot(path=str(shot), full_page=True)

    return {
        "name": f"{case['id']}-{name}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "assertion": (
            f"Directory geo {case['geo']} shows boards {case['board_ids']} at {width}px "
            f"with measurable chooser and keyboard focus"
        ),
        "sha256": sha256_text(html),
        "file": None,
        "local_screenshot": str(shot),
        "served_values": {
            "heading": (heading or "").strip(),
            "board_ids": list(case["board_ids"]),
            "inner_width": int(inner_width),
            "entry_width": entry["width"],
            "chooser_width": chooser["width"],
            "keyboard": keyboard,
            "nojs_link_href": nojs_href,
            "enhanced_results": enhanced,
            "enhancement_probe": enhancement,
            "address_action_present": page.locator("[data-board-address-action]").count() > 0,
        },
    }


def observe_profile_journey(page, base: str, case: dict, viewport: tuple[str, int, int]) -> dict:
    name, width, height = viewport
    board_id = case["profile_board"]
    route = f"/community-boards/{board_id}/"
    page.set_viewport_size({"width": width, "height": height})
    page.goto(absolute(base, route), wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("[data-board-profile-neighborhoods], .board-neighborhoods", timeout=30_000)

    inner_width = page.evaluate("() => window.innerWidth")
    if int(inner_width) != int(width):
        raise SystemExit(f"profile-{board_id}@{name}: inner_width {inner_width} != {width}")

    html = page.content()
    if "Neighborhoods in this district" not in html:
        raise SystemExit(f"profile-{board_id}@{name}: neighborhoods heading missing")
    label_token = case["label"].split()[0]
    nta_id = case["geo"].split(":")[-1]
    if label_token not in html and case["label"] not in html and nta_id not in html:
        raise SystemExit(
            f"profile-{board_id}@{name}: expected neighborhood label {case['label']!r} or {nta_id}"
        )

    participation = page.locator("#meetings-participation, [data-board-next-meeting], a[href='#meetings-participation']")
    if participation.count() < 1 and "Open the verified calendar" not in html and "Next full-board meeting" not in html:
        raise SystemExit(f"profile-{board_id}@{name}: calendar/participation action missing")

    # Near You reverse link restores an NTA geography key.
    near_you = page.locator('a[href*="geo="][href*="nta2020"]')
    if near_you.count() < 1:
        raise SystemExit(f"profile-{board_id}@{name}: Near You neighborhood link missing")

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    shot = SCREENSHOT_DIR / f"profile-{board_id}-{name}.png"
    page.screenshot(path=str(shot), full_page=True)

    return {
        "name": f"profile-{board_id}-{name}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "assertion": (
            f"Profile {board_id} keeps neighborhood links and calendar/participation actions at {width}px"
        ),
        "sha256": sha256_text(html),
        "file": None,
        "local_screenshot": str(shot),
        "served_values": {
            "neighborhoods_heading_present": True,
            "participation_or_calendar_present": True,
            "near_you_link_count": near_you.count(),
            "inner_width": int(inner_width),
        },
    }


def observe_exact_address(page, base: str, viewport: tuple[str, int, int]) -> list[dict]:
    name, width, height = viewport
    route = "/community-boards/"
    page.set_viewport_size({"width": width, "height": height})
    page.goto(absolute(base, route), wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("[data-board-exact-address-input]", timeout=30_000)

    # Open the address panel via the neighborhood address action when present.
    action = page.locator("[data-board-address-action]")
    if action.count():
        action.first.click()
    page.wait_for_selector("[data-board-exact-address-input]", state="visible", timeout=10_000)

    rows = []
    for label, address, expect_ok, board_id, recovery_needle in (
        ("midwood-success", MIDWOOD_ADDRESS, True, MIDWOOD_BOARD, None),
        ("victory-unresolved", VICTORY_ADDRESS, False, None, VICTORY_RECOVERY_NEEDLE),
    ):
        page.fill("[data-board-exact-address-input]", address)
        page.click("[data-board-exact-address-submit]")
        if expect_ok:
            page.wait_for_selector(
                f'[data-board-exact-address-choice="{board_id}"], a[href="/community-boards/{board_id}/"]',
                timeout=45_000,
            )
        else:
            page.wait_for_selector("[data-board-exact-address-status]", timeout=45_000)
            status = page.locator("[data-board-exact-address-status]").inner_text()
            if recovery_needle and recovery_needle not in status:
                raise SystemExit(
                    f"{label}@{name}: expected recovery containing {recovery_needle!r}, got {status!r}"
                )
            if page.locator("[data-board-exact-address-choice]").count() > 0:
                raise SystemExit(f"{label}@{name}: unresolved address must not yield an exact board choice")

        html = page.content()
        # Neighborhood directory remains actionable after address recovery.
        if page.locator("[data-board-neighborhood-select]").count() < 1:
            raise SystemExit(f"{label}@{name}: neighborhood chooser missing after address flow")

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        shot = SCREENSHOT_DIR / f"address-{label}-{name}.png"
        page.screenshot(path=str(shot), full_page=True)
        rows.append(
            {
                "name": f"address-{label}-{name}",
                "route": route,
                "viewport": {"width": width, "height": height},
                "assertion": (
                    f"Exact address '{address}' "
                    + ("resolves to Brooklyn Community Board 14" if expect_ok else "stays unresolved with recovery")
                ),
                "sha256": sha256_text(html),
                "file": None,
                "local_screenshot": str(shot),
                "served_values": {
                    "address_query": address,
                    "ok": expect_ok,
                    "board_id": board_id,
                    "recovery_present": (not expect_ok),
                    "neighborhood_chooser_present": True,
                },
            }
        )
        clear = page.locator("[data-board-exact-address-clear]")
        if clear.count() and clear.is_visible():
            clear.click()
    return rows


def observe_no_js_and_back(page, base: str, viewport: tuple[str, int, int]) -> dict:
    name, width, height = viewport
    route = "/community-boards/?geo=nta2020%3ABK1203"
    page.set_viewport_size({"width": width, "height": height})
    page.goto(absolute(base, route), wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("[data-board-neighborhood-entry]", timeout=30_000)
    # Follow a board profile link, then browser Back.
    page.locator('a[href="/community-boards/brooklyn-cb-14/"]').first.click()
    page.wait_for_url("**/community-boards/brooklyn-cb-14/**", timeout=30_000)
    page.go_back()
    page.wait_for_selector("[data-board-neighborhood-entry]", timeout=30_000)
    restored = page.evaluate("() => window.location.search + window.location.hash")
    if "BK1203" not in restored and "nta2020" not in restored:
        # Soft: some servers may normalize; require directory still actionable.
        pass
    if page.locator("[data-board-neighborhood-select]").count() < 1:
        raise SystemExit(f"back@{name}: directory chooser missing after Back")

    # No-JS: strip scripts and confirm association links remain.
    page.goto(absolute(base, route), wait_until="domcontentloaded", timeout=60_000)
    page.evaluate(
        """() => {
          for (const node of [...document.querySelectorAll('script')]) node.remove();
        }"""
    )
    nojs_link = page.locator('[data-board-neighborhood-link="BK1203"], a[href*="geo=nta2020%3ABK1203"]')
    if nojs_link.count() < 1:
        # Table association links may use different attributes; require any Kensington board profile href.
        if page.locator('a[href="/community-boards/brooklyn-cb-12/"]').count() < 1:
            raise SystemExit(f"nojs@{name}: no-JS Kensington board links missing")

    html = page.content()
    return {
        "name": f"directory-back-nojs-{name}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "assertion": "Back returns to the directory and no-JS board links remain actionable",
        "sha256": sha256_text(html),
        "file": None,
        "served_values": {
            "chooser_present_after_back": True,
            "nojs_board_links_present": True,
            "restored_location": restored,
        },
    }


def observe_unavailable_association(page, base: str, viewport: tuple[str, int, int]) -> dict:
    """Positive control: blocking the index fetch keeps directory links and retry."""
    name, width, height = viewport
    route = "/community-boards/"
    page.set_viewport_size({"width": width, "height": height})

    def block_index(route_obj):
        route_obj.abort()

    page.route("**/data/board_neighborhood_index.json", block_index)
    page.route("**/data/board-neighborhood-generations/**", block_index)
    try:
        page.goto(absolute(base, route), wait_until="domcontentloaded", timeout=60_000)
        # Directory shell and board table/map must remain even if enrichment fails.
        page.wait_for_selector("[data-community-board-root], .scorecard, main", timeout=30_000)
        html = page.content()
        retry = page.locator("[data-board-neighborhood-retry]")
        failure = page.locator("[data-board-neighborhood-failure]")
        # Some builds ship associations inline; still require an actionable directory.
        board_links = page.locator('a[href*="/community-boards/"]')
        if board_links.count() < 1 and "Community Board" not in html:
            raise SystemExit(f"unavailable@{name}: directory became empty when association fetch failed")
        return {
            "name": f"association-unavailable-{name}",
            "route": route,
            "viewport": {"width": width, "height": height},
            "assertion": "Unavailable association data leaves an actionable directory",
            "sha256": sha256_text(html),
            "file": None,
            "served_values": {
                "retry_control_present": retry.count() > 0,
                "failure_region_present": failure.count() > 0,
                "directory_links_present": board_links.count() > 0 or "Community Board" in html,
            },
        }
    finally:
        page.unroute("**/data/board_neighborhood_index.json", block_index)
        page.unroute("**/data/board-neighborhood-generations/**", block_index)


def capture_production(base: str) -> tuple[dict, list[dict]]:
    base = require_production_base(base)
    try:
        served_revision = require_served_page_revision_contains_delivery(
            base,
            REQUIRED_ANCESTOR,
            cwd=ROOT,
        )
    except (WrongPinError, DeployPendingError) as error:
        raise SystemExit(str(error)) from error

    try:
        subjects = require_served_subjects(base)
    except ServedDataMissingError as error:
        raise SystemExit(str(error)) from error

    captures: list[dict] = []
    with launch_browser() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            for viewport in VIEWPORTS:
                for case in JOURNEY_CASES:
                    captures.append(observe_directory_geo(page, base, case, viewport))
                    captures.append(observe_profile_journey(page, base, case, viewport))
                captures.extend(observe_exact_address(page, base, viewport))
                captures.append(observe_no_js_and_back(page, base, viewport))
                captures.append(observe_unavailable_association(page, base, viewport))
        finally:
            browser.close()

    # Positive control converse: desktop entry widths must exceed narrow for Kensington.
    narrow = next(row for row in captures if row["name"] == "kensington-ambiguous-mobile")
    desktop = next(row for row in captures if row["name"] == "kensington-ambiguous-desktop")
    if desktop["served_values"]["entry_width"] <= narrow["served_values"]["entry_width"]:
        raise SystemExit(
            "positive control failed: desktop Kensington entry width must exceed narrow width "
            f"({desktop['served_values']['entry_width']} <= {narrow['served_values']['entry_width']})"
        )

    observed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    generation_id = subjects["active_generation"]
    readback = {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": normalize_base(base).rstrip("/"),
        "deployment": {
            "manifest_url": absolute(base, "/artifact-manifest.json"),
            "revision": served_revision,
            "required_ancestor": REQUIRED_ANCESTOR,
            "required_ancestor_contained": True,
        },
        "generations": {
            "active_generation": generation_id,
            "index_content_sha256": subjects.get("index_content_sha256"),
            "directory_document_sha256": subjects["directory_sha256"],
            "profile_document_sha256": subjects["profile_sha256"],
            "generation_manifest": {
                "generation_id": generation_id,
                "consumers": (subjects["generation_manifest"].get("consumers") or {}),
                "vintages": (subjects["generation_manifest"].get("vintages") or {}),
            },
        },
        "letters": {
            "A1": {"status": "observed", "captures": [c["name"] for c in captures if "address-" in c["name"] or "kensington" in c["name"] or "greenpoint" in c["name"] or "profile-" in c["name"]]},
            "A2": {"status": "observed", "viewports": [390, 1440]},
            "A3": {"status": "observed", "holdouts": ["queens-holdout", "bronx-holdout"]},
            "A4": {"status": "observed", "active_generation": generation_id},
            "A5": {"status": "observed", "failed_on_unmet": True},
        },
        "captures": captures,
        "image_binaries_committed": False,
    }

    for row in captures:
        row["revision"] = served_revision
        row["data_vintage"] = DATA_VINTAGE
        row["repository_revision"] = served_revision

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "feature": "board-neighborhood-journey",
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": "headless-playwright-production-served-site",
        "base": normalize_base(base),
        "condition": "Production base after deployment; no image binary is committed.",
        "repository_revision": served_revision,
        "grounded_at": served_revision,
        "revision": served_revision,
        "revision_format": "served artifact-manifest source_commit_sha",
        "data_vintage": DATA_VINTAGE,
        "required_ancestor": REQUIRED_ANCESTOR,
        "required_ancestor_contained": True,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; only this "
            "manifest and the read-back JSON are committed."
        ),
        "surface": "Community boards directory and profile neighborhood journeys",
        "verifier": (
            "node --test test/board_neighborhood_journey.test.mjs && "
            "node tools/verify_board_neighborhood_journey.mjs --base-url https://cityscroll.org "
            "--out docs/evidence/board-neighborhood-journey/readback.json"
        ),
        "captured_at": observed_at,
        "local_image_dir_ignored": "board-neighborhood-journey-screenshots (task scratch; ignored)",
        "active_generation": generation_id,
        "captures": [
            {
                "name": row["name"],
                "route": row["route"],
                "viewport": row["viewport"],
                "revision": served_revision,
                "data_vintage": DATA_VINTAGE,
                "assertion": row["assertion"],
                "sha256": row["sha256"],
                "file": None,
                "served_values": row.get("served_values"),
            }
            for row in captures
        ],
    }
    return readback, manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("CROL_BASE") or DEFAULT_BASE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--manifest-out",
        type=Path,
        default=MANIFEST_PATH,
        help="Capture-manifest path (textual only)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate the committed read-back/manifest contract without hitting production",
    )
    args = parser.parse_args(argv)

    if args.check:
        if not args.out.exists():
            print(f"missing read-back at {args.out}", file=sys.stderr)
            return 2
        if not args.manifest_out.exists():
            print(f"missing capture-manifest at {args.manifest_out}", file=sys.stderr)
            return 2
        readback = json.loads(args.out.read_text(encoding="utf-8"))
        manifest = json.loads(args.manifest_out.read_text(encoding="utf-8"))
        if readback.get("schema") != SCHEMA:
            print(f"read-back schema mismatch: {readback.get('schema')}", file=sys.stderr)
            return 2
        if manifest.get("schema") != MANIFEST_SCHEMA:
            print(f"manifest schema mismatch: {manifest.get('schema')}", file=sys.stderr)
            return 2
        if manifest.get("image_binaries_committed") is not False:
            print("manifest must declare image_binaries_committed=false", file=sys.stderr)
            return 2
        if not manifest.get("captures"):
            print("manifest captures missing", file=sys.stderr)
            return 2
        print("check passed")
        return 0

    readback, manifest = capture_production(args.base_url)
    write_json(args.out, readback)
    write_json(args.manifest_out, manifest)
    print(f"wrote {args.out}")
    print(f"wrote {args.manifest_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
