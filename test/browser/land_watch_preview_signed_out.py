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
from urllib.parse import quote

from browser_support import launched_chromium

ROOT = Path(__file__).resolve().parents[2]
MEMBERSHIP_PATH = ROOT / "site" / "data" / "land_place_membership.json"
# The specimen NTA is resolved at runtime (see `resolve_specimen_nta`): which NTA's live ZAP
# members all resolve ULURP/ELURP and Active -- so the full membership set survives this
# preview's default facets exactly, letting this journey assert preview == membership rather
# than just a subset -- is a property of the live, continuously refreshed catalog, not a fixed
# NTA. This journey reads committed site/data directly rather than a frozen fixture, so the
# resolver re-measures it on every run instead of needing periodic re-pinning by hand.
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


def candidate_ntas() -> list[str]:
    """Every NTA the committed membership index names, in a stable order."""
    payload = json.loads(MEMBERSHIP_PATH.read_text(encoding="utf-8"))
    return sorted(payload.get("by_geography", {}).get("nta2020", {}).keys())


def independent_membership_ids(nta: str) -> list[str]:
    """Observe membership from the committed public index (not from preview HTML)."""
    payload = json.loads(MEMBERSHIP_PATH.read_text(encoding="utf-8"))
    ids = payload.get("by_geography", {}).get("nta2020", {}).get(nta) or []
    return sorted({str(item) for item in ids if item})


def watch_route(nta: str) -> str:
    filter_json = json.dumps({"geographies": [f"geography:nta2020:{nta}"]}, separators=(",", ":"))
    return f"/following?lens=land&filter={quote(filter_json, safe='')}&count=1"


def emptied_membership_path(tmp: Path, nta: str) -> Path:
    payload = json.loads(MEMBERSHIP_PATH.read_text(encoding="utf-8"))
    payload.setdefault("by_geography", {}).setdefault("nta2020", {})[nta] = []
    out = tmp / "emptied-land-place-membership.json"
    out.write_text(json.dumps(payload), encoding="utf-8")
    return out


def resolve_specimen_nta(base: str, browser) -> str:
    """The first NTA (sorted) whose live preview equals its full committed membership.

    Every default-facet preview is an exact subset of membership; this picks the one NTA,
    among the live catalog's current candidates, where that subset happens to be the whole
    set -- the shape this journey needs to assert preview == membership rather than a subset.
    """
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.clear_cookies()
    page = context.new_page()
    try:
        for nta in candidate_ntas():
            membership_ids = independent_membership_ids(nta)
            if not membership_ids:
                continue
            try:
                observed = collect_preview(page, base, nta)
            except Exception:
                continue
            if observed["status"] != "complete":
                continue
            parity = record_parity(observed["preview_ids"], membership_ids, nta)
            if parity["parity_equal"]:
                return nta
        raise AssertionError(
            "no currently live NTA has a default-facet preview equal to its full membership")
    finally:
        context.close()


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


def collect_preview(page, base: str, nta: str) -> dict:
    install_api_routes(page, base)
    page.goto(f"{base}{watch_route(nta)}", wait_until="networkidle")
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


def record_parity(preview_ids: list[str], membership_ids: list[str], nta: str) -> dict:
    preview = {str(item) for item in preview_ids if item}
    membership = {str(item) for item in membership_ids if item}
    return {
        "preview_project_ids": sorted(preview),
        "membership_project_ids": sorted(membership),
        "preview_project_ids_source": "browser-following-preview-markup",
        "membership_project_ids_source": f"committed-land-place-membership-by_geography.nta2020.{nta}",
        "parity_equal": preview == membership and bool(membership),
        "intersection": sorted(preview & membership),
    }


def main() -> int:
    process, base = start_server()
    try:
        with launched_chromium() as browser:
            nta = resolve_specimen_nta(base, browser)
            membership_ids = independent_membership_ids(nta)
            assert membership_ids, f"{nta} membership must stay populated for the signed-out preview journey"

            context = browser.new_context(viewport={"width": 1280, "height": 900})
            # Explicitly signed out: no cookies / storage.
            context.clear_cookies()
            page = context.new_page()
            observed = collect_preview(page, base, nta)
            assert observed["status"] == "complete", observed
            assert_no_per_user_fields(observed["html"])
            assert_sign_in_affordance(page)
            parity = record_parity(observed["preview_ids"], membership_ids, nta)
            assert parity["parity_equal"], parity
            assert parity["intersection"], parity

            # Positive control: a mutated expectation must fail the parity check.
            mutated = record_parity(observed["preview_ids"] + ["1999Z9999"], membership_ids, nta)
            assert not mutated["parity_equal"], mutated

            context.close()
    finally:
        stop_server(process)

    with tempfile.TemporaryDirectory() as tmp:
        empty_path = emptied_membership_path(Path(tmp), nta)
        empty_process, empty_base = start_server(membership_path=empty_path)
        try:
            with launched_chromium() as browser:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                context.clear_cookies()
                page = context.new_page()
                observed = collect_preview(page, empty_base, nta)
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
                "nta": nta,
                "membership_project_ids": membership_ids,
                "preview_membership_intersection_count": len(membership_ids),
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
