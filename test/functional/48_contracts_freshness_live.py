#!/usr/bin/env python3
"""Post-deploy smoke for the deployed Contracts (Money) resident snapshot.

Checks three things the pre-deploy freshness guard
(tools/check_money_snapshot_freshness.mjs) cannot see, because it only
inspects the committed snapshot before deployment:

* the snapshot actually served by the live origin is within its freshness
  threshold (defense in depth against a stale artifact reaching production
  despite the build-time guard);
* the direct /browse/contracts/ route never transitions from a populated
  server-rendered list to the generic empty state during hydration; and
* a fresh source with current records settles with at least one visible
  record.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "https://cityscroll.org/").rstrip("/") + "/"

# Set only by the production deploy workflow, right after a real acquisition
# refresh. Local/CI runs of the functional suite (test/functional/run.sh)
# serve a fixture snapshot of unmanaged age against the real wall clock, so
# this live-only check stays a no-op there rather than failing on fixture age
# unrelated to any regression — the pre-deploy freshness guard
# (tools/check_money_snapshot_freshness.mjs) already covers offline/CI builds.
STRICT = os.environ.get("CROL_CONTRACTS_FRESHNESS_STRICT") == "1"

# Mirrors OPEN_CONTRACTS_MAX_SNAPSHOT_AGE_MS in site/resident_snapshot_queries.mjs.
MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1000

ROW_MARKER = "money-row-card"
NOTHING_FOUND_MARKER = "Nothing found"


def _parse_iso(value):
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def main() -> None:
    if not STRICT:
        print("contracts freshness browser smoke SKIPPED (CROL_CONTRACTS_FRESHNESS_STRICT not set)")
        return
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()

        snapshot_response = context.request.get(f"{BASE}data/money_default_open.json")
        if not snapshot_response.ok:
            raise AssertionError(f"Contracts snapshot fetch failed: {snapshot_response.status}")
        snapshot = snapshot_response.json()
        vintage = _parse_iso(snapshot.get("generated_at")) or _parse_iso(snapshot.get("open_as_of"))
        if vintage is None:
            raise AssertionError("deployed Contracts snapshot has no valid generated_at/open_as_of")
        age_ms = (datetime.now(timezone.utc) - vintage).total_seconds() * 1000
        if age_ms > MAX_SNAPSHOT_AGE_MS:
            raise AssertionError(
                f"deployed Contracts snapshot is stale: vintage {vintage.isoformat()} "
                f"is {age_ms / 3_600_000:.1f}h old, exceeds the 36h freshness threshold"
            )

        raw_response = context.request.get(f"{BASE}browse/contracts/")
        if not raw_response.ok:
            raise AssertionError(f"Contracts direct route fetch failed: {raw_response.status}")
        initial_row_count = raw_response.text().count(ROW_MARKER)

        page = browser.new_page(viewport={"width": 1280, "height": 960})
        page.goto(f"{BASE}browse/contracts/", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(3_000)
        page.wait_for_load_state("networkidle", timeout=60_000)

        freshness_note = page.locator("[data-contracts-freshness]")
        if freshness_note.count():
            state = freshness_note.first.get_attribute("data-contracts-freshness")
            raise AssertionError(
                f"deployed Contracts page reports a {state!r} freshness state after settling, "
                "even though the pre-deploy freshness guard should have prevented a stale deploy"
            )

        final_row_count = page.locator(".money-row-card").count()
        settled_text = page.locator("#list").inner_text()

        if initial_row_count > 0 and NOTHING_FOUND_MARKER in settled_text:
            raise AssertionError(
                "Contracts direct route transitioned from a populated server-rendered list "
                "to the generic empty state during hydration"
            )

        if final_row_count < 1:
            raise AssertionError(
                "Contracts direct route settled with no visible records, "
                "even though the deployed snapshot passed its freshness guard"
            )

        print(
            "contracts freshness browser smoke OK "
            f"vintage={vintage.isoformat()} initial_rows={initial_row_count} final_rows={final_row_count}"
        )
        browser.close()


if __name__ == "__main__":
    main()
