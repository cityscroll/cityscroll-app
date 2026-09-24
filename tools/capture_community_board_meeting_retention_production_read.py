#!/usr/bin/env python3
"""Production read-back for retained community-board meeting detail (A4).

Hits the live served origin with headless Chromium. Records the concrete
served text for the Brooklyn CB14 September 14 meeting detail after the
upcoming calendar has moved past it — observed values only, never a pass
verdict.

At each viewport (1440x900 and 390x844) the capture also retains width-
dependent layout geometry (viewport metrics and key-element bounding boxes)
so desktop and mobile rows differ as checkable textual observations. Digests
cover that layout evidence. Image binaries stay under the task scratch
directory; only textual receipts are committed under
docs/evidence/community-board-meeting-retention/.
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

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs/evidence/community-board-meeting-retention"
MANIFEST = OUT_DIR / "capture-manifest.json"
PRODUCTION = OUT_DIR / "production-read.json"
READBACK = OUT_DIR / "read-back.json"
EXISTING_MANIFEST = OUT_DIR / "manifest.json"
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / (
    "community-board-meeting-retention-production"
)

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-community-board-meeting-retention-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "c10f6cab88867"
SCHEMA = "cityscroll.community_board_meeting_retention_production_read.v1"
PRODUCER_PATH = "docs/evidence/community-board-meeting-retention/read-back.json"

BOARD_ID = "brooklyn-cb-14"
PROFILE_ROUTE = f"/community-boards/{BOARD_ID}/"
DETAIL_ROUTE = (
    "/meetings/meeting%3Acommunity_board%3A"
    "https%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fseptember-2026-board-meeting%2F"
)
OFFICIAL_SOURCE = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/"
RETAINED_MEETING_ID = (
    "meeting:community_board:https://cb14brooklyn.com/meeting/"
    "september-2026-board-meeting/"
)
MEETING_INDEX_PATH = "/data/community_board_meeting_index.json"
MEETING_DATE = "2026-09-14"
VENUE_NEEDLE = "1625 Ocean Avenue"
FOOTER_TRAP = "810 East 16th"
START_NEEDLES = ("6:30", "18:30")

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def resolve_base() -> str:
    raw = (os.environ.get("CROL_BASE") or DEFAULT_BASE).strip()
    base = normalize_base(raw)
    host = (urllib.parse.urlparse(base).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise RuntimeError(f"production read-back requires a cityscroll.org base, got {base}")
    return base


def read_artifact_manifest(base: str) -> dict:
    url = f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"artifact-manifest at {url} is not an object")
    return payload


def deployed_revision(manifest: dict) -> str:
    sha = manifest.get("source_commit_sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("artifact-manifest lacks a 40-hex source_commit_sha")
    return sha


def fetch_json(url: str) -> dict | list:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"served JSON unavailable at {url}: {error}") from error
    return payload


def absolute_origin_url(base: str, path: str) -> str:
    origin = normalize_base(base).rstrip("/")
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return f"{origin}/{path.lstrip('/')}"


def meeting_row_from_shard_payload(payload: dict | list) -> dict | None:
    entries: list = []
    if isinstance(payload, list):
        entries = payload
    elif isinstance(payload, dict):
        if isinstance(payload.get("entries"), list):
            entries = payload["entries"]
        elif isinstance(payload.get("rows"), list):
            entries = payload["rows"]
        else:
            entries = [payload]

    for entry in entries:
        row = entry
        if isinstance(entry, list) and len(entry) >= 2 and isinstance(entry[1], dict):
            row = entry[1]
        if not isinstance(row, dict):
            continue
        if row.get("meeting_id") == RETAINED_MEETING_ID:
            return row
    return None


def shard_url_for(base: str, path: str) -> str:
    value = str(path or "")
    if value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith("/"):
        return absolute_origin_url(base, value)
    return absolute_origin_url(base, f"data/{value}")


def read_served_upcoming_signal(base: str) -> dict:
    """Read the served upcoming-collection signal for the retained meeting.

    Authority is the published meeting-index row (`omitted_from_upcoming` /
    `collection_visibility`), not the constellation "recent proceedings" list.
    """
    index_url = absolute_origin_url(base, MEETING_INDEX_PATH)
    index = fetch_json(index_url)
    if not isinstance(index, dict):
        raise RuntimeError(f"meeting index at {index_url} is not an object")

    shards = [shard for shard in (index.get("shards") or []) if isinstance(shard, dict)]
    ordered = sorted(
        shards,
        key=lambda shard: 0 if shard.get("kind") == "rows" else 1,
    )

    row = None
    shard_url = None
    for shard in ordered:
        path = shard.get("path")
        if not path:
            continue
        candidate_url = shard_url_for(base, path)
        payload = fetch_json(candidate_url)
        found = meeting_row_from_shard_payload(payload)
        if found is not None:
            row = found
            shard_url = candidate_url
            break

    if row is None:
        raise RuntimeError(
            f"served meeting index does not carry {RETAINED_MEETING_ID}"
        )

    retention = row.get("detail_retention") or {}
    omitted = retention.get("omitted_from_upcoming")
    if omitted is not True:
        raise AssertionError(
            "served upcoming signal missing omitted_from_upcoming=true for "
            f"retained September 14 meeting (got {omitted!r})"
        )
    return {
        "meeting_id": row.get("meeting_id"),
        "board_id": row.get("board_id"),
        "timing_status": row.get("timing_status"),
        "collection_visibility": row.get("collection_visibility"),
        "omitted_from_upcoming": True,
        "retention_basis": retention.get("basis"),
        "retention_as_of_day": retention.get("as_of_day"),
        "cancellation_inferred": retention.get("cancellation_inferred"),
        "scheduled_date": row.get("date") or row.get("event_date") or row.get("meeting_date"),
        "source_url": shard_url or index_url,
        "index_generated_at": index.get("generated_at"),
        "index_code_revision": index.get("code_revision"),
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_ws(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def observe_width_dependent_layout(page, *, focus_selector: str) -> dict:
    """Measure viewport-dependent geometry retained in the committed packet.

    HTML digests alone are width-independent for this static page. Record
    bounding boxes and scroll metrics so desktop and mobile rows differ as
    observed facts (no pass/fail verdict).
    """
    layout = page.evaluate(
        """(focusSelector) => {
          const doc = document.documentElement;
          const boxOf = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              x: Math.round(r.x * 10) / 10,
              y: Math.round(r.y * 10) / 10,
              width: Math.round(r.width * 10) / 10,
              height: Math.round(r.height * 10) / 10,
              visible: r.width > 0 && r.height > 0
                && r.bottom > 0
                && r.right > 0
                && r.top < window.innerHeight
                && r.left < window.innerWidth,
            };
          };
          const focus = document.querySelector(focusSelector);
          const title = document.querySelector('main h1, h1');
          let title_wrapped = null;
          if (title) {
            const cs = window.getComputedStyle(title);
            const parsedLine = Number.parseFloat(cs.lineHeight);
            const lineHeight = Number.isFinite(parsedLine)
              ? parsedLine
              : (Number.parseFloat(cs.fontSize) || 16) * 1.2;
            title_wrapped = title.getBoundingClientRect().height > lineHeight * 1.5;
          }
          return {
            viewport_inner_width: window.innerWidth,
            viewport_inner_height: window.innerHeight,
            document_client_width: doc.clientWidth,
            document_scroll_width: doc.scrollWidth,
            document_scroll_height: doc.scrollHeight,
            horizontal_overflow_px: Math.max(0, doc.scrollWidth - window.innerWidth),
            focus_selector: focusSelector,
            focus_bounding_box: boxOf(focus),
            title_bounding_box: boxOf(title),
            title_wrapped: title_wrapped,
          };
        }""",
        focus_selector,
    )
    if not isinstance(layout, dict):
        raise AssertionError("width-dependent layout probe returned a non-object")
    if layout.get("viewport_inner_width") is None:
        raise AssertionError("width-dependent layout missing viewport_inner_width")
    if not isinstance(layout.get("focus_bounding_box"), dict):
        raise AssertionError(
            f"width-dependent layout missing focus box for {focus_selector!r}"
        )
    return layout


def digest_width_dependent_observation(layout: dict, html: str) -> str:
    """Digest retained width-dependent evidence so both-width rows are checkable."""
    payload = {
        "html_sha256": sha256_text(html),
        "layout": layout,
    }
    return sha256_text(json.dumps(payload, sort_keys=True, ensure_ascii=False))


def data_vintage_from_board(page) -> str | None:
    for attr in (
        "data-generated-at",
        "data-observed-at",
        "data-as-of",
        "data-source-vintage",
    ):
        nodes = page.locator(f"[{attr}]")
        if nodes.count() == 0:
            continue
        value = nodes.first.get_attribute(attr)
        if value:
            return value
    return None


def capture_profile(
    page,
    base: str,
    width: int,
    height: int,
    rev: str,
    upcoming_signal: dict,
) -> dict:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base.rstrip('/')}{PROFILE_ROUTE}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(800)

    detail_href = DETAIL_ROUTE
    link = page.locator(f'a[href="{DETAIL_ROUTE}"], a[href*="september-2026-board-meeting"]')
    if link.count() == 0:
        raise AssertionError("board profile has no September 14 meeting detail link")
    href = link.first.get_attribute("href") or ""
    if DETAIL_ROUTE not in href and "september-2026-board-meeting" not in href:
        raise AssertionError(f"unexpected September 14 href {href!r}")
    if href.startswith("/"):
        detail_href = href

    hearing = page.locator("#board-hearing-preparation-heading, [data-hearing-segment-kind]")
    hearing_visible = hearing.count() > 0

    # Constellation "Upcoming & recent proceedings" may still show a recently
    # past retained meeting under the recent half of that surface. Record that
    # presence and the displayed date honestly; upcoming-collection exclusion
    # is asserted from the served meeting-index row instead.
    constellation = page.evaluate(
        """(retainedMeetingId) => {
          const headings = Array.from(document.querySelectorAll('h2,h3'));
          const hit = headings.find((node) =>
            /upcoming\\s*&\\s*recent proceedings/i.test(
              (node.textContent || '').replace(/\\s+/g, ' ')
            )
          );
          if (!hit) {
            return {
              heading: null,
              block_present: false,
              meeting_ids: [],
              retained_present: false,
              retained_displayed_date: null,
              retained_row_text: null,
            };
          }
          const list = hit.parentElement?.querySelector('ul.node-record-list')
            || (hit.nextElementSibling && hit.nextElementSibling.matches('ul')
              ? hit.nextElementSibling
              : null);
          const items = list
            ? Array.from(
                list.querySelectorAll(
                  'li.node-record[data-semantic-object="meeting"][data-meeting-id]'
                )
              )
            : [];
          const meeting_ids = items.map(
            (node) => node.getAttribute('data-meeting-id') || ''
          );
          const retained = items.find(
            (node) => node.getAttribute('data-meeting-id') === retainedMeetingId
          );
          let retained_displayed_date = null;
          let retained_row_text = null;
          if (retained) {
            retained_row_text = (retained.innerText || '')
              .replace(/\\s+/g, ' ')
              .trim();
            const iso = retained_row_text.match(/\\b(20\\d{2}-\\d{2}-\\d{2})\\b/);
            retained_displayed_date = iso ? iso[1] : null;
          }
          return {
            heading: (hit.textContent || '').replace(/\\s+/g, ' ').trim(),
            block_present: Boolean(list),
            meeting_ids,
            retained_present: Boolean(retained),
            retained_displayed_date,
            retained_row_text,
          };
        }""",
        RETAINED_MEETING_ID,
    )

    body_text = normalize_ws(page.locator("body").inner_text())
    html = page.content()
    # Geometry of the retained September 14 detail link at this viewport.
    layout = observe_width_dependent_layout(
        page,
        focus_selector=(
            f'a[href="{DETAIL_ROUTE}"], a[href*="september-2026-board-meeting"]'
        ),
    )
    digest = digest_width_dependent_observation(layout, html)

    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"cb14-profile-{width}x{height}.png"),
        full_page=True,
    )

    constellation_present = bool(constellation.get("retained_present"))
    constellation_date = constellation.get("retained_displayed_date")
    if constellation_present and constellation_date != MEETING_DATE:
        raise AssertionError(
            "constellation recent row for retained September 14 meeting does not "
            f"display date {MEETING_DATE} (got {constellation_date!r})"
        )

    served_values = {
        "board_id": BOARD_ID,
        "detail_href": detail_href,
        "hearing_preparation_visible": hearing_visible,
        "profile_mentions_september_14": (
            "September 14" in body_text or "2026-09-14" in body_text
        ),
        # Upcoming-collection exclusion (authoritative served signal).
        "upcoming_collection_omitted_from_upcoming": True,
        "upcoming_collection_visibility": upcoming_signal.get("collection_visibility"),
        "upcoming_collection_timing_status": upcoming_signal.get("timing_status"),
        "upcoming_collection_cancellation_inferred": upcoming_signal.get(
            "cancellation_inferred"
        ),
        "upcoming_collection_retention_basis": upcoming_signal.get("retention_basis"),
        "upcoming_collection_retention_as_of_day": upcoming_signal.get(
            "retention_as_of_day"
        ),
        "upcoming_collection_signal_source_url": upcoming_signal.get("source_url"),
        # Constellation recent surface (observed; not the upcoming-collection gate).
        "constellation_recent_block_present": bool(constellation.get("block_present")),
        "constellation_recent_heading": constellation.get("heading"),
        "constellation_recent_meeting_ids": sorted(
            set(constellation.get("meeting_ids") or [])
        ),
        "constellation_recent_includes_retained_meeting": constellation_present,
        "constellation_recent_retained_meeting_date": constellation_date,
        "constellation_recent_retained_row_text": constellation.get("retained_row_text"),
        # Width-dependent layout observation retained in the packet.
        "layout": layout,
    }
    if "result" in served_values or "pass" in served_values:
        raise AssertionError("served_values must not carry a pass verdict")
    if upcoming_signal.get("omitted_from_upcoming") is not True:
        raise AssertionError(
            "served upcoming collection does not omit the retained September 14 meeting"
        )
    if served_values["upcoming_collection_cancellation_inferred"] is not False:
        raise AssertionError(
            "served upcoming signal must keep cancellation_inferred explicitly false"
        )

    return {
        "source": "headless-playwright-production-served-site",
        "name": f"cb14-profile-{'mobile' if width < 800 else 'desktop'}",
        "route": PROFILE_ROUTE,
        "viewport": {"width": width, "height": height},
        "revision": rev,
        "data_vintage": data_vintage_from_board(page),
        "assertion": (
            "Board profile keeps a navigable September 14 meeting detail link after "
            "the served upcoming collection omits that retained past meeting."
        ),
        "sha256": digest,
        "file": None,
        "served_values": served_values,
    }


def capture_detail(page, base: str, width: int, height: int, rev: str) -> dict:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base.rstrip('/')}{DETAIL_ROUTE}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(800)

    status = page.evaluate("() => document.title || ''")
    body_text = normalize_ws(page.locator("body").inner_text())
    html = page.content()

    if page.url.endswith("/404") or "not found" in body_text.lower()[:200]:
        raise AssertionError(f"detail route returned not-found at {page.url}")

    venue_shown = VENUE_NEEDLE in body_text or VENUE_NEEDLE in html
    footer_as_venue = False
    # Prefer structured venue markup when present.
    venue_nodes = page.locator(
        '[data-meeting-venue], [itemprop="location"], .meeting-venue, '
        '[data-field="venue"], [data-field="address"]'
    )
    venue_text = ""
    if venue_nodes.count() > 0:
        venue_text = normalize_ws(venue_nodes.first.inner_text())
        footer_as_venue = FOOTER_TRAP in venue_text and VENUE_NEEDLE not in venue_text
    else:
        footer_as_venue = FOOTER_TRAP in body_text and VENUE_NEEDLE not in body_text

    official_source_shown = (
        OFFICIAL_SOURCE in html
        or "Official source" in body_text
        or "official source" in body_text.lower()
    )
    start_shown = any(needle in body_text or needle in html for needle in START_NEEDLES)
    date_shown = MEETING_DATE in html or "September 14" in body_text or "Sep 14" in body_text
    cancelled_marker = 'data-meeting-cancelled="1"' in html

    # Prefer a key on-page fact element for geometry (venue, else official source).
    focus_selector = (
        '[data-meeting-venue], [itemprop="location"], .meeting-venue, '
        '[data-field="venue"], [data-field="address"], '
        f'a[href="{OFFICIAL_SOURCE}"], a[href*="cb14brooklyn.com/meeting/september-2026"]'
    )
    layout = observe_width_dependent_layout(page, focus_selector=focus_selector)
    digest = digest_width_dependent_observation(layout, html)
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"cb14-detail-{width}x{height}.png"),
        full_page=True,
    )

    served_values = {
        "title": normalize_ws(status),
        "venue_address": VENUE_NEEDLE if venue_shown else (venue_text or None),
        "venue_shown": venue_shown,
        "footer_address_used_as_venue": footer_as_venue,
        "scheduled_date": MEETING_DATE if date_shown else None,
        "scheduled_date_shown": date_shown,
        "start_shown": start_shown,
        "official_source_url": OFFICIAL_SOURCE if official_source_shown else None,
        "official_source_shown": official_source_shown,
        "cancelled_marker": bool(cancelled_marker),
        "http_path": DETAIL_ROUTE,
        # Width-dependent layout observation retained in the packet.
        "layout": layout,
    }
    if not venue_shown:
        raise AssertionError("served detail does not show 1625 Ocean Avenue")
    if footer_as_venue:
        raise AssertionError("served detail uses footer 810 East 16th as the venue")
    if not date_shown:
        raise AssertionError("served detail does not show the September 14 scheduled date")
    if not official_source_shown:
        raise AssertionError("served detail does not show the official source")
    if not start_shown:
        raise AssertionError("served detail does not show the published 6:30 start")
    if cancelled_marker:
        raise AssertionError("served detail carries a cancelled marker")
    if "result" in served_values or "pass" in served_values:
        raise AssertionError("served_values must not carry a pass verdict")

    return {
        "source": "headless-playwright-production-served-site",
        "name": f"cb14-detail-{'mobile' if width < 800 else 'desktop'}",
        "route": DETAIL_ROUTE,
        "viewport": {"width": width, "height": height},
        "revision": rev,
        "data_vintage": data_vintage_from_board(page),
        "assertion": (
            "Retained September 14 detail opens with venue 1625 Ocean Avenue, "
            "the published start, and the official source after the calendar moved on."
        ),
        "sha256": digest,
        "file": None,
        "served_values": served_values,
    }


def build_receipt(
    *,
    base: str,
    artifact: dict,
    rev: str,
    observed_at: str,
    reads: list[dict],
) -> dict:
    generated_at = artifact.get("generated_at")
    profile_reads = [row for row in reads if row["route"] == PROFILE_ROUTE]
    detail_reads = [row for row in reads if row["route"] == DETAIL_ROUTE]
    return {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": normalize_base(base).rstrip("/"),
        "deployment": {
            "manifest_url": f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}",
            "revision": rev,
            "generated_at": generated_at,
            "deployment_at": artifact.get("deployment_at") or generated_at,
            "manifest_sha256": sha256_text(json.dumps(artifact, sort_keys=True)),
        },
        "capture": {
            "tool": "tools/capture_community_board_meeting_retention_production_read.py",
            "browser": "chromium",
            "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
            "screenshot_binaries_committed": False,
        },
        "producer": {
            "path": PRODUCER_PATH,
            "schema": SCHEMA,
            "letters": ["A4"],
        },
        "letters": {
            "A4": {
                "clause": "deployed_profile_to_detail_after_calendar_moves_on",
                "profile_route": PROFILE_ROUTE,
                "detail_route": DETAIL_ROUTE,
                "reads": reads,
                "profile_reads": profile_reads,
                "detail_reads": detail_reads,
            }
        },
        "reads": reads,
        "summary": {
            "case_count": 2,
            "capture_count": len(reads),
            "letter": "A4",
            "board_id": BOARD_ID,
            "meeting_date": MEETING_DATE,
        },
    }


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "community-board-meeting-retention",
        "public_alias": PUBLIC_ALIAS,
        "surface": "Retained community board meeting detail after calendar refresh",
        "base": normalize_base(receipt["origin"]),
        "condition": (
            f"Production base {normalize_base(receipt['origin'])} after deployment; "
            "no image binary is committed."
        ),
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": rev,
        "repository_revision": rev,
        "grounded_at": rev,
        "data_vintage": MEETING_DATE,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "image binaries are not committed. Width-dependent layout geometry "
            "is retained as textual observations on each capture row."
        ),
        "note": (
            "Production desktop/mobile receipts for the Brooklyn CB14 September 14 "
            "retained meeting detail after the upcoming calendar moved on, including "
            "per-viewport layout geometry so both widths are independently checkable."
        ),
        "verifier": (
            "node --test test/community_board_meeting_retention_production_read.test.mjs"
        ),
        "producer": receipt["producer"],
        "captures": receipt["letters"]["A4"]["reads"],
    }


def validate(receipt: dict) -> None:
    if receipt.get("schema") != SCHEMA:
        raise AssertionError(f"unexpected schema {receipt.get('schema')}")
    if receipt.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("public_alias mismatch")
    if receipt.get("evidence_class") != "deployed-production-read-back":
        raise AssertionError("evidence_class must be deployed-production-read-back")
    deployment = receipt.get("deployment") or {}
    if not re.fullmatch(r"[0-9a-f]{40}", deployment.get("revision") or ""):
        raise AssertionError("deployment.revision must be a 40-hex served SHA")
    producer = receipt.get("producer") or {}
    if producer.get("path") != PRODUCER_PATH:
        raise AssertionError("producer path mismatch")
    if producer.get("letters") != ["A4"]:
        raise AssertionError("producer letters mismatch")
    a4 = ((receipt.get("letters") or {}).get("A4") or {})
    if a4.get("clause") != "deployed_profile_to_detail_after_calendar_moves_on":
        raise AssertionError("A4 clause mismatch")
    reads = a4.get("reads") or []
    if len(reads) < 4:
        raise AssertionError("A4 requires profile+detail at desktop and mobile")
    profile_reads = [row for row in reads if row.get("route") == PROFILE_ROUTE]
    detail_reads = [row for row in reads if row.get("route") == DETAIL_ROUTE]
    if len(profile_reads) < 2 or len(detail_reads) < 2:
        raise AssertionError("A4 requires profile and detail reads at both widths")
    def require_layout(row: dict) -> dict:
        values = row.get("served_values") or {}
        layout = values.get("layout")
        if not isinstance(layout, dict):
            raise AssertionError(
                f"{row.get('name')}: missing retained width-dependent layout observation"
            )
        for key in (
            "viewport_inner_width",
            "viewport_inner_height",
            "document_client_width",
            "document_scroll_width",
            "document_scroll_height",
            "horizontal_overflow_px",
            "focus_selector",
            "focus_bounding_box",
            "title_bounding_box",
        ):
            if key not in layout:
                raise AssertionError(f"{row.get('name')}: layout missing {key}")
        box = layout.get("focus_bounding_box")
        if not isinstance(box, dict) or not all(
            k in box for k in ("x", "y", "width", "height", "visible")
        ):
            raise AssertionError(
                f"{row.get('name')}: focus_bounding_box must record x/y/width/height/visible"
            )
        expected_width = (row.get("viewport") or {}).get("width")
        if layout.get("viewport_inner_width") != expected_width:
            raise AssertionError(
                f"{row.get('name')}: layout viewport_inner_width "
                f"{layout.get('viewport_inner_width')!r} != capture width {expected_width!r}"
            )
        return layout

    for row in detail_reads:
        values = row.get("served_values") or {}
        if not values.get("venue_shown"):
            raise AssertionError(f"{row.get('name')}: venue not shown")
        if values.get("footer_address_used_as_venue"):
            raise AssertionError(f"{row.get('name')}: footer used as venue")
        if not values.get("official_source_shown"):
            raise AssertionError(f"{row.get('name')}: official source missing")
        if not values.get("scheduled_date_shown"):
            raise AssertionError(f"{row.get('name')}: scheduled date missing")
        if values.get("cancelled_marker"):
            raise AssertionError(f"{row.get('name')}: cancelled marker present")
        require_layout(row)
        if "result" in values or "pass" in values:
            raise AssertionError("A4 served_values must not carry a pass verdict")
    for row in profile_reads:
        values = row.get("served_values") or {}
        if values.get("upcoming_collection_omitted_from_upcoming") is not True:
            raise AssertionError(
                f"{row.get('name')}: served upcoming signal missing "
                "omitted_from_upcoming=true"
            )
        if values.get("upcoming_collection_cancellation_inferred") is not False:
            raise AssertionError(
                f"{row.get('name')}: cancellation_inferred must be explicitly false"
            )
        if "constellation_recent_includes_retained_meeting" not in values:
            raise AssertionError(
                f"{row.get('name')}: constellation recent presence must be recorded"
            )
        if values.get("constellation_recent_includes_retained_meeting") is True:
            if values.get("constellation_recent_retained_meeting_date") != MEETING_DATE:
                raise AssertionError(
                    f"{row.get('name')}: constellation recent row must display "
                    f"{MEETING_DATE}"
                )
        require_layout(row)
        if "result" in values or "pass" in values:
            raise AssertionError("A4 served_values must not carry a pass verdict")

    def by_width(rows: list[dict], width: int) -> dict | None:
        for row in rows:
            if (row.get("viewport") or {}).get("width") == width:
                return row
        return None

    for label, rows in (("detail", detail_reads), ("profile", profile_reads)):
        desktop = by_width(rows, 1440)
        mobile = by_width(rows, 390)
        if desktop is None or mobile is None:
            raise AssertionError(f"A4 requires {label} reads at 1440 and 390")
        desktop_layout = (desktop.get("served_values") or {}).get("layout")
        mobile_layout = (mobile.get("served_values") or {}).get("layout")
        if desktop_layout == mobile_layout:
            raise AssertionError(
                f"A4 {label} layout observations must differ across desktop and mobile"
            )
        if desktop.get("sha256") == mobile.get("sha256"):
            raise AssertionError(
                f"A4 {label} capture digests must differ across desktop and mobile"
            )


def assert_canonical_json(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    canonical = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if raw != canonical:
        raise AssertionError(f"{path.relative_to(ROOT)} is not canonical sorted-key JSON")


def check() -> None:
    receipt = load_json(READBACK)
    validate(receipt)
    assert_canonical_json(READBACK)
    production = load_json(PRODUCTION)
    if production.get("schema") != SCHEMA:
        raise AssertionError("production-read schema mismatch")
    if production.get("producer", {}).get("letters") != ["A4"]:
        raise AssertionError("production-read producer letters mismatch")
    if not ((production.get("letters") or {}).get("A4") or {}).get("reads"):
        raise AssertionError("production-read missing A4 reads")
    assert_canonical_json(PRODUCTION)
    manifest = load_json(MANIFEST)
    if manifest.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("capture-manifest public_alias mismatch")
    if manifest.get("producer", {}).get("letters") != ["A4"]:
        raise AssertionError("capture-manifest producer letters mismatch")
    assert_canonical_json(MANIFEST)
    a4_names = {row["name"] for row in receipt["letters"]["A4"]["reads"]}
    manifest_names = {row.get("name") for row in manifest.get("captures") or []}
    if not a4_names.issubset(manifest_names):
        raise AssertionError("capture-manifest missing A4 captures")
    if EXISTING_MANIFEST.exists():
        packet = load_json(EXISTING_MANIFEST)
        acceptance = packet.get("acceptance") or {}
        if acceptance.get("A4") not in {
            "proved_by_deployed_production_read_back",
            "proved_by_source_fixture_and_deployed_read_back",
        }:
            raise AssertionError(
                "packet manifest acceptance.A4 must name the deployed read-back"
            )
    print(
        f"community-board-meeting-retention A4 check passed: {READBACK.relative_to(ROOT)}"
    )


def capture() -> dict:
    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"production base={base} revision={rev}", flush=True)
    print("reading served upcoming-collection signal", flush=True)
    upcoming_signal = read_served_upcoming_signal(base)
    print(
        "upcoming signal: "
        f"omitted_from_upcoming={upcoming_signal.get('omitted_from_upcoming')} "
        f"visibility={upcoming_signal.get('collection_visibility')} "
        f"timing={upcoming_signal.get('timing_status')}",
        flush=True,
    )

    reads: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (compatible; CityScrollCapture/1.0)"
        )
        page = context.new_page()
        for name, width, height in VIEWPORTS:
            print(f"retention A4 profile {name}", flush=True)
            reads.append(
                capture_profile(page, base, width, height, rev, upcoming_signal)
            )
            print(f"retention A4 detail {name}", flush=True)
            reads.append(capture_detail(page, base, width, height, rev))
        browser.close()

    receipt = build_receipt(
        base=base,
        artifact=artifact,
        rev=rev,
        observed_at=observed_at,
        reads=reads,
    )
    validate(receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return 0

    receipt = capture()
    write_json(READBACK, receipt)
    write_json(PRODUCTION, receipt)
    write_json(MANIFEST, build_manifest(receipt))
    print(f"wrote {READBACK.relative_to(ROOT)}", flush=True)
    print(f"wrote {PRODUCTION.relative_to(ROOT)}", flush=True)
    print(f"wrote {MANIFEST.relative_to(ROOT)}", flush=True)
    for row in receipt["letters"]["A4"]["reads"]:
        values = row["served_values"]
        print(f"  {row['name']}: {values}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
