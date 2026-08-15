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
PROPERTY_GOLDEN = json.loads(
    (ROOT / "test/contract/fixtures/property_location_golden.json").read_text()
)
PROPERTY_SOURCE = next(
    item["row"]
    for item in PROPERTY_GOLDEN["notices"]
    if item.get("row", {}).get("request_id") == "20170130106"
)
NOTICE = {
    **DRIFT_CONTRACTS["feed"]["row"],
    "type_of_notice_description": "Solicitation",
    "section_name": "Procurement",
    "additional_description_1": "Submit a response for the playground reconstruction at 1 Centre Street.",
}
PROPERTY_NOTICE = {
    **PROPERTY_SOURCE,
    "property_location": {
        "scope": "local",
        "bbls": ["1020260015"],
        "tax_lots": [{"borough_code": "1", "block": "2026", "lot": "15", "bbl": "1020260015"}],
    },
    "disposition_stage": "hearing",
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


MANDATE_BACKLINKS_LOOKUP = {
    "schema": "cityscroll.notice_mandate_backlinks.v1",
    "method": "notice_mandate_backlinks_v1",
    "generated_at": "2026-08-09T00:00:00.000Z",
    "counts": {"notices": 1, "edges": 1, "by_relation": {"implemented_by_contract": 1}},
    "by_notice": {
        NOTICE_ID: [
            {
                "duty_text": "Issue a request for proposals for playground reconstruction services.",
                "citation": "Local Law fixture §1",
                "source_href": "https://example.test/law/playground",
                "relation": "implemented_by_contract",
                "relation_label": "Procurement record for this duty",
                "agency_id": "parks-and-recreation",
                "agency_name": "Parks and Recreation",
                "agency_href": "/agencies/parks-and-recreation/",
                "mandate_id": "fixture-mandate-001",
                "publication_tier": "public_inferred",
            }
        ]
    },
}


def install_notice_routes(
    page: Page,
    translation_calls: list[str],
    *,
    notice: dict[str, object] = NOTICE,
    mandate_lookup: dict[str, object] | None = MANDATE_BACKLINKS_LOOKUP,
) -> None:
    page.route(
        "https://data.cityofnewyork.us/resource/dg92-zbpx.json*",
        lambda route: fulfill_json(route, [notice]),
    )
    page.route(
        "https://api.cityscroll.org/notice*",
        lambda route: fulfill_json(
            route,
            {
                "ok": True,
                "row": notice,
                "civic_time": {
                    "schema": "cityscroll.civic_time_notice_history.v1",
                    "subject_ref": f"notice:{notice['request_id']}",
                    "state": "ok",
                    "events": [
                        {
                            "event_id": "fixture-published",
                            "subject_ref": f"notice:{notice['request_id']}",
                            "event_kind": "procurement.notice_published",
                            "valid_at": None,
                            "valid_from": None,
                            "valid_to": None,
                            "published_at": notice.get("start_date"),
                            "observed_at": None,
                            "processed_at": "2026-08-10T12:00:00.000Z",
                            "written_at": None,
                            "status": "occurred",
                        },
                        {
                            "event_id": "fixture-due",
                            "subject_ref": f"notice:{notice['request_id']}",
                            "event_kind": "procurement.solicitation_due",
                            "valid_at": notice.get("due_date"),
                            "valid_from": None,
                            "valid_to": None,
                            "published_at": None,
                            "observed_at": None,
                            "processed_at": None,
                            "written_at": None,
                            "status": "occurred",
                        },
                    ],
                },
            },
        ),
    )
    page.route(
        "**/attachment-metadata*",
        lambda route: fulfill_json(route, {"request_id": NOTICE_ID, "attachments": []}),
    )
    if mandate_lookup is not None:
        page.route(
            "**/data/notice_mandate_backlinks_lookup.json*",
            lambda route: fulfill_json(route, mandate_lookup),
        )

    def translate(route: Route) -> None:
        translation_calls.append(route.request.url)
        fulfill_json(route, TRANSLATION)

    page.route("https://api.cityscroll.org/translate/**", translate)
    page.route("https://crol-worker.crol-worker.workers.dev/translate/**", translate)
    page.route(
        "**/property-locations*",
        lambda route: fulfill_json(
            route,
            {
                "properties": [notice] if notice.get("section_name") == "Property Disposition" else [],
                "disposition_spines": [],
            },
        ),
    )


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
    history = page.locator("#noticeview [data-civic-time-history='1']")
    history.wait_for(state="visible", timeout=10000)
    assert history.locator("[data-civic-time-event]").count() == 2
    history_text = history.inner_text()
    assert "bitemporal history" in history_text.lower()
    assert "VALID" in history_text and "SYSTEM" in history_text
    assert history.locator("[data-civic-time-valid='']").count() == 1
    assert history.locator("[data-civic-time-system='']").count() == 1
    assert history_text.count("Not recorded") >= 2
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


def assert_connected_mandate_card(page: Page) -> None:
    """Hydrated notice path paints one Connected mandate provenance card when indexed."""
    card = page.locator("#noticeview [data-connected-mandate='1']")
    card.wait_for(state="visible", timeout=10000)
    assert card.count() == 1, "mandate backlink card duplicated after hydration"
    text = card.inner_text()
    text_lower = text.lower()
    # .chain-h may render the heading in CSS uppercase; match case-insensitively.
    assert "connected mandate" in text_lower
    assert "playground reconstruction" in text_lower
    assert "procurement record for this duty" in text_lower
    assert "local law fixture" in text_lower
    source = card.locator('a[href="https://example.test/law/playground"]')
    assert source.count() == 1, "source-law link missing from mandate card"
    agency = card.locator('a[href="/agencies/parks-and-recreation/"]')
    assert agency.count() == 1, "agency dossier link missing from mandate card"
    watch = card.locator("a.notice-mandate-watch[data-mandate-watch='1']")
    assert watch.count() == 1, "per-mandate watch action missing from mandate card"
    assert "watch this mandate" in watch.inner_text().lower()
    watch_href = watch.get_attribute("href") or ""
    assert "lens=mandates" in watch_href
    assert "mandate_id" in watch_href
    assert "fixture-mandate-001" in watch_href
    # Graph subject_ref forms stay off the reader surface; bare mandate_id is the product filter.
    html = card.inner_html()
    assert "subject_ref" not in html
    assert "mandate:" not in html
    assert "evidence_only" not in html


def assert_no_connected_mandate_absence(page: Page) -> None:
    """Notices without a public backlink render no card and no absence announcement."""
    assert page.locator("#noticeview [data-connected-mandate]").count() == 0
    body = page.locator("#noticeview").inner_text().lower()
    assert "connected mandate" not in body
    assert "not yet shown" not in body


def assert_structured_property_sections(page: Page) -> dict[str, object]:
    commercial = page.locator("#ncommercial [data-commercial-detail='1']")
    commercial.wait_for(state="visible", timeout=10000)
    rows = commercial.locator(".property-commercial-facts > .property-commercial-row")
    assert rows.count() >= 3, "commercial facts collapsed instead of rendering labeled rows"
    for index in range(rows.count()):
        row = rows.nth(index)
        assert row.locator(":scope > dt.property-commercial-label").count() == 1
        assert row.locator(":scope > dd.property-commercial-value").count() == 1
    assert commercial.locator(".stage-name").count() == 0, "legacy bare sub-heading template survived"

    quotes = commercial.locator("blockquote.property-commercial-evidence")
    assert quotes.count() >= 2
    for index in range(quotes.count()):
        quote = quotes.nth(index)
        assert quote.locator("cite").count() == 1
        copy = quote.locator("q").inner_text().strip()
        assert not copy.startswith("…") and not copy.endswith("…"), (
            f"clipped evidence fragment leaked into rendered copy: {copy!r}"
        )
    rendered = commercial.inner_text()
    assert "not an auction price" in rendered
    assert "Call the public-hearings office at (212) 788-7490" in rendered
    assert commercial.locator(".property-commercial-timed-events time").count() >= 2

    rail = page.locator("#nactions .next-action-rail")
    rail.locator("[data-action-current]").wait_for(state="visible", timeout=10000)
    assert rail.locator("details.bid-guide > .property-action-sections").count() == 1
    assert rail.locator("details.bid-guide > ol").count() == 0
    assert rail.locator("[data-action-current]").count() == 1
    assert rail.locator("[data-action-history]").count() == 1
    history = rail.locator("[data-action-history-event]")
    assert history.count() == 2, "past hearing and accommodation should share one history subsection"
    assert len(set(history.get_attribute("data-action-kind") for history in history.all())) == 2
    rail_text = rail.inner_text()
    rail_text_lower = rail_text.lower()
    assert "review published records" in rail_text_lower
    assert "what already happened" in rail_text_lower
    assert "This action is closed. Read the City Record notice." not in rail_text
    assert "The notice does not say when or where to view it." not in rail_text
    non_answers = page.locator("#nactions dl dt + dd").all_inner_texts()
    assert not any(
        any(marker in value.lower() for marker in ("does not say", "not listed", "unknown", "action is closed"))
        for value in non_answers
    )

    ellipsis_findings = page.evaluate(
        """
        () => [
          '#ncommercial [data-commercial-detail] q',
          '#ncommercial [data-commercial-detail] p',
          '#nactions [data-action-current] p',
          '#nactions [data-action-current] dd',
          '#nactions [data-action-history-event]',
          '#npropertyxd [data-parcel-biography] li'
        ].flatMap(selector => [...document.querySelectorAll(selector)]
          .map(node => ({ selector, text: node.textContent.trim() }))
          .filter(item => /^(?:…|\\.{3})|(?:…|\\.{3})$/.test(item.text)))
        """
    )
    assert ellipsis_findings == [], f"raw clipped fragments leaked into notice sections: {ellipsis_findings}"

    bare_text_findings = page.evaluate(
        """
        () => [
          '#ncommercial .property-commercial-facts',
          '#ncommercial .property-commercial-row',
          '#nactions [data-action-current]',
          '#nactions [data-action-history]',
          '#npropertyxd [data-parcel-biography]'
        ].flatMap(selector => [...document.querySelectorAll(selector)].flatMap(node =>
          [...node.childNodes]
            .filter(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
            .map(child => ({ selector, text: child.textContent.trim() }))
        ))
        """
    )
    assert bare_text_findings == [], f"structured notice sections contain bare text nodes: {bare_text_findings}"
    raw_i18n_keys = page.evaluate(
        """
        () => {
          const root = document.querySelector('#npropertyxd [data-parcel-biography]');
          if (!root) return [];
          const out = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const pattern = /\\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\\b/g;
          while (walker.nextNode()) {
            const text = walker.currentNode.textContent.trim();
            if (text) out.push(...[...text.matchAll(pattern)].map(match => match[0]));
          }
          return [...new Set(out)].sort();
        }
        """
    )
    assert raw_i18n_keys == [], f"parcel biography rendered raw i18n keys: {raw_i18n_keys}"
    return {
        "labels": rows.locator("dt").all_inner_texts(),
        "history_kinds": history.evaluate_all(
            "nodes => nodes.map(node => node.dataset.actionKind)"
        ),
    }


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        direct_context = context_with_clipboard(browser)
        direct = direct_context.new_page()
        direct_calls: list[str] = list()
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
        assert_connected_mandate_card(direct)
        if os.environ.get("CROL_AFTER_SCREENSHOT"):
            direct.screenshot(path=os.environ["CROL_AFTER_SCREENSHOT"], full_page=True)
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
        click_calls: list[str] = list()
        install_notice_routes(clicked, click_calls)
        clicked.goto(f"{BASE}/notices/{NOTICE_ID}", wait_until="load", timeout=30000)
        button = clicked.locator("[data-xlate-btn]")
        button.wait_for(state="visible", timeout=10000)
        assert click_calls == [], "saved-language document arrival should retain the explicit translation control"
        button.click()
        clicked.locator('#nxlate .xlate-pane[data-loaded="1"]').wait_for(state="visible", timeout=10000)
        assert len(click_calls) == 1 and "lang=es" in click_calls[0]
        click_context.close()

        property_context = context_with_clipboard(browser)
        property_page = property_context.new_page()
        property_calls: list[str] = list()
        # Empty public index: property notices without a backlink stay silent.
        install_notice_routes(
            property_page,
            property_calls,
            notice=PROPERTY_NOTICE,
            mandate_lookup={
                "schema": "cityscroll.notice_mandate_backlinks.v1",
                "method": "notice_mandate_backlinks_v1",
                "counts": {"notices": 0, "edges": 0, "by_relation": {}},
                "by_notice": {},
            },
        )
        property_page.goto(
            f"{BASE}/notices/{PROPERTY_NOTICE['request_id']}",
            wait_until="load",
            timeout=30000,
        )
        property_page.locator("#nactions .next-action-rail").wait_for(state="visible", timeout=10000)
        assert_no_connected_mandate_absence(property_page)

        biography = property_page.locator("#npropertyxd [data-parcel-biography='1']")
        biography.wait_for(state="visible", timeout=10000)
        document_structure = assert_structured_property_sections(property_page)
        assert "observed parcel biography" in biography.inner_text().lower()
        assert biography.locator("[data-parcel-biography-domain]").count() == 5
        assert biography.locator("[data-parcel-biography-domain='property'] a[href^='#notice/']").count() >= 1
        # Internal land pivots stay on the project document route; optional official
        # provenance ↗ links are separate and must not replace those pivots.
        land_pivots = biography.locator(
            "[data-parcel-biography-domain='land'] a[href^='#land/']"
        )
        assert land_pivots.count() >= 1
        for index in range(land_pivots.count()):
            href = land_pivots.nth(index).get_attribute("href") or ""
            assert href.startswith("#land/") and "unsupported-filter" not in href, (
                f"parcel land pivot must use the supported project document route: {href}"
            )
        land_official = biography.locator(
            "[data-parcel-biography-domain='land'] a.ui-official-source-link"
        )
        for index in range(land_official.count()):
            link = land_official.nth(index)
            href = link.get_attribute("href") or ""
            assert "zap.planning.nyc.gov/projects/" in href, (
                f"land official-source provenance should deep-link ZAP: {href}"
            )
            assert (link.get_attribute("target") or "") == "_blank"
            assert "noopener" in (link.get_attribute("rel") or "")
        assert biography.locator("[data-parcel-biography-domain='tax_lien'][data-status='observed']").count() == 1
        assert biography.locator("[data-parcel-coverage]").count() == 0
        assert biography.locator(".parcel-biography-item-meta").count() >= 3
        assert biography.locator(".parcel-biography-relation").count() >= 3
        assert biography.locator(".property-xd-owners").count() == 0
        biography_text = biography.inner_text().lower()
        assert "coverage:" not in biography_text
        assert "snapshot" not in biography_text
        assert "complete parcel history" not in biography.inner_text().lower()
        # Source-name organizers stay off the public parcel biography.
        assert "city record online" not in biography_text
        assert "grouped by source" not in biography_text
        parcel_pivot = biography.locator("a[data-entity-ref='bbl:1020260015']").first
        assert parcel_pivot.is_visible()
        assert "entity_refs_all" in (parcel_pivot.get_attribute("href") or "")
        parcel_pivot.click()
        scoped_biography = property_page.locator(
            "#parcel-biography-panel [data-parcel-biography='1'][data-parcel-ref='bbl:1020260015']"
        )
        scoped_biography.wait_for(state="visible", timeout=10000)
        assert "entity_refs_all" in property_page.url
        property_context.close()

        hash_context = context_with_clipboard(browser)
        hash_page = hash_context.new_page()
        hash_calls: list[str] = list()
        install_notice_routes(hash_page, hash_calls, notice=PROPERTY_NOTICE)
        hash_page.goto(
            f"{BASE}/#notice/{PROPERTY_NOTICE['request_id']}",
            wait_until="load",
            timeout=30000,
        )
        hash_structure = assert_structured_property_sections(hash_page)
        assert hash_structure == document_structure, (
            "document and legacy client entry paths rendered different structured-card contracts"
        )
        hash_context.close()

        browser.close()

    print("OK notice document translation, actions, disclosure, copy link, and observed parcel biography")


if __name__ == "__main__":
    main()
