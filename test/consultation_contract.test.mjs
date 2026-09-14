import assert from "node:assert/strict";
import { test } from "node:test";
import { DOT_PILOT_SEEDS, consultationLifecycle, materializeConsultations, validateConsultationMaterialization } from "../site/consultation_acquisition.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

test("fixed materialization contains four organizer-backed rounds and separate channels", () => {
  const materialized = materializeConsultations();
  assert.equal(materialized.consultations.length, 4);
  assert.deepEqual(materialized.consultations.map((item) => item.title), [
    "Fast Buses: Central Brooklyn", "Coney Island Transportation Study", "Secure Bike Parking", "Public E-Bike Charging",
  ]);
  assert.equal(materialized.consultations[0].channels.length, 2);
  assert.ok(materialized.consultations.every((item) => item.sources.every((source) => source.field_locator)));
});

test("resident materialization rendering performs zero publisher requests", () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("resident rendering must not fetch publisher data"); };
  try {
    const renderedMaterialization = materializeConsultations({ asOf: "2026-09-14T00:00:00.000Z" });
    assert.equal(renderedMaterialization.schema, "cityscroll.consultation_materialization.v1");
    assert.equal(renderedMaterialization.consultations.length, 4);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source fingerprints are exact SHA-256 shapes", () => {
  assert.ok(DOT_PILOT_SEEDS.every((round) => round.sources.every((item) => /^[0-9a-f]{64}$/i.test(item.source_hash))));
  assert.throws(() => validateConsultationMaterialization([
    { ...DOT_PILOT_SEEDS[0], sources: [{ ...DOT_PILOT_SEEDS[0].sources[0], source_hash: `${DOT_PILOT_SEEDS[0].sources[0].source_hash}0` }] },
    ...DOT_PILOT_SEEDS.slice(1),
  ]), /64 hexadecimal/);
});

test("maps and forms remain organizer-linked channels and administrative links are rejected", () => {
  const channels = DOT_PILOT_SEEDS.flatMap((item) => item.channels);
  assert.ok(channels.every((channel) => channel.open_now === false));
  assert.throws(() => validateConsultationMaterialization([{
    ...DOT_PILOT_SEEDS[0], sources: [{ id: "admin", role: "administrative", url: "https://example.test/manage-project-surveys", field_locator: "nav" }],
  }, ...DOT_PILOT_SEEDS.slice(1)]), /administrative/);
});

test("Microsoft loading evidence cannot create an open-now assertion", () => {
  const form = DOT_PILOT_SEEDS[3].sources.find((item) => item.role === "microsoft_form");
  assert.equal(form.field_locator.includes("loading shell"), true);
  assert.equal(DOT_PILOT_SEEDS[3].channels.find((item) => item.id === "ebike-charging-form").open_now, false);
});

test("date precision is retained without inventing a time", () => {
  const deadline = DOT_PILOT_SEEDS[0].deadline;
  assert.deepEqual(deadline, { value: "2026-10-31", precision: "day", source: "questionnaire_copy" });
  assert.equal(Object.hasOwn(deadline, "time"), false);
});

test("an expired day removes the response action without rewriting the source date", async () => {
  await withPinnedClock("2026-11-01T00:00:00.000Z", async () => {
    const lifecycle = consultationLifecycle(DOT_PILOT_SEEDS[0]);
    assert.equal(lifecycle.current, "deadline_passed");
    assert.equal(lifecycle.response_action, "removed");
    assert.equal(DOT_PILOT_SEEDS[0].deadline.value, "2026-10-31");
  });
});
