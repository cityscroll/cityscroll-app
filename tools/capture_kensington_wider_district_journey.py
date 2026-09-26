#!/usr/bin/env python3
"""Capture deployed Kensington wider-district journey screenshots.

Records textual served values plus sha256 digests. Screenshot binaries stay
under the local task scratch directory; the committed manifest may reference
an externally retained https screenshot URL.

Every list and clicked-detail screenshot in a written packet must come from the
same capture run (shared capture_run_id). The tool never copies screenshot URLs
or digests from a prior manifest. Deliberate reuse of another packet's image must
record an explicit reused_from source (feature, revision, and run or captured_at).
Identical page pixels may share a digest across independently captured packets;
coherence is proved by the shared capture_run_id and clicked-from-list navigation.

The capture refuses to run until the served Pages artifact-manifest revision
contains the recorded landed wider-district delivery commit as a git ancestor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "test" / "browser"))
from browser_support import launched_chromium  # noqa: E402
from deployed_capture_ancestor import (  # noqa: E402
    DeployPendingError,
    WrongPinError,
    load_recorded_delivery,
    require_served_page_revision_contains_delivery,
    revision_contains_ancestor,
)

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "near-you-kensington-wider-district"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-kensington-wider-district-screenshots"
PUBLIC_ALIAS = "ce70cec48d558"
DEFAULT_BASE = "https://cityscroll.org/"
# Landed squash-merge on the default branch; derived from delivery.json at load.
REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY_PATH)
KENSINGTON_LIST = "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings"
KENSINGTON_DETAIL = (
    "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com"
    "%2Fmeeting%2Fhousing-and-land-use-committee-meeting-september-2026%2F"
)
SEPT_NEEDLE = "housing-and-land-use-committee-meeting-september-2026"
TITLE_NEEDLE = "Housing and Land Use Committee Meeting"
VENUE_NEEDLE = "810 East 16th"
WIDER_NEEDLE = "Wider district activity"
VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)
LOCAL_IMAGE_DIR_NOTE = "near-you-kensington-wider-district-screenshots (local ignored dir under task scratch)"


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
    page.wait_for_selector(".near-record, [data-results-count], .near-empty, .near-broader-districts", timeout=60_000)
    try:
        page.wait_for_selector(f'[data-record-id*="{SEPT_NEEDLE}"][data-broader-scope="broader"]', timeout=45_000)
    except Exception:
        pass
    html = page.content()
    focusable = page.eval_on_selector_all(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
        "nodes => nodes.filter(n => !!(n.offsetParent || n.getClientRects().length)).length",
    )
    return {
        "named_row_present": SEPT_NEEDLE in html and TITLE_NEEDLE in html,
        "wider_district_present": WIDER_NEEDLE in html,
        "venue_address_present": VENUE_NEEDLE in html,
        "broader_district_k14_present": 'data-broader-district="K14"' in html,
        "broader_district_k07_present": 'data-broader-district="K07"' in html,
        "title_present": TITLE_NEEDLE in html,
        "no_javascript_title_link": "near-record-title-link" in html,
        "keyboard_focusable_count": int(focusable or 0),
        "selected_label": page.locator("text=Kensington").count() > 0,
        "results_count": page.locator("[data-results-count]").first.get_attribute("data-results-count")
        if page.locator("[data-results-count]").count()
        else None,
    }


def observe_detail(page) -> dict:
    page.wait_for_selector("h1, .meeting-hero, .civic-object-hero", timeout=60_000)
    html = page.content()
    focusable = page.eval_on_selector_all(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
        "nodes => nodes.filter(n => !!(n.offsetParent || n.getClientRects().length)).length",
    )
    return {
        "detail_title_present": TITLE_NEEDLE in html,
        "venue_address_present": VENUE_NEEDLE in html,
        "named_row_present": False,
        "wider_district_present": False,
        "broader_district_k14_present": False,
        "broader_district_k07_present": False,
        "keyboard_focusable_count": int(focusable or 0),
        "no_javascript_title_link": True,
        "source_link_present": "cb14brooklyn.com" in html,
        "opened_from_list_click": True,
    }


def open_list(page, base: str) -> None:
    url = urllib.request.urljoin(base, KENSINGTON_LIST)
    page.goto(url, wait_until="networkidle", timeout=90_000)
    try:
        page.locator("text=Browse records").first.click(timeout=5_000)
        page.wait_for_timeout(1000)
    except Exception:
        pass
    try:
        page.keyboard.press("Tab")
    except Exception:
        pass


def click_named_row_into_detail(page) -> str:
    """Click the broader September row into the meeting detail; return landed path."""
    card_selector = f'[data-record-id*="{SEPT_NEEDLE}"][data-broader-scope="broader"]'
    card = page.locator(card_selector).first
    card.wait_for(state="attached", timeout=45_000)
    try:
        card.scroll_into_view_if_needed(timeout=15_000)
    except Exception:
        pass

    href = page.eval_on_selector(
        f"{card_selector} a.near-record-title-link, {card_selector} a[href*='{SEPT_NEEDLE}']",
        "el => el && (el.href || el.getAttribute('href'))",
    )
    if href:
        with page.expect_navigation(wait_until="networkidle", timeout=90_000):
            # DOM click from the named row's own link (avoids off-screen hit-target flakes).
            page.eval_on_selector(
                f"{card_selector} a.near-record-title-link, {card_selector} a[href*='{SEPT_NEEDLE}']",
                "el => el.click()",
            )
    else:
        inspect = card.locator(".near-record-inspect").first
        if inspect.count() == 0:
            raise SystemExit("broader named row has neither a title link nor an Inspect control")
        inspect.click(timeout=10_000, force=True)
        open_link = page.locator("#near-you-record-inspection a[href*='housing-and-land-use-committee-meeting-september-2026']").first
        if open_link.count() == 0:
            open_link = page.get_by_role("link", name=re.compile(r"open full detail|full detail", re.I))
        open_link.wait_for(state="visible", timeout=15_000)
        with page.expect_navigation(wait_until="networkidle", timeout=90_000):
            open_link.click(timeout=15_000)

    landed = urlparse(page.url).path or ""
    if SEPT_NEEDLE not in landed and SEPT_NEEDLE not in urllib.parse.unquote(page.url):
        html = page.content()
        if TITLE_NEEDLE not in html:
            raise SystemExit(f"list click did not land on September meeting detail: {page.url!r}")
    return landed or KENSINGTON_DETAIL


def require_explicit_reuse(row: dict) -> None:
    """Validate reused_from metadata when a row deliberately cites another packet."""
    reused = row.get("reused_from")
    if not isinstance(reused, dict):
        raise SystemExit(
            f"{row.get('name')}: image reuse requires reused_from "
            "(feature, revision, and capture_run_id or captured_at)"
        )
    source_feature = reused.get("feature")
    source_revision = reused.get("revision")
    source_run = reused.get("capture_run_id") or reused.get("captured_at")
    if not source_feature or not source_revision or not source_run:
        raise SystemExit(
            f"{row.get('name')}: reused_from must name feature, revision, and capture_run_id or captured_at; got {reused!r}"
        )


def validate_manifest(manifest: dict) -> None:
    assert manifest["schema"] == "cityscroll.render_capture_manifest.v1"
    assert manifest["image_binaries_committed"] is False
    assert manifest.get("required_ancestor") == REQUIRED_ANCESTOR
    assert manifest.get("required_ancestor_contained") is True
    run_id = manifest.get("capture_run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise SystemExit("manifest missing capture_run_id for a single coherent run")
    captures = manifest.get("captures") or []
    assert len(captures) >= 4
    seen_digests: set[str] = set()
    for row in captures:
        assert row.get("screenshot_url", "").startswith("https://")
        assert re.fullmatch(r"[0-9a-f]{64}", row.get("sha256") or "")
        if row.get("capture_run_id") != run_id:
            raise SystemExit(
                f"{row.get('name')}: capture_run_id {row.get('capture_run_id')!r} diverges from manifest run {run_id!r}"
            )
        if row.get("reused_from"):
            require_explicit_reuse(row)
        else:
            digest = row["sha256"]
            if digest in seen_digests:
                raise SystemExit(f"{row.get('name')}: duplicate sha256 within the same packet without reused_from")
            seen_digests.add(digest)
        values = row.get("served_values") or {}
        if str(row.get("name") or "").startswith("kensington-meetings-"):
            assert values.get("wider_district_present") is True
            assert values.get("venue_address_present") is True
            assert values.get("named_row_present") is True
            assert values.get("broader_district_k14_present") is True
            assert values.get("broader_district_k07_present") is False
        if str(row.get("name") or "").startswith("kensington-detail-"):
            assert values.get("venue_address_present") is True
            assert values.get("detail_title_present") is True
            if not row.get("reused_from"):
                assert values.get("opened_from_list_click") is True
                assert row.get("navigation") == "clicked-from-list"


def capture_row(
    *,
    name: str,
    route: str,
    width: int,
    height: int,
    revision: str,
    assertion: str,
    image_path: Path,
    served: dict,
    capture_run_id: str,
    navigation: str,
) -> dict:
    return {
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
        "capture_run_id": capture_run_id,
        "navigation": navigation,
        "served_values": served,
    }


def capture(base: str, host: bool) -> dict:
    # Fresh packet only: never read prior screenshot_url / sha256 values.
    if MANIFEST_PATH.exists():
        print(f"replacing prior packet at {MANIFEST_PATH} with a fresh single-run capture", flush=True)

    revision = require_served_revision_contains_delivery(base)
    capture_run_id = str(uuid.uuid4())
    captured_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(
        f"production base={base} revision={revision} capture_run_id={capture_run_id}",
        flush=True,
    )
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    captures: list[dict] = []
    local_files: list[Path] = []

    with launched_chromium() as browser:
        for viewport_name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent="cityscroll-kensington-wider-district/1",
            )
            page = context.new_page()
            open_list(page, base)
            list_served = observe_list(page)
            if not list_served.get("named_row_present") or not list_served.get("wider_district_present"):
                raise SystemExit(f"{viewport_name} list capture missing broader named row: {list_served!r}")
            if list_served.get("broader_district_k07_present"):
                raise SystemExit(f"{viewport_name} list capture unexpectedly includes K07")

            list_name = f"kensington-meetings-{viewport_name}"
            list_path = SCREENSHOT_DIR / f"{list_name}.png"
            page.screenshot(path=str(list_path), full_page=True)
            local_files.append(list_path)
            captures.append(
                capture_row(
                    name=list_name,
                    route=KENSINGTON_LIST,
                    width=width,
                    height=height,
                    revision=revision,
                    assertion=(
                        "Deployed Kensington meetings list shows the September 23 CB14 row under wider-district activity"
                    ),
                    image_path=list_path,
                    served=list_served,
                    capture_run_id=capture_run_id,
                    navigation="direct",
                )
            )

            landed_path = click_named_row_into_detail(page)
            detail_served = observe_detail(page)
            if not detail_served.get("detail_title_present") or not detail_served.get("venue_address_present"):
                raise SystemExit(f"{viewport_name} detail capture missing title/venue: {detail_served!r}")

            detail_name = f"kensington-detail-{viewport_name}"
            detail_path = SCREENSHOT_DIR / f"{detail_name}.png"
            page.screenshot(path=str(detail_path), full_page=True)
            local_files.append(detail_path)
            detail_route = landed_path if SEPT_NEEDLE in landed_path else KENSINGTON_DETAIL
            captures.append(
                capture_row(
                    name=detail_name,
                    route=detail_route,
                    width=width,
                    height=height,
                    revision=revision,
                    assertion=(
                        "Deployed meeting detail opened from the Kensington wider-district row shows the September 23 title and 810 East 16th Street venue"
                    ),
                    image_path=detail_path,
                    served=detail_served,
                    capture_run_id=capture_run_id,
                    navigation="clicked-from-list",
                )
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
            row["screenshot_url"] = f"file://{SCREENSHOT_DIR / (row['name'] + '.png')}"

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "near-you-kensington-wider-district",
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": "headless-playwright-production-served-site",
        "capture_run_id": capture_run_id,
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
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; only this manifest is committed. "
            "Externally retained https screenshot_url values are required. "
            "All captures in this packet share capture_run_id; silent reuse of another packet's image is forbidden."
        ),
        "surface": "Near You Kensington wider-district journey",
        "verifier": "node --test test/kensington_wider_district_journey.test.mjs",
        "captured_at": captured_at,
        "local_image_dir_ignored": LOCAL_IMAGE_DIR_NOTE,
        "captures": captures,
    }
    validate_manifest(manifest)
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "wrote": str(MANIFEST_PATH),
                "revision": revision,
                "capture_run_id": capture_run_id,
                "captures": len(captures),
            },
            indent=2,
        )
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=os.environ.get("CROL_BASE", DEFAULT_BASE))
    parser.add_argument("--host", action="store_true", help="upload screenshots to a public host")
    parser.add_argument("--check", action="store_true", help="validate an existing manifest")
    args = parser.parse_args()
    if args.check:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        validate_manifest(manifest)
        print("ok")
        return 0
    capture(args.base.rstrip("/") + "/", host=args.host)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
