"""Search document E2E: real-shaped API records must render as non-empty relevant results."""

import json
import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

SEARCH_FIXTURES = {
    "police": [{
        "id": "20260807025",
        "title": "NYPD Police Officer Hats",
        "type": "contracts",
        "snippet": "Police equipment procurement.",
        "href": "/notices/20260807025",
    }],
    "zoning": [{
        "id": "20260729004",
        "title": "Subcommittee on Zoning and Franchises meeting",
        "type": "meetings",
        "snippet": "Public zoning hearing.",
        "href": "/notices/20260729004",
    }],
    "budget": [{
        "id": "20260804027",
        "title": "Subscription of Sonatype IQ Server & 100 Repository Firewall",
        "type": "contracts",
        "snippet": "Agency budget object code 069/9912/337.",
        "href": "/notices/20260804027",
    }],
    "contract": [{
        "id": "20260804027",
        "title": "Subscription of Sonatype IQ Server & 100 Repository Firewall",
        "type": "contracts",
        "snippet": "A current contract award.",
        "href": "/notices/20260804027",
    }],
    "hearing": [{
        "id": "20260729004",
        "title": "Subcommittee on Zoning and Franchises meeting",
        "type": "meetings",
        "snippet": "Public hearing and meeting notice.",
        "href": "/notices/20260729004",
    }],
}


def json_response(route, body):
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()

        def search_api(route):
            query = route.request.url.split("q=", 1)[-1].lower()
            for term, results in SEARCH_FIXTURES.items():
                if term in query:
                    json_response(route, {"results": results})
                    return
            json_response(route, {"results": []})

        page.route("https://api.cityscroll.org/search?*", search_api)
        page.route("https://crol-worker.crol-worker.workers.dev/search?*", search_api)

        for term, expected in SEARCH_FIXTURES.items():
            page.goto(f"{BASE}/search/?q={term}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_function(
                "document.querySelectorAll('[data-search-result]').length > 0",
                timeout=30000,
            )
            results = page.locator("[data-search-result]")
            assert results.count() > 0, term
            text = results.first.text_content() or ""
            assert term.lower() in text.lower(), (term, text)
            assert results.first.locator("a[href^='/notices/']").count() == 1
            assert expected[0]["title"] in text, (term, text)

        page.goto(f"{BASE}/search/?q=zzzz-no-match", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function(
            "document.querySelector('[data-search-lane] .topic-search-lane-status')?.textContent === 'No matches'",
            timeout=30000,
        )
        assert page.locator("[data-search-result]").count() == 0
        assert "No matching" in (page.locator("[data-search-lane]").first.text_content() or "")

        print("PASS: search renders relevant common-term records and an honest empty state")
        browser.close()


if __name__ == "__main__":
    main()
