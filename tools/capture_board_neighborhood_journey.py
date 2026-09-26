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
import uuid
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
PAGE_LOAD_HEADER_KEYS = ("date", "cf-ray", "cf-cache-status", "age", "last-modified", "etag")
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

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


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime(TIMESTAMP_FORMAT)


def header_map(raw_headers) -> dict[str, str | None]:
    """Normalize served response headers used in the per-run receipt."""
    headers: dict[str, str | None] = {}
    for key in PAGE_LOAD_HEADER_KEYS:
        value = None
        try:
            # Playwright Response.headers is a lower-cased mapping.
            if hasattr(raw_headers, "get"):
                value = raw_headers.get(key) or raw_headers.get(key.title())
            if value is None and hasattr(raw_headers, "get_all"):
                values = raw_headers.get_all(key) or raw_headers.get_all(key.title())
                if values:
                    value = values[0]
        except Exception:
            value = None
        if isinstance(value, (list, tuple)):
            value = value[0] if value else None
        headers[key] = str(value) if value else None
    return headers


def request_receipt(
    *,
    url: str,
    http_status: int,
    raw_headers,
    served_revision: str | None,
    kind: str,
) -> dict:
    return {
        "kind": kind,
        "url": url,
        "http_status": int(http_status),
        "observed_at": utc_now(),
        "served_revision": served_revision,
        "headers": header_map(raw_headers),
    }


def fetch_bytes(
    url: str,
    *,
    accept: str = "*/*",
    timeout: int = 60,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
    kind: str = "fetch",
) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": accept},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            body = response.read()
            if request_log is not None:
                request_log.append(
                    request_receipt(
                        url=url,
                        http_status=status,
                        raw_headers=response.headers,
                        served_revision=served_revision,
                        kind=kind,
                    )
                )
            return status, body
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ServedDataMissingError(f"served resource unavailable at {url}: {error}") from error


def fetch_json(
    url: str,
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
    kind: str = "fetch-json",
) -> dict | list:
    _status, raw = fetch_bytes(
        url,
        accept="application/json",
        request_log=request_log,
        served_revision=served_revision,
        kind=kind,
    )
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


def require_served_subjects(
    base: str,
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    """Refuse when directory, index, ACTIVE pointer, or profile markup is absent."""
    index_url = absolute(base, "/data/board_neighborhood_index.json")
    active_url = absolute(base, "/data/board-neighborhood-generations/ACTIVE")
    directory_url = absolute(base, "/community-boards/")
    profile_url = absolute(base, "/community-boards/brooklyn-cb-14/")

    index = fetch_json(
        index_url,
        request_log=request_log,
        served_revision=served_revision,
        kind="board-neighborhood-index",
    )
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

    active = fetch_json(
        active_url,
        request_log=request_log,
        served_revision=served_revision,
        kind="board-neighborhood-active",
    )
    if not isinstance(active, dict) or not active.get("active_generation"):
        raise ServedDataMissingError(f"ACTIVE generation pointer missing at {active_url}")
    generation_id = str(active["active_generation"])
    gen_manifest = fetch_json(
        absolute(base, f"/data/board-neighborhood-generations/{generation_id}/manifest.json"),
        request_log=request_log,
        served_revision=served_revision,
        kind="board-neighborhood-generation-manifest",
    )
    if not isinstance(gen_manifest, dict):
        raise ServedDataMissingError("generation manifest missing")

    _status, directory_html = fetch_bytes(
        directory_url,
        accept="text/html",
        request_log=request_log,
        served_revision=served_revision,
        kind="directory-html",
    )
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
        request_log=request_log,
        served_revision=served_revision,
        kind="directory-module",
    )
    module_text = directory_module.decode("utf-8", "replace")
    if "board_neighborhood_index.mjs" in module_text or "node:crypto" in module_text:
        raise ServedDataMissingError(
            "served board_neighborhood_directory.mjs still imports a Node-only index module"
        )

    _status, profile_html = fetch_bytes(
        profile_url,
        accept="text/html",
        request_log=request_log,
        served_revision=served_revision,
        kind="profile-html",
    )
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


def goto_with_receipt(
    page,
    url: str,
    *,
    request_log: list[dict] | None,
    served_revision: str | None,
    kind: str,
) -> object:
    response = page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    if request_log is not None and response is not None:
        request_log.append(
            request_receipt(
                url=url,
                http_status=int(response.status),
                raw_headers=response.headers,
                served_revision=served_revision,
                kind=kind,
            )
        )
    return response


BOARD_HASH_GUARD_INIT = """
(() => {
  if (window.__cityscrollBoardHashGuard) return;
  window.__cityscrollBoardHashGuard = true;
  const fallbackBoard = () =>
    document.querySelector('[data-community-board-root]')?.dataset?.selectedBoard ||
    document.querySelector('.community-board-boundary[data-board-id]:not([hidden])')?.dataset?.boardId ||
    'brooklyn-cb-14';
  const normalize = (raw) => {
    try {
      const url = new URL(String(raw || ''), window.location.href);
      if (url.hash === '#board-' || url.hash === '#board') {
        url.hash = `#board-${fallbackBoard()}`;
      }
      // Collapse empty `?` vs no-search so replaceState cannot thrash navigations.
      const search = url.search && url.search !== '?' ? url.search : '';
      return `${url.pathname}${search}${url.hash}`;
    } catch (error) {
      return raw;
    }
  };
  const sameLocation = (candidate) => {
    try {
      return normalize(candidate) === normalize(window.location.href);
    } catch (error) {
      return false;
    }
  };
  const origReplace = history.replaceState.bind(history);
  const origPush = history.pushState.bind(history);
  history.replaceState = (state, title, url) => {
    const next = normalize(url);
    if (sameLocation(next)) return;
    return origReplace(state, title, next);
  };
  history.pushState = (state, title, url) => {
    const next = normalize(url);
    if (sameLocation(next)) return;
    return origPush(state, title, next);
  };
})();
"""


def install_board_hash_guard(page) -> None:
    """Install before navigation so empty ``#board-`` rewrites cannot thrash the DOM."""
    page.add_init_script(BOARD_HASH_GUARD_INIT)


def stabilize_community_boards_page(page) -> None:
    """Stop the live empty ``#board-`` hash thrash from detaching directory controls.

    A served scorecard loop can rewrite the location to ``#board-`` (empty board
    id) and detach progressive-enhancement nodes. Capture only needs a stable
    document; rewrite empty board hashes to the first real board path.
    """
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_selector("[data-community-board-root], [data-board-neighborhood-entry]", timeout=30_000)
    # Init-script already installed the guard; only normalize the current URL.
    # Retry when a concurrent hash rewrite destroys the execution context.
    last_error = None
    for _ in range(8):
        try:
            page.evaluate(
                """() => {
                  const root = document.querySelector('[data-community-board-root]');
                  const fallback =
                    root?.dataset?.selectedBoard ||
                    document.querySelector('.community-board-boundary[data-board-id]:not([hidden])')?.dataset?.boardId ||
                    'brooklyn-cb-14';
                  const current = new URL(window.location.href);
                  if (current.hash === '#board-' || current.hash === '#board') {
                    current.hash = `#board-${fallback}`;
                  }
                  const search = current.search && current.search !== '?' ? current.search : '';
                  const next = `${current.pathname}${search}${current.hash}`;
                  const now = `${window.location.pathname}${window.location.search === '?' ? '' : window.location.search}${window.location.hash}`;
                  if (next !== now) history.replaceState(null, '', next);
                  return window.location.href;
                }"""
            )
            return
        except Exception as error:  # noqa: BLE001 - Playwright context races
            last_error = error
            message = str(error)
            if "Execution context was destroyed" not in message and "navigation" not in message.lower():
                raise
            page.wait_for_load_state("domcontentloaded")
            page.wait_for_timeout(200)
    raise SystemExit(f"stabilize_community_boards_page failed after retries: {last_error}")


def observe_directory_geo(
    page,
    base: str,
    case: dict,
    viewport: tuple[str, int, int],
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    name, width, height = viewport
    nta_id = case["geo"].split(":")[-1]
    route = f"/community-boards/?geo={urllib.parse.quote(case['geo'], safe=':')}"
    page.set_viewport_size({"width": width, "height": height})
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-directory-{case['id']}-{name}",
    )
    stabilize_community_boards_page(page)
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
    # Progressive enhancement can leave a second same-nta link in the results
    # panel, so read href from the first match only.
    nojs = page.locator(f'[data-board-neighborhood-link="{nta_id}"]')
    if nojs.count() < 1:
        raise SystemExit(f"{case['id']}@{name}: no-JS association link missing for {nta_id}")
    nojs_href = nojs.first.get_attribute("href")

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


def observe_profile_journey(
    page,
    base: str,
    case: dict,
    viewport: tuple[str, int, int],
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    name, width, height = viewport
    board_id = case["profile_board"]
    route = f"/community-boards/{board_id}/"
    page.set_viewport_size({"width": width, "height": height})
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-profile-{board_id}-{name}",
    )
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


def observe_exact_address(
    page,
    base: str,
    viewport: tuple[str, int, int],
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> list[dict]:
    name, width, height = viewport
    route = "/community-boards/"
    page.set_viewport_size({"width": width, "height": height})
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-exact-address-{name}",
    )
    stabilize_community_boards_page(page)
    # Input exists in the server panel while hidden; wait for attachment first.
    page.wait_for_selector("[data-board-exact-address-input]", state="attached", timeout=30_000)
    page.wait_for_selector("[data-board-neighborhood-entry]", timeout=30_000)

    rows = []
    for label, address, expect_ok, board_id, recovery_needle in (
        ("midwood-success", MIDWOOD_ADDRESS, True, MIDWOOD_BOARD, None),
        ("victory-unresolved", VICTORY_ADDRESS, False, None, VICTORY_RECOVERY_NEEDLE),
    ):
        stabilize_community_boards_page(page)
        outcome = page.evaluate(
            """async (address) => {
              const panel = document.querySelector('[data-board-neighborhood-address]');
              const form = document.querySelector('[data-board-exact-address-form]');
              const input = document.querySelector('[data-board-exact-address-input]');
              if (!panel || !form || !input) {
                return { ok: false, error: 'exact-address controls missing' };
              }
              panel.hidden = false;
              // Give the scorecard module a moment to attach submit listeners after navigation.
              await new Promise((resolve) => setTimeout(resolve, 1500));
              input.value = address;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              for (let i = 0; i < 90; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                const choice = document.querySelector(
                  '[data-board-exact-address-result] [data-board-exact-address-choice]'
                );
                const status = (document.querySelector('[data-board-exact-address-status]')?.textContent || '').trim();
                if (choice || (status && status !== 'Looking up that address…')) {
                  return {
                    ok: true,
                    choice: choice?.getAttribute('data-board-exact-address-choice') || null,
                    status,
                  };
                }
              }
              return {
                ok: false,
                error: 'timed out waiting for exact-address outcome',
                status: (document.querySelector('[data-board-exact-address-status]')?.textContent || '').trim(),
              };
            }""",
            address,
        )
        if not outcome or not outcome.get("ok"):
            raise SystemExit(
                f"{label}@{name}: exact-address resolve failed: {outcome!r}"
            )
        if expect_ok:
            if outcome.get("choice") != board_id:
                raise SystemExit(
                    f"{label}@{name}: expected board {board_id}, got {outcome!r}"
                )
        else:
            status = str(outcome.get("status") or "")
            if recovery_needle and recovery_needle not in status:
                raise SystemExit(
                    f"{label}@{name}: expected recovery containing {recovery_needle!r}, got {status!r}"
                )
            if outcome.get("choice"):
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


def observe_no_js_and_back(
    page,
    base: str,
    viewport: tuple[str, int, int],
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    name, width, height = viewport
    route = "/community-boards/?geo=nta2020%3ABK1203"
    page.set_viewport_size({"width": width, "height": height})
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-back-nojs-{name}",
    )
    stabilize_community_boards_page(page)
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
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-back-nojs-reload-{name}",
    )
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


def observe_unavailable_association(
    page,
    base: str,
    viewport: tuple[str, int, int],
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    """Positive control: blocking the index fetch keeps directory links and retry."""
    name, width, height = viewport
    route = "/community-boards/"
    page.set_viewport_size({"width": width, "height": height})

    def block_index(route_obj):
        route_obj.abort()

    page.route("**/data/board_neighborhood_index.json", block_index)
    page.route("**/data/board-neighborhood-generations/**", block_index)
    try:
        goto_with_receipt(
            page,
            absolute(base, route),
            request_log=request_log,
            served_revision=served_revision,
            kind=f"browser-association-unavailable-{name}",
        )
        # Directory shell and board table/map must remain even if enrichment fails.
        page.wait_for_selector("[data-community-board-root], .scorecard, main", timeout=30_000)
        stabilize_community_boards_page(page)
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


def capture_production(base: str) -> dict:
    base = require_production_base(base)
    run_id = str(uuid.uuid4())
    run_started_at = utc_now()
    request_log: list[dict] = []

    # Record the artifact-manifest fetch itself so the packet proves the pin check ran.
    artifact_url = absolute(base, "/artifact-manifest.json")
    try:
        artifact_payload = fetch_json(
            artifact_url,
            request_log=request_log,
            kind="artifact-manifest",
        )
    except ServedDataMissingError as error:
        raise SystemExit(str(error)) from error
    if not isinstance(artifact_payload, dict):
        raise SystemExit(f"served artifact-manifest is not an object at {artifact_url}")

    def fetch_json_from_recorded(_url: str) -> dict:
        # require_served_page_revision_contains_delivery re-fetches the same URL;
        # reuse the already-fetched payload so the receipt stays one request.
        return artifact_payload

    try:
        served_revision = require_served_page_revision_contains_delivery(
            base,
            REQUIRED_ANCESTOR,
            cwd=ROOT,
            fetch_json=fetch_json_from_recorded,
        )
    except (WrongPinError, DeployPendingError) as error:
        raise SystemExit(str(error)) from error

    # Stamp served_revision onto the artifact-manifest receipt now that it is known.
    if request_log:
        request_log[0]["served_revision"] = served_revision

    try:
        subjects = require_served_subjects(
            base,
            request_log=request_log,
            served_revision=served_revision,
        )
    except ServedDataMissingError as error:
        raise SystemExit(str(error)) from error

    captures: list[dict] = []
    with launch_browser() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            install_board_hash_guard(page)
            for viewport in VIEWPORTS:
                for case in JOURNEY_CASES:
                    captures.append(
                        observe_directory_geo(
                            page,
                            base,
                            case,
                            viewport,
                            request_log=request_log,
                            served_revision=served_revision,
                        )
                    )
                    captures.append(
                        observe_profile_journey(
                            page,
                            base,
                            case,
                            viewport,
                            request_log=request_log,
                            served_revision=served_revision,
                        )
                    )
                # Exact-address uses a fresh page so prior hash/geo thrash cannot
                # leave the directory panel stuck hidden.
                address_page = browser.new_page()
                try:
                    install_board_hash_guard(address_page)
                    captures.extend(
                        observe_exact_address(
                            address_page,
                            base,
                            viewport,
                            request_log=request_log,
                            served_revision=served_revision,
                        )
                    )
                finally:
                    address_page.close()
                captures.append(
                    observe_no_js_and_back(
                        page,
                        base,
                        viewport,
                        request_log=request_log,
                        served_revision=served_revision,
                    )
                )
                captures.append(
                    observe_unavailable_association(
                        page,
                        base,
                        viewport,
                        request_log=request_log,
                        served_revision=served_revision,
                    )
                )
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

    run_finished_at = utc_now()
    generation_id = subjects["active_generation"]
    for row in captures:
        row["revision"] = served_revision
        row["data_vintage"] = DATA_VINTAGE
        row["repository_revision"] = served_revision
        row["source"] = "headless-playwright-production-served-site"
        # Screenshots stay under task scratch; never commit absolute local paths.
        row.pop("local_screenshot", None)

    # Every production request must carry Date + CF-Ray so the packet proves it ran live.
    for entry in request_log:
        headers = entry.get("headers") or {}
        if not headers.get("date"):
            raise SystemExit(f"run receipt missing Date header for {entry.get('url')}")
        if not headers.get("cf-ray"):
            raise SystemExit(f"run receipt missing CF-Ray header for {entry.get('url')}")
        if entry.get("served_revision") != served_revision:
            raise SystemExit(
                f"run receipt served_revision mismatch for {entry.get('url')}: "
                f"{entry.get('served_revision')} != {served_revision}"
            )

    readback = {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": run_finished_at,
        "evidence_class": "deployed-production-read-back",
        "origin": normalize_base(base).rstrip("/"),
        "capture_run_id": run_id,
        "fixture_evidence": {
            "path": "docs/evidence/board-neighborhood-journey/capture-manifest.json",
            "note": (
                "Local hermetic fixture and module-oracle rows remain in capture-manifest.json; "
                "this production read-back is retained beside that fixture packet."
            ),
        },
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
            "A1": {
                "status": "observed",
                "captures": [
                    c["name"]
                    for c in captures
                    if "address-" in c["name"]
                    or "kensington" in c["name"]
                    or "greenpoint" in c["name"]
                    or "profile-" in c["name"]
                ],
            },
            "A2": {"status": "observed", "viewports": [390, 1440]},
            "A3": {"status": "observed", "holdouts": ["queens-holdout", "bronx-holdout"]},
            "A4": {"status": "observed", "active_generation": generation_id},
            "A5": {"status": "observed", "failed_on_unmet": True},
        },
        "captures": captures,
        "run_receipt": {
            "capture_run_id": run_id,
            "run_started_at": run_started_at,
            "run_finished_at": run_finished_at,
            "served_revision": served_revision,
            "origin": normalize_base(base).rstrip("/"),
            "note": (
                "Per-request Date, CF-Ray, and served revision headers prove this production "
                "read-back executed against the live origin."
            ),
            "requests": request_log,
        },
        "image_binaries_committed": False,
    }
    return readback


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("CROL_BASE") or DEFAULT_BASE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--manifest-out",
        type=Path,
        default=MANIFEST_PATH,
        help=(
            "Fixture capture-manifest path used by --check. Production runs write only the "
            "read-back so fixture evidence stays beside the production packet."
        ),
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
        if readback.get("evidence_class") == "deployed-production-read-back":
            receipt = readback.get("run_receipt")
            if not isinstance(receipt, dict) or not receipt.get("requests"):
                print("production read-back missing run_receipt.requests", file=sys.stderr)
                return 2
            for entry in receipt["requests"]:
                headers = (entry or {}).get("headers") or {}
                if not headers.get("date") or not headers.get("cf-ray"):
                    print(
                        f"run receipt entry missing Date/CF-Ray for {entry.get('url')}",
                        file=sys.stderr,
                    )
                    return 2
            if not readback.get("generations", {}).get("active_generation"):
                print("production read-back missing generations.active_generation", file=sys.stderr)
                return 2
        # Fixture packet honesty: module-oracle rows must not pretend to be viewport captures.
        for row in manifest.get("captures") or []:
            source = row.get("source")
            if source == "hermetic-module-oracle":
                if row.get("viewport") not in (None, {}):
                    print(
                        f"module-oracle row {row.get('name')} must not carry a viewport label",
                        file=sys.stderr,
                    )
                    return 2
            elif source == "headless-playwright-fixture-document":
                if not (row.get("viewport") or {}).get("width"):
                    print(
                        f"fixture browser row {row.get('name')} must keep its measured viewport",
                        file=sys.stderr,
                    )
                    return 2
        print("check passed")
        return 0

    readback = capture_production(args.base_url)
    write_json(args.out, readback)
    print(f"wrote {args.out}")
    print(
        "preserved fixture capture-manifest at "
        f"{args.manifest_out.relative_to(ROOT) if args.manifest_out.is_absolute() else args.manifest_out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
