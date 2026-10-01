import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyProbeSlot,
  assertResidentNearYouHonesty,
  classifySyntheticCell,
  emptySyntheticAggregate,
  findForbiddenCrossGroupKeys,
  readSyntheticAggregate,
  slotRetainedObservation,
  syntheticGroupDelivery,
} from "../tools/lib/geography_navigation_field_vitals_synthetic.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGGREGATE_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/field-vitals-synthetic-aggregate.json",
);
const RESIDENT_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/field-vitals-observation.json",
);
const PAGES_PATH = join(ROOT, "data/performance/near-you-synthetic-probe.json");
const PROBE = join(ROOT, "tools/run_near_you_synthetic_probe.py");

test("probe plan covers desktop and mobile and requires interaction for INP", () => {
  const pages = JSON.parse(readFileSync(PAGES_PATH, "utf8"));
  assert.equal(pages.traffic_class, "synthetic");
  assert.deepEqual(
    pages.device_profiles.map((profile) => profile.device_class).sort(),
    ["desktop", "mobile"],
  );
  assert.equal(pages.visit_policy.interaction.required, true);
  assert.ok(pages.visit_policy.interaction.preferred_selectors.includes("#near-geo-search-input"));

  const plan = spawnSync("python3", [PROBE, "--plan", "--pages", PAGES_PATH], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  const body = JSON.parse(plan.stdout);
  assert.equal(body.traffic_class, "synthetic");
  assert.equal(body.marker.value, "synthetic");
  assert.equal(body.marker.carried_on_page_url, false);
  const classes = body.visits.map((visit) => visit.device_class).sort();
  assert.deepEqual(classes, ["desktop", "mobile"]);
  assert.ok(body.visits.every((visit) => visit.interaction_required === true));
});

test("delivery records first_probe_slot with null merge_commit and pull_request (present, not absent)", () => {
  const delivery = syntheticGroupDelivery();
  assert.equal(delivery.kind, "first_probe_slot");
  assert.equal(Object.hasOwn(delivery, "merge_commit"), true);
  assert.equal(Object.hasOwn(delivery, "pull_request"), true);
  assert.equal(delivery.merge_commit, null);
  assert.equal(delivery.pull_request, null);
  assert.equal(delivery.at, null);
});

test("below-floor cell withholds percentile; zero observations are no_data", () => {
  const below = classifySyntheticCell({
    metric_id: "lcp_ms",
    device_class: "desktop",
    sampled_count: 4,
  });
  assert.equal(below.status, "insufficient_sample");
  assert.equal(below.sampled_count, 4);
  assert.equal(below.quantile_value, null);
  assert.equal(below.percentile_withheld, true);

  const empty = classifySyntheticCell({
    metric_id: "inp_ms",
    device_class: "mobile",
    sampled_count: 0,
  });
  assert.equal(empty.status, "no_data");
  assert.equal(empty.sampled_count, 0);
  assert.notEqual(empty.status, below.status);
});

test("retained aggregate has no combined/overall/total cross-group keys", () => {
  const document = JSON.parse(readFileSync(AGGREGATE_PATH, "utf8"));
  const forbidden = findForbiddenCrossGroupKeys(document);
  assert.deepEqual(forbidden, []);
  assert.equal(document.combined_with_other_groups, false);
  assert.equal(document.measurement_group, "synthetic");
  assert.ok(!("overall" in document));
  assert.ok(!("total" in document));
  assert.ok(!("combined" in document));
});

test("mutation control: empty slot does not set delivery; first retaining slot does", () => {
  let aggregate = emptySyntheticAggregate();
  assert.equal(aggregate.delivery.at, null);

  const emptySlot = {
    run_key: "slot-empty",
    observed_at: "2026-10-01T12:00:00.000Z",
    observations_emitted: 0,
    retained_observation_count: 0,
  };
  assert.equal(slotRetainedObservation(emptySlot), false);
  aggregate = applyProbeSlot(aggregate, emptySlot);
  assert.equal(aggregate.delivery.at, null);
  assert.equal(aggregate.delivery.merge_commit, null);
  assert.equal(aggregate.delivery.pull_request, null);

  const retainingSlot = {
    run_key: "slot-retain-1",
    observed_at: "2026-10-01T13:00:00.000Z",
    observations_emitted: 6,
    retained_observation_count: 6,
    cells: [
      { metric_id: "lcp_ms", device_class: "desktop", sampled_count: 1 },
      { metric_id: "lcp_ms", device_class: "mobile", sampled_count: 1 },
      { metric_id: "inp_ms", device_class: "desktop", sampled_count: 1 },
      { metric_id: "inp_ms", device_class: "mobile", sampled_count: 1 },
      { metric_id: "cls_score", device_class: "desktop", sampled_count: 1 },
      { metric_id: "cls_score", device_class: "mobile", sampled_count: 1 },
    ],
  };
  assert.equal(slotRetainedObservation(retainingSlot), true);
  aggregate = applyProbeSlot(aggregate, retainingSlot);
  assert.equal(aggregate.delivery.at, "2026-10-01T13:00:00.000Z");
  assert.equal(aggregate.delivery.slot_id, "slot-retain-1");
  assert.equal(aggregate.delivery.merge_commit, null);
  assert.equal(aggregate.delivery.pull_request, null);
  assert.equal(aggregate.delivery.kind, "first_probe_slot");

  // A later retaining slot must not move the first-slot anchor.
  aggregate = applyProbeSlot(aggregate, {
    ...retainingSlot,
    run_key: "slot-retain-2",
    observed_at: "2026-10-01T14:00:00.000Z",
  });
  assert.equal(aggregate.delivery.at, "2026-10-01T13:00:00.000Z");
  assert.equal(aggregate.delivery.slot_id, "slot-retain-1");
});

test("reader refuses missing required per-cell field and names it; absent vs unread", () => {
  assert.equal(readSyntheticAggregate(null).state, "absent");
  assert.equal(readSyntheticAggregate("not-json-object").state, "unread");

  const document = emptySyntheticAggregate();
  delete document.cells[0].sampled_count;
  const refused = readSyntheticAggregate(document);
  assert.equal(refused.ok, false);
  assert.equal(refused.missing_field, "cells[0].sampled_count");

  const ok = readSyntheticAggregate(emptySyntheticAggregate());
  assert.equal(ok.ok, true);
});

test("retained synthetic aggregate validates; delivery nulls are explicit", () => {
  const document = JSON.parse(readFileSync(AGGREGATE_PATH, "utf8"));
  const read = readSyntheticAggregate(document);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(Object.hasOwn(document.delivery, "merge_commit"), true);
  assert.equal(Object.hasOwn(document.delivery, "pull_request"), true);
  assert.equal(document.delivery.merge_commit, null);
  assert.equal(document.delivery.pull_request, null);
  assert.equal(document.cells.length, 6);
});

test("resident near-you honesty survives (acceptance 7)", () => {
  const resident = JSON.parse(readFileSync(RESIDENT_PATH, "utf8"));
  assert.equal(assertResidentNearYouHonesty(resident), true);
});
