#!/usr/bin/env python3
"""Production read-back for retained community-board meeting detail (A4).

Hits the live served origin with headless Chromium. Records the concrete
served text for the Brooklyn CB14 September 14 meeting detail after the
upcoming calendar has moved past it — observed values only, never a pass
verdict.

Commits textual receipts under docs/evidence/community-board-meeting-retention/.
Optional screenshots stay under the task scratch directory.
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


def capture_profile(page, base: str, width: int, height: int, rev: str) -> dict:
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

    # Upcoming collection: require the retained September 14 CityScroll detail
    # path not to appear among upcoming/recent proceeding cards once past.
    upcoming = page.evaluate(
        """() => {
          const headings = Array.from(document.querySelectorAll('h2,h3'));
          const hit = headings.find((node) =>
            /upcoming\\s*&\\s*recent proceedings/i.test(
              (node.textContent || '').replace(/\\s+/g, ' ')
            )
          );
          if (!hit) return { html: '', meeting_ids: [] };
          const list = hit.parentElement?.querySelector('ul.node-record-list')
            || (hit.nextElementSibling && hit.nextElementSibling.matches('ul')
              ? hit.nextElementSibling
              : null);
          const html = list ? (list.outerHTML || '') : '';
          const meeting_ids = list
            ? Array.from(
                list.querySelectorAll(
                  'li.node-record[data-semantic-object="meeting"][data-meeting-id]'
                )
              ).map((node) => node.getAttribute('data-meeting-id') || '')
            : [];
          return { html, meeting_ids };
        }"""
    )
    upcoming_html = upcoming.get("html") or ""
    upcoming_meeting_ids = list(upcoming.get("meeting_ids") or [])
    retained_meeting_id = (
        "meeting:community_board:https://cb14brooklyn.com/meeting/"
        "september-2026-board-meeting/"
    )
    upcoming_excludes_detail = (
        DETAIL_ROUTE not in upcoming_html
        and "september-2026-board-meeting" not in upcoming_html
    )
    upcoming_list_excludes_retained_id = retained_meeting_id not in set(upcoming_meeting_ids)

    body_text = normalize_ws(page.locator("body").inner_text())
    digest = sha256_text(page.content())

    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"cb14-profile-{width}x{height}.png"),
        full_page=True,
    )

    served_values = {
        "board_id": BOARD_ID,
        "detail_href": detail_href,
        "hearing_preparation_visible": hearing_visible,
        "profile_mentions_september_14": "September 14" in body_text or "2026-09-14" in body_text,
        "upcoming_excludes_retained_detail_href": upcoming_excludes_detail,
        "upcoming_list_excludes_retained_meeting_id": upcoming_list_excludes_retained_id,
        "upcoming_meeting_ids": sorted(set(upcoming_meeting_ids)),
        "upcoming_block_present": bool(upcoming_html),
    }
    if "result" in served_values or "pass" in served_values:
        raise AssertionError("served_values must not carry a pass verdict")
    if not served_values["upcoming_excludes_retained_detail_href"]:
        raise AssertionError(
            "upcoming collection still embeds the retained September 14 detail href"
        )
    if not served_values["upcoming_list_excludes_retained_meeting_id"]:
        raise AssertionError(
            "upcoming meeting list still includes the retained September 14 meeting id"
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
            "the upcoming collection has moved on."
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

    digest = sha256_text(html)
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
            "only this manifest is committed."
        ),
        "note": (
            "Production desktop/mobile receipts for the Brooklyn CB14 September 14 "
            "retained meeting detail after the upcoming calendar moved on."
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
        if "result" in values or "pass" in values:
            raise AssertionError("A4 served_values must not carry a pass verdict")
    for row in profile_reads:
        values = row.get("served_values") or {}
        if not values.get("upcoming_excludes_retained_detail_href"):
            raise AssertionError(
                f"{row.get('name')}: upcoming still embeds retained detail href"
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

    reads: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (compatible; CityScrollCapture/1.0)"
        )
        page = context.new_page()
        for name, width, height in VIEWPORTS:
            print(f"retention A4 profile {name}", flush=True)
            reads.append(capture_profile(page, base, width, height, rev))
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
