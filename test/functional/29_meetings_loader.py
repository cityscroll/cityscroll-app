"""Verify the Meetings cold path keeps Rules behind the first bounded list."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent / "assets"))
from ci_waits import wait_for_function


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/")
HEARINGS = {
    "hearings": [
        {
            "meeting_id": "meeting:city_record:loader-test",
            "source_system": "city_record",
            "meeting_origin": "city_record",
            "request_id": "loader-test",
            "title": "A bounded Meetings loader test",
            "agency": "Parks and Recreation",
            "event_date": "2026-08-20T14:00:00.000",
            "affected_area": {"scope": "unlocated", "boroughs": []},
            "participation": {},
            "venue": {},
            "source_url": "https://www.nyc.gov/",
        }
    ]
}


def install_probe(page):
    page.add_init_script(
        """
        (() => {
          window.__meetingsLoaderProbe = {listPaintMs: null};
          new MutationObserver(() => {
            if (
              window.__meetingsLoaderProbe.listPaintMs === null &&
              document.querySelector("#meetingsfeed .meetings-fcard")
            ) {
              window.__meetingsLoaderProbe.listPaintMs = performance.now();
            }
          }).observe(document, {subtree: true, childList: true});
        })();
        """
    )
    page.route(
        "**/hearings*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(HEARINGS),
        ),
    )


def collect_metrics(page):
    wait_for_function(
        page,
        "document.querySelector('#meetingsfeed .meetings-fcard') !== null",
        label="first bounded Meetings list",
    )
    return page.evaluate(
        """
        () => {
          const resources = performance.getEntriesByType("resource").map(entry => ({
            name: entry.name,
            startTime: entry.startTime,
            responseEnd: entry.responseEnd
          }));
          const rules = resources.find(entry => /\\/app\\/rules\\.mjs(?:\\?|$)/.test(entry.name));
          const hearings = resources.find(entry => /\\/hearings(?:\\?|$)/.test(entry.name));
          return {
            listPaintMs: window.__meetingsLoaderProbe.listPaintMs,
            rulesStartMs: rules?.startTime ?? null,
            hearingsCompleteMs: hearings?.responseEnd ?? null
          };
        }
        """
    )


def assert_loader_order(metrics, label):
    assert metrics["listPaintMs"] is not None, metrics
    assert metrics["hearingsCompleteMs"] is not None, metrics
    rules_start = metrics["rulesStartMs"]
    assert rules_start is None or rules_start >= metrics["listPaintMs"], (
        f"{label} imported Rules before the first bounded Meetings list: {metrics}"
    )


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        cold_context = browser.new_context()
        cold_page = cold_context.new_page()
        install_probe(cold_page)
        cold_page.goto(
            BASE.rstrip("/") + "/browse/meetings/",
            wait_until="domcontentloaded",
            timeout=30000,
        )
        cold = collect_metrics(cold_page)
        assert_loader_order(cold, "cold direct navigation")
        cold_context.close()

        warm_context = browser.new_context()
        warm_page = warm_context.new_page()
        install_probe(warm_page)
        warm_page.goto(BASE.rstrip("/") + "/browse/", wait_until="domcontentloaded", timeout=30000)
        warm_page.wait_for_selector("#tab-meetings", state="attached")
        warm_page.goto(
            BASE.rstrip("/") + "/browse/meetings/",
            wait_until="domcontentloaded",
            timeout=30000,
        )
        warm = collect_metrics(warm_page)
        assert_loader_order(warm, "warm navigation from Browse")
        warm_context.close()
        browser.close()

    print("PASS: Meetings loader order", json.dumps({"cold": cold, "warm": warm}, sort_keys=True))


if __name__ == "__main__":
    main()
