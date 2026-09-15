import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consultationDeadline,
  consultationNowItems,
  consultationPlace,
} from "../site/consultation_place_time.mjs";

const observed = "2026-08-01T00:00:00.000Z";
const base = { id: "round-1", title: "A local invitation", organizer: "Agency", observed_at: observed };

test("place projection preserves exact board identity, accepted address evidence, and absence", () => {
  assert.deepEqual(consultationPlace({ ...base, geography: { kind: "community_board", labels: ["CB14"], evidence: "board_identity" } }).community_districts, ["K14"]);
  assert.deepEqual(consultationPlace({ ...base, geography: { labels: ["Bloomingdale"], evidence: "accepted_address_geocoding", community_districts: ["M10"] } }).community_districts, ["M10"]);
  assert.deepEqual(consultationPlace({ ...base, geography: { kind: "corridor", labels: ["Church Avenue"] } }).community_districts, []);
  assert.equal(consultationPlace({ ...base, geography: { kind: "citywide", labels: ["New York City"] } }).scope, "citywide");
});

test("Now admits only fresh deadlines in the inclusive thirty-day window", () => {
  const options = { asOf: "2026-08-15T12:00:00.000Z" };
  const fresh = { ...base, observed_at: "2026-08-15T00:00:00.000Z" };
  assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-08-15", precision: "day" } }, options).supported, true);
  assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-09-14", precision: "day" } }, options).supported, true);
  assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-09-15", precision: "day" } }, options).supported, false);
  assert.equal(consultationDeadline({ ...fresh, deadline: { value: "2026-08-14", precision: "day" } }, options).expired, true);
  assert.equal(consultationDeadline({ ...fresh, deadline: null }, options).supported, false);
  assert.equal(consultationDeadline({ ...base, deadline: { value: "2026-08-20", precision: "day" }, observed_at: "2026-07-31T00:00:00.000Z" }, options).fresh, false);
  const [item] = consultationNowItems([{ ...fresh, deadline: { value: "2026-08-20", precision: "day" } }], options);
  assert.equal(item.time.precision, "day");
  assert.equal(item.place.scope, "unlocated");
});
