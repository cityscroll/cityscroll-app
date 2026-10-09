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
    // Publication keeps the full artifact's own non-exact state (a missing
    // lens stays unfilterable) rather than collapsing it into "unavailable".
    const projection = geographyRecordProjection(slice.activity, { key, lens: "meetings" });
    const source = geographyRecordProjection(activity, { key, lens: "meetings" });
    assert.ok(["unavailable", "unfilterable", "incomplete"].includes(projection.state), `${code}:${projection.state}`);
    assert.equal(projection.state, source.state, code);
    assert.equal(projection.exact, false, code);
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

  // Mott Haven has property membership but no meetings hits. Observed-only
  // serialization keeps meetings absent (source_unavailable) instead of a
  // sibling-fabricated empty array.
  const mottHaven = readSlice("geography:nta2020:BX0101:meetings");
  assert.equal(mottHaven.coverage.state, "source_unavailable");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      mottHaven.activity.geography_items.by_key["geography:nta2020:BX0101"] || {},
      "meetings",
    ),
    false,
  );
  assert.equal(
    geographyRecordProjection(mottHaven.activity, { key: "geography:nta2020:BX0101", lens: "meetings" }).state,
    "unfilterable",
  );

  // Explicit measured zero remains distinct when the meetings lens itself publishes [].
  const zeroSource = structuredClone(activity);
  zeroSource.geography_items.by_key["geography:nta2020:BX0101"] = {
    ...zeroSource.geography_items.by_key["geography:nta2020:BX0101"],
    meetings: [],
  };
  const zeroBuilt = buildNearYou(zeroSource, {}, "distinct-zero", { residentialPlaces });
  const zeroSlice = JSON.parse(
    zeroBuilt.entries.find((row) => row.key === zeroBuilt.manifest.slices["geography:nta2020:BX0101:meetings"]).value,
  );
  assert.equal(zeroSlice.coverage.state, "zero");
  assert.deepEqual(zeroSlice.activity.geography_items.by_key["geography:nta2020:BX0101"].meetings, []);
  assert.equal(
    geographyRecordProjection(zeroSlice.activity, { key: "geography:nta2020:BX0101", lens: "meetings" }).state,
    "zero",
  );

  assert.equal(built.manifest.slices["geography:nta2020:BK9999:meetings"], undefined);

  const communityDistrict = readSlice("community-district:X01:meetings");
  const neighborhood = readSlice("geography:nta2020:BX0101:meetings");
  const cdMembers = communityDistrict.activity.district_items?.by_level?.community_district?.X01?.meetings || [];
  assert.ok(Array.isArray(cdMembers));
  const neighborhoodBag = neighborhood.activity.geography_items.by_key["geography:nta2020:BX0101"] || {};
  assert.equal(Object.prototype.hasOwnProperty.call(neighborhoodBag, "meetings"), false);
  assert.equal(
    cdMembers.length > 0 && neighborhoodBag.meetings === undefined,
    true,
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
  // Current observed-only semantics: Mott Haven property membership no longer
  // fabricates an empty meetings array, so BX0101 meetings is source_unavailable.
  // The receipt keeps its capture-time expectation for audit.
  const currentCoverageByFixture = {
    BK0101: "source_unavailable",
    QN0103: "source_unavailable",
    SI0101: "source_unavailable",
    MN0102: "ready",
    BX0101: "source_unavailable",
  };
  const built = buildNearYou(activity, {}, "receipt-check", { residentialPlaces });
  for (const fixture of receipt.fixtures) {
    const sliceId = `geography:nta2020:${fixture.id}:meetings`;
    const slice = JSON.parse(built.entries.find((row) => row.key === built.manifest.slices[sliceId]).value);
    assert.equal(slice.coverage.state, currentCoverageByFixture[fixture.id], fixture.id);
    assert.ok(
      ["ready", "zero", "source_unavailable"].includes(fixture.expected_local_coverage),
      fixture.id,
    );
    const key = `geography:nta2020:${fixture.id}`;
    const projection = geographyRecordProjection(slice.activity, { key, lens: "meetings" });
    if (currentCoverageByFixture[fixture.id] === "ready") {
      assert.equal(projection.state, "ready", fixture.id);
      assert.ok(projection.count > 0, fixture.id);
    } else {
      assert.equal(projection.exact, false, fixture.id);
      assert.equal(projection.count, null, fixture.id);
      assert.equal(projection.state, geographyRecordProjection(activity, { key, lens: "meetings" }).state, fixture.id);
    }
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

// Local recovery (explicit All NYC broadening) over the frozen published rows.
// Imports are local to this block so the earlier tests above stay unchanged.
import { LEGACY_LENS_ROUTES } from "../site/route_migration.mjs";
import { entityRouteRef } from "../site/entity_pivot.mjs";
import {
  allNycRecordsRouteHash,
  scopeForAllNycRecords,
} from "../site/near_you_scope_runtime.mjs";
import { renderNearYouDocument } from "../site/near_you_view.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  LOCAL_ESCAPE_SOURCE,
  readLocalEscapeFixture,
  readPinnedDistrictActivity,
  reduceDistrictActivity,
} from "./helpers/near_you_local_escape_fixture.mjs";

const FROZEN_CLOCK = "2026-09-28T12:00:00.000Z";
const frozen = readLocalEscapeFixture();
const SHEEPSHEAD_BAY = "geography:nta2020:BK1503";
const TRIBECA = "geography:nta2020:MN0102";
const MOTT_HAVEN = "geography:nta2020:BX0101";
const KENSINGTON = "geography:nta2020:BK1203";
const LOCAL_PLACE_PARAMS = ["geo", "boro", "cd", "council", "neighborhood", "scope", "level", "id", "parent"];

function frozenTest(name, body) {
  return test(name, () => withPinnedClock(FROZEN_CLOCK, body));
}

function nearYouScope(query) {
  return scopeFromNearYouUrl(`https://cityscroll.org/near-you/?${query}`);
}

/** The destination's own reading of a Browse document URL: path facet, then the scope route grammar. */
function scopeFromBrowseDocument(href) {
  const url = new URL(href, "https://cityscroll.org");
  const lens = Object.entries(LEGACY_LENS_ROUTES).find(([, route]) => route === url.pathname)?.[0];
  assert.ok(lens, `${href} is not a Browse collection document`);
  return { lens, url, scope: scopeFromRouteHash(`#${lens}?${url.searchParams.toString()}`) };
}

function surfacePanel(html, surface) {
  const start = html.indexOf(`data-near-surface-panel="${surface}"`);
  assert.ok(start >= 0, `${surface} surface panel is rendered`);
  const next = html.indexOf("data-near-surface-panel=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

function allNycLinks(html) {
  return [...html.matchAll(/<a href="([^"]+)" data-near-recovery="all-nyc">([^<]+)<\/a>/g)]
    .map((match) => ({ href: match[1].replaceAll("&amp;", "&"), label: match[2] }));
}

function assertNoPlaceConstraint(scope, label) {
  assert.deepEqual(scope.place.boroughs, [], label);
  assert.deepEqual(scope.place.community_districts, [], label);
  assert.deepEqual(scope.place.council_districts, [], label);
  assert.equal(scope.place.neighborhood, null, label);
  assert.equal(scope.place.location_scope, null, label);
  assert.deepEqual(scope.place.geographies || [], [], label);
}

frozenTest("the frozen fixture is the exact reduction of the pinned published snapshot", (t) => {
  assert.deepEqual(frozen.provenance.revision, LOCAL_ESCAPE_SOURCE.revision);
  assert.deepEqual(frozen.provenance.blob, LOCAL_ESCAPE_SOURCE.blob);
  const pinned = readPinnedDistrictActivity();
  if (!pinned) {
    t.skip(`pinned blob ${LOCAL_ESCAPE_SOURCE.blob} is not in this checkout's object store`);
    return;
  }
  const { provenance, ...rows } = frozen;
  assert.deepEqual(rows, reduceDistrictActivity(pinned));
});

frozenTest("A1: Sheepshead Bay's unsupported Meetings filter keeps a null count and offers one All NYC link on Map and Records", () => {
  assert.deepEqual(frozen.geography_items.by_key[SHEEPSHEAD_BAY], { land: ["2019K0147"] });
  const view = buildNearYouViewModel(
    nearYouScope("geo=nta2020:BK1503&lens=meetings&surface=map"),
    frozen,
    boundaries,
    { canonicalBase: "https://cityscroll.org/near-you" },
  );
  assert.equal(view.results.count, null);
  assert.deepEqual(view.results.ids, []);
  assert.equal(view.localRecovery.state, "unsupported");
  assert.equal(view.localRecovery.message, "We can’t filter these meetings to this neighborhood yet.");

  const html = renderNearYouDocument(view);
  const deferred = renderNearYouDeferredParts(view).resultsHtml;
  const hydrated = allNycLinks(deferred);
  for (const [surface, links] of [
    ["map", allNycLinks(surfacePanel(html, "map"))],
    ["records", allNycLinks(surfacePanel(html, "records"))],
    ["records after hydration", hydrated],
  ]) {
    assert.equal(links.length, 1, `${surface}: exactly one All NYC link`);
    assert.equal(links[0].label, "All NYC meetings", surface);
    const destination = scopeFromBrowseDocument(links[0].href);
    assert.equal(destination.lens, "meetings", surface);
    assert.equal(destination.url.pathname, "/browse/meetings/", surface);
    assertNoPlaceConstraint(destination.scope, surface);
    for (const name of LOCAL_PLACE_PARAMS) assert.equal(destination.url.searchParams.has(name), false, `${surface}: ${name}`);
  }
  assert.equal(allNycLinks(html).length, 2, "one link per surface, no third copy inside disclosures");
  // Converse control: the pre-existing list link keeps the failing place when the
  // scope carries legacy axes, and the same destination check rejects it.
  const legacy = buildNearYouViewModel(
    nearYouScope("geo=nta2020:BK1503&lens=meetings&boro=Brooklyn&cd=K15&neighborhood=Sheepshead%20Bay"),
    frozen,
    boundaries,
  );
  assert.throws(() => assertNoPlaceConstraint(scopeFromBrowseDocument(legacy.browseHref).scope, "legacy list link"));
  assertNoPlaceConstraint(scopeFromBrowseDocument(legacy.localRecovery.allNycHref).scope, "legacy All NYC link");
});

frozenTest("A2: broadening round-trips topic, agency, type and dates through the Browse parser and clears every place axis", () => {
  const agency = "Landmarks Preservation Commission";
  const scope = nearYouScope([
    "geo=nta2020:BK1503",
    "lens=meetings",
    "q=hearing",
    `agency=${encodeURIComponent(agency)}`,
    "type=Public%20Hearings",
    "when=month",
    "placeRole=venue",
    "boro=Brooklyn",
    "cd=K15",
    "council=48",
    "neighborhood=Sheepshead%20Bay",
  ].join("&"));
  assert.deepEqual(scope.place.geographies, [SHEEPSHEAD_BAY]);
  assert.deepEqual(scope.place.boroughs, ["Brooklyn"]);
  const view = buildNearYouViewModel(scope, frozen, boundaries);
  const href = view.localRecovery.allNycHref;
  const { scope: destination } = scopeFromBrowseDocument(href);
  assertNoPlaceConstraint(destination, "broadened destination");
  assert.equal(destination.topic.query, scope.topic.query);
  assert.equal(destination.time_window.preset, "month");
  assert.deepEqual(destination.facets.domains, ["meetings"]);
  assert.deepEqual(destination.facets.values.entity_refs_all, [entityRouteRef("agency", agency)]);
  // The destination cannot apply type or place role; both are named, never carried silently.
  assert.deepEqual(scopeForAllNycRecords(scope).removed.map((row) => [row.axis, row.value]), [
    ["type", "Public Hearings"],
    ["place_role", "venue"],
  ]);
  assert.equal(destination.facets.values.type, undefined);
  assert.equal(destination.facets.values.place_role, undefined);
  assert.equal(view.localRecovery.removedNote, "Also removes: type “Public Hearings”, “Happening here”.");
  assert.ok(view.placePresentation.label);
  assert.equal(view.localRecovery.placeNote, `Removes the ${view.placePresentation.label} place filter.`);
  // The exact local scope stays usable and unchanged.
  assert.deepEqual(view.scope.place.geographies, [SHEEPSHEAD_BAY]);
  assert.equal(view.scope.facets.values.type, "Public Hearings");

  // Converse control: without a date filter Browse would open on this week, so
  // an unbounded Near You window is carried explicitly.
  const undated = allNycRecordsRouteHash(nearYouScope("geo=nta2020:BK1503&lens=meetings"));
  assert.equal(undated, "#meetings?when=all");
  assert.equal(scopeFromRouteHash(undated).time_window.preset, "all");
});

frozenTest("A3: exact membership, published zero and wider-district previews keep their own identities", () => {
  const tribecaIds = frozen.geography_items.by_key[TRIBECA].meetings;
  assert.equal(tribecaIds.length, 26);
  const tribeca = buildNearYouViewModel(nearYouScope("geo=nta2020:MN0102&lens=meetings"), frozen, boundaries);
  assert.deepEqual(tribeca.results.ids, [...tribecaIds].map(String).sort());
  assert.equal(tribeca.results.count, 26);
  assert.equal(tribeca.localRecovery, null);

  assert.deepEqual(frozen.geography_items.by_key[MOTT_HAVEN].meetings, []);
  const mottHaven = buildNearYouViewModel(nearYouScope("geo=nta2020:BX0101&lens=meetings"), frozen, boundaries);
  assert.equal(mottHaven.results.count, 0);
  assert.equal(mottHaven.localRecovery.state, "zero");
  assert.equal(mottHaven.localRecovery.message, "No mapped meetings match these filters.");
  assert.match(renderNearYouDeferredParts(mottHaven).resultsHtml, /data-results-count="0"/);

  assert.equal(frozen.geography_items.by_key[KENSINGTON], undefined);
  const districts = frozen.district_items.by_level.community_district;
  const slices = Object.fromEntries(["K12", "K14"].map((id) => [`geography:community_district:${id}`, {
    records: {
      meetings: Object.fromEntries(districts[id].meetings.map((recordId) => [recordId, frozen.records.meetings[recordId]])),
    },
    district_items: { by_level: { community_district: { [id]: districts[id] } } },
  }]));
  const kensington = buildNearYouViewModel(nearYouScope("geo=nta2020:BK1203&lens=meetings"), frozen, boundaries, {
    broaderDistricts: {
      relations: ["K14", "K12"].map((id) => ({ key: `geography:community_district:${id}`, id })),
      slices,
    },
  });
  assert.equal(kensington.results.count, null);
  assert.deepEqual(kensington.results.ids, []);
  assert.equal(kensington.localRecovery.state, "unsupported");
  const k14 = kensington.broader_districts.districts.find((district) => district.id === "K14");
  assert.ok(k14, "K14 previews remain available as wider-district content");
  assert.equal(k14.scope, "broader");
  assert.equal(k14.count, k14.records.length);
  assert.ok(k14.records.every((record) => districts.K14.meetings.includes(record.id)));
  assert.match(k14.href, /geo=community_district%3AK14/);
  assert.equal(kensington.broader_districts.districts.some((district) => district.id === "K12"), false,
    "K12 publishes no meetings, so no empty preview group appears");
  const html = renderNearYouDeferredParts(kensington).resultsHtml;
  assert.ok(html.indexOf("near-broader-districts-heading") < html.indexOf('data-near-recovery="all-nyc"'));
});

frozenTest("A4: zero, unsupported, incomplete, failed load and unknown place render distinct task copy without side effects", () => {
  const incomplete = structuredClone(frozen);
  incomplete.geography_items.coverage = { status: "incomplete" };
  const cases = {
    zero: buildNearYouViewModel(nearYouScope("geo=nta2020:BX0101&lens=meetings"), frozen, boundaries),
    unsupported: buildNearYouViewModel(nearYouScope("geo=nta2020:BK1503&lens=meetings"), frozen, boundaries),
    incomplete: buildNearYouViewModel(nearYouScope("geo=nta2020:MN0102&lens=meetings"), incomplete, boundaries),
    error: buildNearYouViewModel(nearYouScope("geo=nta2020:MN0102&lens=meetings"), null, boundaries, { dataState: "error" }),
    unknown: buildNearYouViewModel(nearYouScope("neighborhood=Atlantis&lens=meetings"), frozen, boundaries),
  };
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetchCalls.push(args); throw new Error("no fetch during render"); };
  let rendered;
  try {
    rendered = Object.fromEntries(Object.entries(cases).map(([name, view]) => [name, {
      view,
      html: renderNearYouDocument(view),
      deferred: renderNearYouDeferredParts(view).resultsHtml,
    }]));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(fetchCalls, []);
  const messages = Object.entries(rendered).map(([name, row]) => {
    assert.equal(row.view.localRecovery.state, name);
    return row.view.localRecovery.message;
  });
  assert.equal(new Set(messages).size, 5, "each state carries its own copy");
  for (const [name, row] of Object.entries(rendered)) {
    const blocks = [...row.html.matchAll(/<div class="near-coverage near-local-recovery"[\s\S]*?<\/div>/g)].map((match) => match[0]);
    assert.equal(blocks.length, 2, `${name}: one block per surface`);
    for (const block of blocks) {
      const text = block.replace(/<[^>]+>/g, " ");
      assert.doesNotMatch(text, /no civic activity|no activity|materializ|membership|lens|projection|\bKV\b/i, name);
      assert.doesNotMatch(block, /<(?:button|form|script|meta)\b|data-use-location|\/following\//, name);
      const actions = [...block.matchAll(/data-near-recovery="([a-z-]+)"/g)].map((match) => match[1]);
      assert.deepEqual(actions, name === "error" ? ["all-nyc", "retry"] : ["all-nyc"], name);
    }
    assert.doesNotMatch(row.html, /http-equiv="refresh"/i, name);
    assert.equal(row.view.results.count, name === "zero" ? 0 : null, name);
  }
  assert.equal(rendered.error.view.localRecovery.retryHref, rendered.error.view.recoveryHref);
  assert.deepEqual(new URL(rendered.error.view.localRecovery.retryHref).searchParams.getAll("geo"), [TRIBECA], "Retry keeps the local scope");
});
