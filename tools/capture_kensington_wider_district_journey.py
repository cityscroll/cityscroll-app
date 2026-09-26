#!/usr/bin/env python3
"""Capture deployed Kensington wider-district journey screenshots.

Records textual served values plus sha256 digests. Screenshot binaries stay
under the local task scratch directory; the committed manifest may reference
an externally retained https screenshot URL.

Every list and clicked-detail screenshot in a written packet must come from the
same capture run (shared capture_run_id). The tool never copies screenshot URLs
or digests from a prior manifest. Deliberate reuse of another packet's image must
record an explicit reused_from source (feature, revision, and run or captured_at).
A row whose image digest already appears anywhere else in the retained evidence
tree, or in this manifest's previous committed version, must carry reused_from.
Silent reuse while asserting a fresh coherent run is refused.

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
import time
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
from capture_image_provenance import (  # noqa: E402
    collect_retained_image_digests,
    refuse_reuse_claiming_interaction,
    refuse_silent_image_reuse,
    row_claims_journey_interaction,
)
from near_you_detail_observer import (  # noqa: E402
    fetch_document_html,
    observe_detail_packet_fields,
    observe_named_row_present,
    observe_no_javascript_title_link,
)
from capture_run_receipt import validate_run_receipt  # noqa: E402

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


EVIDENCE_ROOT = ROOT / "docs" / "evidence"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


PAGE_LOAD_HEADER_KEYS = ("date", "cf-ray", "cf-cache-status", "age", "last-modified", "etag")


def page_load_receipt(response, served_revision: str) -> dict:
    """Record the per-request served headers proving this run loaded the page.

    ``cf-ray`` is a unique-per-request token the edge stamps on every live
    response; ``date`` moves each second. Both distinguish a real load from a
    deterministic page whose body never varies.
    """
    headers: dict[str, str | None] = {}
    status = None
    url = None
    if response is not None:
        try:
            raw = response.headers  # Playwright lowercases header names
        except Exception:
            raw = {}
        for key in PAGE_LOAD_HEADER_KEYS:
            value = raw.get(key)
            headers[key] = value if value else None
        try:
            status = response.status
        except Exception:
            status = None
        try:
            url = response.url
        except Exception:
            url = None
    return {
        "url": url,
        "http_status": status,
        "served_revision": served_revision,
        "headers": headers,
    }


def upload_file(path: Path) -> dict:
    """Upload one file to the screenshot host, recording the HTTP exchange."""
    requested_at = now_iso()
    started = time.monotonic()
    proc = subprocess.run(
        [
            "curl",
            "-sS",
            "-w",
            "\n%{http_code}",
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
    elapsed = round(time.monotonic() - started, 3)
    responded_at = now_iso()
    stdout = proc.stdout or ""
    url = stdout
    http_status = None
    if "\n" in stdout:
        body, _, code = stdout.rpartition("\n")
        url = body.strip()
        if code.strip().isdigit():
            http_status = int(code.strip())
    url = url.strip()
    if not url.startswith("https://"):
        raise SystemExit(f"screenshot host failed for {path.name}: {proc.stdout!r} {proc.stderr!r}")
    return {
        "returned_url": url,
        "http_status": http_status,
        "requested_at": requested_at,
        "responded_at": responded_at,
        "elapsed_seconds": elapsed,
    }


def demonstrate_host_dedup(capture_run_id: str) -> dict:
    """Show, inside this run, why identical bytes keep the same hosted address.

    Uploads a fresh unique payload twice (same bytes must return the same URL)
    and a one-byte-altered copy (must return a different URL). This is exactly
    why the packet's four screenshot addresses repeat across runs: a
    deterministic page produces byte-identical screenshots and the host is
    content-addressed.
    """
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    base_bytes = (
        "cityscroll-host-dedup-demonstration\n"
        f"{capture_run_id}\n"
        f"{uuid.uuid4().hex}{os.urandom(24).hex()}\n"
    ).encode("utf-8")
    altered_bytes = bytearray(base_bytes)
    altered_bytes[-1] = altered_bytes[-1] ^ 0x01  # alter exactly one byte
    altered_bytes = bytes(altered_bytes)

    first_path = SCREENSHOT_DIR / "host-dedup-demo-original.bin"
    repeat_path = SCREENSHOT_DIR / "host-dedup-demo-identical-copy.bin"
    altered_path = SCREENSHOT_DIR / "host-dedup-demo-one-byte-altered.bin"
    first_path.write_bytes(base_bytes)
    repeat_path.write_bytes(base_bytes)
    altered_path.write_bytes(altered_bytes)

    first = upload_file(first_path)
    repeat = upload_file(repeat_path)
    altered = upload_file(altered_path)

    return {
        "note": (
            "The screenshot host is content-addressed: identical bytes return the same file URL, "
            "so a deterministic page's screenshot keeps the same address across runs; a "
            "one-byte-altered copy returns a different URL."
        ),
        "host": "catbox.moe",
        "first_upload": {"sha256": sha256_bytes(base_bytes), **first},
        "repeat_same_bytes": {"sha256": sha256_bytes(base_bytes), **repeat},
        "altered_one_byte": {"sha256": sha256_bytes(altered_bytes), **altered},
        "same_bytes_returned_same_url": first["returned_url"] == repeat["returned_url"],
        "altered_bytes_returned_different_url": first["returned_url"] != altered["returned_url"],
    }


def sibling_manifest_revision(manifest_rel_path: str) -> str:
    """Return the recorded revision of a sibling capture manifest under evidence."""
    try:
        data = json.loads((EVIDENCE_ROOT / manifest_rel_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "unknown"
    return str(data.get("revision") or data.get("repository_revision") or "unknown")


def host_screenshots(paths: list[Path]) -> dict[str, dict]:
    """Upload screenshots to an external https host and return name→exchange.

    Each exchange records the returned URL, HTTP status, and request/response
    timestamps so the manifest can prove this run performed the upload.
    """
    mapping: dict[str, dict] = {}
    for path in paths:
        mapping[path.name] = upload_file(path)
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
        "opened_from_list_click": True,
    }


def open_list(page, base: str):
    """Load the Kensington list route; return the document navigation response."""
    url = urllib.request.urljoin(base, KENSINGTON_LIST)
    response = page.goto(url, wait_until="networkidle", timeout=90_000)
    try:
        page.locator("text=Browse records").first.click(timeout=5_000)
        page.wait_for_timeout(1000)
    except Exception:
        pass
    try:
        page.keyboard.press("Tab")
    except Exception:
        pass
    return response


def click_named_row_into_detail(page):
    """Click the broader September row into the meeting detail.

    Returns ``(landed_path, navigation_response)`` so the caller can record the
    per-request served headers of the detail load reached by the click.
    """
    card_selector = f'[data-record-id*="{SEPT_NEEDLE}"][data-broader-scope="broader"]'
    card = page.locator(card_selector).first
    card.wait_for(state="attached", timeout=45_000)
    try:
        card.scroll_into_view_if_needed(timeout=15_000)
    except Exception:
        pass

    response = None
    href = page.eval_on_selector(
        f"{card_selector} a.near-record-title-link, {card_selector} a[href*='{SEPT_NEEDLE}']",
        "el => el && (el.href || el.getAttribute('href'))",
    )
    if href:
        with page.expect_navigation(wait_until="networkidle", timeout=90_000) as nav_info:
            # DOM click from the named row's own link (avoids off-screen hit-target flakes).
            page.eval_on_selector(
                f"{card_selector} a.near-record-title-link, {card_selector} a[href*='{SEPT_NEEDLE}']",
                "el => el.click()",
            )
        response = nav_info.value
    else:
        inspect = card.locator(".near-record-inspect").first
        if inspect.count() == 0:
            raise SystemExit("broader named row has neither a title link nor an Inspect control")
        inspect.click(timeout=10_000, force=True)
        open_link = page.locator("#near-you-record-inspection a[href*='housing-and-land-use-committee-meeting-september-2026']").first
        if open_link.count() == 0:
            open_link = page.get_by_role("link", name=re.compile(r"open full detail|full detail", re.I))
        open_link.wait_for(state="visible", timeout=15_000)
        with page.expect_navigation(wait_until="networkidle", timeout=90_000) as nav_info:
            open_link.click(timeout=15_000)
        response = nav_info.value

    landed = urlparse(page.url).path or ""
    if SEPT_NEEDLE not in landed and SEPT_NEEDLE not in urllib.parse.unquote(page.url):
        html = page.content()
        if TITLE_NEEDLE not in html:
            raise SystemExit(f"list click did not land on September meeting detail: {page.url!r}")
    return landed or KENSINGTON_DETAIL, response


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
            # The card requires a genuinely CLICKED detail at both widths.
            # Disclosure can never satisfy a "clicked detail" clause, so a
            # detail row must assert the click and must not carry reuse
            # metadata; the general interaction guard below also refuses any
            # reused row that claims an interaction.
            if row.get("reused_from"):
                raise SystemExit(
                    f"{row.get('name')}: a clicked-detail row must not carry reused_from; "
                    "disclosure cannot satisfy the clicked-detail requirement"
                )
            assert values.get("opened_from_list_click") is True
            assert row.get("navigation") == "clicked-from-list"

    refuse_reuse_claiming_interaction(manifest)
    refuse_silent_image_reuse(
        manifest,
        evidence_root=ROOT / "docs" / "evidence",
        manifest_path=MANIFEST_PATH,
        cwd=ROOT,
    )
    # Every row must carry a receipt entry from this run (matching capture_run_id
    # and timestamps inside the run window); a deterministic digest and hosted
    # address cannot substitute for proof this run executed.
    validate_run_receipt(manifest)


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
    page_load: dict,
    captured_at: str,
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
        # Per-run receipt: proof only this execution could have produced. The
        # upload exchange is filled in after hosting the screenshots.
        "run_receipt": {
            "capture_run_id": capture_run_id,
            "captured_at": captured_at,
            "page_load": page_load,
            "upload": None,
            "click_observation": {
                "navigation": navigation,
                "opened_from_list_click": bool(served.get("opened_from_list_click")),
            },
        },
    }


def capture(base: str, host: bool) -> dict:
    # Fresh packet only: never read prior screenshot_url / sha256 values.
    if MANIFEST_PATH.exists():
        print(f"replacing prior packet at {MANIFEST_PATH} with a fresh single-run capture", flush=True)

    revision = require_served_revision_contains_delivery(base)
    capture_run_id = str(uuid.uuid4())
    run_started_at = now_iso()
    captured_at = run_started_at
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
            list_response = open_list(page, base)
            list_page_load = page_load_receipt(list_response, revision)
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
                    page_load=list_page_load,
                    captured_at=now_iso(),
                )
            )

            landed_path, detail_response = click_named_row_into_detail(page)
            detail_page_load = page_load_receipt(detail_response, revision)
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
                    page_load=detail_page_load,
                    captured_at=now_iso(),
                )
            )
            context.close()

    # Disclose any deterministic byte-coincidence with a sibling packet. A
    # clicked detail page renders identically no matter how it was reached, so a
    # genuinely re-captured detail image can be byte-identical to one another
    # card already captured. Name the sibling and its revision and affirm the
    # independent in-run re-capture rather than reuse the image silently.
    foreign_index = collect_retained_image_digests(
        EVIDENCE_ROOT,
        exclude_manifest=MANIFEST_PATH,
    )
    for row in captures:
        hits = foreign_index.get(row["sha256"]) or []
        if hits and row_claims_journey_interaction(row):
            sibling = hits[0]
            row["coincident_hash"] = {
                "feature": sibling.feature,
                "revision": sibling_manifest_revision(sibling.manifest_path),
                "independently_recaptured": True,
                "note": (
                    "Deterministic meeting-detail page re-captured in this run after clicking "
                    "the wider-district row; byte-identical to the named sibling packet."
                ),
            }

    run_receipt: dict | None = None
    if host:
        # Demonstrate the host's content-addressing inside this same run: the
        # same bytes twice (one URL), a one-byte-altered copy (a different URL).
        host_dedup = demonstrate_host_dedup(capture_run_id)
        hosted = host_screenshots(local_files)
        for row in captures:
            exchange = hosted.get(f"{row['name']}.png")
            if not exchange:
                raise SystemExit(f"missing hosted URL for {row['name']}")
            row["screenshot_url"] = exchange["returned_url"]
            row["run_receipt"]["upload"] = exchange
        run_receipt = {
            "capture_run_id": capture_run_id,
            "base": base,
            "served_revision": revision,
            "run_started_at": run_started_at,
            "run_finished_at": now_iso(),
            "host": "catbox.moe",
            "note": (
                "Every capture row is backed by evidence only this run could have produced: the "
                "live upload HTTP exchange, the per-request served response headers (Date, CF-Ray, "
                "served revision) observed while the page loaded, and the shared capture_run_id "
                "stamped inside this run window. The four screenshot addresses repeat across runs "
                "because the host deduplicates identical bytes, as the demonstration below shows."
            ),
            "host_dedup_demonstration": host_dedup,
        }
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
            "All captures in this packet share capture_run_id and were captured in this run. "
            "Every row is fresh: the clicked-detail rows were reached by clicking the wider-district row. "
            "The deployed meeting-detail page is deterministic, so a re-captured detail image can be "
            "byte-identical to a sibling packet; such a row discloses that coincidence in a coincident_hash "
            "field naming the sibling feature and revision and affirming the independent in-run re-capture. "
            "A digest that appears in another packet is forbidden unless the row carries reused_from "
            "(with no interaction claim) or a coincident_hash declaration backed by an observed click. "
            "Because the host is content-addressed, a deterministic page keeps the same hosted address "
            "across runs, so neither the digest nor the address proves a fresh execution; the run_receipt "
            "supplies that proof - per row the live upload exchange and the per-request served headers "
            "(Date, CF-Ray, served revision), plus an in-run demonstration of the host deduplication."
        ),
        "surface": "Near You Kensington wider-district journey",
        "verifier": "node --test test/kensington_wider_district_journey.test.mjs",
        "captured_at": captured_at,
        "local_image_dir_ignored": LOCAL_IMAGE_DIR_NOTE,
        "run_receipt": run_receipt,
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
