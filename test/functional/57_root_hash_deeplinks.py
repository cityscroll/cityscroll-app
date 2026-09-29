#!/usr/bin/env python3
"""Root hash ingress reaches every route family registered by the topic SPA."""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


ROOT = pathlib.Path(__file__).resolve().parents[2]
ROUTE_TIMEOUT_MS = int(os.environ.get("CROL_ROOT_HASH_TIMEOUT_MS", "60000"))

# One representative per registry entry. The equality assertion below makes a
# newly registered route fail this census until it has a real browser specimen.
CASES = {
    "browse": ("browse", "#tab-browse.active"),
    "money": ("money", "#tab-money.active"),
    "staffing": ("staffing", "#tab-staffing.active"),
    "exams": ("exams", "#tab-exams.active"),
    "land": ("land", "#tab-land.active"),
    "property": ("property", "#tab-property.active"),
    "rules": ("rules", "#tab-rules.active"),
    "meetings": ("meetings", "#tab-meetings.active"),
    "now": ("now", "#tab-now.active"),
    "map": ("map", "[data-near-you-root]"),
    "alerts": ("alerts", "[data-following-root]"),
    "notice-item": ("notice/20260701099", "#tab-notice.active"),
    "land-item": ("land/2022M0258", "#land-item-card"),
    "exam-item": ("exam/7016", '[data-exam-document="1"]'),
    "vendor": ("vendor/CAMBA", "#tab-entity.active"),
    "agency": (
        "agency/Housing%20Preservation%20and%20Development",
        '[data-civic-object-kind="agency-constellation"], #tab-entity.active',
    ),
    "official": ("official/7801", "#official-skim"),
    "matter": ("matter/84124P0003001", "#tab-entity.active"),
    "investigation-signal": (
        "investigation/signal/root-hash-census-missing",
        "#inv-empty-guide",
    ),
    "investigation-shared": (
        "investigation/shared/root-hash-census-missing",
        "#tab-entity.active",
    ),
    "task": ("task/can-i-bid", "#tab-task.active #taskview"),
    "investigation": ("investigation", "#inv-empty-guide"),
    "notice-collection": ("notice", "#tab-money.active"),
    "exam-collection": ("exam", "#tab-exams.active"),
    "vendor-collection": ("vendor", "#tab-money.active"),
    "agency-collection": ("agency", "#tab-money.active"),
    "matter-collection": ("matter", "#tab-money.active"),
    "investigation-shared-collection": (
        "investigation/shared",
        "#inv-empty-guide",
    ),
    "task-collection": ("task", "#tab-money.active"),
}


def new_page(browser):
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    install_routes(page)
    return page


def registered_route_ids(browser, base: str) -> list[str]:
    page = new_page(browser)
    try:
        page.goto(f"{base}app/#browse", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function(
            "() => document.body.dataset.appReady === 'true' && Array.isArray(globalThis.CrolSpaHashRoutes)",
            timeout=60_000,
        )
        return page.evaluate("globalThis.CrolSpaHashRoutes.map(route => route.id)")
    finally:
        page.close()


def assert_route(browser, base: str, route_id: str, fragment: str, selector: str) -> None:
    page = new_page(browser)
    try:
        page.goto(f"{base}#{fragment}", wait_until="domcontentloaded", timeout=60_000)
        try:
            page.locator(selector).first.wait_for(state="visible", timeout=ROUTE_TIMEOUT_MS)
        except PlaywrightTimeoutError as error:
            raise AssertionError(
                f"{route_id} did not reach {selector} via /#{fragment}: {page.url}"
            ) from error
    finally:
        page.close()


@contextmanager
def pages_server():
    configured = os.environ.get("CROL_PAGES_BASE")
    if configured:
        yield configured.rstrip("/") + "/"
        return

    site_directory = pathlib.Path(os.environ.get("CROL_PAGES_SITE_DIR", ROOT / "_site"))
    if not (site_directory / "app" / "index.html").is_file():
        raise AssertionError(
            f"Pages-shaped artifact missing {site_directory / 'app' / 'index.html'}; "
            "run tools/prepare_functional_site.sh"
        )
    with tempfile.TemporaryDirectory(prefix="crol-pages-canonical-") as temporary:
        ready_file = pathlib.Path(temporary) / "ready"
        process = subprocess.Popen(
            [
                sys.executable,
                "tools/local_site_server.py",
                "--directory",
                str(site_directory),
                "--port",
                "0",
                "--ready-file",
                str(ready_file),
                "--pages-canonicalization",
                "--pages-root-query-fallback",
            ],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if ready_file.is_file() and ready_file.stat().st_size:
                    yield ready_file.read_text(encoding="utf-8").strip().rstrip("/") + "/"
                    return
                if process.poll() is not None:
                    error = process.stderr.read() if process.stderr else ""
                    raise AssertionError(f"Pages-shaped local server exited early: {error}")
                time.sleep(0.1)
            raise AssertionError("timed out waiting for Pages-shaped local server")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def main() -> None:
    with pages_server() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        route_ids = registered_route_ids(browser, base)
        assert len(route_ids) == len(set(route_ids)), f"duplicate SPA route ids: {route_ids}"
        assert set(route_ids) == set(CASES), (
            f"root hash census does not match router registry; "
            f"missing={sorted(set(route_ids) - set(CASES))} "
            f"stale={sorted(set(CASES) - set(route_ids))}"
        )

        for route_id in route_ids:
            assert_route(browser, base, route_id, *CASES[route_id])

        bare = new_page(browser)
        bare.goto(base, wait_until="domcontentloaded", timeout=60_000)
        bare.locator("[data-near-you-root]").wait_for(state="visible", timeout=30_000)
        assert "Near you" in bare.title()
        bare.close()

        unknown = new_page(browser)
        unknown.goto(f"{base}#not-a-cityscroll-route", wait_until="domcontentloaded", timeout=60_000)
        unknown.locator("[data-near-you-root]").wait_for(state="visible", timeout=30_000)
        assert unknown.url.endswith("/#not-a-cityscroll-route"), unknown.url
        unknown.close()

        # Positive control: Pages must collapse the former /index.html target
        # back onto Near You. Disabling root ingress prevents the fixed path
        # from rescuing this deliberately unsafe direct navigation.
        control = new_page(browser)
        control.add_init_script("globalThis.CROL_DISABLE_ROOT_HASH_BOOT = true")
        control.goto(f"{base}index.html#land/2022M0258", wait_until="domcontentloaded", timeout=60_000)
        control.locator("[data-near-you-root]").wait_for(state="visible", timeout=30_000)
        assert control.url == f"{base}#land/2022M0258", control.url
        failed_as_expected = False
        try:
            control.locator("#land-item-card").wait_for(state="attached", timeout=1_500)
        except PlaywrightTimeoutError:
            failed_as_expected = True
        assert failed_as_expected, "positive control unexpectedly reached the Land SPA view"
        control.close()

        # The bare root is a Worker-owned Near You shell, but a query-bearing
        # root can fall through to the Pages topic document. A resolved place
        # must therefore adopt the canonical /near-you/ document explicitly,
        # opening the place's Records as a typed entry does.
        root_place = new_page(browser)
        root_place.goto(base, wait_until="domcontentloaded", timeout=60_000)
        root_place.locator("#near-geo-search-input").fill("Midwood")
        root_place.locator("form.near-geo-search button[type='submit']").click()
        expected_midwood = f"{base}near-you/?geo=nta2020%3ABK1403&surface=records"
        root_place.wait_for_url(expected_midwood, timeout=ROUTE_TIMEOUT_MS)
        root_place.locator("[data-near-you-root]").wait_for(state="visible", timeout=ROUTE_TIMEOUT_MS)
        assert "Near you" in root_place.title()
        assert "page could not update" not in root_place.locator("[data-map-status]").inner_text()
        root_place.close()

        # Positive control: the same resolved-place action already works from
        # the canonical Near You document under the Pages-shaped server.
        canonical_place = new_page(browser)
        canonical_place.goto(f"{base}near-you/", wait_until="domcontentloaded", timeout=60_000)
        canonical_place.locator("#near-geo-search-input").fill("Midwood")
        canonical_place.locator("form.near-geo-search button[type='submit']").click()
        canonical_place.wait_for_url(expected_midwood, timeout=ROUTE_TIMEOUT_MS)
        canonical_place.close()

        browser.close()

    print(
        f"root hash deep links OK routes={len(route_ids)} bare=near-you "
        "unknown=near-you pages-index-control=failed root-place=near-you"
    )


if __name__ == "__main__":
    main()
