"""Signed-out Land geography Following preview browser acceptance.

Loads the Following page in real Chromium with the real stylesheet, compares
preview project identifiers against an independently observed membership list,
and exercises emptied-source plus positive-control failure paths.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from browser_support import launched_chromium

ROOT = Path(__file__).resolve().parents[2]
MEMBERSHIP_PATH = ROOT / "site" / "data" / "land_place_membership.json"
WATCH_ROUTE = (
    "/following?lens=land&filter="
    "%7B%22geographies%22%3A%5B%22geography%3Anta2020%3ASI0105%22%5D%7D&count=1"
)
PREVIEW_ID_RE = re.compile(r'data-preview-id="([^"]+)"')
STATUS_RE = re.compile(r'data-following-preview-status="([^"]+)"')
PER_USER_MARKERS = (
    'data-session-recognized="true"',
    "data-watch-key=",
    'data-personal-state="recognized"',
    "subscriber_id",
    "watch_id",
    "prefs_token",
    "cs_session=",
)


def start_server(*, membership_path: Path | None = None) -> tuple[subprocess.Popen, str]:
    env = os.environ.copy()
    env["FOLLOWING_TODAY_ISO"] = "2026-09-26"
    if membership_path is not None:
        env["LAND_PLACE_MEMBERSHIP_PATH"] = str(membership_path)
    process = subprocess.Popen(
        ["node", "tools/serve_following_land_preview.mjs"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    base = process.stdout.readline().strip()
    if not base.startswith("http://127.0.0.1:"):
        err = process.stderr.read() if process.stderr else ""
        process.terminate()
        raise RuntimeError(f"Following preview server failed to start: {base!r} {err}")
    return process, base


def stop_server(process: subprocess.Popen) -> None:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def independent_membership_ids() -> list[str]:
    """Observe membership from the committed public index (not from preview HTML)."""
    payload = json.loads(MEMBERSHIP_PATH.read_text(encoding="utf-8"))
    ids = payload.get("by_geography", {}).get("nta2020", {}).get("SI0105") or []
    return sorted({str(item) for item in ids if item})


def emptied_membership_path(tmp: Path) -> Path:
    payload = json.loads(MEMBERSHIP_PATH.read_text(encoding="utf-8"))
    payload.setdefault("by_geography", {}).setdefault("nta2020", {})["SI0105"] = []
    out = tmp / "emptied-land-place-membership.json"
    out.write_text(json.dumps(payload), encoding="utf-8")
    return out


def install_api_routes(page, base: str) -> None:
    """Keep the personal island on the local signed-out stub (no remote session)."""

    def fulfill_personal(route):
        route.fulfill(
            status=200,
            headers={"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"},
            body=(
                '<div data-session-recognized="false" data-personal-state="unrecognized">'
                "<p>Open a CityScroll email to see your watches.</p>"
                '<p class="following-personal-recovery">'
                '<a href="#create" data-following-create-recovery>Create a watch</a></p></div>'
            ),
        )

    page.route("https://api.cityscroll.org/following/personal", fulfill_personal)
    page.route("https://api.cityscroll.org/following/personal**", fulfill_personal)
    # Prefer the local origin personal endpoint when the document is rewritten.
    page.route(f"{base}/following/personal", fulfill_personal)
    page.route(f"{base}/following/personal**", fulfill_personal)


def collect_preview(page, base: str) -> dict:
    install_api_routes(page, base)
    page.goto(f"{base}{WATCH_ROUTE}", wait_until="networkidle")
    page.wait_for_selector('[data-session-recognized="false"]', state="attached", timeout=5000)
    # Real stylesheet must load for the acceptance journey.
    hrefs = page.eval_on_selector_all(
        'link[rel="stylesheet"]',
        "nodes => nodes.map((n) => n.href)",
    )
    assert any(href.endswith("/brand.css") or "/brand.css" in href for href in hrefs), hrefs
    assert any(
        href.endswith("/civic-documents.css") or "/civic-documents.css" in href for href in hrefs
    ), hrefs
    panel = page.locator("[data-following-preview-panel]")
    assert panel.count() == 1
    html = page.content()
    status = STATUS_RE.search(html)
    ids = PREVIEW_ID_RE.findall(html)
    return {
        "html": html,
        "status": status.group(1) if status else None,
        "preview_ids": ids,
        "stylesheet_hrefs": hrefs,
    }


def assert_no_per_user_fields(html: str) -> None:
    lowered = html.lower()
    for marker in PER_USER_MARKERS:
        assert marker.lower() not in lowered, f"anonymous response leaked {marker}"


def assert_sign_in_affordance(page) -> None:
    assert page.locator('[data-following-subscribe-form] input[type="email"]').count() == 1
    # Personal island may be demoted/collapsed on create-first preview layouts; presence is enough.
    assert page.locator('[data-session-recognized="false"]').count() >= 1
    assert page.locator("text=Open a CityScroll email to see your watches").count() >= 1


def record_parity(preview_ids: list[str], membership_ids: list[str]) -> dict:
    preview = {str(item) for item in preview_ids if item}
    membership = {str(item) for item in membership_ids if item}
    return {
        "preview_project_ids": sorted(preview),
        "membership_project_ids": sorted(membership),
        "preview_project_ids_source": "browser-following-preview-markup",
        "membership_project_ids_source": "committed-land-place-membership-by_geography.nta2020.SI0105",
        "parity_equal": preview == membership and bool(membership),
        "intersection": sorted(preview & membership),
    }


def main() -> int:
    membership_ids = independent_membership_ids()
    assert "2026R0127" in membership_ids, membership_ids

    process, base = start_server()
    try:
        with launched_chromium() as browser:
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            # Explicitly signed out: no cookies / storage.
            context.clear_cookies()
            page = context.new_page()
            observed = collect_preview(page, base)
            assert observed["status"] == "complete", observed
            assert_no_per_user_fields(observed["html"])
            assert_sign_in_affordance(page)
            parity = record_parity(observed["preview_ids"], membership_ids)
            assert parity["parity_equal"], parity
            assert "2026R0127" in parity["intersection"], parity

            # Positive control: a mutated expectation must fail the parity check.
            mutated = record_parity(observed["preview_ids"] + ["1999Z9999"], membership_ids)
            assert not mutated["parity_equal"], mutated

            context.close()
    finally:
        stop_server(process)

    with tempfile.TemporaryDirectory() as tmp:
        empty_path = emptied_membership_path(Path(tmp))
        empty_process, empty_base = start_server(membership_path=empty_path)
        try:
            with launched_chromium() as browser:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                context.clear_cookies()
                page = context.new_page()
                observed = collect_preview(page, empty_base)
                assert observed["status"] == "complete", observed
                assert observed["preview_ids"] == [], observed
                assert "No matches now — still watch for new" in observed["html"]
                assert_no_per_user_fields(observed["html"])
                assert_sign_in_affordance(page)
                context.close()
        finally:
            stop_server(empty_process)

    print(
        json.dumps(
            {
                "ok": True,
                "membership_project_ids": membership_ids,
                "preview_includes": "2026R0127",
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - surface harness failures to node:test
        print(f"land_watch_preview_signed_out failed: {exc}", file=sys.stderr)
        raise
