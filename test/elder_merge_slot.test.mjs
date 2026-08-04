import assert from "node:assert/strict";
import test from "node:test";

import { pickElderSeatHolder, DEFAULT_ELDER } from "../tools/elder_merge_slot.mjs";

test("policy separates soft steering from hard reservation", () => {
  assert.equal(DEFAULT_ELDER.detect_and_steer_age_hours, 2);
  assert.equal(DEFAULT_ELDER.elder_age_hours, 6);
  assert.equal(DEFAULT_ELDER.rebase_churn_threshold, 3);

  const result = pickElderSeatHolder(
    [{ number: 410, ready: true, age_hours: 2.5, rebase_count: 0 }],
    DEFAULT_ELDER,
  );
  assert.equal(result.seat, null, "soft-tier PR must not hold a ready train");
});

test("younger ready PRs do not overtake an eligible elder", () => {
  const now = Date.parse("2026-08-03T18:00:00Z");
  const result = pickElderSeatHolder(
    [
      { number: 410, created_at: "2026-08-03T16:00:00Z", ready: true }, // 2h — young
      { number: 397, created_at: "2026-08-03T08:00:00Z", ready: true }, // 10h — elder
      { number: 415, created_at: "2026-08-03T17:00:00Z", ready: true }, // 1h — young
    ],
    DEFAULT_ELDER,
    now,
  );
  assert.equal(result.seat.number, 397);
  assert.match(result.reason, /#397/);
});

test("rebase churn alone qualifies a PR as elder", () => {
  const result = pickElderSeatHolder(
    [
      { number: 500, ready: true, age_hours: 1, rebase_count: 5 },
      { number: 501, ready: true, age_hours: 2, rebase_count: 0 },
    ],
    DEFAULT_ELDER,
  );
  assert.equal(result.seat.number, 500);
});

test("no reservation when no PR exceeds thresholds", () => {
  const result = pickElderSeatHolder(
    [
      { number: 1, ready: true, age_hours: 1, rebase_count: 0 },
      { number: 2, ready: true, age_hours: 2, rebase_count: 1 },
    ],
    DEFAULT_ELDER,
  );
  assert.equal(result.seat, null);
  assert.match(result.reason, /no elder/);
});

test("disabled policy returns no seat", () => {
  const result = pickElderSeatHolder(
    [{ number: 1, ready: true, age_hours: 48 }],
    { ...DEFAULT_ELDER, enabled: false },
  );
  assert.equal(result.seat, null);
});
