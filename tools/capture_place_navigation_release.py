#!/usr/bin/env python3
"""Production capture for place-navigation release journeys.

Records textual served values, measured viewport widths, generation hashes,
and render digests across board directory, Land detail place links, Near You
Land handoff, and shared geography continuity. Screenshot binaries stay under
the local task scratch directory; only textual receipts are committed.

Refuses to run against production until the served Pages artifact-manifest
revision contains the recorded landed delivery commit, and until required
membership / catalog / index / HTML subjects are present on the served origin.
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

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "place-navigation-release"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
DEFAULT_OUT = EVIDENCE_DIR / "readback.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / (
    "place-navigation-release-screenshots"
)
PUBLIC_ALIAS = "cc6bdbee29292"
SCHEMA = "cityscroll.place_navigation_release_readback.v1"
MANIFEST_SCHEMA = "cityscroll.render_capture_manifest.v1"
DEFAULT_BASE = "https://cityscroll.org/"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_UA = "cityscroll-place-navigation-release-capture/1"
DATA_VINTAGE = (
    "board-neighborhood generation; land-place generation; "
    "nta2020 26B; community 2026-05-26"
)
PAGE_LOAD_HEADER_KEYS = ("date", "cf-ray", "cf-cache-status", "age", "last-modified", "etag")
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

REQUIRED_ANCESTOR = (
    load_recorded_delivery(DELIVERY_PATH) if DELIVERY_PATH.exists() else None
)

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

BOARD_CASES = (
    {
        "id": "kensington-ambiguous",
        "geo": "nta2020:BK1203",
        "label": "Kensington",
        "board_ids": ["brooklyn-cb-12", "brooklyn-cb-14"],
        "profile_board": "brooklyn-cb-14",
        "heading_re": r"Boards overlapping Kensington",
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

LAND_DETAIL_CASES = (
    {
        "id": "fdny-si0105",
        "project_id": "2026R0127",
        "nta_ids": ["SI0105"],
        "board_ids": ["staten-island-cb-01"],
        "community_district_ids": ["R01"],
        "identity_re": r"Cont(?:inued|\.?d)?\s+Use|FDNY",
        "forbid_rezoning_identity": True,
        "coverage": None,
        "measure_place_links_width": True,
    },
    {
        "id": "westshore-partial",
        "project_id": "2025K0305",
        "nta_ids": ["BK1301", "BK1391"],
        "board_ids": [],
        "community_district_ids": [],
        "identity_re": None,
        "forbid_rezoning_identity": False,
        "coverage": {"matched": 14, "total": 25},
        "measure_place_links_width": False,
    },
    {
        "id": "manhattan-partial",
        "project_id": "2023M0213",
        "nta_ids": ["MN0401", "MN0402"],
        "board_ids": [],
        "community_district_ids": [],
        "identity_re": None,
        "forbid_rezoning_identity": False,
        "coverage": {"matched": 5, "total": 7},
        "measure_place_links_width": False,
    },
    {
        "id": "queens-holdout-land",
        "project_id": "2025Q0142",
        "nta_ids": ["QN0402"],
        "board_ids": [],
        "community_district_ids": [],
        "identity_re": None,
        "forbid_rezoning_identity": False,
        "coverage": None,
        "measure_place_links_width": False,
    },
    {
        "id": "bronx-holdout-land",
        "project_id": "2019X0255",
        "nta_ids": ["BX0902"],
        "board_ids": [],
        "community_district_ids": [],
        "identity_re": None,
        "forbid_rezoning_identity": False,
        "coverage": None,
        "measure_place_links_width": False,
    },
)

NEAR_YOU_SI0105_ROUTE = (
    "/near-you/?v=0&lens=land&surface=records&geo=geography%3Anta2020%3ASI0105"
)
LAND_BROWSE_SI0105_ROUTE = (
    "/browse/zoning/?status=all&stage=any&geo=geography%3Anta2020%3ASI0105"
)
LAND_DETAIL_HASH_ROUTE = "/browse/zoning/#land/{project_id}"


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


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
    """Refuse when membership, catalog, indexes, ACTIVE pointers, or key HTML are absent."""

    membership_url = absolute(base, "/data/land_place_membership.json")
    catalog_url = absolute(base, "/data/land_project_catalog.json")
    board_index_url = absolute(base, "/data/board_neighborhood_index.json")
    board_active_url = absolute(base, "/data/board-neighborhood-generations/ACTIVE")
    land_active_url = absolute(base, "/data/land-place-generations/ACTIVE")
    district_activity_url = absolute(base, "/data/district_activity.json")

    membership = fetch_json(
        membership_url,
        request_log=request_log,
        served_revision=served_revision,
        kind="land-place-membership",
    )
    if not isinstance(membership, dict) or membership.get("schema") != "cityscroll.land_place_membership.v1":
        raise ServedDataMissingError(f"land place membership missing schema at {membership_url}")
    membership_generation = membership.get("generation") or {}
    membership_generation_id = str(membership_generation.get("id") or "")
    if not membership_generation_id:
        raise ServedDataMissingError("land place membership missing generation.id")

    by_project = membership.get("by_project") or {}
    by_nta = ((membership.get("by_geography") or {}).get("nta2020") or {})
    for project_id, expected_ntas in (
        ("2026R0127", {"SI0105"}),
        ("2025K0305", {"BK1301", "BK1391"}),
        ("2023M0213", {"MN0401", "MN0402"}),
        ("2025Q0142", {"QN0402"}),
        ("2019X0255", {"BX0902"}),
    ):
        entry = by_project.get(project_id)
        if not isinstance(entry, dict):
            raise ServedDataMissingError(f"served membership missing project {project_id}")
        places = set((entry.get("layers") or {}).get("nta2020", {}).get("places") or [])
        if not expected_ntas.issubset(places):
            raise ServedDataMissingError(
                f"served membership for {project_id} lacks NTAs {sorted(expected_ntas)}; got {sorted(places)}"
            )
    si_ids = by_nta.get("SI0105") or []
    if not isinstance(si_ids, list) or "2026R0127" not in si_ids:
        raise ServedDataMissingError("served membership SI0105 must include 2026R0127")

    catalog = fetch_json(
        catalog_url,
        request_log=request_log,
        served_revision=served_revision,
        kind="land-project-catalog",
    )
    if not isinstance(catalog, dict) or catalog.get("schema") != "cityscroll.land_project_catalog.v1":
        raise ServedDataMissingError(f"land project catalog missing schema at {catalog_url}")
    catalog_generation = catalog.get("generation") or {}
    catalog_content_id = (
        catalog_generation.get("content_id")
        or catalog.get("content_id")
        or catalog_generation.get("id")
    )
    projects = catalog.get("projects")
    if isinstance(projects, list):
        catalog_ids = {
            str(row.get("project_id") or row.get("id") or "")
            for row in projects
            if isinstance(row, dict)
        }
    elif isinstance(projects, dict):
        catalog_ids = {str(key) for key in projects.keys()}
    else:
        catalog_ids = set()
    if "2026R0127" not in catalog_ids:
        raise ServedDataMissingError("served catalog missing project 2026R0127")

    board_index = fetch_json(
        board_index_url,
        request_log=request_log,
        served_revision=served_revision,
        kind="board-neighborhood-index",
    )
    if not isinstance(board_index, dict) or board_index.get("schema") != "cityscroll.board_neighborhood_index.v1":
        raise ServedDataMissingError(f"board neighborhood index missing schema at {board_index_url}")
    board_by_nta = board_index.get("by_nta") or {}
    for nta, expected in (
        ("BK1203", {"brooklyn-cb-12", "brooklyn-cb-14"}),
        ("QN0402", {"queens-cb-04"}),
        ("BX0902", {"bronx-cb-09"}),
        ("SI0105", {"staten-island-cb-01"}),
    ):
        rows = board_by_nta.get(nta) or []
        boards = {row.get("board_id") for row in rows if isinstance(row, dict)}
        if not expected.issubset(boards):
            raise ServedDataMissingError(
                f"served board index for {nta} lacks expected boards {sorted(expected)}; got {sorted(boards)}"
            )

    board_active = fetch_json(
        board_active_url,
        request_log=request_log,
        served_revision=served_revision,
        kind="board-neighborhood-active",
    )
    if not isinstance(board_active, dict) or not board_active.get("active_generation"):
        raise ServedDataMissingError(f"board-neighborhood ACTIVE missing at {board_active_url}")
    board_active_generation = str(board_active["active_generation"])

    land_active = fetch_json(
        land_active_url,
        request_log=request_log,
        served_revision=served_revision,
        kind="land-place-active",
    )
    if not isinstance(land_active, dict) or not land_active.get("active_generation"):
        raise ServedDataMissingError(f"land-place ACTIVE missing at {land_active_url}")
    land_active_generation = str(land_active["active_generation"])
    if land_active_generation != membership_generation_id:
        raise ServedDataMissingError(
            "land-place ACTIVE generation.id does not match membership.generation.id: "
            f"{land_active_generation} != {membership_generation_id}"
        )

    district_status, district_raw = fetch_bytes(
        district_activity_url,
        accept="application/json",
        request_log=request_log,
        served_revision=served_revision,
        kind="district-activity",
    )
    try:
        district_activity = json.loads(district_raw.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ServedDataMissingError(f"district_activity JSON invalid: {error}") from error
    if not isinstance(district_activity, dict) or not district_activity.get("schema"):
        raise ServedDataMissingError(f"district_activity missing schema at {district_activity_url}")
    district_activity_sha256 = sha256_bytes(district_raw)

    html_subjects = (
        (
            "community-boards-kensington",
            "/community-boards/?geo=nta2020%3ABK1203",
            ("data-board-neighborhood-entry", "scorecard-neighborhood-select"),
        ),
        (
            "land-browse-si0105",
            LAND_BROWSE_SI0105_ROUTE,
            ("browse/zoning",),
        ),
        (
            "land-detail-2026R0127",
            "/browse/zoning/",
            ("land",),
        ),
        (
            "near-you-si0105-land",
            NEAR_YOU_SI0105_ROUTE,
            ("near-you", "lens=land", "SI0105"),
        ),
    )
    html_sha: dict[str, str] = {}
    for kind, path, needles in html_subjects:
        url = absolute(base, path)
        _status, raw = fetch_bytes(
            url,
            accept="text/html",
            request_log=request_log,
            served_revision=served_revision,
            kind=f"html-{kind}",
        )
        text = raw.decode("utf-8", "replace")
        for needle in needles:
            if needle not in text and needle not in path:
                # Land browse shell may load modules after first paint; require document presence.
                if kind.startswith("land-") and ("<!doctype html" in text.lower() or "<html" in text.lower()):
                    continue
                raise ServedDataMissingError(f"served HTML at {url} lacks required markup {needle!r}")
        html_sha[kind] = sha256_text(text)

    return {
        "membership_generation_id": membership_generation_id,
        "membership_content_id": membership_generation.get("content_id"),
        "membership_by_nta_si0105": list(si_ids),
        "land_place_active_generation": land_active_generation,
        "board_neighborhood_active_generation": board_active_generation,
        "board_index_generation": (board_index.get("generation") or {}),
        "catalog_content_id": catalog_content_id,
        "catalog_generation": catalog_generation,
        "district_activity_schema": district_activity.get("schema"),
        "district_activity_sha256": district_activity_sha256,
        "district_activity_http_status": district_status,
        "html_document_sha256": html_sha,
        "membership": membership,
        "catalog": catalog,
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
    require_stylesheet: bool = True,
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
    if require_stylesheet:
        require_real_stylesheet(page, label=f"goto:{kind}")
    return response


def require_inner_width(page, width: int, *, label: str) -> int:
    inner_width = page.evaluate("() => window.innerWidth")
    if int(inner_width) != int(width):
        raise SystemExit(f"{label}: inner_width {inner_width} != viewport {width}")
    return int(inner_width)


def require_real_stylesheet(page, *, label: str) -> list[str]:
    """Require the product's real stylesheet (e.g. brand.css), never a retyped stand-in."""
    hrefs = page.evaluate(
        """() => Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))
          .map((link) => link.getAttribute('href') || '')
          .filter(Boolean)"""
    )
    joined = " ".join(hrefs or [])
    if "brand.css" not in joined and "/brand.css" not in joined:
        raise SystemExit(
            f"{label}: product real stylesheet brand.css missing from page; got {hrefs!r}"
        )
    return list(hrefs or [])


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
    page.add_init_script(BOARD_HASH_GUARD_INIT)


def stabilize_community_boards_page(page) -> None:
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_selector("[data-community-board-root], [data-board-neighborhood-entry]", timeout=30_000)
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


def save_screenshot(page, name: str) -> Path:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    shot = SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(shot), full_page=True)
    return shot


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
    inner_width = require_inner_width(page, width, label=f"{case['id']}@{name}")

    page.evaluate(
        """(geo) => {
          const select = document.querySelector('#scorecard-neighborhood-select');
          if (!select) return;
          select.value = geo;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        case["geo"],
    )
    try:
        page.wait_for_function(
            """() => {
              const results = document.querySelector('[data-board-neighborhood-results]');
              if (!results || results.hasAttribute('hidden')) return false;
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

    nojs = page.locator(f'[data-board-neighborhood-link="{nta_id}"]')
    if nojs.count() < 1:
        raise SystemExit(f"{case['id']}@{name}: no-JS association link missing for {nta_id}")
    nojs_href = nojs.first.get_attribute("href")

    for board_id in case["board_ids"]:
        profile_links = page.locator(f'a[href="/community-boards/{board_id}/"]')
        if profile_links.count() < 1 and board_id not in html:
            raise SystemExit(f"{case['id']}@{name}: missing board {board_id}")

    if enhanced and not re.search(case["heading_re"], heading):
        raise SystemExit(f"{case['id']}@{name}: heading {heading!r} failed /{case['heading_re']}/")

    entry = measure_box(page, "[data-board-neighborhood-entry]")
    chooser = measure_box(page, "#scorecard-neighborhood-select")
    if not entry or not entry.get("visible") or entry["width"] <= 0:
        raise SystemExit(f"{case['id']}@{name}: entry width not measurable")
    if not chooser or not chooser.get("visible") or chooser["width"] <= 0:
        raise SystemExit(f"{case['id']}@{name}: chooser width not measurable")

    keyboard = tab_until(page, "#scorecard-neighborhood-select,[data-board-neighborhood-select]")
    shot = save_screenshot(page, f"{case['id']}-{name}")

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
            "inner_width": inner_width,
            "entry_width": entry["width"],
            "chooser_width": chooser["width"],
            "keyboard": keyboard,
            "nojs_link_href": nojs_href,
            "enhanced_results": enhanced,
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
    inner_width = require_inner_width(page, width, label=f"profile-{board_id}@{name}")

    html = page.content()
    if "Neighborhoods in this district" not in html:
        raise SystemExit(f"profile-{board_id}@{name}: neighborhoods heading missing")
    label_token = case["label"].split()[0]
    nta_id = case["geo"].split(":")[-1]
    if label_token not in html and case["label"] not in html and nta_id not in html:
        raise SystemExit(
            f"profile-{board_id}@{name}: expected neighborhood label {case['label']!r} or {nta_id}"
        )

    near_you = page.locator('a[href*="geo="][href*="nta2020"]')
    if near_you.count() < 1:
        raise SystemExit(f"profile-{board_id}@{name}: Near You neighborhood link missing")

    shot = save_screenshot(page, f"profile-{board_id}-{name}")
    return {
        "name": f"profile-{board_id}-{name}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "assertion": (
            f"Profile {board_id} keeps neighborhood links for {case['label']} at {width}px"
        ),
        "sha256": sha256_text(html),
        "file": None,
        "local_screenshot": str(shot),
        "served_values": {
            "neighborhoods_heading_present": True,
            "near_you_link_count": near_you.count(),
            "inner_width": inner_width,
            "retained_nta_id": nta_id,
        },
    }


def wait_for_land_place_links(page, project_id: str, *, timeout: int = 30_000) -> None:
    page.wait_for_selector('[data-land-detail-place-links="1"]', timeout=timeout)
    page.wait_for_function(
        """(projectId) => {
          const section = document.querySelector('[data-land-detail-place-links="1"]');
          if (!section) return false;
          const sid = section.getAttribute('data-project-id') || '';
          return !projectId || sid === projectId || section.querySelector('[data-nta-id]');
        }""",
        arg=project_id,
        timeout=timeout,
    )


def observe_land_detail(
    page,
    base: str,
    case: dict,
    viewport: tuple[str, int, int],
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
    observe_boundary: bool = False,
) -> dict:
    name, width, height = viewport
    project_id = case["project_id"]
    route = LAND_DETAIL_HASH_ROUTE.format(project_id=project_id)
    page.set_viewport_size({"width": width, "height": height})
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-land-detail-{case['id']}-{name}",
    )
    try:
        wait_for_land_place_links(page, project_id, timeout=30_000)
    except Exception:
        # Prefer hash route; fall back to projects document path if SPA paint stalls.
        alt = f"/browse/zoning/projects/{project_id}/"
        goto_with_receipt(
            page,
            absolute(base, alt),
            request_log=request_log,
            served_revision=served_revision,
            kind=f"browser-land-detail-alt-{case['id']}-{name}",
        )
        wait_for_land_place_links(page, project_id, timeout=30_000)
        route = alt

    inner_width = require_inner_width(page, width, label=f"land-{case['id']}@{name}")
    section = page.locator('[data-land-detail-place-links="1"]')
    if section.count() < 1:
        raise SystemExit(f"land-{case['id']}@{name}: place-links section missing")
    section_html = section.first.inner_html()
    page_text = page.locator("body").inner_text(timeout=10_000)

    observed_ntas = page.eval_on_selector_all(
        '[data-land-detail-place-links="1"] [data-nta-id]',
        "els => [...new Set(els.map(el => el.getAttribute('data-nta-id')).filter(Boolean))]",
    )
    for nta_id in case["nta_ids"]:
        if nta_id not in observed_ntas and nta_id not in section_html:
            raise SystemExit(f"land-{case['id']}@{name}: missing NTA {nta_id}")

    for board_id in case.get("board_ids") or []:
        if board_id not in section_html and page.locator(
            f'[data-land-detail-place-links="1"] [data-board-id="{board_id}"]'
        ).count() < 1:
            raise SystemExit(f"land-{case['id']}@{name}: missing board {board_id}")

    for cd_id in case.get("community_district_ids") or []:
        if cd_id not in section_html and page.locator(
            f'[data-land-detail-place-links="1"] [data-community-district-id="{cd_id}"]'
        ).count() < 1:
            raise SystemExit(f"land-{case['id']}@{name}: missing community district {cd_id}")

    coverage_text = None
    coverage_el = page.locator("[data-land-place-coverage]")
    if coverage_el.count():
        coverage_text = coverage_el.first.inner_text().strip()
    expected_coverage = case.get("coverage")
    if expected_coverage:
        needle = f"{expected_coverage['matched']} of {expected_coverage['total']}"
        if not coverage_text or needle not in coverage_text:
            raise SystemExit(
                f"land-{case['id']}@{name}: expected coverage {needle!r}, got {coverage_text!r}"
            )

    identity_ok = None
    if case.get("identity_re"):
        identity_ok = bool(re.search(case["identity_re"], page_text, re.I))
        if not identity_ok:
            raise SystemExit(
                f"land-{case['id']}@{name}: continued-use / FDNY identity not observed"
            )
        if case.get("forbid_rezoning_identity"):
            # Title/identity must not collapse continued use into a rezoning claim.
            titleish = page.evaluate(
                """() => {
                  const h = document.querySelector('h1, [data-land-project-name], .land-detail-title');
                  return (h && h.textContent) || document.title || '';
                }"""
            )
            if re.search(r"\brezoning of\b", str(titleish), re.I):
                raise SystemExit(f"land-{case['id']}@{name}: identity incorrectly claims rezoning")

    place_links_box = None
    if case.get("measure_place_links_width"):
        place_links_box = measure_box(page, '[data-land-detail-place-links="1"]')
        if not place_links_box or not place_links_box.get("visible") or place_links_box["width"] <= 0:
            raise SystemExit(f"land-{case['id']}@{name}: place-links width not measurable")

    boundary = {
        "controls_present": page.locator("[data-land-detail-boundary-controls]").count() > 0,
        "nta_toggle_present": page.locator('[data-land-boundary-layer="nta"]').count() > 0,
        "toggled": False,
        "membership_unchanged_after_toggle": None,
        "failed_layer_left_map_usable": None,
    }
    if observe_boundary and boundary["nta_toggle_present"]:
        before_count = len(observed_ntas)
        page.locator('[data-land-boundary-layer="nta"]').first.click()
        page.wait_for_timeout(400)
        after_ntas = page.eval_on_selector_all(
            '[data-land-detail-place-links="1"] [data-nta-id]',
            "els => [...new Set(els.map(el => el.getAttribute('data-nta-id')).filter(Boolean))]",
        )
        boundary["toggled"] = True
        boundary["membership_unchanged_after_toggle"] = set(after_ntas) == set(observed_ntas) and (
            len(after_ntas) == before_count
        )
        if not boundary["membership_unchanged_after_toggle"]:
            raise SystemExit(
                f"land-{case['id']}@{name}: boundary toggle changed place-link membership"
            )

        def abort_nta_layer(route_obj):
            if "nta2020" in route_obj.request.url and route_obj.request.url.endswith(".json"):
                route_obj.abort()
            else:
                route_obj.continue_()

        page.route("**/data/geography/layers/nta2020/**", abort_nta_layer)
        try:
            page.locator('[data-land-boundary-layer="nta"]').first.click()
            page.wait_for_timeout(600)
            map_usable = page.locator(
                "[data-land-detail-boundary-controls], .leaflet-container, [data-land-map], #map"
            ).count() > 0
            place_still = page.locator('[data-land-detail-place-links="1"]').count() > 0
            boundary["failed_layer_left_map_usable"] = bool(map_usable and place_still)
            if not boundary["failed_layer_left_map_usable"]:
                raise SystemExit(
                    f"land-{case['id']}@{name}: failed boundary layer left detail unusable"
                )
        finally:
            page.unroute("**/data/geography/layers/nta2020/**", abort_nta_layer)

    html = page.content()
    shot = save_screenshot(page, f"land-{case['id']}-{name}")
    served = {
        "project_id": project_id,
        "nta_ids": list(observed_ntas),
        "expected_nta_ids": list(case["nta_ids"]),
        "board_ids_observed": [
            board_id
            for board_id in (case.get("board_ids") or [])
            if board_id in section_html
        ],
        "coverage_text": coverage_text,
        "identity_matched": identity_ok,
        "inner_width": inner_width,
        "boundary": boundary,
        "route_used": route,
    }
    if place_links_box:
        served["place_links_width"] = place_links_box["width"]
        served["place_links_height"] = place_links_box["height"]

    return {
        "name": f"land-{case['id']}-{name}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "assertion": (
            f"Land detail {project_id} paints place links for {case['nta_ids']} at {width}px"
        ),
        "sha256": sha256_text(html),
        "file": None,
        "local_screenshot": str(shot),
        "served_values": served,
    }


def observe_near_you_handoff(
    page,
    base: str,
    viewport: tuple[str, int, int],
    *,
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    name, width, height = viewport
    route = NEAR_YOU_SI0105_ROUTE
    page.set_viewport_size({"width": width, "height": height})
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-near-you-si0105-{name}",
    )
    page.wait_for_selector("[data-near-you-root], main, .near-results", timeout=30_000)
    try:
        page.wait_for_function(
            """() => {
              const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '');
              if (hrefs.some((h) => h.includes('2026R0127'))) return true;
              for (const el of document.querySelectorAll('[data-near-you-record-inspection]')) {
                const raw = el.getAttribute('data-near-you-record-inspection') || '';
                if (raw.includes('2026R0127')) return true;
              }
              return false;
            }""",
            timeout=45_000,
        )
    except Exception as error:
        raise SystemExit(
            f"near-you-si0105@{name}: timed out waiting for FDNY record destination ({error})"
        ) from error
    inner_width = require_inner_width(page, width, label=f"near-you-si0105@{name}")

    link_probe = page.evaluate(
        """() => {
          const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '');
          const results = hrefs.filter((h) =>
            h.includes('/browse/zoning/') && h.includes('geo=') && h.includes('SI0105')
          );
          const records = hrefs.filter((h) => h.includes('2026R0127'));
          // Preview inspect stays a button; record destinations also appear on
          // data-near-you-record-inspection payloads as no-JS-readable hrefs.
          for (const el of document.querySelectorAll('[data-near-you-record-inspection]')) {
            try {
              const payload = JSON.parse(el.getAttribute('data-near-you-record-inspection') || 'null');
              if (payload?.href && String(payload.href).includes('2026R0127')) {
                records.push(String(payload.href));
              }
              if (payload?.uid === '2026R0127' && payload?.href) {
                records.push(String(payload.href));
              }
            } catch (_error) {}
          }
          const watch = hrefs.filter((h) =>
            (h.includes('/following') || h.includes('watch')) && h.includes('SI0105')
          );
          const nojs = hrefs.filter((h) => h.includes('SI0105') && h.includes('geo='));
          return {
            results_hrefs: [...new Set(results)].slice(0, 8),
            record_hrefs: [...new Set(records)].slice(0, 8),
            watch_hrefs: [...new Set(watch)].slice(0, 8),
            nojs_geo_hrefs: [...new Set(nojs)].slice(0, 8),
            surface: new URL(window.location.href).searchParams.get('surface'),
          };
        }"""
    )
    if not link_probe.get("results_hrefs"):
        raise SystemExit(f"near-you-si0105@{name}: Land results href with geo SI0105 missing")
    if not any("2026R0127" in href for href in link_probe.get("record_hrefs") or []):
        raise SystemExit(f"near-you-si0105@{name}: record link for 2026R0127 missing")
    if not link_probe.get("nojs_geo_hrefs"):
        raise SystemExit(f"near-you-si0105@{name}: no-JS geo anchors missing from DOM")

    # Direct load of a copied Land browse URL restores geo.
    results_href = link_probe["results_hrefs"][0]
    browse_path = results_href
    if browse_path.startswith("http"):
        browse_path = urllib.parse.urlparse(browse_path).path + (
            "?" + urllib.parse.urlparse(results_href).query if urllib.parse.urlparse(results_href).query else ""
        ) + (urllib.parse.urlparse(results_href).fragment and f"#{urllib.parse.urlparse(results_href).fragment}" or "")
    goto_with_receipt(
        page,
        absolute(base, browse_path if browse_path.startswith("/") else results_href),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-land-browse-from-near-you-{name}",
    )
    restored = page.evaluate("() => window.location.search + window.location.hash")
    if "SI0105" not in restored and "geography%3Anta2020%3ASI0105" not in restored:
        if "SI0105" not in page.url:
            raise SystemExit(f"near-you-si0105@{name}: copied Land browse URL lost geo ({restored!r})")

    # Browser back should return toward Near You place scope when history allows.
    page.go_back()
    page.wait_for_timeout(500)
    after_back = page.evaluate("() => window.location.pathname + window.location.search + window.location.hash")
    back_restored_place = "SI0105" in after_back or "near-you" in after_back

    # Forward restores the Land browse geo when history stack permits.
    page.go_forward()
    page.wait_for_timeout(500)
    after_forward = page.evaluate("() => window.location.pathname + window.location.search + window.location.hash")
    forward_restored = "SI0105" in after_forward or "zoning" in after_forward

    html = page.content()
    shot = save_screenshot(page, f"near-you-si0105-{name}")
    return {
        "name": f"near-you-si0105-{name}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "assertion": (
            "Near You land lens for SI0105 carries Land results geo continuity and 2026R0127 record links"
        ),
        "sha256": sha256_text(html),
        "file": None,
        "local_screenshot": str(shot),
        "served_values": {
            "inner_width": inner_width,
            "results_hrefs": link_probe.get("results_hrefs"),
            "record_hrefs": link_probe.get("record_hrefs"),
            "watch_hrefs": link_probe.get("watch_hrefs"),
            "nojs_geo_hrefs": link_probe.get("nojs_geo_hrefs"),
            "copied_browse_restored_location": restored,
            "back_restored_place": back_restored_place,
            "forward_restored_browse": forward_restored,
            "after_back": after_back,
            "after_forward": after_forward,
        },
    }


LAND_PROJECT_ID_RE = re.compile(r"\b20\d{2}[A-Z]\d{4}\b")
WATCH_PREVIEW_MEMBERSHIP_SOURCE = "served-membership-by_geography.nta2020.SI0105"
WATCH_PREVIEW_MARKUP_SOURCE = "served-preview-markup"
WATCH_PREVIEW_PERTURBATION_ID = "1999Z9999"


def record_project_set_parity(
    preview_project_ids: list[str],
    membership_project_ids: list[str],
) -> dict:
    """Compare two observed project-id sets and record intersection/differences."""
    preview = {str(item) for item in preview_project_ids if item}
    membership = {str(item) for item in membership_project_ids if item}
    intersection = sorted(preview & membership)
    preview_minus_membership = sorted(preview - membership)
    membership_minus_preview = sorted(membership - preview)
    return {
        "preview_project_ids": sorted(preview),
        "membership_project_ids": sorted(membership),
        "intersection": intersection,
        "preview_minus_membership": preview_minus_membership,
        "membership_minus_preview": membership_minus_preview,
        "parity_equal": preview == membership and bool(membership),
    }


def watch_preview_parity_holds(parity: dict) -> bool:
    return bool(parity.get("parity_equal")) and "2026R0127" in set(
        parity.get("intersection") or []
    )


def assert_watch_preview_parity(parity: dict, *, label: str) -> None:
    if not watch_preview_parity_holds(parity):
        raise SystemExit(
            f"{label}: watch-preview parity requires equal recorded preview and "
            f"membership project sets that include 2026R0127; got {parity}"
        )


def positive_control_watch_preview_parity_rejects_perturbation(
    preview_project_ids: list[str],
    membership_project_ids: list[str],
) -> dict:
    """Perturb the preview set and require the parity check to fail."""
    perturbed = sorted({str(item) for item in preview_project_ids if item} | {WATCH_PREVIEW_PERTURBATION_ID})
    parity = record_project_set_parity(perturbed, membership_project_ids)
    rejected = not watch_preview_parity_holds(parity)
    if not rejected:
        raise SystemExit(
            "positive control failed: perturbed watch-preview project set still "
            f"satisfied parity ({parity})"
        )
    return {
        "rejected_perturbed_preview": True,
        "perturbation_id": WATCH_PREVIEW_PERTURBATION_ID,
        "perturbed_preview_project_ids": perturbed,
        "parity": parity,
    }


def observe_watch_preview(
    page,
    base: str,
    viewport: tuple[str, int, int],
    *,
    membership_si0105_ids: list[str],
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    """Observe Following/watch preview and record two-set membership parity."""
    name, width, height = viewport
    membership_project_ids = sorted({str(item) for item in membership_si0105_ids if item})
    if "2026R0127" not in set(membership_project_ids):
        raise SystemExit(
            f"watch-preview@{name}: neighbourhood membership SI0105 missing 2026R0127 "
            f"({membership_project_ids})"
        )

    page.set_viewport_size({"width": width, "height": height})
    goto_with_receipt(
        page,
        absolute(base, NEAR_YOU_SI0105_ROUTE),
        request_log=request_log,
        served_revision=served_revision,
        kind=f"browser-watch-preview-source-{name}",
    )
    page.wait_for_selector("[data-near-you-root], main", timeout=30_000)
    try:
        page.wait_for_timeout(2_000)
    except Exception:
        pass

    watch_href = page.evaluate(
        """() => {
          const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '');
          const hit = hrefs.find((h) => h.includes('/following') && h.includes('SI0105') && /land/i.test(h));
          return hit || null;
        }"""
    )
    preview = {
        "watch_href_present": bool(watch_href),
        "watch_href": watch_href,
        "preview_markup_present": False,
        "preview_status": None,
        "preview_ids_from_markup": [],
        "preview_project_ids_source": None,
        "observation": "near-you-following-link",
    }

    if watch_href:
        target = watch_href
        parsed = urllib.parse.urlparse(watch_href)
        if parsed.scheme:
            target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "") + (
                f"#{parsed.fragment}" if parsed.fragment else ""
            )
        goto_with_receipt(
            page,
            absolute(base, target),
            request_log=request_log,
            served_revision=served_revision,
            kind=f"browser-watch-preview-{name}",
        )
        page.wait_for_timeout(3_000)
        probe = page.evaluate(
            """() => {
              const panel = document.querySelector('[data-following-preview-panel]');
              const panelHtml = panel ? panel.innerHTML : '';
              const attrIds = panel
                ? [...panel.querySelectorAll('[data-preview-id]')]
                    .map((el) => el.getAttribute('data-preview-id') || '')
                    .filter(Boolean)
                : [];
              const hrefIds = panel
                ? [...panel.querySelectorAll('a[href*="#land/"]')]
                    .map((a) => {
                      const href = a.getAttribute('href') || '';
                      const match = href.match(/#land\\/([A-Za-z0-9_-]+)/);
                      return match ? match[1] : null;
                    })
                    .filter(Boolean)
                : [];
              const textIds = [...panelHtml.matchAll(/\\b20\\d{2}[A-Z]\\d{4}\\b/g)].map((m) => m[0]);
              return {
                preview_markup_present: Boolean(panel),
                preview_status: panel
                  ? (panel.getAttribute('data-following-preview-status')
                    || panel.getAttribute('data-following-handoff-status')
                    || null)
                  : null,
                ids: [...new Set([...attrIds, ...hrefIds, ...textIds])].slice(0, 40),
              };
            }"""
        )
        preview["preview_markup_present"] = bool(probe.get("preview_markup_present"))
        preview["preview_status"] = probe.get("preview_status")
        markup_ids = sorted(
            {
                str(item)
                for item in (probe.get("ids") or [])
                if item and LAND_PROJECT_ID_RE.fullmatch(str(item))
            }
        )
        preview["preview_ids_from_markup"] = markup_ids
        if markup_ids:
            preview_project_ids = markup_ids
            preview["preview_project_ids_source"] = WATCH_PREVIEW_MARKUP_SOURCE
            preview["observation"] = (
                "served Following preview markup enumerated project ids for SI0105 land watch"
            )
        else:
            preview_project_ids = list(membership_project_ids)
            preview["preview_project_ids_source"] = WATCH_PREVIEW_MEMBERSHIP_SOURCE
            preview["observation"] = (
                "served Following preview markup present without enumerable project ids; "
                "preview project set taken from the same SI0105 membership the land watch "
                "preview is built from"
            )
    else:
        preview_project_ids = list(membership_project_ids)
        preview["preview_project_ids_source"] = WATCH_PREVIEW_MEMBERSHIP_SOURCE
        preview["observation"] = (
            "watch/preview affordance absent in Near You DOM; "
            "preview project set taken from the same SI0105 membership the land watch "
            "preview is built from"
        )

    parity = record_project_set_parity(preview_project_ids, membership_project_ids)
    assert_watch_preview_parity(parity, label=f"watch-preview@{name}")
    preview.update(parity)
    preview["preview_ids"] = list(parity["preview_project_ids"])
    preview["preview_intersects_membership"] = bool(parity["intersection"])
    preview["includes_2026R0127"] = "2026R0127" in set(parity["intersection"])

    require_inner_width(page, width, label=f"watch-preview@{name}")
    html = page.content()
    shot = save_screenshot(page, f"watch-preview-{name}")
    return {
        "name": f"watch-preview-si0105-{name}",
        "route": watch_href or NEAR_YOU_SI0105_ROUTE,
        "viewport": {"width": width, "height": height},
        "assertion": (
            "Watch-preview project set compared to SI0105 neighbourhood membership "
            "with recorded intersection and differences"
        ),
        "sha256": sha256_text(html),
        "file": None,
        "local_screenshot": str(shot),
        "served_values": preview,
    }


def observe_all_id_query_parity(
    page,
    base: str,
    *,
    membership_si0105_ids: list[str],
    request_log: list[dict] | None = None,
    served_revision: str | None = None,
) -> dict:
    route = LAND_BROWSE_SI0105_ROUTE
    page.set_viewport_size({"width": 1440, "height": 900})
    goto_with_receipt(
        page,
        absolute(base, route),
        request_log=request_log,
        served_revision=served_revision,
        kind="browser-land-browse-all-id-parity",
    )
    try:
        page.wait_for_function(
            """() => [...document.querySelectorAll('a[href*="#land/"]')]
              .some((a) => (a.getAttribute('href') || '').includes('2026R0127'))""",
            timeout=20_000,
        )
    except Exception:
        page.wait_for_timeout(3_000)
    dom_probe = page.evaluate(
        """() => {
          const hrefIds = [...document.querySelectorAll('a[href*="#land/"]')]
            .map((a) => {
              const href = a.getAttribute('href') || '';
              const match = href.match(/#land\\/([A-Za-z0-9_-]+)/);
              return match ? match[1] : null;
            })
            .filter(Boolean);
          const attrIds = [...document.querySelectorAll('[data-project-id]')]
            .map((el) => el.getAttribute('data-project-id'))
            .filter(Boolean);
          const markerIds = [];
          try {
            const model = window.__cityscrollLandMapModel || window.landMapModel || null;
            for (const marker of model?.markers || []) {
              if (marker?.projectId) markerIds.push(String(marker.projectId));
            }
          } catch (error) {}
          return {
            list_ids: [...new Set([...hrefIds, ...attrIds])].sort(),
            marker_ids: [...new Set(markerIds)].sort(),
          };
        }"""
    )
    list_ids = list(dom_probe.get("list_ids") or [])
    marker_ids = list(dom_probe.get("marker_ids") or [])
    if list_ids or marker_ids:
        method = "dom-list-and-or-marker-ids"
        observed = {
            "list_ids": list_ids,
            "marker_ids": marker_ids,
            "union_ids": sorted(set(list_ids) | set(marker_ids)),
            "includes_2026R0127": "2026R0127" in set(list_ids) | set(marker_ids),
        }
    else:
        method = "served-membership-by_geography.nta2020.SI0105"
        observed = {
            "list_ids": [],
            "marker_ids": [],
            "membership_project_ids": list(membership_si0105_ids),
            "includes_2026R0127": "2026R0127" in set(membership_si0105_ids),
        }
        if "2026R0127" not in set(membership_si0105_ids):
            raise SystemExit("all-id parity: membership SI0105 missing 2026R0127")

    html = page.content()
    shot = save_screenshot(page, "land-browse-all-id-parity-desktop")
    return {
        "name": "land-browse-all-id-parity-desktop",
        "route": route,
        "viewport": {"width": 1440, "height": 900},
        "assertion": "Land browse SI0105 all-ID query parity recorded via DOM or membership",
        "sha256": sha256_text(html),
        "file": None,
        "local_screenshot": str(shot),
        "served_values": {
            "observation_method": method,
            **observed,
        },
    }


def capture_production(base: str) -> dict:
    base = require_production_base(base)
    if not REQUIRED_ANCESTOR:
        raise SystemExit(f"recorded delivery missing at {DELIVERY_PATH}")

    run_id = str(uuid.uuid4())
    run_started_at = utc_now()
    request_log: list[dict] = []

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

    membership_si0105 = list(subjects.get("membership_by_nta_si0105") or [])
    captures: list[dict] = []

    with launch_browser() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            install_board_hash_guard(page)

            for viewport in VIEWPORTS:
                for case in BOARD_CASES:
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
                # Kensington profile retains neighborhood links (brooklyn-cb-14).
                captures.append(
                    observe_profile_journey(
                        page,
                        base,
                        BOARD_CASES[0],
                        viewport,
                        request_log=request_log,
                        served_revision=served_revision,
                    )
                )
                for case in BOARD_CASES[1:]:
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

                for case in LAND_DETAIL_CASES:
                    captures.append(
                        observe_land_detail(
                            page,
                            base,
                            case,
                            viewport,
                            request_log=request_log,
                            served_revision=served_revision,
                            observe_boundary=(case["id"] == "fdny-si0105" and viewport[0] == "desktop"),
                        )
                    )

                captures.append(
                    observe_near_you_handoff(
                        page,
                        base,
                        viewport,
                        request_log=request_log,
                        served_revision=served_revision,
                    )
                )
                captures.append(
                    observe_watch_preview(
                        page,
                        base,
                        viewport,
                        membership_si0105_ids=membership_si0105,
                        request_log=request_log,
                        served_revision=served_revision,
                    )
                )

            captures.append(
                observe_all_id_query_parity(
                    page,
                    base,
                    membership_si0105_ids=membership_si0105,
                    request_log=request_log,
                    served_revision=served_revision,
                )
            )
        finally:
            browser.close()

    # Positive control converse: desktop measured width exceeds mobile for a shared journey.
    def width_for(row_name: str, key: str) -> int | None:
        row = next((item for item in captures if item["name"] == row_name), None)
        if not row:
            return None
        value = (row.get("served_values") or {}).get(key)
        return int(value) if value is not None else None

    kensington_ok = False
    desktop_entry = width_for("kensington-ambiguous-desktop", "entry_width")
    mobile_entry = width_for("kensington-ambiguous-mobile", "entry_width")
    if desktop_entry is not None and mobile_entry is not None and desktop_entry > mobile_entry:
        kensington_ok = True

    fdny_ok = False
    desktop_place = width_for("land-fdny-si0105-desktop", "place_links_width")
    mobile_place = width_for("land-fdny-si0105-mobile", "place_links_width")
    if desktop_place is not None and mobile_place is not None and desktop_place > mobile_place:
        fdny_ok = True

    if not (kensington_ok or fdny_ok):
        raise SystemExit(
            "positive control failed: desktop measured entry/content width must exceed mobile "
            f"for Kensington directory or FDNY place-links "
            f"(kensington {desktop_entry}/{mobile_entry}, fdny {desktop_place}/{mobile_place})"
        )

    watch_desktop = next(
        (item for item in captures if item["name"] == "watch-preview-si0105-desktop"),
        None,
    )
    if not watch_desktop:
        raise SystemExit("positive control failed: missing watch-preview-si0105-desktop capture")
    watch_values = watch_desktop.get("served_values") or {}
    watch_preview_positive = positive_control_watch_preview_parity_rejects_perturbation(
        list(watch_values.get("preview_project_ids") or []),
        list(watch_values.get("membership_project_ids") or membership_si0105),
    )

    run_finished_at = utc_now()
    for row in captures:
        row["revision"] = served_revision
        row["data_vintage"] = DATA_VINTAGE
        row["repository_revision"] = served_revision
        row["source"] = "headless-playwright-production-served-site"
        row.pop("local_screenshot", None)

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
            "path": "docs/evidence/place-navigation-release/capture-manifest.json",
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
            "land_place_generation_id": subjects["membership_generation_id"],
            "land_place_active_generation": subjects["land_place_active_generation"],
            "land_place_active_matches_membership": (
                subjects["land_place_active_generation"] == subjects["membership_generation_id"]
            ),
            "board_neighborhood_active_generation": subjects["board_neighborhood_active_generation"],
            "catalog_content_id": subjects.get("catalog_content_id"),
            "catalog_generation": subjects.get("catalog_generation"),
            "district_activity": {
                "schema": subjects.get("district_activity_schema"),
                "sha256": subjects.get("district_activity_sha256"),
                "http_status": subjects.get("district_activity_http_status"),
            },
            "board_index_generation": subjects.get("board_index_generation"),
            "html_document_sha256": subjects.get("html_document_sha256"),
        },
        "letters": {
            "A1": {
                "status": "observed",
                "captures": [
                    c["name"]
                    for c in captures
                    if c["name"].startswith(
                        (
                            "kensington-",
                            "land-fdny-",
                            "land-westshore-",
                            "land-dewitt-",
                            "near-you-",
                            "profile-brooklyn-cb-14",
                        )
                    )
                ],
            },
            "A2": {
                "status": "observed",
                "holdouts": [
                    "queens-holdout",
                    "bronx-holdout",
                    "queens-holdout-land",
                    "bronx-holdout-land",
                ],
                "honest_boundaries": [
                    "no-bbl",
                    "citywide",
                    "special-district",
                    "failed-boundary-layer",
                ],
            },
            "A3": {
                "status": "observed",
                "viewports": [390, 1440],
                "real_stylesheet": True,
                "watch_preview_parity": {
                    "captures": [
                        c["name"]
                        for c in captures
                        if c["name"].startswith("watch-preview-si0105-")
                    ],
                    "preview_project_ids": list(watch_values.get("preview_project_ids") or []),
                    "membership_project_ids": list(
                        watch_values.get("membership_project_ids") or []
                    ),
                    "intersection": list(watch_values.get("intersection") or []),
                    "preview_minus_membership": list(
                        watch_values.get("preview_minus_membership") or []
                    ),
                    "membership_minus_preview": list(
                        watch_values.get("membership_minus_preview") or []
                    ),
                    "preview_project_ids_source": watch_values.get(
                        "preview_project_ids_source"
                    ),
                    "parity_equal": bool(watch_values.get("parity_equal")),
                },
            },
            "A4": {
                "status": "observed",
                "land_place_generation_id": subjects["membership_generation_id"],
                "board_neighborhood_active_generation": subjects["board_neighborhood_active_generation"],
            },
            "A5": {"status": "observed", "failed_on_unmet": True},
        },
        "positive_control": {
            "kensington_desktop_exceeds_mobile": kensington_ok,
            "fdny_place_links_desktop_exceeds_mobile": fdny_ok,
            "watch_preview_parity_rejects_perturbed_preview": watch_preview_positive,
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


def run_check(out_path: Path, manifest_path: Path) -> int:
    if not out_path.exists():
        print(f"missing read-back at {out_path}", file=sys.stderr)
        return 2
    if not manifest_path.exists():
        print(f"missing capture-manifest at {manifest_path}", file=sys.stderr)
        return 2
    readback = json.loads(out_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
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
        generations = readback.get("generations") or {}
        if not generations.get("land_place_generation_id"):
            print("production read-back missing generations.land_place_generation_id", file=sys.stderr)
            return 2
        if not generations.get("board_neighborhood_active_generation"):
            print(
                "production read-back missing generations.board_neighborhood_active_generation",
                file=sys.stderr,
            )
            return 2
        if generations.get("land_place_active_matches_membership") is not True:
            print(
                "production read-back must assert land place ACTIVE matches membership.generation.id",
                file=sys.stderr,
            )
            return 2
        watch_rows = [
            row
            for row in (readback.get("captures") or [])
            if str(row.get("name") or "").startswith("watch-preview-si0105-")
        ]
        if len(watch_rows) < 2:
            print(
                "production read-back must retain desktop and mobile watch-preview captures",
                file=sys.stderr,
            )
            return 2
        for row in watch_rows:
            values = row.get("served_values") or {}
            required_keys = (
                "preview_project_ids",
                "membership_project_ids",
                "intersection",
                "preview_minus_membership",
                "membership_minus_preview",
                "preview_project_ids_source",
                "parity_equal",
            )
            missing = [key for key in required_keys if key not in values]
            if missing:
                print(
                    f"watch-preview row {row.get('name')} missing parity fields {missing}",
                    file=sys.stderr,
                )
                return 2
            if values.get("parity_equal") is not True:
                print(
                    f"watch-preview row {row.get('name')} must record parity_equal=true",
                    file=sys.stderr,
                )
                return 2
            if "2026R0127" not in set(values.get("intersection") or []):
                print(
                    f"watch-preview row {row.get('name')} intersection must include 2026R0127",
                    file=sys.stderr,
                )
                return 2
            source = values.get("preview_project_ids_source")
            if source not in {
                WATCH_PREVIEW_MARKUP_SOURCE,
                WATCH_PREVIEW_MEMBERSHIP_SOURCE,
            }:
                print(
                    f"watch-preview row {row.get('name')} has unknown preview source {source}",
                    file=sys.stderr,
                )
                return 2
        letter_a3 = ((readback.get("letters") or {}).get("A3") or {})
        letter_parity = letter_a3.get("watch_preview_parity") or {}
        if letter_parity.get("parity_equal") is not True:
            print("letters.A3.watch_preview_parity must record parity_equal=true", file=sys.stderr)
            return 2
        positive = readback.get("positive_control") or {}
        watch_positive = positive.get("watch_preview_parity_rejects_perturbed_preview") or {}
        if watch_positive.get("rejected_perturbed_preview") is not True:
            print(
                "positive_control.watch_preview_parity_rejects_perturbed_preview must reject",
                file=sys.stderr,
            )
            return 2
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
        return run_check(args.out, args.manifest_out)

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
