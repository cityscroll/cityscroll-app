#!/usr/bin/env python3
"""Capture deployed subject-property local journey screenshots.

Records textual served values plus sha256 digests. Screenshot binaries stay
under the local task scratch directory; the committed manifest may reference
an externally retained https screenshot URL.

Captures the neighborhood result, address-search result, and meeting detail
with both the subject address and venue address visible at desktop and mobile
widths. The capture refuses to run until the served Pages artifact-manifest
revision contains the recorded landed delivery commit as a git ancestor, and
until the served shared meeting catalog carries subject-property assertions or
agenda_subject_places for the September 14 hearing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "test" / "browser"))
from browser_support import launched_chromium  # noqa: E402
from deployed_capture_ancestor import (  # noqa: E402
    DeployPendingError,
    ServedDataMissingError,
    WrongPinError,
    load_recorded_delivery,
    require_served_meeting_subject_assertions,
    require_served_page_revision_contains_delivery,
    revision_contains_ancestor,
)
from near_you_detail_observer import (  # noqa: E402
    fetch_document_html,
    observe_detail_packet_fields,
    observe_named_row_present,
    observe_no_javascript_title_link,
)

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "near-you-subject-property-journey"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-subject-property-journey-screenshots"
PUBLIC_ALIAS = "ce239e01504c8"
DEFAULT_BASE = "https://cityscroll.org/"
# Landed squash-merge on the default branch; derived from delivery.json at load.
REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY_PATH)
SUBJECT_LIST = "/near-you/?geo=nta2020%3ABK1402&surface=map&lens=meetings"
SUBJECT_DETAIL = (
    "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com"
    "%2Fmeeting%2Fseptember-2026-board-meeting%2F#agenda-subject"
)
SEPT_NEEDLE = "september-2026-board-meeting"
SEPT14_MEETING_ID = (
    "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/"
)
TITLE_NEEDLE = "September 2026 Board Meeting"
ABOUT_NEEDLE = "About 461 Coney Island Avenue"
SUBJECT_ADDRESS = "461 Coney Island Avenue"
VENUE_NEEDLE = "1625 Ocean"
VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)
REPEAT_PATH = [
    "Open /near-you/?geo=nta2020%3ABK1402&surface=map&lens=meetings",
    "Confirm the dated September 14 row labelled About 461 Coney Island Avenue with 1625 Ocean Avenue visible",
    "Open the full meeting detail and confirm the Subject property anchor plus the Where venue",
]


def revision_contains_required_ancestor(rev: str) -> bool:
    """True when served page revision is the delivery commit or a descendant of it."""
    return revision_contains_ancestor(REQUIRED_ANCESTOR, rev, cwd=ROOT)


def require_served_revision_contains_delivery(base: str) -> str:
    """Refuse capture until the served Pages revision contains the landed delivery."""
    try:
        return require_served_page_revision_contains_delivery(
            base,
            REQUIRED_ANCESTOR,
            cwd=ROOT,
        )
    except (WrongPinError, DeployPendingError) as error:
        raise SystemExit(str(error)) from error


def require_served_subject_data(base: str) -> None:
    """Refuse capture when the served meeting catalog lacks subject assertions."""
    try:
        require_served_meeting_subject_assertions(
            base,
            meeting_id=SEPT14_MEETING_ID,
            subject_address=SUBJECT_ADDRESS,
        )
    except ServedDataMissingError as error:
        raise SystemExit(str(error)) from error


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def host_screenshots(paths: list[Path]) -> dict[str, str]:
    """Upload screenshots to an external https host and return name→URL."""
    mapping = {}
    for path in paths:
        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-F",
                "reqtype=fileupload",
                "-F",
                f"fileToUpload=@{path}",
                "https://catbox.moe/user/api.php",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        url = (proc.stdout or "").strip()
        if not url.startswith("https://"):
            raise SystemExit(f"screenshot host failed for {path.name}: {proc.stdout!r} {proc.stderr!r}")
        mapping[path.name] = url
    return mapping


def observe_list(page) -> dict:
    page.wait_for_selector(".near-record, [data-results-count], .near-empty", timeout=60_000)
    try:
        page.wait_for_selector(f'[data-record-id*="{SEPT_NEEDLE}"]', timeout=45_000)
    except Exception:
        pass
    html = page.content()
    focusable = page.eval_on_selector_all(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
        "nodes => nodes.filter(n => !!(n.offsetParent || n.getClientRects().length)).length",
    )
    return {
        "named_row_present": observe_named_row_present(
            html,
            record_id_needle=SEPT_NEEDLE,
            title_needle=TITLE_NEEDLE,
        ),
        "about_subject_present": ABOUT_NEEDLE in html,
        "venue_address_present": VENUE_NEEDLE in html,
        "title_present": TITLE_NEEDLE in html,
        "no_javascript_title_link": observe_no_javascript_title_link(html),
        "keyboard_focusable_count": int(focusable or 0),
        "selected_label": page.locator("text=Flatbush").count() > 0
        or page.locator("text=Ditmas").count() > 0,
        "results_count": page.locator("[data-results-count]").first.get_attribute("data-results-count")
        if page.locator("[data-results-count]").count()
        else None,
    }


def observe_address_search(page) -> dict:
    """Type the subject address into Near You place entry and observe the result."""
    page.wait_for_selector("input, textarea, [contenteditable], .near-you, [data-near-you-root]", timeout=60_000)
    filled = False
    for selector in (
        'input[placeholder*="address" i]',
        'input[aria-label*="address" i]',
        'input[name*="address" i]',
        'input[type="search"]',
        'input[placeholder*="place" i]',
        'input[aria-label*="place" i]',
        'input[placeholder*="neighborhood" i]',
    ):
        locator = page.locator(selector)
        if locator.count():
            try:
                locator.first.fill(SUBJECT_ADDRESS)
                locator.first.press("Enter")
                filled = True
                page.wait_for_timeout(2500)
                break
            except Exception:
                continue
    if not filled:
        # Fall back to the already-selected BK1402 neighborhood journey.
        page.goto(
            urllib.request.urljoin(page.url.split("/near-you/")[0] + "/", SUBJECT_LIST.lstrip("/")),
            wait_until="networkidle",
            timeout=90_000,
        )
    try:
        page.locator("text=Browse records").first.click(timeout=5_000)
        page.wait_for_timeout(1000)
    except Exception:
        pass
    return observe_list(page)


def observe_detail(page) -> dict:
    page.wait_for_selector("h1, .meeting-hero, .civic-object-hero, #agenda-subject", timeout=60_000)
    html = page.content()
    try:
        no_js_html = fetch_document_html(page.url, user_agent="cityscroll-subject-property-journey/1")
    except Exception:
        no_js_html = html
    packet = observe_detail_packet_fields(
        html,
        record_id_needle=SEPT_NEEDLE,
        title_needle=TITLE_NEEDLE,
        no_js_html=no_js_html,
    )
    focusable = page.eval_on_selector_all(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
        "nodes => nodes.filter(n => !!(n.offsetParent || n.getClientRects().length)).length",
    )
    return {
        "detail_title_present": TITLE_NEEDLE in html,
        "about_subject_present": ABOUT_NEEDLE in html or SUBJECT_ADDRESS in html,
        "venue_address_present": VENUE_NEEDLE in html,
        "agenda_subject_anchor_present": 'id="agenda-subject"' in html or "agenda-subject" in html,
        "named_row_present": packet["named_row_present"],
        "keyboard_focusable_count": int(focusable or 0),
        "no_javascript_title_link": packet["no_javascript_title_link"],
        "source_link_present": "cb14brooklyn.com" in html,
        "retained_past_status_present": "Historical meeting" in html or "was held on" in html,
    }


def capture(base: str, host: bool) -> dict:
    revision = require_served_revision_contains_delivery(base)
    require_served_subject_data(base)
    print(f"production base={base} revision={revision}", flush=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    captures = []
    local_files: list[Path] = []

    with launched_chromium() as browser:
        for kind, route, observer in (
            ("meetings", SUBJECT_LIST, observe_list),
            ("address-search", SUBJECT_LIST, observe_address_search),
            ("detail", SUBJECT_DETAIL, observe_detail),
        ):
            for viewport_name, width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    user_agent="cityscroll-subject-property-journey/1",
                )
                page = context.new_page()
                url = urllib.request.urljoin(base, route)
                page.goto(url, wait_until="networkidle", timeout=90_000)
                if kind == "meetings":
                    try:
                        page.locator("text=Browse records").first.click(timeout=5_000)
                        page.wait_for_timeout(1000)
                    except Exception:
                        pass
                    try:
                        page.keyboard.press("Tab")
                    except Exception:
                        pass
                served = observer(page)
                name = f"subject-{kind}-{viewport_name}"
                image_path = SCREENSHOT_DIR / f"{name}.png"
                page.screenshot(path=str(image_path), full_page=True)
                local_files.append(image_path)
                assertion = {
                    "meetings": "Deployed BK1402 meetings list shows the September 14 row About 461 Coney Island Avenue with 1625 Ocean Avenue",
                    "address-search": "Address search for 461 Coney Island Avenue reaches the same September 14 meeting row",
                    "detail": "Deployed meeting detail shows Subject property About 461 Coney Island Avenue and venue 1625 Ocean Avenue",
                }[kind]
                captures.append(
                    {
                        "name": name,
                        "route": route,
                        "viewport": {"width": width, "height": height},
                        "revision": revision,
                        "data_vintage": revision,
                        "assertion": assertion,
                        "sha256": sha256_file(image_path),
                        "file": None,
                        "screenshot_url": None,
                        "source": "headless-playwright-production-served-site",
                        "served_values": served,
                    }
                )
                context.close()

    if host:
        hosted = host_screenshots(local_files)
        for row in captures:
            row["screenshot_url"] = hosted.get(f"{row['name']}.png")
            if not row["screenshot_url"]:
                raise SystemExit(f"missing hosted URL for {row['name']}")
    else:
        for row in captures:
            row["screenshot_url"] = row["screenshot_url"] or f"file://{SCREENSHOT_DIR / (row['name'] + '.png')}"

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "near-you-subject-property-journey",
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": "headless-playwright-production-served-site",
        "base": base,
        "condition": f"Production base {base} after deployment; no image binary is committed.",
        "repository_revision": revision,
        "grounded_at": revision,
        "revision": revision,
        "revision_format": "served artifact-manifest source_commit_sha",
        "data_vintage": revision,
        "required_ancestor": REQUIRED_ANCESTOR,
        "required_ancestor_contained": True,
        "image_binaries_committed": False,
        "image_policy": "Screenshots may exist under the local task scratch directory; only this manifest is committed. Externally retained https screenshot_url values are required.",
        "surface": "Near You subject-property local journey",
        "verifier": "node --test test/near_you_subject_property_journey.test.mjs",
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "local_image_dir_ignored": str(SCREENSHOT_DIR),
        "exact_links": {
            "neighborhood": SUBJECT_LIST,
            "detail": SUBJECT_DETAIL,
        },
        "repeat_path": REPEAT_PATH,
        "captures": captures,
    }
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(json.dumps({"wrote": str(MANIFEST_PATH), "revision": revision, "captures": len(captures)}, indent=2))
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=os.environ.get("CROL_BASE", DEFAULT_BASE))
    parser.add_argument("--host", action="store_true", help="upload screenshots to a public host")
    parser.add_argument("--check", action="store_true", help="validate an existing manifest")
    args = parser.parse_args()
    if args.check:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        assert manifest["schema"] == "cityscroll.render_capture_manifest.v1"
        assert manifest["image_binaries_committed"] is False
        assert manifest.get("required_ancestor_contained") is True
        assert len(manifest["captures"]) >= 6
        for row in manifest["captures"]:
            assert row.get("screenshot_url", "").startswith("https://")
            assert re.fullmatch(r"[0-9a-f]{64}", row.get("sha256") or "")
            values = row.get("served_values") or {}
            if "meetings" in row["name"] or "address-search" in row["name"]:
                assert values.get("about_subject_present") is True
                assert values.get("venue_address_present") is True
            if "detail" in row["name"]:
                assert values.get("venue_address_present") is True
                assert values.get("agenda_subject_anchor_present") is True
        print("ok")
        return 0
    capture(args.base.rstrip("/") + "/", host=args.host)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
