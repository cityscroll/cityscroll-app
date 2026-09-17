import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNearYouExplanationCandidates } from "../site/near_you_explanation_path.mjs";
import { buildNearYouViewModel } from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";
import { scopeWithPlace } from "../site/near_you_scope_runtime.mjs";
import { handleNearYou } from "../worker/src/near_you.mjs";
import { NEAR_YOU_MANIFEST_KEY } from "../worker/src/lib/route_read_model_kv.mjs";

const RECORD_ID = "BSA-2026-001";
const MANHATTAN = "geography:borough:1";
const K15 = "geography:community_district:K15";

const nodes = [
  { subject_ref: "borough:manhattan", kind: "borough", label: "Manhattan" },
  { subject_ref: "community-district:K15", kind: "community-district", label: "Brooklyn Community District 15" },
];

const edges = [
  {
    type: "located_in", from: `notice:${RECORD_ID}`, to: "borough:manhattan", decision: "public",
    method: "district_activity_placement_v1", method_version: "1.0.0", confidence: "strong",
    location_role: "venue", basis: "Venue / logistics",
    evidence: { placement_method: "venue_line", boundary_vintage: "2026-05-26" },
  },
  {
    type: "located_in", from: `notice:${RECORD_ID}`, to: "community-district:K15", decision: "public",
    method: "district_activity_placement_v1", method_version: "1.0.0", confidence: "strong",
    location_role: "affected_area", basis: "Affected area",
    evidence: { placement_method: "matter_address", boundary_vintage: "2026-05-26" },
  },
];

const record = {
  id: RECORD_ID, title: "Frozen multi-place hearing", agency: "Transportation", type: "Public Hearing",
  date: "2026-08-12T18:00:00.000Z", basis: "Venue / logistics", confidence: "strong",
  route: `/#notice/${RECORD_ID}`,
  place: {
    geographies: [
      { key: MANHATTAN, type: "borough", id: "1", label: "Manhattan", visibility: "public",
        location_role: "venue", basis: "Venue / logistics", method: "venue_line", confidence: "strong",
        source_id: "district-boundaries", boundary_vintage: "2026-05-26", provenance: { placement_method: "venue_line" } },
      { key: K15, type: "community_district", id: "K15", label: "Brooklyn Community District 15", visibility: "public",
        location_role: "affected_area", basis: "Affected area", method: "matter_address", confidence: "strong",
        source_id: "district-boundaries", boundary_vintage: "2026-05-26", provenance: { placement_method: "matter_address" } },
    ],
  },
};

const backlinks = [{ publication_tier: "deterministic", duty_text: "Review public matters.", agency_name: "Transportation", agency_href: "/agencies/transportation", relation_label: "public duty" }];
const candidates = buildNearYouExplanationCandidates({ record, lens: "meetings", locatedEdges: edges, geographyNodes: nodes, mandateBacklinks: backlinks });
record.why_here_candidates = candidates;

const activity = {
  built_at: "2026-08-04T12:00:00.000Z", records: { meetings: { [RECORD_ID]: record } },
  district_items: { by_level: { borough: { Manhattan: { meetings: [RECORD_ID] } }, community_district: { K15: { meetings: [RECORD_ID] } }, council_district: {} }, citywide: { meetings: [] }, virtual: { meetings: [] }, unlocated: { meetings: [] } },
  geography_items: { definitions: {}, by_key: { [MANHATTAN]: { meetings: [RECORD_ID] }, [K15]: { meetings: [RECORD_ID] } } },
};
const boundaries = { boundary_vintage: "2026-05-26", community_districts: [], council_districts: [] };

function placeScope(placeRole, place) {
  return scopeWithPlace(scopeFromLensState("meetings", { agency: "Transportation", place_role: placeRole }), place);
}

test("membership metadata preserves distinct locality roles without duplicating the record", () => {
  assert.equal(candidates.length, 2);
  assert.equal(candidates.find((candidate) => candidate.location.subject_ref === "borough:manhattan").location.place_role, "venue");
  assert.equal(candidates.find((candidate) => candidate.location.subject_ref === "community-district:K15").location.place_role, "affected_area");
  assert.equal(Object.keys(activity.records.meetings).length, 1);
});

test("Near You filters and explains from the selected admitting membership", () => {
  const manhattan = buildNearYouViewModel(placeScope("venue", { borough: "Manhattan" }), activity, boundaries);
  assert.deepEqual(manhattan.results.ids, [RECORD_ID]);
  assert.equal(manhattan.results.records[0].why_here.location.place_role, "venue");

  const k15 = buildNearYouViewModel(placeScope("affected_area", { borough: "Brooklyn", communityDistrict: "K15" }), activity, boundaries);
  assert.deepEqual(k15.results.ids, [RECORD_ID]);
  assert.equal(k15.results.records[0].why_here.location.place_role, "affected_area");
  assert.equal(k15.results.records[0].why_here.location.label, "Brooklyn Community District 15");
});

test("served Near You route renders the explanation from the selected membership", async () => {
  const sliceKey = "near-you:v1:membership-role-fixture";
  const values = new Map([
    [NEAR_YOU_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "near-you",
      version: "membership-role-fixture",
      slices: Object.fromEntries([
        "borough:Manhattan", "community-district:K15", "citywide", "virtual", "unlocated",
      ].flatMap((place) => [[`${place}:meetings`, sliceKey]])),
    })],
    [sliceKey, JSON.stringify({ activity, community_geography: {} })],
  ]);
  const env = { ALERT_STATE: { async get(key) { return values.get(key) || null; } } };

  async function deferredHtml(query) {
    const documentResponse = await handleNearYou(new Request(`https://cityscroll.org/near-you/?${query}`), env);
    assert.equal(documentResponse.status, 200);
    assert.match(await documentResponse.text(), /data-near-deferred="results"/);
    const deferredResponse = await handleNearYou(new Request(`https://cityscroll.org/near-you/deferred.json?${query}`), env);
    assert.equal(deferredResponse.status, 200);
    return (await deferredResponse.json()).results_html;
  }

  const manhattanHtml = await deferredHtml("lens=meetings&boro=Manhattan&placeRole=venue");
  assert.match(manhattanHtml, /data-place-role="venue"/);
  // Explanation lives in the inspection payload after staged Near You cards.
  assert.match(
    manhattanHtml,
    /&quot;place_role_label&quot;:&quot;Meeting venue&quot;,&quot;label&quot;:&quot;Manhattan&quot;/,
  );
  assert.doesNotMatch(
    manhattanHtml,
    /&quot;place_role_label&quot;:&quot;Affected area&quot;,&quot;label&quot;:&quot;Brooklyn Community District 15&quot;/,
  );

  const k15Html = await deferredHtml("lens=meetings&boro=Brooklyn&cd=K15&placeRole=affected_area");
  assert.match(k15Html, /data-place-role="affected_area"/);
  assert.match(
    k15Html,
    /&quot;place_role_label&quot;:&quot;Affected area&quot;,&quot;label&quot;:&quot;Brooklyn Community District 15&quot;/,
  );
  assert.doesNotMatch(
    k15Html,
    /&quot;place_role_label&quot;:&quot;Meeting venue&quot;,&quot;label&quot;:&quot;Manhattan&quot;/,
  );
});
