#!/usr/bin/env python3
"""Observe Contracts explicit full-record navigation followed by Back.

Reads a self-contained collection HTML path whose named full-record links
point at a sibling record document. Opens the collection in headless
Chromium, clicks the first explicit full-record control, confirms arrival on
the record document, presses browser Back, and prints JSON observations a
focused test can assert. No screenshots are written.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

VIEWPORT = {"width": 1440, "height": 900}


def _path_and_query(url: str) -> str:
    parsed = urlsplit(url)
    return f"{parsed.path}?{parsed.query}" if parsed.query else parsed.path


def observe(collection_path: pathlib.Path) -> dict:
    collection_url = collection_path.resolve().as_uri()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport=VIEWPORT)
            try:
                page.goto(collection_url, wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_selector("#list .money-row-card", timeout=10_000)
                page.wait_for_selector("a.money-row-full-record", timeout=10_000)

                before = page.evaluate(
                    """() => {
                      const cards = [...document.querySelectorAll('#list .money-row-card')];
                      const full = document.querySelector('a.money-row-full-record');
                      const filter = document.querySelector('[data-contracts-filter]');
                      return {
                        href: location.href,
                        path: location.pathname + location.search + location.hash,
                        card_count: cards.length,
                        filter: filter ? filter.getAttribute('data-contracts-filter') : null,
                        full_record_href: full ? full.getAttribute('href') : null,
                        full_record_label: full
                          ? String(full.innerText || '').replace(/\\s+/g, ' ').trim()
                          : null,
                      };
                    }"""
                )
                assert before["card_count"] >= 1, "collection fixture rendered no cards"
                assert before["full_record_href"], "collection fixture lacks a named full-record link"
                assert "Open the full record" in (before["full_record_label"] or ""), (
                    f"full-record label drifted: {before['full_record_label']!r}"
                )

                with page.expect_navigation(wait_until="domcontentloaded", timeout=30_000):
                    page.locator("a.money-row-full-record").first.click()

                after_open = page.evaluate(
                    """() => ({
                      href: location.href,
                      path: location.pathname + location.search + location.hash,
                      title: document.title || '',
                      body: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim(),
                    })"""
                )
                assert "record.html" in after_open["href"], (
                    f"full-record click did not reach the record document: {after_open['href']!r}"
                )
                assert before["href"] != after_open["href"], "full-record click did not navigate"

                page.go_back(wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_selector("#list .money-row-card", timeout=10_000)
                page.wait_for_selector("a.money-row-full-record", timeout=10_000)

                after_back = page.evaluate(
                    """() => {
                      const cards = [...document.querySelectorAll('#list .money-row-card')];
                      const full = document.querySelector('a.money-row-full-record');
                      const filter = document.querySelector('[data-contracts-filter]');
                      return {
                        href: location.href,
                        path: location.pathname + location.search + location.hash,
                        card_count: cards.length,
                        filter: filter ? filter.getAttribute('data-contracts-filter') : null,
                        full_record_present: Boolean(full),
                        full_record_href: full ? full.getAttribute('href') : null,
                      };
                    }"""
                )
            finally:
                page.close()
        finally:
            browser.close()

    restored = (
        after_back["href"] == before["href"]
        and after_back["card_count"] == before["card_count"]
        and after_back["filter"] == before["filter"]
        and after_back["full_record_present"] is True
        and after_back["full_record_href"] == before["full_record_href"]
    )
    return {
        "schema": "cityscroll.contract_result_inspection_return_with_back.v1",
        "document": str(collection_path),
        "viewport": VIEWPORT,
        "before": before,
        "after_open": {
            "href": after_open["href"],
            "path": after_open["path"],
            "title": after_open["title"],
            "reached_record_document": "record.html" in after_open["href"],
            "navigated_away": before["href"] != after_open["href"],
        },
        "after_back": after_back,
        "observed": {
            "navigated_to_full_record": before["href"] != after_open["href"]
            and "record.html" in after_open["href"],
            "returned_with_back": restored,
            "collection_path_before": _path_and_query(before["href"]),
            "collection_path_after_back": _path_and_query(after_back["href"]),
            "card_count_before": before["card_count"],
            "card_count_after_back": after_back["card_count"],
            "filter_before": before["filter"],
            "filter_after_back": after_back["filter"],
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "document",
        type=pathlib.Path,
        help="Absolute or relative path to the collection HTML document",
    )
    args = parser.parse_args(argv)
    document = args.document.expanduser().resolve()
    if not document.is_file():
        print(f"document not found: {document}", file=sys.stderr)
        return 2
    payload = observe(document)
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    print()
    if not payload["observed"]["navigated_to_full_record"]:
        print("full-record navigation was not observed", file=sys.stderr)
        return 1
    if not payload["observed"]["returned_with_back"]:
        print("Back did not restore the collection state", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
