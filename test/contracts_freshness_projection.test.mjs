import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  nyNaiveTimestampToInstantMs,
  openContractSnapshotProjection,
  OPEN_CONTRACTS_FRESHNESS_STATES,
} from "../site/resident_snapshot_queries.mjs";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";

const moneyListSource = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");

function notice(id, dueDate, overrides = {}) {
  return {
    request_id: id,
    type_of_notice_description: "Solicitation",
    agency_name: "Finance",
    short_title: `Notice ${id}`,
    due_date: dueDate,
    ...overrides,
  };
}

test("America/New_York naive-timestamp conversion is DST-aware", () => {
  // 2026-09-02T16:00:00 in NYC is EDT (UTC-4).
  assert.equal(nyNaiveTimestampToInstantMs("2026-09-02T16:00:00.000"), Date.parse("2026-09-02T20:00:00.000Z"));
  // 2026-01-15T09:00:00 in NYC is EST (UTC-5).
  assert.equal(nyNaiveTimestampToInstantMs("2026-01-15T09:00:00"), Date.parse("2026-01-15T14:00:00.000Z"));
  assert.equal(nyNaiveTimestampToInstantMs(""), null);
  assert.equal(nyNaiveTimestampToInstantMs(null), null);
});

test("a historical committed snapshot evaluated well past its vintage is stale, not empty", () => {
  const payload = {
    generated_at: "2026-08-15T19:35:39.293Z",
    open_as_of: "2026-08-15",
    notices: [notice("1", "2026-08-20T14:00:00.000"), notice("2", "2026-09-02T16:00:00.000")],
  };
  const projection = openContractSnapshotProjection(payload, { clock: new Date("2026-09-04T12:00:00Z") });
  assert.equal(projection.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.STALE);
  assert.equal(projection.emptyStateEligible, false);
  assert.equal(projection.sourceVintage, "2026-08-15");
  // Both notices are long past their deadline by 2026-09-04, so the rows are
  // correctly empty here too — the assertion under test is the *state*, not
  // the row count: staleness must not be reported as "fresh_empty".
  assert.deepEqual(projection.rows, []);
});

test("a stale source with future-dated rows keeps them, qualified rather than presented as complete", () => {
  const payload = {
    generated_at: "2026-08-15T19:35:39.293Z",
    open_as_of: "2026-08-15",
    notices: [notice("1", "2026-08-20T14:00:00.000"), notice("2", "2026-12-01T16:00:00.000")],
  };
  const clock = new Date("2026-09-04T12:00:00Z");
  const projection = openContractSnapshotProjection(payload, { clock });
  assert.equal(projection.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.STALE);
  assert.deepEqual(projection.rows.map((row) => row.request_id), ["2"]);

  const view = buildBrowseView("contracts", payload, new URLSearchParams(), { clock });
  assert.deepEqual(view.rows.map((row) => row.request_id), ["2"]);
  assert.equal(view.contractsFreshness.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.STALE);
  const html = renderBrowseView(view);
  assert.match(html, /data-contracts-freshness="stale"/);
  assert.match(html, /Open-RFP data is out of date/);
  assert.match(html, /Notice 2/);
  assert.doesNotMatch(html, /Notice 1/);
});

test("expired rows never appear, in either the build-rendered or the projected hydration rows", () => {
  const payload = {
    generated_at: "2026-09-04T08:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [notice("expired", "2026-09-01T10:00:00.000"), notice("open", "2026-09-10T10:00:00.000")],
  };
  const clock = new Date("2026-09-04T12:00:00Z");
  const projection = openContractSnapshotProjection(payload, { clock });
  assert.deepEqual(projection.rows.map((row) => row.request_id), ["open"]);

  const view = buildBrowseView("contracts", payload, new URLSearchParams(), { clock });
  assert.deepEqual(view.rows.map((row) => row.request_id), ["open"]);
  assert.doesNotMatch(renderBrowseView(view), /data-record-id="expired"/);
});

test("build-rendered and hydrated states agree for the same explicit clock", () => {
  const payload = {
    generated_at: "2026-09-04T08:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [
      notice("a", "2026-09-01T10:00:00.000"),
      notice("b", "2026-09-10T10:00:00.000"),
      notice("c", "2026-09-20T10:00:00.000"),
    ],
  };
  const clock = new Date("2026-09-04T12:00:00Z");
  const projection = openContractSnapshotProjection(payload, { clock });
  const view = buildBrowseView("contracts", payload, new URLSearchParams(), { clock });
  assert.deepEqual(
    view.rows.map((row) => row.request_id).sort(),
    projection.rows.map((row) => row.request_id).sort(),
  );
  assert.equal(view.contractsFreshness.freshnessState, projection.freshnessState);
  assert.equal(view.contractsFreshness.sourceVintage, projection.sourceVintage);
});

test("a fresh empty source still renders the ordinary empty state", () => {
  const payload = {
    generated_at: "2026-09-04T08:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [],
  };
  const clock = new Date("2026-09-04T12:00:00Z");
  const projection = openContractSnapshotProjection(payload, { clock });
  assert.equal(projection.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.FRESH_EMPTY);
  assert.equal(projection.emptyStateEligible, true);

  const view = buildBrowseView("contracts", payload, new URLSearchParams(), { clock });
  const html = renderBrowseView(view);
  assert.doesNotMatch(html, /Open-RFP data is out of date/);
});

test("an unavailable snapshot is distinguished from a genuinely empty population", () => {
  const clock = new Date("2026-09-04T12:00:00Z");
  assert.equal(
    openContractSnapshotProjection(null, { clock }).freshnessState,
    OPEN_CONTRACTS_FRESHNESS_STATES.UNAVAILABLE,
  );
  assert.equal(
    openContractSnapshotProjection({ notices: [] }, { clock }).freshnessState,
    OPEN_CONTRACTS_FRESHNESS_STATES.UNAVAILABLE,
  );
  const unavailable = openContractSnapshotProjection(null, { clock });
  assert.equal(unavailable.emptyStateEligible, false);
  assert.deepEqual(unavailable.rows, []);
});

test("a solicitation due later today in New York remains visible until its actual deadline", () => {
  const payload = {
    generated_at: "2026-09-04T08:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [notice("today-later", "2026-09-04T18:00:00.000")],
  };
  // 2026-09-04T14:00:00 America/New_York (EDT, UTC-4) = 18:00:00Z — still hours
  // before the 18:00 local deadline.
  const beforeDeadline = new Date(nyNaiveTimestampToInstantMs("2026-09-04T14:00:00"));
  const stillOpen = openContractSnapshotProjection(payload, { clock: beforeDeadline });
  assert.deepEqual(stillOpen.rows.map((row) => row.request_id), ["today-later"]);
});

test("a solicitation whose deadline has passed today is excluded", () => {
  const payload = {
    generated_at: "2026-09-04T08:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [notice("today-earlier", "2026-09-04T09:00:00.000")],
  };
  const afterDeadline = new Date(nyNaiveTimestampToInstantMs("2026-09-04T14:00:00"));
  const closed = openContractSnapshotProjection(payload, { clock: afterDeadline });
  assert.deepEqual(closed.rows, []);
});

test("buildBrowseView without an explicit clock keeps its prior unfiltered contracts behavior", () => {
  // The build/edge boundary always supplies a clock in production; callers that
  // omit one (existing tests, other facets) must not have rows silently dropped
  // by a guessed day.
  const payload = { notices: [notice("legacy", "2020-01-01T00:00:00.000")] };
  const view = buildBrowseView("contracts", payload, new URLSearchParams());
  assert.deepEqual(view.rows.map((row) => row.request_id), ["legacy"]);
  assert.equal(view.contractsFreshness, null);
});

test("money-list.mjs hydration reads the shared projection instead of a private due-date filter", () => {
  assert.match(moneyListSource, /openContractSnapshotProjection/);
  assert.doesNotMatch(moneyListSource, /function filterStillOpenMoneyNotices/);
  // The default-search path paints straight from the projection's rows and its
  // freshness state; it never separately re-derives "still open" or clears a
  // populated list back to the generic empty state on its own.
  assert.match(moneyListSource, /currentMoneyFreshness=defaultProjection/);
  assert.match(moneyListSource, /currentMoneyFreshness && !currentMoneyFreshness\.emptyStateEligible/);
});
