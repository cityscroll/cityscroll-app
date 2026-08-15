"""Mobile interaction and layout ratchet at the 360px acceptance width.

The broader axe walk uses 390px and desktop review widths. This focused gate covers
the narrower phone width where intrinsic grid sizing and compact controls have
historically escaped: no document overflow, 44px primary touch targets, a vertical
phase chain, a tap/focus path for abbreviated phase labels, and contained tables.
"""

from __future__ import annotations

import functools
import http.server
import os
from pathlib import Path
import sys
import threading

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from ci_waits import wait_for_locator  # noqa: E402
from i18n_fixtures import install_routes  # noqa: E402
from tools.local_site_server import QuietHandler  # noqa: E402

BASE = os.environ.get("CROL_BASE", "")
VIEWPORT = {"width": 360, "height": 800}  # Source: mobile contract acceptance width.
SURFACES = (
    # The root is a neutral topic entry; Contracts is covered on its canonical
    # document route so this fixture waits for the intended source-backed list.
    ("contracts", "browse/contracts/#money", "#list .row"),
    ("staffing", "#people?view=guide", "#career-results .career-card, #staffing-notice-list .staffing-hire-row"),
    ("property", "#property", "#propertyfeed .fcard"),
    ("rules", "#rules", "#rulesfeed .fcard"),
    ("meetings", "#meetings", "#meetingsfeed .fcard"),
    # List-first mobile Near you: exact records ready before the optional Map surface.
    ("near you", "near-you/", ".near-results[data-results-count], [data-near-surface='list']"),
    ("following", "following/", "[data-following-preview-form]"),
    ("rule detail", "#notice/20260714029", ".rule-phase-stepper"),
    ("reader action", "#notice/20260701099", "#noticeview .panel"),
)


def rendered_target_failures(page: Page) -> list[dict]:
    return page.evaluate(
        """() => {
          const selector = [
            'button:not([disabled])',
            'input:not([disabled]):not([type="hidden"])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            'summary',
            'a.act',
            '.lc-step-help[tabindex="0"]'
          ].join(',');
          const rendered = el => {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            const closed = el.closest('details:not([open])');
            if (closed && !closed.querySelector(':scope > summary')?.contains(el)) return false;
            return style.display !== 'none' && style.visibility !== 'hidden'
              && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll(selector)].filter(rendered).flatMap(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width >= 43.5 && rect.height >= 43.5) return [];
            return [{
              tag: el.tagName.toLowerCase(), id: el.id,
              cls: String(el.className || '').slice(0, 90),
              text: String(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 90),
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            }];
          });
        }"""
    )


def assert_mobile_surface(page: Page, name: str) -> None:
    metrics = page.evaluate(
        """() => ({
          innerWidth,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: document.querySelector('meta[name="viewport"]')?.content || '',
        })"""
    )
    assert metrics["innerWidth"] == 360, (name, metrics)
    assert metrics["scrollWidth"] <= metrics["clientWidth"] + 1, (name, metrics)
    assert "width=device-width" in metrics["viewport"], (name, metrics)
    failures = rendered_target_failures(page)
    assert not failures, f"{name}: touch targets below 44px: {failures[:12]}"
    if name == "contracts":
        collision = page.evaluate(
            """() => {
              const a = document.querySelector('.lang-switcher').getBoundingClientRect();
              const b = document.querySelector('.cr-title').getBoundingClientRect();
              return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
            }"""
        )
        assert not collision, "language selector overlaps the masthead title at 360px"


def install_table_fixture(page: Page) -> None:
    page.evaluate(
        """async () => {
          const mod = await import('./attachment_tables_ui.mjs');
          const detail = document.querySelector('#detail');
          detail.innerHTML = mod.attachmentTablesHTML({
            tables_status: 'ok',
            tables_preview: 'Species and timber volume',
            extracted_tables: [{
              caption: 'Forest products',
              headers: ['Species', 'Sawtimber (MBF)', 'Pulp (cords)', 'Percent of sawtimber'],
              rows: [
                ['Red Oak', '91.6', '28', '49%'],
                ['White Ash', '41.1', '18', '22%'],
              ],
            }],
          }, {t: key => key});
          detail.querySelector('.attachment-tables').open = true;
        }"""
    )


def run(base: str) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport=VIEWPORT, has_touch=True)
        page = context.new_page()
        install_routes(page)

        for name, route, ready in SURFACES:
            page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=30_000)
            wait_for_locator(
                page.locator(ready).first,
                timeout=45_000,
                label=f"{name} mobile surface",
            )
            page.wait_for_timeout(250)
            assert_mobile_surface(page, name)

            if name == "near you":
                contract = page.evaluate(
                    """() => ({
                      count: Number(document.querySelector('.near-results')?.dataset.resultsCount || 0),
                      ids: [...document.querySelectorAll('.near-results [data-record-id]')].map(el => el.dataset.recordId),
                      paths: Object.fromEntries([...document.querySelectorAll('[data-map-id]')].map(el => [el.dataset.mapId, Number(el.dataset.count)])),
                      areas: Object.fromEntries([...document.querySelectorAll('[data-map-area]')].map(el => [el.dataset.mapArea, Number(el.dataset.count)])),
                      enhanced: document.querySelector('[data-near-you-root]')?.dataset.enhanced,
                      listFirst: getComputedStyle(document.querySelector('[data-near-surface-panel="list"]')||document.body).display !== 'none',
                      mapHidden: getComputedStyle(document.querySelector('[data-near-surface-panel="map"]')||document.body).display === 'none',
                    })"""
                )
                assert contract["count"] == len(set(contract["ids"])), contract
                assert contract["paths"] == contract["areas"], contract
                assert contract["enhanced"] == "true", contract
                assert contract["listFirst"], contract
                # Enhanced mobile defaults to the list surface; Map remains one tap away.
                if contract["enhanced"] == "true":
                    assert contract["mapHidden"], contract
                    map_switch = page.locator("[data-near-surface='map']")
                    assert map_switch.count() > 0, contract
                    map_switch.first.click()
                    wait_for_locator(
                        page.locator(".near-area-list a").first,
                        label="Near you map area link",
                    )
                    assert page.evaluate(
                        """() => getComputedStyle(document.querySelector('[data-near-surface-panel="map"]')).display !== 'none'"""
                    )
                else:
                    wait_for_locator(
                        page.locator(".near-area-list a").first,
                        label="Near you area link",
                    )

            if name == "rule detail":
                phase_buttons = page.locator(".rule-phase-stepper .lc-step")
                assert phase_buttons.count() >= 3
                tops = phase_buttons.evaluate_all(
                    "els => els.map(el => Math.round(el.getBoundingClientRect().top))"
                )
                assert len(set(tops)) == len(tops), f"phase chain still wraps horizontally: {tops}"

        page.goto(f"{base}#money", wait_until="domcontentloaded", timeout=30_000)
        wait_for_locator(page.locator("#detail"), label="attachment detail surface")
        install_table_fixture(page)
        wait_for_locator(page.locator("table.attachment-table"), label="attachment table")
        assert_mobile_surface(page, "attachment table")
        table_metrics = page.evaluate(
            """() => {
              const body = document.querySelector('.attachment-tables-body');
              const head = document.querySelector('.attachment-table th[tabindex]');
              return {
                contained: body.scrollWidth > body.clientWidth,
                headHeight: head.getBoundingClientRect().height,
                documentOverflow: document.documentElement.scrollWidth - innerWidth,
              };
            }"""
        )
        assert table_metrics["contained"], table_metrics
        assert table_metrics["headHeight"] >= 43.5, table_metrics
        assert table_metrics["documentOverflow"] <= 1, table_metrics

        page.goto(f"{base}#property", wait_until="domcontentloaded", timeout=30_000)
        wait_for_locator(page.locator("#property-domain-intro"), label="property domain intro")
        page.locator("#property-domain-intro").evaluate(
            """el => el.insertAdjacentHTML('beforeend', `
              <ol class="lc-stepper" aria-label="Example phase disclosure">
                <li><span class="lc-step lc-step-help" tabindex="0"
                  aria-label="Auction or request for proposals"
                  title="Auction or request for proposals">BID</span></li>
              </ol>`)
            """
        )
        help_step = page.locator(".lc-step-help[title]").first
        help_step.focus()
        disclosure = help_step.evaluate(
            "el => getComputedStyle(el, '::after').content.replace(/^['\"]|['\"]$/g, '')"
        )
        assert disclosure and disclosure != "none", "abbreviated phase has no tap/focus disclosure"

        context.close()

        no_js = browser.new_context(viewport=VIEWPORT, has_touch=True, java_script_enabled=False)
        no_js_page = no_js.new_page()
        no_js_page.goto(f"{base}near-you/", wait_until="domcontentloaded", timeout=30_000)
        wait_for_locator(
            no_js_page.locator(".near-area-list a").first,
            label="Near you no-JavaScript area link",
        )
        assert_mobile_surface(no_js_page, "near you without JavaScript")
        no_js_contract = no_js_page.evaluate(
            """() => ({
              count: Number(document.querySelector('.near-results')?.dataset.resultsCount || 0),
              ids: [...document.querySelectorAll('.near-results [data-record-id]')].map(el => el.dataset.recordId),
              bags: [...document.querySelectorAll('.near-bag')].map(el => el.dataset.bag),
              controlsHidden: [...document.querySelectorAll('.js-only')].every(el => el.hidden),
            })"""
        )
        assert no_js_contract["count"] == len(set(no_js_contract["ids"])), no_js_contract
        assert no_js_contract["bags"] == ["citywide", "virtual", "unlocated"], no_js_contract
        assert no_js_contract["controlsHidden"], no_js_contract

        no_js_page.goto(f"{base}following/", wait_until="domcontentloaded", timeout=30_000)
        wait_for_locator(
            no_js_page.locator("[data-following-preview-form]"),
            label="Following no-JavaScript preview form",
        )
        assert_mobile_surface(no_js_page, "following without JavaScript")
        following_contract = no_js_page.evaluate(
            """() => ({
              scopeCount: Number(document.querySelector('[data-scope-count]')?.dataset.scopeCount || 0),
              previewRows: document.querySelectorAll('[data-following-preview-panel] [data-record-id]').length,
              criteriaMethod: document.querySelector('[data-following-preview-form]')?.method,
              quietPrompt: /Pick a topic or place to see matches/.test(
                document.querySelector('[data-following-subscribe-panel]')?.textContent || ''
              ),
              topicControls: [...document.querySelectorAll(
                '[data-following-topic-scope] button.ui-filter-chip[data-following-scope-axis="topic"]'
              )].map(el => ({tag: el.tagName, pressed: el.getAttribute('aria-pressed')})),
              placeControls: [...document.querySelectorAll(
                '[data-following-place-scope] button.ui-filter-chip[data-following-scope-axis="place"]'
              )].map(el => ({tag: el.tagName, pressed: el.getAttribute('aria-pressed')})),
              lensSelects: document.querySelectorAll('select[name="lens"]').length,
              sectionOrder: [...document.querySelectorAll('#your-following, #create, #packs')]
                .map(el => el.id),
              layout: document.querySelector('[data-following-root]')?.dataset.followingLayout || '',
            })"""
        )
        assert following_contract["scopeCount"] == following_contract["previewRows"], following_contract
        assert following_contract["criteriaMethod"] == "get", following_contract
        assert following_contract["quietPrompt"], following_contract
        assert len(following_contract["topicControls"]) >= 5, following_contract
        assert len(following_contract["placeControls"]) >= 5, following_contract
        for control_group in (following_contract["topicControls"], following_contract["placeControls"]):
            assert all(
                control["tag"] == "BUTTON" and control["pressed"] in {"true", "false"}
                for control in control_group
            ), following_contract
        assert following_contract["lensSelects"] == 0, following_contract
        # Create leads; saved watches are secondary (not a fixed top invariant).
        assert following_contract["sectionOrder"] == ["create", "your-following", "packs"], following_contract
        assert following_contract["layout"] == "browse", following_contract
        no_js.close()
        browser.close()


def main() -> None:
    global BASE
    server = None
    thread = None
    if not BASE:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        BASE = f"http://127.0.0.1:{server.server_port}/"
    try:
        run(BASE)
        print("OK mobile viewport: 360px overflow, touch targets, phase disclosure, and table containment")
    finally:
        if server:
            server.shutdown()
            if thread:
                thread.join(timeout=5)
            server.server_close()


if __name__ == "__main__":
    main()
