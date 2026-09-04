import assert from "node:assert/strict";
import test from "node:test";

import { evaluateMoneySnapshotFreshness } from "../tools/check_money_snapshot_freshness.mjs";
import { OPEN_CONTRACTS_FRESHNESS_STATES } from "../site/resident_snapshot_queries.mjs";

function notice(id, dueDate) {
  return {
    request_id: id,
    type_of_notice_description: "Solicitation",
    agency_name: "Finance",
    short_title: `Notice ${id}`,
    due_date: dueDate,
  };
}

test("a snapshot refreshed just now passes the production freshness guard", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const payload = {
    generated_at: "2026-09-04T11:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [notice("1", "2026-09-10T14:00:00.000")],
  };
  const result = evaluateMoneySnapshotFreshness(payload, { now });
  assert.equal(result.ok, true);
  assert.equal(result.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.FRESH);
  assert.deepEqual(result.findings, []);
});

test("a fresh zero-row snapshot passes the production freshness guard", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const payload = {
    generated_at: "2026-09-04T11:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [],
  };
  const result = evaluateMoneySnapshotFreshness(payload, { now });
  assert.equal(result.ok, true);
  assert.equal(result.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.FRESH_EMPTY);
});

test("a snapshot older than the 36-hour threshold fails the production freshness guard, even with rows", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const payload = {
    generated_at: "2026-09-02T00:00:00.000Z",
    open_as_of: "2026-09-02",
    notices: [notice("1", "2026-12-01T14:00:00.000")],
  };
  const result = evaluateMoneySnapshotFreshness(payload, { now });
  assert.equal(result.ok, false);
  assert.equal(result.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.STALE);
  assert.match(result.findings[0], /stale/);
});

test("a snapshot missing open_as_of and generated_at fails as unavailable, never inferred from rows", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const payload = { notices: [notice("1", "2026-12-01T14:00:00.000")] };
  const result = evaluateMoneySnapshotFreshness(payload, { now });
  assert.equal(result.ok, false);
  assert.equal(result.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.UNAVAILABLE);
});

test("freshness never infers staleness from row count or latest deadline alone", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  // Fresh vintage, but every notice already expired: freshness is a function
  // of the snapshot's own vintage, not of whether any row is still open.
  const payload = {
    generated_at: "2026-09-04T11:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [notice("expired", "2026-09-01T00:00:00.000")],
  };
  const result = evaluateMoneySnapshotFreshness(payload, { now });
  assert.equal(result.ok, true);
  assert.equal(result.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.FRESH_EMPTY);
});

test("a custom max-age threshold is honored", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const payload = {
    generated_at: "2026-09-04T00:00:00.000Z",
    open_as_of: "2026-09-04",
    notices: [],
  };
  const strict = evaluateMoneySnapshotFreshness(payload, { now, maxAgeMs: 6 * 60 * 60 * 1000 });
  assert.equal(strict.ok, false);
  assert.equal(strict.freshnessState, OPEN_CONTRACTS_FRESHNESS_STATES.STALE);
});
