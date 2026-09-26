#!/usr/bin/env python3
"""Capture deployed homepage place-entry journeys at desktop and phone widths.

Runs against the production Pages site. Refuses until the served
``/artifact-manifest.json`` revision contains the landed delivery commit
recorded in ``docs/evidence/home-local-entry-journey/delivery.json``.

Journeys (both widths):
  - initial homepage place entry
  - typed Midwood address
  - typed Kensington neighborhood
  - controlled Midwood geolocation grant
  - geolocation permission denial, then typed Kensington recovery

Screenshot binaries stay under the local task scratch directory. With
``--host``, every row retains an https screenshot URL plus the in-run receipt
introduced for the Kensington wider-district capture (live upload exchange and
per-load served headers).
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
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "test" / "browser"))
from browser_support import launched_chromium  # noqa: E402
from capture_image_provenance import (  # noqa: E402
    refuse_reuse_claiming_interaction,
    refuse_silent_image_reuse,
)
from capture_run_receipt import validate_run_receipt  # noqa: E402
from deployed_capture_ancestor import (  # noqa: E402
    DeployPendingError,
    WrongPinError,
    load_recorded_delivery,
    require_served_page_revision_contains_delivery,
    revision_contains_ancestor,
)

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "home-local-entry-journey"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "home-local-entry-journey-screenshots"
PUBLIC_ALIAS = "c0b9b1f319b51"
DEFAULT_BASE = "https://cityscroll.org/"
REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY_PATH)
MIDWOOD_POINT = {"latitude": 40.6297346, "longitude": -73.9615272}
MIDWOOD_ROUTE = "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings"
KENSINGTON_ROUTE = "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings"
VIEWPORTS = (
    ("desktop", 1440, 900),
    ("phone", 390, 844),
)
LOCAL_IMAGE_DIR_NOTE = "home-local-entry-journey-screenshots (local ignored dir under task scratch)"
DENIAL_STATUS_RE = re.compile(r"permission was not granted|Choose an area", re.I)


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


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


PAGE_LOAD_HEADER_KEYS = ("date", "cf-ray", "cf-cache-status", "age", "last-modified", "etag")


def page_load_receipt(response, served_revision: str) -> dict:
    """Record the per-request served headers proving this run loaded the page."""
    headers: dict[str, str | None] = {}
    status = None
    url = None
    if response is not None:
        try:
            raw = response.headers
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
    """Show, inside this run, why identical bytes keep the same hosted address."""
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    base_bytes = (
        "cityscroll-host-dedup-demonstration\n"
        f"{capture_run_id}\n"
        f"{uuid.uuid4().hex}{os.urandom(24).hex()}\n"
    ).encode("utf-8")
    altered_bytes = bytearray(base_bytes)
    altered_bytes[-1] = altered_bytes[-1] ^ 0x01
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


def host_screenshots(paths: list[Path]) -> dict[str, dict]:
    """Upload screenshots to an external https host and return name→exchange."""
    mapping: dict[str, dict] = {}
    for path in paths:
        mapping[path.name] = upload_file(path)
    return mapping


def wait_home_ready(page) -> None:  # noqa: ANN001
    page.wait_for_selector("[data-home-local-entry]", timeout=30000)
    page.wait_for_selector("[data-home-local-input]", timeout=30000)
    page.locator("[data-home-local-input]").focus()
    page.wait_for_function(
        """() => {
          const root = document.querySelector('[data-home-local-entry]');
          return Boolean(root && root.dataset.homeLocalMounted === 'true');
        }""",
        timeout=30000,
    )


def observe_initial(page) -> dict:  # noqa: ANN001
    return page.evaluate(
        """() => {
          const root = document.querySelector('[data-home-local-entry]');
          const input = document.querySelector('[data-home-local-input]');
          const locationBtn = document.querySelector('[data-home-local-location]');
          const topic = document.querySelector('[data-home-topic-entry]');
          const following = document.querySelector('a[href="/following/"]');
          return {
            heading: document.querySelector('#home-local-heading')?.textContent || null,
            has_location_button: Boolean(locationBtn) && !locationBtn.hidden,
            has_place_input: Boolean(input),
            has_topic_search: Boolean(topic),
            has_following_link: Boolean(following),
            overflow_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            mounted: root?.dataset?.homeLocalMounted === 'true',
            path: location.pathname,
          };
        }"""
    )


def observe_near_you(page, *, expected_geo: str) -> dict:  # noqa: ANN001
    page.wait_for_timeout(500)
    href = page.url
    path = urlparse(href).path or ""
    return {
        "href": href,
        "path": path,
        "geo": expected_geo,
        "geo_in_url": expected_geo.replace(":", "%3A") in href or expected_geo in href,
        "ephemeral_leak": any(
            token in href.lower() for token in ("address=", "lat=", "lon=", "810", "kensington")
        ),
    }


def observe_denial(page) -> dict:  # noqa: ANN001
    return page.evaluate(
        """() => {
          const status = document.querySelector('[data-home-local-status]');
          const input = document.querySelector('[data-home-local-input]');
          const locationBtn = document.querySelector('[data-home-local-location]');
          return {
            path: location.pathname,
            status_text: status?.textContent || null,
            input_usable: Boolean(input) && !input.disabled,
            location_button_enabled: Boolean(locationBtn) && !locationBtn.disabled,
            still_on_home: location.pathname === '/' || location.pathname === '',
          };
        }"""
    )


def deny_geolocation_permission(page, origin: str) -> None:  # noqa: ANN001
    """Force browser geolocation permission to denied for this origin."""
    # Playwright's BrowserContext.grant_permissions does not expose "denied";
    # CDP Browser.setPermission does.
    client = page.context.new_cdp_session(page)
    client.send(
        "Browser.setPermission",
        {
            "permission": {"name": "geolocation"},
            "setting": "denied",
            "origin": origin.rstrip("/"),
        },
    )


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
        "run_receipt": {
            "capture_run_id": capture_run_id,
            "captured_at": captured_at,
            "page_load": page_load,
            "upload": None,
            "click_observation": {
                "navigation": navigation,
            },
        },
    }


def validate_manifest(manifest: dict) -> None:
    assert manifest["schema"] == "cityscroll.render_capture_manifest.v1"
    assert manifest["image_binaries_committed"] is False
    assert manifest.get("required_ancestor") == REQUIRED_ANCESTOR
    assert manifest.get("required_ancestor_contained") is True
    run_id = manifest.get("capture_run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise SystemExit("manifest missing capture_run_id for a single coherent run")
    captures = manifest.get("captures") or []
    if len(captures) < 10:
        raise SystemExit(f"expected at least 10 capture rows (5 journeys × 2 widths), got {len(captures)}")
    seen_digests: set[str] = set()
    required_name_parts = (
        "home-initial-",
        "home-midwood-result-",
        "home-kensington-result-",
        "home-geolocation-grant-",
        "home-geolocation-denial-",
        "home-geolocation-denial-recovery-",
    )
    names = [str(row.get("name") or "") for row in captures]
    for prefix in required_name_parts:
        if not any(name.startswith(prefix) for name in names):
            raise SystemExit(f"manifest missing required journey rows starting with {prefix!r}")
    for row in captures:
        assert str(row.get("screenshot_url") or "").startswith("https://"), row.get("name")
        assert re.fullmatch(r"[0-9a-f]{64}", row.get("sha256") or ""), row.get("name")
        if row.get("capture_run_id") != run_id:
            raise SystemExit(
                f"{row.get('name')}: capture_run_id {row.get('capture_run_id')!r} diverges from manifest run {run_id!r}"
            )
        digest = row["sha256"]
        if digest in seen_digests and not row.get("reused_from"):
            raise SystemExit(f"{row.get('name')}: duplicate sha256 within the same packet without reused_from")
        seen_digests.add(digest)
    refuse_reuse_claiming_interaction(manifest)
    refuse_silent_image_reuse(
        manifest,
        evidence_root=ROOT / "docs" / "evidence",
        manifest_path=MANIFEST_PATH,
        cwd=ROOT,
    )
    validate_run_receipt(manifest)


def open_home(page, base: str):
    """Load the production homepage; return the document navigation response."""
    url = urllib.request.urljoin(base, "/")
    response = page.goto(url, wait_until="domcontentloaded", timeout=90_000)
    wait_home_ready(page)
    return response


def capture(base: str, host: bool) -> dict:
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
    origin = base.rstrip("/")

    with launched_chromium() as browser:
        for viewport_name, width, height in VIEWPORTS:
            # --- Initial + typed Midwood ---
            context = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent="cityscroll-home-local-entry/1",
            )
            page = context.new_page()
            home_response = open_home(page, base)
            home_page_load = page_load_receipt(home_response, revision)
            initial = observe_initial(page)
            if not initial.get("has_location_button") or not initial.get("has_place_input"):
                raise SystemExit(f"{viewport_name}: place entry missing on initial screen: {initial!r}")
            if initial.get("overflow_x", 0) > 1:
                raise SystemExit(f"{viewport_name}: initial horizontal overflow {initial['overflow_x']}")

            initial_name = f"home-initial-{viewport_name}"
            initial_path = SCREENSHOT_DIR / f"{initial_name}.png"
            page.screenshot(path=str(initial_path), full_page=True)
            local_files.append(initial_path)
            captures.append(
                capture_row(
                    name=initial_name,
                    route="/",
                    width=width,
                    height=height,
                    revision=revision,
                    assertion=(
                        "Deployed homepage place entry present; Use my location present; "
                        "address/place input present; topic search and Following remain reachable; "
                        "horizontal overflow ≤ 1px"
                    ),
                    image_path=initial_path,
                    served=initial,
                    capture_run_id=capture_run_id,
                    navigation="direct",
                    page_load=home_page_load,
                    captured_at=now_iso(),
                )
            )

            page.fill("[data-home-local-input]", "810 East 16th Street Brooklyn")
            with page.expect_navigation(wait_until="domcontentloaded", timeout=60000) as nav_info:
                page.click("[data-home-local-submit]")
            midwood_response = nav_info.value
            midwood_page_load = page_load_receipt(midwood_response, revision)
            midwood_served = observe_near_you(page, expected_geo="nta2020:BK1403")
            if not midwood_served.get("geo_in_url"):
                raise SystemExit(f"{viewport_name}: Midwood navigation failed: {midwood_served!r}")
            if midwood_served.get("ephemeral_leak"):
                raise SystemExit(f"{viewport_name}: ephemeral values leaked into Midwood URL: {midwood_served!r}")

            midwood_name = f"home-midwood-result-{viewport_name}"
            midwood_path = SCREENSHOT_DIR / f"{midwood_name}.png"
            page.screenshot(path=str(midwood_path), full_page=True)
            local_files.append(midwood_path)
            captures.append(
                capture_row(
                    name=midwood_name,
                    route=MIDWOOD_ROUTE,
                    width=width,
                    height=height,
                    revision=revision,
                    assertion=(
                        "Typed 810 East 16th Street from deployed / selects Midwood; "
                        "shared URL carries geography only"
                    ),
                    image_path=midwood_path,
                    served=midwood_served,
                    capture_run_id=capture_run_id,
                    navigation="typed-submit",
                    page_load=midwood_page_load,
                    captured_at=now_iso(),
                )
            )
            context.close()

            # --- Typed Kensington ---
            context2 = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent="cityscroll-home-local-entry/1",
            )
            page2 = context2.new_page()
            open_home(page2, base)
            page2.fill("[data-home-local-input]", "Kensington")
            with page2.expect_navigation(wait_until="domcontentloaded", timeout=60000) as nav_info:
                page2.click("[data-home-local-submit]")
            kensington_response = nav_info.value
            kensington_page_load = page_load_receipt(kensington_response, revision)
            kensington_served = observe_near_you(page2, expected_geo="nta2020:BK1203")
            if not kensington_served.get("geo_in_url"):
                raise SystemExit(f"{viewport_name}: Kensington navigation failed: {kensington_served!r}")

            kensington_name = f"home-kensington-result-{viewport_name}"
            kensington_path = SCREENSHOT_DIR / f"{kensington_name}.png"
            page2.screenshot(path=str(kensington_path), full_page=True)
            local_files.append(kensington_path)
            captures.append(
                capture_row(
                    name=kensington_name,
                    route=KENSINGTON_ROUTE,
                    width=width,
                    height=height,
                    revision=revision,
                    assertion="Typed Kensington from deployed / selects BK1203 Near You state",
                    image_path=kensington_path,
                    served=kensington_served,
                    capture_run_id=capture_run_id,
                    navigation="typed-submit",
                    page_load=kensington_page_load,
                    captured_at=now_iso(),
                )
            )
            context2.close()

            # --- Geolocation grant (Midwood parcel) ---
            context3 = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent="cityscroll-home-local-entry/1",
                geolocation=MIDWOOD_POINT,
                permissions=["geolocation"],
            )
            page3 = context3.new_page()
            open_home(page3, base)
            with page3.expect_navigation(wait_until="domcontentloaded", timeout=60000) as nav_info:
                page3.click("[data-home-local-location]")
            grant_response = nav_info.value
            grant_page_load = page_load_receipt(grant_response, revision)
            grant_served = observe_near_you(page3, expected_geo="nta2020:BK1403")
            if not grant_served.get("geo_in_url"):
                raise SystemExit(f"{viewport_name}: geolocation grant failed: {grant_served!r}")

            grant_name = f"home-geolocation-grant-{viewport_name}"
            grant_path = SCREENSHOT_DIR / f"{grant_name}.png"
            page3.screenshot(path=str(grant_path), full_page=True)
            local_files.append(grant_path)
            captures.append(
                capture_row(
                    name=grant_name,
                    route=MIDWOOD_ROUTE,
                    width=width,
                    height=height,
                    revision=revision,
                    assertion="Controlled Midwood parcel geolocation grant on deployed / selects BK1403",
                    image_path=grant_path,
                    served=grant_served,
                    capture_run_id=capture_run_id,
                    navigation="geolocation-grant",
                    page_load=grant_page_load,
                    captured_at=now_iso(),
                )
            )
            context3.close()

            # --- Geolocation denial + Kensington recovery ---
            context4 = browser.new_context(
                viewport={"width": width, "height": height},
                user_agent="cityscroll-home-local-entry/1",
            )
            page4 = context4.new_page()
            deny_home_response = open_home(page4, base)
            deny_home_page_load = page_load_receipt(deny_home_response, revision)
            deny_geolocation_permission(page4, origin)
            page4.click("[data-home-local-location]")
            page4.wait_for_function(
                """() => {
                  const status = document.querySelector('[data-home-local-status]');
                  const text = (status && status.textContent) || '';
                  return /permission was not granted|Choose an area/i.test(text);
                }""",
                timeout=30000,
            )
            denial_served = observe_denial(page4)
            if not denial_served.get("still_on_home"):
                raise SystemExit(f"{viewport_name}: denial navigated away unexpectedly: {denial_served!r}")
            if not DENIAL_STATUS_RE.search(str(denial_served.get("status_text") or "")):
                raise SystemExit(f"{viewport_name}: denial status missing: {denial_served!r}")
            if not denial_served.get("input_usable"):
                raise SystemExit(f"{viewport_name}: place input unusable after denial: {denial_served!r}")

            denial_name = f"home-geolocation-denial-{viewport_name}"
            denial_path = SCREENSHOT_DIR / f"{denial_name}.png"
            page4.screenshot(path=str(denial_path), full_page=True)
            local_files.append(denial_path)
            captures.append(
                capture_row(
                    name=denial_name,
                    route="/",
                    width=width,
                    height=height,
                    revision=revision,
                    assertion=(
                        "Browser geolocation permission denied on deployed / keeps the resident on the "
                        "homepage with a usable place chooser and permission-recovery copy"
                    ),
                    image_path=denial_path,
                    served=denial_served,
                    capture_run_id=capture_run_id,
                    navigation="geolocation-denial",
                    page_load=deny_home_page_load,
                    captured_at=now_iso(),
                )
            )

            page4.fill("[data-home-local-input]", "Kensington")
            with page4.expect_navigation(wait_until="domcontentloaded", timeout=60000) as nav_info:
                page4.click("[data-home-local-submit]")
            recovery_response = nav_info.value
            recovery_page_load = page_load_receipt(recovery_response, revision)
            recovery_served = observe_near_you(page4, expected_geo="nta2020:BK1203")
            if not recovery_served.get("geo_in_url"):
                raise SystemExit(
                    f"{viewport_name}: denial recovery Kensington navigation failed: {recovery_served!r}"
                )

            recovery_name = f"home-geolocation-denial-recovery-{viewport_name}"
            recovery_path = SCREENSHOT_DIR / f"{recovery_name}.png"
            page4.screenshot(path=str(recovery_path), full_page=True)
            local_files.append(recovery_path)
            captures.append(
                capture_row(
                    name=recovery_name,
                    route=KENSINGTON_ROUTE,
                    width=width,
                    height=height,
                    revision=revision,
                    assertion=(
                        "After geolocation denial on deployed /, typing Kensington reaches BK1203 "
                        "without reload or an account"
                    ),
                    image_path=recovery_path,
                    served=recovery_served,
                    capture_run_id=capture_run_id,
                    navigation="geolocation-denial-recovery",
                    page_load=recovery_page_load,
                    captured_at=now_iso(),
                )
            )
            context4.close()

    run_receipt: dict | None = None
    if host:
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
                "stamped inside this run window. Screenshot addresses may repeat across runs "
                "because the host deduplicates identical bytes, as the demonstration below shows."
            ),
            "host_dedup_demonstration": host_dedup,
        }
    else:
        for row in captures:
            row["screenshot_url"] = f"file://{SCREENSHOT_DIR / (row['name'] + '.png')}"

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "home-local-entry-journey",
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
            "Because the host is content-addressed, a deterministic page keeps the same hosted address "
            "across runs, so neither the digest nor the address proves a fresh execution; the run_receipt "
            "supplies that proof - per row the live upload exchange and the per-request served headers "
            "(Date, CF-Ray, served revision), plus an in-run demonstration of the host deduplication."
        ),
        "surface": "Homepage place-entry journeys into Near You",
        "verifier": "node --test test/home_local_entry_journey.test.mjs",
        "captured_at": captured_at,
        "local_image_dir_ignored": LOCAL_IMAGE_DIR_NOTE,
        "route": "/",
        "exact_links": [
            "/",
            MIDWOOD_ROUTE,
            KENSINGTON_ROUTE,
        ],
        "run_receipt": run_receipt,
        "captures": captures,
    }
    if host:
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
                "hosted": host,
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
        if not DELIVERY_PATH.exists():
            raise SystemExit(f"recorded delivery missing at {DELIVERY_PATH}")
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        validate_manifest(manifest)
        print("ok")
        return 0
    if not DELIVERY_PATH.exists():
        raise SystemExit(f"recorded delivery missing at {DELIVERY_PATH}")
    capture(args.base.rstrip("/") + "/", host=args.host)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
