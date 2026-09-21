import assert from "node:assert/strict";
import test from "node:test";

import { withPinnedClock } from "./helpers/test_clock.mjs";
import { OPEN_CONTRACTS_FRESHNESS_STATES } from "../site/resident_snapshot_queries.mjs";

const messages = {
  contracts_source_stale: "Open-RFP data is out of date. Last updated {date}.",
  money_agencies_source_stale: "The agency filter is using a retained copy. Source copy dated {date}.",
  retry_open_data: "The latest CityScroll snapshot is unavailable. Retry in a moment.",
};

globalThis.t = (key, values = {}) => String(messages[key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");

const {
  moneyAgencyStalenessNoticeHTML,
  moneyStaleSourceNoticeHTML,
} = await import("../site/money-freshness.mjs");

test("retained agency metadata renders a resident-readable source vintage", async () => {
  await withPinnedClock("2026-09-21T12:00:00Z", () => {
    const html = moneyAgencyStalenessNoticeHTML({
      stale: true,
      source_vintage: "2026-09-01T00:00:00.000Z",
    });

    assert.match(html, /data-contracts-agencies-freshness="stale"/);
    assert.match(html, /Source copy dated 2026-09-01\./);
  });
});

test("current agency metadata emits no staleness note", async () => {
  await withPinnedClock("2026-09-21T12:00:00Z", () => {
    assert.equal(
      moneyAgencyStalenessNoticeHTML({
        stale: false,
        source_vintage: "2026-09-21T00:00:00.000Z",
      }),
      "",
    );
  });
});

test("stale open-contract metadata renders its source vintage", async () => {
  await withPinnedClock("2026-09-21T12:00:00Z", () => {
    const html = moneyStaleSourceNoticeHTML({
      freshnessState: OPEN_CONTRACTS_FRESHNESS_STATES.STALE,
      sourceVintage: "2026-09-01T00:00:00.000Z",
    });

    assert.match(html, /data-contracts-freshness="stale"/);
    assert.match(html, /Last updated 2026-09-01\./);
  });
});

test("current open-contract metadata emits no staleness note", async () => {
  await withPinnedClock("2026-09-21T12:00:00Z", () => {
    assert.equal(
      moneyStaleSourceNoticeHTML({
        freshnessState: OPEN_CONTRACTS_FRESHNESS_STATES.FRESH,
        sourceVintage: "2026-09-21T00:00:00.000Z",
      }),
      "",
    );
  });
});
