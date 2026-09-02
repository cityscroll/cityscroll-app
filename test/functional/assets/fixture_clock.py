"""Pin the browser's civic day to one on which the committed fixtures are true.

Browser checks read committed snapshots. Those snapshots carry real deadlines, and a real
clock walks past them: `site/data/money_default_open.json` was taken on 2026-08-15 and its
newest response deadline is 2026-09-02, so from 00:00 UTC on 2026-09-02 the default Contracts
list correctly contained nothing. Every check that waits for a result row then timed out, and
three accessibility shards turned red on pull requests that had touched no procurement code.

The suite therefore states the day it is testing instead of inheriting whatever day the runner
woke up on. `site/app/core.mjs` reads `window.CROL_PINNED_TODAY` when a harness sets it before
the first application script runs; nothing in the shipped product sets it, so residents keep
being shown the real day and the product keeps judging "accepting now" by the real clock.

The pinned day comes from the fixture's own vintage, so refreshing a snapshot moves the day
with it and no date has to be maintained by hand here.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MONEY_OPEN_SNAPSHOT = ROOT / "site" / "data" / "money_default_open.json"


def fixture_today() -> str:
    """The day the committed open-solicitation snapshot describes."""
    payload = json.loads(MONEY_OPEN_SNAPSHOT.read_text(encoding="utf-8"))
    for key in ("open_as_of", "generated_at", "retrieved_at"):
        value = str(payload.get(key) or "")[:10]
        if len(value) == 10 and value[4] == "-" and value[7] == "-":
            return value
    raise AssertionError(
        f"{MONEY_OPEN_SNAPSHOT} declares no vintage; a fixture clock cannot be derived from it"
    )


def pin_fixture_clock(page, day: str | None = None) -> str:
    """Pin one page's civic day. Must run before the page navigates."""
    pinned = day or fixture_today()
    page.add_init_script(f"window.CROL_PINNED_TODAY = {json.dumps(pinned)};")
    return pinned
