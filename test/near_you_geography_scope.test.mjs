import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import { geographyRecordProjection } from "../site/geography_navigation_records.mjs";
import {
  LENSES,
  buildNearYou,
  decideNearYouManifestActivation,
  placeCoverageState,
  residentialPlacesFromNtaLayer,
  requiredNearYouSliceIds,
  validateNearYouManifestCompleteness,
} from "../tools/build_worker_route_read_models.mjs";

import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
  renderNearYouBody,
} from "../site/near_you_view.mjs";
import {
  scopeFromRouteHash,
  scopeWithGeographies,
} from "../site/scope_v0.mjs";

const ROOT = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
const activity = readJson("site/data/district_activity.json");
const boundaries = readJson("site/data/district_boundaries.json");
const ntaLayer = readJson("site/data/geography/layers/nta2020/26B.json");
const residentialPlaces = residentialPlacesFromNtaLayer(ntaLayer);

test("map short-token URLs retain the exact canonical geography in the records scope", () => {
  const short = scopeFromNearYouUrl("https://cityscroll.org/near-you/?geo=nta2020:BK0101&lens=meetings");
  const full = scopeFromNearYouUrl("https://cityscroll.org/near-you/?geo=geography:nta2020:BK0101&lens=meetings");
  assert.deepEqual(short.place.geographies, ["geography:nta2020:BK0101"]);
  assert.deepEqual(short, full);
});

test("published slices retain an observed empty membership without inventing unknown coverage", () => {
  const key = "geography:nta2020:BK0102";
  const missing = "geography:nta2020:BK0101";
  const source = {
    geography_items: {
      definitions: {
        [key]: { key, type: "nta2020", id: "BK0102", label: "Williamsburg" },
      },
      by_key: { [key]: { meetings: [] } },
    },
    records: { meetings: {} },
  };
  const places = [
    { key, type: "nta2020", id: "BK0102", label: "Williamsburg", class: "statistical", subtype: "residential", source_id: "dcp-nta2020-boundaries", boundary_vintage: "26B" },
    { key: missing, type: "nta2020", id: "BK0101", label: "Greenpoint", class: "statistical", subtype: "residential", source_id: "dcp-nta2020-boundaries", boundary_vintage: "26B" },
  ];
  const built = buildNearYou(source, {}, "fixture", { residentialPlaces: places });
  const zeroEntry = built.entries.find((entry) => entry.key === built.manifest.slices[`${key}:meetings`]);
  const zeroSlice = JSON.parse(zeroEntry.value);
  assert.deepEqual(zeroSlice.activity.geography_items.by_key[key].meetings, []);
  assert.equal(zeroSlice.coverage.state, "zero");

  const unavailableEntry = built.entries.find((entry) => entry.key === built.manifest.slices[`${missing}:meetings`]);
  const unavailableSlice = JSON.parse(unavailableEntry.value);
  assert.equal(unavailableSlice.coverage.state, "source_unavailable");
  assert.equal(unavailableSlice.activity.geography_items.by_key[missing], undefined);
  assert.equal(unavailableSlice.activity.geography_items.definitions[missing].label, "Greenpoint");
  assert.equal(geographyRecordProjection(unavailableSlice.activity, { key: missing, lens: "meetings" }).state, "unavailable");
});

test("A1: canonical residential registry × LENSES has no silently missing slice", () => {
  assert.ok(residentialPlaces.length >= 190, "residential registry should be populated");
  assert.ok(residentialPlaces.some((place) => place.id === "BK0101"));
  assert.ok(residentialPlaces.some((place) => place.id === "QN0103"));
  assert.ok(residentialPlaces.some((place) => place.id === "SI0101"));

  const built = buildNearYou(activity, {}, "census", { residentialPlaces });
  const completeness = validateNearYouManifestCompleteness(built.manifest, residentialPlaces, LENSES);
  assert.equal(completeness.ok, true);
  assert.equal(completeness.missing.length, 0);
  assert.equal(completeness.required, residentialPlaces.length * LENSES.length);

  for (const code of ["BK0101", "QN0103", "SI0101"]) {
    const key = `geography:nta2020:${code}`;
    const sliceId = `${key}:meetings`;
    const entry = built.entries.find((row) => row.key === built.manifest.slices[sliceId]);
    assert.ok(entry, sliceId);
    const slice = JSON.parse(entry.value);
    assert.ok(["ready", "source_unavailable"].includes(slice.coverage.state), `${code}:${slice.coverage.state}`);
    assert.notEqual(slice.coverage.state, "zero", code);
    assert.equal(placeCoverageState(activity, key, "meetings"), "source_unavailable");
    const projection = geographyRecordProjection(slice.activity, { key, lens: "meetings" });
    assert.equal(projection.state, "unavailable");
    assert.equal(projection.count, null);
  }
});

test("A2: positive membership, published zero, unknown place, and activation failure stay distinct", () => {
  const built = buildNearYou(activity, {}, "distinct", { residentialPlaces });
  const readSlice = (sliceId) => JSON.parse(
    built.entries.find((row) => row.key === built.manifest.slices[sliceId]).value,
  );

  const tribeca = readSlice("geography:nta2020:MN0102:meetings");
  assert.equal(tribeca.coverage.state, "ready");
  assert.ok(tribeca.activity.geography_items.by_key["geography:nta2020:MN0102"].meetings.length > 0);
  assert.equal(
    geographyRecordProjection(tribeca.activity, { key: "geography:nta2020:MN0102", lens: "meetings" }).state,
    "ready",
  );

  const mottHaven = readSlice("geography:nta2020:BX0101:meetings");
  assert.equal(mottHaven.coverage.state, "zero");
  assert.deepEqual(mottHaven.activity.geography_items.by_key["geography:nta2020:BX0101"].meetings, []);
  assert.equal(
    geographyRecordProjection(mottHaven.activity, { key: "geography:nta2020:BX0101", lens: "meetings" }).state,
    "zero",
  );

  assert.equal(built.manifest.slices["geography:nta2020:BK9999:meetings"], undefined);

  const communityDistrict = readSlice("community-district:X01:meetings");
  const neighborhood = readSlice("geography:nta2020:BX0101:meetings");
  const cdMembers = communityDistrict.activity.district_items?.by_level?.community_district?.X01?.meetings || [];
  assert.ok(Array.isArray(cdMembers));
  assert.deepEqual(neighborhood.activity.geography_items.by_key["geography:nta2020:BX0101"].meetings, []);
  assert.equal(
    JSON.stringify(neighborhood.activity.geography_items.by_key["geography:nta2020:BX0101"].meetings)
      === JSON.stringify(cdMembers) && cdMembers.length > 0,
    false,
    "neighborhood slice must not inherit broader district membership",
  );

  const previous = { schema_version: 1, kind: "near-you", version: "prior-good", slices: { ...built.manifest.slices } };
  const incomplete = {
    ...built.manifest,
    version: "incomplete-candidate",
    slices: Object.fromEntries(
      Object.entries(built.manifest.slices).filter(([sliceId]) => !sliceId.startsWith("geography:nta2020:BK0101:")),
    ),
  };
  const refused = decideNearYouManifestActivation({
    previousManifest: previous,
    candidateManifest: incomplete,
    residentialPlaces,
  });
  assert.equal(refused.activate, false);
  assert.equal(refused.reason, "incomplete_manifest");
  assert.equal(refused.activeManifest.version, "prior-good");
  assert.ok(refused.missing.some((sliceId) => sliceId.startsWith("geography:nta2020:BK0101:")));

  const stale = { schema_version: 0, kind: "near-you", version: "stale", slices: built.manifest.slices };
  const staleDecision = decideNearYouManifestActivation({
    previousManifest: previous,
    candidateManifest: stale,
    residentialPlaces,
  });
  assert.equal(staleDecision.activate, false);
  assert.equal(staleDecision.reason, "stale_or_invalid_manifest");
  assert.equal(staleDecision.activeManifest.version, "prior-good");

  const partialKeys = new Set(
    requiredNearYouSliceIds(residentialPlaces)
      .filter((sliceId) => !sliceId.startsWith("geography:nta2020:SI0101:"))
      .map((sliceId) => built.manifest.slices[sliceId]),
  );
  const partial = decideNearYouManifestActivation({
    previousManifest: previous,
    candidateManifest: built.manifest,
    residentialPlaces,
    publishedSliceKeys: partialKeys,
  });
  assert.equal(partial.activate, false);
  assert.equal(partial.reason, "partial_publication");
  assert.equal(partial.activeManifest.version, "prior-good");

  const activated = decideNearYouManifestActivation({
    previousManifest: previous,
    candidateManifest: built.manifest,
    residentialPlaces,
    publishedSliceKeys: new Set(Object.values(built.manifest.slices)),
  });
  assert.equal(activated.activate, true);
  assert.equal(activated.activeManifest.version, built.manifest.version);
});

function populatedKey(type, lens) {
  return Object.values(activity.geography_items.definitions)
    .find((definition) => definition.type === type
      && activity.geography_items.by_key[definition.key]?.[lens]?.length)?.key;
}

test("A3: live read-back receipt retains the five borough fixtures and activation proofs", () => {
  const receipt = readJson("docs/evidence/near-you-place-slices/live-readback-receipt.json");
  assert.equal(receipt.schema, "cityscroll.near_you_place_slices_live_readback.v1");
  assert.equal(receipt.record, "cityscroll-engineering/c76db1a2c9474");
  assert.equal(receipt.grounded_at, "fbefd38e164a77ec9f18a8d530e933a7ed1cd67c");
  assert.ok(["awaiting_production_readback", "recorded"].includes(receipt.status));
  assert.deepEqual(receipt.fixtures.map((row) => row.id), ["BK0101", "QN0103", "SI0101", "MN0102", "BX0101"]);
  const built = buildNearYou(activity, {}, "receipt-check", { residentialPlaces });
  for (const fixture of receipt.fixtures) {
    const sliceId = `geography:nta2020:${fixture.id}:meetings`;
    const slice = JSON.parse(built.entries.find((row) => row.key === built.manifest.slices[sliceId]).value);
    assert.equal(slice.coverage.state, fixture.expected_local_coverage, fixture.id);
    assert.equal(
      geographyRecordProjection(slice.activity, {
        key: `geography:nta2020:${fixture.id}`,
        lens: "meetings",
      }).state,
      fixture.expected_projection_state,
      fixture.id,
    );
  }
  assert.ok(receipt.assertions.some((row) => row.id === "canonical-registry-census" && row.result === "accepted"));
  assert.ok(receipt.assertions.some((row) => row.id === "fail-then-recover-activation" && row.result === "accepted"));
  assert.ok(receipt.assertions.some((row) => row.id === "atomic-publication-gate" && row.result === "accepted"));
  assert.ok(receipt.assertions.some((row) => row.id === "production-five-fixture-readback"));
  assert.equal(JSON.stringify(receipt).includes("/Users/"), false);
  assert.doesNotMatch(JSON.stringify(receipt), /file:\/\//);
});

test("all five Near You lenses carry role- and provenance-preserving generic geography matches", () => {
  assert.deepEqual(activity.geography_items.public_types, [
    "borough",
    "community_district",
    "council_district",
    "nta2020",
    "police_precinct",
  ]);
  assert.ok(!activity.geography_items.public_types.includes("sanitation_district"));
  assert.ok(!activity.geography_items.public_types.includes("business_improvement_district"));

  for (const lens of ["land", "property", "rules", "meetings", "money"]) {
    const records = Object.values(activity.records[lens]);
    assert.ok(records.length > 0, lens);
    assert.ok(records.every((record) => record.place), `${lens}: missing place envelope`);
    assert.ok(records.some((record) => record.place.geographies.length), `${lens}: no geography matches`);
    for (const match of records.flatMap((record) => record.place.geographies)) {
      assert.ok(match.key.startsWith("geography:"), `${lens}:${match.key}`);
      assert.equal(match.relation, "located_in");
      assert.ok(match.location_role, `${lens}:${match.key}:role`);
      assert.ok(match.basis, `${lens}:${match.key}:basis`);
      assert.ok(match.method, `${lens}:${match.key}:method`);
      assert.ok(match.source_id, `${lens}:${match.key}:source`);
      assert.ok(match.boundary_vintage, `${lens}:${match.key}:vintage`);
    }
  }
});

test("NTA and Police Precinct scopes drive the same Near You membership index and explanation evidence", () => {
  for (const type of ["nta2020", "police_precinct"]) {
    const key = populatedKey(type, "property");
    assert.ok(key, type);
    const scope = scopeWithGeographies(scopeFromRouteHash("#property"), [key]);
    const view = buildNearYouViewModel(scope, activity, boundaries);
    const indexed = activity.geography_items.by_key[key].property;

    assert.deepEqual(view.results.ids, indexed);
    assert.equal(view.results.count, indexed.length);
    assert.ok(view.results.records.every((record) => record.geography_evidence?.key === key));
    assert.ok(view.geographyOptions.some((option) => option.key === key));

    const initialHtml = renderNearYouBody(view);
    const { resultsHtml } = renderNearYouDeferredParts(view);
    assert.doesNotMatch(initialHtml, /data-geography-key=/);
    // Geography evidence stays in the inspection payload, not the default card.
    assert.doesNotMatch(resultsHtml, /data-geography-evidence="1"/);
    assert.doesNotMatch(resultsHtml, /class="near-record-why"/);
    assert.match(resultsHtml, /data-near-you-record-inspection=/);
    assert.match(resultsHtml, /class="near-record-inspect/);
    const payloadMatch = resultsHtml.match(/data-near-you-record-inspection="([^"]+)"/);
    assert.ok(payloadMatch, "inspection payload is present on the result card");
    const payload = JSON.parse(payloadMatch[1]
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&"));
    assert.equal(payload.geography?.label, view.results.records[0].geography_evidence.label);
    assert.equal(payload.geography?.basis, view.results.records[0].geography_evidence.basis);
    assert.equal(payload.geography?.tier, view.results.records[0].geography_evidence.tier);
    const residentText = resultsHtml.replace(/<details\b[\s\S]*?<\/details>/gi, "").replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(residentText, /strong basis|location evidence|placement_method|point_in_polygon/i);
    assert.match(initialHtml, new RegExp(`<option value="${key}" selected>`));
  }
});
