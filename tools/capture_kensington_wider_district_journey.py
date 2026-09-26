#!/usr/bin/env python3
"""Capture deployed Kensington wider-district journey screenshots.

Records textual served values plus sha256 digests. Screenshot binaries stay
under the local task scratch directory; the committed manifest may reference
an externally retained https screenshot URL.

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
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

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
from near_you_detail_observer import (  # noqa: E402
    fetch_document_html,
    observe_detail_packet_fields,
    observe_named_row_present,
    observe_no_javascript_title_link,
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
        "named_row_present": observe_named_row_present(
            html,
            record_id_needle=SEPT_NEEDLE,
            title_needle=TITLE_NEEDLE,
        ),
        "wider_district_present": WIDER_NEEDLE in html,
        "venue_address_present": VENUE_NEEDLE in html,
        "broader_district_k14_present": 'data-broader-district="K14"' in html,
        "broader_district_k07_present": 'data-broader-district="K07"' in html,
        "title_present": TITLE_NEEDLE in html,
        "no_javascript_title_link": observe_no_javascript_title_link(html),
        "keyboard_focusable_count": int(focusable or 0),
        "selected_label": page.locator("text=Kensington").count() > 0,
        "results_count": page.locator("[data-results-count]").first.get_attribute("data-results-count")
        if page.locator("[data-results-count]").count()
        else None,
    }


def observe_detail(page) -> dict:
    page.wait_for_selector("h1, .meeting-hero, .civic-object-hero", timeout=60_000)
    html = page.content()
    try:
        no_js_html = fetch_document_html(page.url, user_agent="cityscroll-kensington-wider-district/1")
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
        "venue_address_present": VENUE_NEEDLE in html,
        "named_row_present": packet["named_row_present"],
        "wider_district_present": WIDER_NEEDLE in html,
        "broader_district_k14_present": 'data-broader-district="K14"' in html,
        "broader_district_k07_present": 'data-broader-district="K07"' in html,
        "keyboard_focusable_count": int(focusable or 0),
        "no_javascript_title_link": packet["no_javascript_title_link"],
        "source_link_present": "cb14brooklyn.com" in html,
    }


def capture(base: str, host: bool) -> dict:
    revision = require_served_revision_contains_delivery(base)
    print(f"production base={base} revision={revision}", flush=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    captures = []
    local_files: list[Path] = []

    with launched_chromium() as browser:
        for kind, route, observer in (
            ("meetings", KENSINGTON_LIST, observe_list),
            ("detail", KENSINGTON_DETAIL, observe_detail),
        ):
            for viewport_name, width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    user_agent="cityscroll-kensington-wider-district/1",
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
                if kind == "meetings":
                    if not served.get("named_row_present") or not served.get("wider_district_present"):
                        raise SystemExit(
                            f"{viewport_name} list capture missing broader named row: {served!r}"
                        )
                    if served.get("broader_district_k07_present"):
                        raise SystemExit(f"{viewport_name} list capture unexpectedly includes K07")
                name = f"kensington-{kind}-{viewport_name}"
                image_path = SCREENSHOT_DIR / f"{name}.png"
                page.screenshot(path=str(image_path), full_page=True)
                local_files.append(image_path)
                captures.append(
                    {
                        "name": name,
                        "route": route,
                        "viewport": {"width": width, "height": height},
                        "revision": revision,
                        "data_vintage": revision,
                        "assertion": (
                            "Deployed Kensington meetings list shows the September 23 CB14 row under wider-district activity"
                            if kind == "meetings"
                            else "Deployed meeting detail shows the September 23 title and 810 East 16th Street venue"
                        ),
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
        "feature": "near-you-kensington-wider-district",
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
        "surface": "Near You Kensington wider-district journey",
        "verifier": "node --test test/kensington_wider_district_journey.test.mjs",
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "local_image_dir_ignored": str(SCREENSHOT_DIR),
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
        assert manifest.get("required_ancestor") == REQUIRED_ANCESTOR
        assert manifest.get("required_ancestor_contained") is True
        assert len(manifest["captures"]) >= 4
        for row in manifest["captures"]:
            assert row.get("screenshot_url", "").startswith("https://")
            assert re.fullmatch(r"[0-9a-f]{64}", row.get("sha256") or "")
            values = row.get("served_values") or {}
            if row["name"].startswith("kensington-meetings-"):
                assert values.get("wider_district_present") is True
                assert values.get("venue_address_present") is True
                assert values.get("named_row_present") is True
                assert values.get("broader_district_k14_present") is True
                assert values.get("broader_district_k07_present") is False
            if row["name"].startswith("kensington-detail-"):
                assert values.get("venue_address_present") is True
        print("ok")
        return 0
    capture(args.base.rstrip("/") + "/", host=args.host)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
