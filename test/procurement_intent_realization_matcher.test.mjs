import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildProspectiveProcess } from "../ontology/procurement_intent.mjs";
import { resolvePredictions } from "../worker/src/lib/prediction_contract.mjs";
import {
  generateRealizationCandidates,
  matchHistoricalIntent,
  matchHistoricalIntents,
} from "../warehouse/lib/procurement_intent_realization_matcher.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/procurement_intent_radar/gold_fixtures.v0.json", import.meta.url), "utf8"));
const positives = fixtures.cases.filter((item) => item.kind === "positive");
const processes = positives.map((item) => buildProspectiveProcess({ source: item.source, assertion: item.expected_future_action_assertion }));

const realizations = [
  {
    source_system: "city_record", source_system_id: "26026P0003", epin: "26026P0003",
    published_at: "2025-10-01", agency: "DYCD", title: "COMPASS Programs in Public Schools", procurement_method: "RFP",
  },
  {
    source_system: "city_record", source_system_id: "26026P0004", epin: "26026P0004",
    published_at: "2025-10-01", agency: "Department of Youth and Community Development",
    title: "COMPASS Center-Based and Non-Public School Site Programs", procurement_method: "RFP",
  },
  {
    source_system: "passport", source_system_id: "06925P0010", epin: "06925P0010",
    published_at: "2025-03-07", agency: "HRA / DSS",
    title: "DVS 94 beds Emergency Shelter and Support Services Open Ended RFx",
    description: "Emergency shelter for domestic violence survivors, single adults and families.", procurement_method: "RFx",
  },
  {
    source_system: "city_record", source_system_id: "06823P0002", epin: "06823P0002",
    published_at: "2022-10-14", agency: "Administration for Children's Services",
    title: "Alternative to Detention RFP", procurement_method: "RFP",
  },
];

test("all three positive fixtures match without using the eventual publisher identifier", () => {
  const results = matchHistoricalIntents(processes, realizations);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((result) => result.outcome), [
    {
      status: "matched", occurrence: "hit", timing: "hit", lead_days: 135,
      match_confidence: "extremely_high", cardinality: { intent_count: 1, realized_count: 2, relation: "one_to_many" },
    },
    {
      status: "matched", occurrence: "hit", timing: "miss", lead_days: 149,
      match_confidence: "extremely_high", cardinality: { intent_count: 1, realized_count: 1, relation: "one_to_one" },
    },
    {
      status: "matched", occurrence: "hit", timing: "miss", lead_days: 219,
      match_confidence: "high", cardinality: { intent_count: 1, realized_count: 1, relation: "one_to_one" },
    },
  ]);
  assert.deepEqual(results[0].realized_by.map((edge) => edge.to), [
    "procurement:city_record:26026P0003", "procurement:city_record:26026P0004",
  ]);
  assert.ok(results[0].realized_by.every((edge) => edge.status === "accepted"));
  assert.equal(results[0].candidates[0].features.temporal_integrity.feature_clock, "intent_fields_as_observed_at_only");
  assert.equal(JSON.stringify(results[0].candidates[0].features).includes("26026P0003"), false);
});

test("resolution events preserve the exact provisional subject/event pair", () => {
  const result = matchHistoricalIntent(processes[1], [realizations[2]]);
  assert.deepEqual(result.resolution_events, [{
    event_id: "procurement:passport:06925P0010",
    subject_ref: "procurement-intent:hra-dv-94-beds-2024",
    event_kind: "procurement.notice_published",
    published_at: "2025-03-07",
  }]);
  const resolved = resolvePredictions(
    [processes[1].predictions.occurrence, processes[1].predictions.timing],
    result.resolution_events,
    { now: "2025-03-08T00:00:00.000Z" },
  );
  assert.deepEqual(resolved.map((prediction) => prediction.status), ["resolved_hit", "resolved_miss"]);
});

test("agency scope, date horizon, and missing realization data fail closed", () => {
  const intent = processes[0];
  const rows = [
    { source_system: "city_record", source_system_id: "wrong-agency", published_at: "2025-10-01", agency: "ACS", title: "COMPASS RFP" },
    { source_system: "city_record", source_system_id: "too-late", published_at: "2027-01-01", agency: "DYCD", title: "COMPASS RFP" },
    { source_system: "city_record", source_system_id: "no-date", agency: "DYCD", title: "COMPASS RFP" },
  ];
  assert.deepEqual(generateRealizationCandidates(intent, rows), []);
});

test("ambiguous same-agency candidates remain review leads without public realized_by edges", () => {
  const result = matchHistoricalIntent(processes[1], [{
    source_system: "passport", source_system_id: "ambiguous", published_at: "2025-01-10", agency: "DSS",
    title: "Emergency Services RFP", procurement_method: "RFP",
  }]);
  assert.equal(result.outcome.status, "review");
  assert.equal(result.outcome.occurrence, "unresolved");
  assert.equal(result.realized_by.length, 0);
  assert.equal(result.review_candidates.length, 1);
  assert.equal(result.review_candidates[0].features.decision, "review");
});

test("unmatched intent stays unmatched rather than forcing the nearest same-agency row", () => {
  const result = matchHistoricalIntent(processes[0], [{
    source_system: "city_record", source_system_id: "generic", published_at: "2025-06-01", agency: "DYCD",
    title: "General Services", procurement_method: "RFP",
  }]);
  assert.equal(result.outcome.status, "review");
  assert.equal(result.realized_by.length, 0);
  assert.equal(result.outcome.match_confidence, "ambiguous");
});

test("hindsight-only fields are rejected before feature extraction", () => {
  assert.throws(() => matchHistoricalIntent({
    ...processes[0],
    stated_intent: { ...processes[0].stated_intent, epin: "26026P0003" },
  }, realizations), /hindsight-only field epin/u);
  assert.throws(() => matchHistoricalIntent({
    ...processes[0],
    stated_intent: { ...processes[0].stated_intent, vendor_name: "Future Vendor" },
  }, realizations), /hindsight-only field vendor_name/u);
});
