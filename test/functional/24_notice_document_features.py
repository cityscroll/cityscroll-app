"""Document-route notice features run through the real browser enhancement island.

This is intentionally a route-level Playwright contract, not a unit test of translation
helpers. It enters ``/notices/<id>`` through the same clean-route server used in CI and
stubs only the remote City Record and Worker responses.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Browser, BrowserContext, Page, Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
ROOT = Path(__file__).parents[2]
DRIFT_CONTRACTS = json.loads((ROOT / "test/fixtures/deterministic-drift/contracts.json").read_text())
DRIFT_NOTICE = next(item for item in DRIFT_CONTRACTS["permalinks"] if item["kind"] == "notice")
NOTICE_ID = DRIFT_NOTICE["id"]
NOTICE = {
    **DRIFT_CONTRACTS["feed"]["row"],
    "type_of_notice_description": "Solicitation",
    "section_name": "Procurement",
    "additional_description_1": "Submit a response for the playground reconstruction at 1 Centre Street.",
}
TRANSLATION = {
    "ok": True,
    "id": NOTICE_ID,
    "lang": "es",
    "title": "Reconstrucción del parque infantil",
    "description": "Presente una respuesta para la reconstrucción del parque infantil en 1 Centre Street.",
    "label": "unofficial_translation",
}


def fulfill_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def install_notice_routes(page: Page, translation_calls: list[str]) -> None:
    page.route(
        "https://data.cityofnewyork.us/resource/dg92-zbpx.json*",
        lambda route: fulfill_json(route, [NOTICE]),
    )
    page.route(
        "**/attachment-metadata*",
        lambda route: fulfill_json(route, {"request_id": NOTICE_ID, "attachments": []}),
    )

    def translate(route: Route) -> None:
        translation_calls.append(route.request.url)
        fulfill_json(route, TRANSLATION)

    page.route("https://api.cityscroll.org/translate/**", translate)
    page.route("https://crol-worker.crol-worker.workers.dev/translate/**", translate)


def context_with_clipboard(browser: Browser, *, saved_language: str | None = None) -> BrowserContext:
    context = browser.new_context()
    language_setup = f"localStorage.setItem('crol_lang', {json.dumps(saved_language)});" if saved_language else ""
    context.add_init_script(
        f"""
        {language_setup}
        Object.defineProperty(navigator, 'clipboard', {{ configurable: true, value: {{
          writeText(value) {{ window.__copiedNoticeUrl = value; return Promise.resolve(); }}
        }} }});
        """
    )
    return context


def assert_document_feature_parity(page: Page) -> None:
    page.locator("#nactions .next-action-rail").wait_for(state="visible")
    watch = page.locator('#nactions a[href*="/following"]').first
    assert watch.is_visible(), "document route lost the notice watch control"

    disclosures = (
        (page.locator("#noticeview details.fulltext"), "full-notice"),
        (page.locator("#nactions details.bid-guide"), "action-guide"),
    )
    for disclosure, label in disclosures:
        assert disclosure.count() == 1, f"document route lost the {label} disclosure"
        summary = disclosure.locator("summary")
        if disclosure.get_attribute("open") is not None:
            summary.click()
        assert disclosure.get_attribute("open") is None, f"{label} disclosure did not close"
        summary.click()
        assert disclosure.get_attribute("open") is not None, f"{label} disclosure did not reopen"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        direct_context = context_with_clipboard(browser)
        direct = direct_context.new_page()
        direct_calls: list[str] = []
        install_notice_routes(direct, direct_calls)
        direct.goto(f"{BASE}/notices/{NOTICE_ID}?lang=es", wait_until="load", timeout=30000)

        translated = direct.locator('#nxlate .xlate-pane[data-loaded="1"]')
        translated.wait_for(state="visible", timeout=10000)
        assert TRANSLATION["title"] in translated.inner_text()
        assert len(direct_calls) == 1, f"direct language arrival made {len(direct_calls)} translation requests"
        assert "lang=es" in direct_calls[0]
        assert direct.locator("[data-xlate-btn]").inner_text() != "Mostrar traducción no oficial", (
            "direct language arrival left the translation behind an extra click"
        )

        assert_document_feature_parity(direct)
        direct.locator("#ncopy").click()
        copied = direct.evaluate("window.__copiedNoticeUrl")
        copied_url = urlsplit(copied)
        fixture_url = urlsplit(DRIFT_NOTICE["canonical_spanish"])
        assert (copied_url.path, copied_url.query) == (fixture_url.path, fixture_url.query), (
            f"copy link drifted from the canonical language fixture: {copied}"
        )
        direct_context.close()

        click_context = context_with_clipboard(browser, saved_language="es")
        clicked = click_context.new_page()
        click_calls: list[str] = []
        install_notice_routes(clicked, click_calls)
        clicked.goto(f"{BASE}/notices/{NOTICE_ID}", wait_until="load", timeout=30000)
        button = clicked.locator("[data-xlate-btn]")
        button.wait_for(state="visible", timeout=10000)
        assert click_calls == [], "saved-language document arrival should retain the explicit translation control"
        button.click()
        clicked.locator('#nxlate .xlate-pane[data-loaded="1"]').wait_for(state="visible", timeout=10000)
        assert len(click_calls) == 1 and "lang=es" in click_calls[0]
        click_context.close()

        browser.close()

    print("OK notice document translation, actions, watch, disclosure, and language-carrying copy link")


if __name__ == "__main__":
    main()
