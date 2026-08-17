#!/usr/bin/env python3
"""Verify every curated capability permalink against the live CityScroll site.

The desk capabilities page consumes ``site/demo/demo-links.json#capabilities``.
This checker follows that exact selection and applies each linked entry's executable
browser expectations to production. It writes no files; redirect stdout when a
machine-readable verification observation is needed.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "site" / "demo" / "demo-links.json"
EMPTY_COPY = (
    "nothing found",
    "no awards on record",
    "no staffing notices match",
    "resolving vendor:",
)


def visible_locator(page, expected: dict):
    locator = page.locator(expected["selector"])
    if expected.get("text"):
        locator = locator.filter(has_text=expected["text"])
    return locator


def verify_entry(browser, base: str, entry: dict, timeout_ms: int) -> dict:
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    url = f"{base.rstrip('/')}/{entry['url'].lstrip('/')}"
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        status = response.status if response else None
        if status is None or status >= 400:
            raise AssertionError(f"HTTP status is {status!r}")

        visible_checks = []
        for expected in entry["expectations"]["visible"]:
            locator = visible_locator(page, expected)
            locator.first.wait_for(state="visible", timeout=timeout_ms)
            visible_checks.append({
                "selector": expected["selector"],
                **({"text": expected["text"]} if expected.get("text") else {}),
                "matches": locator.count(),
            })

        expected_path = entry["expectations"].get("pathname")
        if expected_path and urlparse(page.url).path != expected_path:
            raise AssertionError(
                f"pathname {urlparse(page.url).path!r} does not match {expected_path!r}"
            )

        visible_forbidden = []
        for expected in entry["expectations"]["notVisible"]:
            locator = visible_locator(page, expected)
            count = sum(locator.nth(index).is_visible() for index in range(locator.count()))
            if count:
                visible_forbidden.append({**expected, "visibleMatches": count})
        if visible_forbidden:
            raise AssertionError(f"forbidden states are visible: {visible_forbidden!r}")

        body = " ".join((page.locator("body").inner_text() or "").split())
        if len(body) < 200:
            raise AssertionError(f"rendered body is suspiciously short ({len(body)} characters)")
        empty_hits = [phrase for phrase in EMPTY_COPY if phrase in body.lower()]
        if empty_hits:
            raise AssertionError(f"empty-shell copy is visible: {', '.join(empty_hits)}")
        if page_errors:
            raise AssertionError(f"page errors: {page_errors!r}")

        return {
            "id": entry["id"],
            "feature": entry["feature"],
            "url": page.url,
            "rationale": entry["description"],
            "httpStatus": status,
            "title": page.title(),
            "bodyCharacters": len(body),
            "visibleChecks": visible_checks,
            "forbiddenVisible": 0,
            "pageErrors": 0,
        }
    except (AssertionError, PlaywrightTimeoutError) as error:
        raise AssertionError(f"{entry['id']} ({url}): {error}") from error
    finally:
        page.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="https://cityscroll.org")
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    entries = {entry["id"]: entry for entry in manifest["entries"]}
    selected_ids = manifest["capabilities"]["entryIds"]
    missing = [entry_id for entry_id in selected_ids if entry_id not in entries]
    if missing:
        raise SystemExit(f"unknown capability entries: {', '.join(missing)}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            verified = [
                verify_entry(browser, args.base, entries[entry_id], args.timeout_ms)
                for entry_id in selected_ids
            ]
        finally:
            browser.close()

    print(json.dumps({
        "schema": "cityscroll.capability_permalink_verification.v1",
        "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "base": args.base,
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "capabilityUpdatedOn": manifest["capabilities"]["updatedOn"],
        "verifiedCount": len(verified),
        "verified": verified,
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
