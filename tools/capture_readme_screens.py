#!/usr/bin/env python3
"""Capture public-site screenshots for the README.

Captures frames from the live cityscroll.org that each prove a cross-source
capability. All captures are headless Chromium against the public deployment.
Output: docs/readme/*.png

Each frame waits for real content (data-bearing selectors) and asserts that no
skeleton/placeholder is still visible before writing the PNG. Fixed sleeps and
network-idle alone are not treated as readiness.
"""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = "https://cityscroll.org/"
OUT = Path(__file__).resolve().parents[1] / "docs" / "readme"
WIDTH = 1440
HEIGHT = 900
READY_TIMEOUT_MS = 45_000

# Loading placeholders the public site paints before hydration.
# .empty.skel / .skl — content-shaped list placeholders
SKELETON_SELECTOR = ".empty.skel, .skl"


def _is_visible_js() -> str:
    return """
    (el) => {
      if (!el) return false;
      if (typeof el.checkVisibility === "function") {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      return el.getClientRects().length > 0;
    }
    """


def visible_skeletons(page: Page) -> list[str]:
    """Return className strings for any still-visible skeleton/placeholder nodes."""
    return page.evaluate(
        f"""
        () => {{
          const isVisible = {_is_visible_js()};
          return [...document.querySelectorAll({SKELETON_SELECTOR!r})]
            .filter(isVisible)
            .map((el) => el.className || el.tagName);
        }}
        """
    )


def assert_no_visible_skeletons(page: Page, frame: str) -> None:
    """Fail loudly if a loading skeleton is still on screen. Never write that frame."""
    leftover = visible_skeletons(page)
    if leftover:
        raise AssertionError(
            f"{frame}: skeleton/placeholder still visible at capture time: {leftover}. "
            "Refusing to write the PNG."
        )


def wait_ready(page: Page, expression: str, *, frame: str, timeout: int = READY_TIMEOUT_MS) -> None:
    """Wait until a content-readiness predicate is true, then ban skeletons."""
    try:
        page.wait_for_function(expression, timeout=timeout)
    except Exception as exc:
        raise TimeoutError(f"{frame}: content readiness timed out after {timeout}ms") from exc
    page.evaluate("document.fonts && document.fonts.ready")
    assert_no_visible_skeletons(page, frame)


def screenshot(page: Page, name: str) -> Path:
    """Assert no skeletons, then write the PNG. A skeleton must never pass capture."""
    assert_no_visible_skeletons(page, name)
    path = OUT / name
    page.screenshot(path=str(path), animations="disabled")
    # Re-check after the write path so a race cannot leave a skeleton frame committed.
    assert_no_visible_skeletons(page, name)
    return path


def goto_hash(page: Page, hash_route: str | None = None) -> None:
    page.goto(BASE, wait_until="domcontentloaded", timeout=30_000)
    if hash_route:
        route = hash_route if hash_route.startswith("#") else f"#{hash_route}"
        page.evaluate("(h) => { window.location.hash = h; }", route)


def capture_homepage(page: Page) -> None:
    """Homepage masthead flow — CTA under tagline, category tabs, Contracts list.

    Must wait out the default Contracts list skeleton (money tab is active under the fold).
    """
    goto_hash(page)
    wait_ready(
        page,
        """() => {
          const cta = document.getElementById('homeCta');
          const tabs = document.querySelectorAll('.tabbtn').length >= 6;
          const listReady = document.querySelectorAll('#list .row').length > 0
            && !document.querySelector('#list .empty.skel');
          return !!cta && tabs && listReady;
        }""",
        frame="homepage.png",
    )
    screenshot(page, "homepage.png")


def capture_procurement_lifecycle(page: Page) -> None:
    """Notice detail with procurement lifecycle — City Record + Checkbook + PASSPort + OCP."""
    goto_hash(page, "#notice/20260724018")
    wait_ready(
        page,
        """() => {
          const life = document.querySelector('#dlifecycle');
          const hasLifecycle = life
            && (life.textContent || '').includes('Contract lifecycle')
            && life.querySelectorAll('.box').length >= 1
            && !life.querySelector('.empty.skel, .loading');
          const hasDetail = (document.querySelector('#detail')?.textContent || '').length > 200;
          return hasLifecycle && hasDetail;
        }""",
        frame="procurement-lifecycle.png",
    )
    page.evaluate("() => window.scrollTo(0, 350)")
    # Brief paint settle after scroll only — readiness already established above.
    page.wait_for_timeout(200)
    assert_no_visible_skeletons(page, "procurement-lifecycle.png")
    screenshot(page, "procurement-lifecycle.png")


def capture_vendor_profile(page: Page) -> None:
    """Vendor profile — name variants resolved, all agencies, total awards across systems."""
    goto_hash(page, "#vendor/Community%20Mediation%20Services%2C%20Inc.")
    wait_ready(
        page,
        """() => {
          const box = document.querySelector('#entityview');
          if (!box) return false;
          const text = box.textContent || '';
          if (text.includes('building profile') || text.includes('resolving vendor')) return false;
          if (box.querySelector('.empty.skel, .empty .loading')) return false;
          const variants = box.querySelectorAll('.vendor-variant-item').length;
          return variants >= 1 && text.length > 200;
        }""",
        frame="vendor-profile.png",
    )
    screenshot(page, "vendor-profile.png")


def capture_data_page(page: Page) -> None:
    """Data page — live per-section counting and transparency about data quality."""
    page.goto(f"{BASE}data.html", wait_until="domcontentloaded", timeout=30_000)
    wait_ready(
        page,
        """() => {
          const sectionText = (document.querySelector('#sections')?.textContent || '').trim();
          const volumeText = (document.querySelector('#volume')?.textContent || '').trim();
          const procmixText = (document.querySelector('#procmix')?.textContent || '').trim();
          const agenciesText = (document.querySelector('#agencies')?.textContent || '').trim();
          const vendorsText = (document.querySelector('#vendors')?.textContent || '').trim();
          const stillCounting = /Counting\\s*1M|Loading[….]/i.test(
            [sectionText, volumeText, procmixText, agenciesText, vendorsText].join(' ')
          );
          const bars = document.querySelectorAll('#vendors .bar, #agencies .bar, .bar').length;
          // Sections paint last (full-corpus count); require real section labels + chart bars.
          const sectionsReady = sectionText.length > 80
            && /Procurement|Changes in Personnel/i.test(sectionText)
            && !/Counting\\s*1M/i.test(sectionText);
          return !stillCounting && sectionsReady && bars >= 10
            && volumeText.length > 20 && procmixText.length > 20
            && agenciesText.length > 40 && vendorsText.length > 40;
        }""",
        frame="data-page.png",
        timeout=90_000,
    )
    screenshot(page, "data-page.png")


def capture_money_search(page: Page) -> None:
    """Money lens with procurement notices — RFPs and awards in one searchable view."""
    goto_hash(page, "#money")
    # Ensure the money tab is active even if hash routing is slow.
    page.locator('[data-tab="money"]').first.click(timeout=10_000)
    wait_ready(
        page,
        """() => {
          const rows = document.querySelectorAll('#list .row').length;
          const noSkel = !document.querySelector('#list .empty.skel');
          const tabActive = document.querySelector('#tab-money.active, .tabpane#tab-money.active')
            || document.querySelector('.tabbtn[data-tab="money"].active');
          return rows > 0 && noSkel && !!tabActive;
        }""",
        frame="money-search.png",
    )
    page.evaluate("() => window.scrollTo(0, 1100)")
    page.wait_for_timeout(200)
    # After scroll, list must still be real rows (not re-skeletoned).
    page.wait_for_function(
        "() => document.querySelectorAll('#list .row').length > 0 && !document.querySelector('#list .empty.skel')",
        timeout=15_000,
    )
    assert_no_visible_skeletons(page, "money-search.png")
    screenshot(page, "money-search.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(
                viewport={"width": WIDTH, "height": HEIGHT},
                device_scale_factor=2,
            )
            page.set_default_timeout(READY_TIMEOUT_MS)

            capture_homepage(page)
            print(f"captured {OUT / 'homepage.png'}")

            capture_procurement_lifecycle(page)
            print(f"captured {OUT / 'procurement-lifecycle.png'}")

            capture_vendor_profile(page)
            print(f"captured {OUT / 'vendor-profile.png'}")

            capture_data_page(page)
            print(f"captured {OUT / 'data-page.png'}")

            capture_money_search(page)
            print(f"captured {OUT / 'money-search.png'}")

            page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
