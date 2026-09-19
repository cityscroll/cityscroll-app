/**
 * Typed contract work sites and service areas.
 *
 *   node --test test/procurement_contract_service_geography.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  GEOGRAPHY_NAVIGATION_LAYER_TYPES,
  GEOGRAPHY_NAVIGATION_POINT_BUNDLES,
} from "../site/geography_navigation_capability.mjs";
import { loadCivicGeographyLayer } from "../site/civic_geography.mjs";
import {
  BROAD_SCOPE_KINDS,
  CONTRACT_PLACE_ROLES,
  CONTRACT_SERVICE_GEOGRAPHY_SCHEMA,
  GEOGRAPHY_RELATIONS,
  PLACE_INPUT_KINDS,
  RESOLUTION_STATES,
  SPATIAL_EVIDENCE_KINDS,
  VENDOR_ADDRESS_ROLE,
  admitContractPlaceAssertion,
  buildContractServiceGeographyDocument,
  classifySpatialEvidence,
  facilitySiteFromNoticePlaceFact,
  nearYouLocalContractIds,
  projectContractPlacesIntoGeographyItems,
  resolveContractPlaceAssertion,
  retainVendorAddressIdentity,
  validateContractServiceGeographyDocument,
} from "../site/procurement_contract_service_geography.mjs";

const ROOT = process.cwd();
const MATERIALIZED = JSON.parse(readFileSync(
  join(ROOT, "site/data/procurement_contract_service_geography.json"),
  "utf8",
));
const PLACE_FACTS = JSON.parse(readFileSync(
  join(ROOT, "site/data/procurement_place_facts.json"),
  "utf8",
));
const CROSSWALK_CD = JSON.parse(readFileSync(
  join(ROOT, "site/data/geography/crosswalks/nta2020__community_district/26B__2026-05-26.json"),
  "utf8",
));

const BHRAGS_CONTRACT_ID = "CT107120258801626";
const BHRAGS_NOTICE_ID = "20240829105";
const BHRAGS_ADDRESS = "3218 Emmons Avenue, Brooklyn";
const SHEEPSHEAD = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "sheepshead-bay-station");

const registry = JSON.parse(readFileSync(
  join(ROOT, "site/data/geography/layer_registry.json"),
  "utf8",
));

function loadNavigationLayers() {
  return GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => {
    const row = registry.layers.find((entry) => entry.type === type);
    assert.ok(row, type);
    return loadCivicGeographyLayer(JSON.parse(readFileSync(join(ROOT, row.artifacts.full.path), "utf8")));
  });
}

const LAYER_DATA = loadNavigationLayers();
const [SHEEP_LON, SHEEP_LAT] = SHEEPSHEAD.coordinates;

function emmonsGeocode() {
  return { lon: SHEEP_LON, lat: SHEEP_LAT, status: "matched", method: "fixture_point" };
}

function bhragsPlaceFact() {
  return PLACE_FACTS.rows.find((row) => row.request_id === BHRAGS_NOTICE_ID);
}

test("A1: BHRAGS retains Emmons Avenue as notice-attributed facility_site with NTA membership and notice evidence", () => {
  assert.equal(MATERIALIZED.schema, CONTRACT_SERVICE_GEOGRAPHY_SCHEMA);
  const coverage = validateContractServiceGeographyDocument(MATERIALIZED);
  assert.equal(coverage.ok, true, coverage.errors.join("; "));

  const placeFact = bhragsPlaceFact();
  assert.ok(placeFact);
  assert.equal(placeFact.address, BHRAGS_ADDRESS);
  assert.equal(placeFact.units, 60);
  assert.equal(placeFact.request_id, BHRAGS_NOTICE_ID);

  const admitted = facilitySiteFromNoticePlaceFact(placeFact, { contractId: BHRAGS_CONTRACT_ID });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.assertion.place_role, CONTRACT_PLACE_ROLES.FACILITY_SITE);
  assert.equal(admitted.assertion.contract_id, BHRAGS_CONTRACT_ID);
  assert.equal(admitted.assertion.input.address, BHRAGS_ADDRESS);
  assert.equal(admitted.assertion.units, 60);
  assert.equal(admitted.assertion.citation.notice_id, BHRAGS_NOTICE_ID);
  assert.equal(admitted.assertion.citation.source_observation_ref, `city_record:${BHRAGS_NOTICE_ID}`);
  assert.equal(admitted.assertion.legacy_role, "facility_service_site");

  const resolved = resolveContractPlaceAssertion(admitted.assertion, {
    layerData: LAYER_DATA,
    geocode: emmonsGeocode,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.state, RESOLUTION_STATES.RESOLVED);
  assert.equal(resolved.entry.selected_key, `geography:nta2020:${SHEEPSHEAD.membership.nta2020.id}`);
  const nta = resolved.geographies.find((row) => row.type === "nta2020");
  assert.equal(nta.id, SHEEPSHEAD.membership.nta2020.id);
  assert.equal(nta.boundary_vintage, SHEEPSHEAD.membership.nta2020.boundary_vintage);
  assert.equal(nta.relation, GEOGRAPHY_RELATIONS.LOCATED_IN);
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    assert.ok(
      resolved.geographies.some((row) => row.type === type && row.id === SHEEPSHEAD.membership[type].id),
      type,
    );
  }

  const materializedBhrags = MATERIALIZED.rows.find((row) => (
    row.kind === "contract_place"
    && row.assertion?.contract_id === BHRAGS_CONTRACT_ID
    && row.assertion?.place_role === CONTRACT_PLACE_ROLES.FACILITY_SITE
  ));
  assert.ok(materializedBhrags);
  assert.equal(materializedBhrags.assertion.citation.notice_id, BHRAGS_NOTICE_ID);
  assert.equal(materializedBhrags.assertion.units, 60);
  assert.equal(materializedBhrags.assertion.input.address, BHRAGS_ADDRESS);
});

test("A2: admitted contract passages create typed work, delivery, service, and beneficiary areas with citation fields", () => {
  const cases = [
    {
      place_role: CONTRACT_PLACE_ROLES.WORK_SITE,
      address: "1 Metrotech Center, Brooklyn",
      locator: "page 4 / Work Sites",
    },
    {
      place_role: CONTRACT_PLACE_ROLES.DELIVERY_SITE,
      address: "120 Schermerhorn Street, Brooklyn",
      locator: "section 3.2 Delivery",
    },
    {
      place_role: CONTRACT_PLACE_ROLES.SERVICE_AREA,
      input_kind: PLACE_INPUT_KINDS.NAMED_GEOGRAPHY,
      named_geography: "Brooklyn Community District 15",
      geography_type: "community_district",
      locator: "Exhibit B Service Area",
    },
    {
      place_role: CONTRACT_PLACE_ROLES.BENEFICIARY_AREA,
      input_kind: PLACE_INPUT_KINDS.NAMED_GEOGRAPHY,
      named_geography: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
      geography_type: "nta2020",
      locator: "page 12 / Beneficiaries",
    },
  ];

  for (const fixture of cases) {
    const admitted = admitContractPlaceAssertion({
      contract_id: "CT999900000000001",
      source_document_id: "doc-site-schedule-1",
      effective_period: { start: "2024-07-01", end: "2026-06-30" },
      ...fixture,
    });
    assert.equal(admitted.ok, true, fixture.place_role);
    assert.equal(admitted.assertion.place_role, fixture.place_role);
    assert.equal(admitted.assertion.citation.source_document_id, "doc-site-schedule-1");
    assert.equal(admitted.assertion.citation.locator, fixture.locator);
    assert.equal(admitted.assertion.citation.effective_period.start, "2024-07-01");
    assert.equal(admitted.assertion.citation.effective_period.end, "2026-06-30");
  }
});

test("A3: vendor_address is retained for identity but never becomes service geography or a Near You local count", () => {
  const refused = admitContractPlaceAssertion({
    contract_id: BHRAGS_CONTRACT_ID,
    place_role: VENDOR_ADDRESS_ROLE,
    address: "999 Vendor Headquarters Plaza, Albany, NY",
    source_document_id: "vendor-profile-1",
    locator: "vendor mailing address",
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.includes("vendor_address_is_not_service_geography"));
  assert.equal(refused.identity_only.role, VENDOR_ADDRESS_ROLE);

  const identity = retainVendorAddressIdentity({
    contract_id: BHRAGS_CONTRACT_ID,
    address: "999 Vendor Headquarters Plaza, Albany, NY",
    source_document_id: "vendor-profile-1",
  });
  assert.equal(identity.emits_service_geography, false);
  assert.equal(identity.near_you_local_count, false);

  const projected = projectContractPlacesIntoGeographyItems([
    {
      kind: "vendor_address_identity",
      identity_only: identity,
      assertion: null,
      resolution: {
        ok: true,
        state: RESOLUTION_STATES.RESOLVED,
        geographies: [{
          key: `geography:nta2020:${SHEEPSHEAD.membership.nta2020.id}`,
          type: "nta2020",
          id: SHEEPSHEAD.membership.nta2020.id,
          label: SHEEPSHEAD.membership.nta2020.label,
          relation: GEOGRAPHY_RELATIONS.LOCATED_IN,
          method: "vendor_address",
          boundary_vintage: SHEEPSHEAD.membership.nta2020.boundary_vintage,
        }],
      },
    },
  ]);
  assert.deepEqual(projected.by_key, {});
  assert.ok(projected.skipped.some((row) => row.reason === "vendor_address_excluded_from_geography_items"));
  assert.deepEqual(
    nearYouLocalContractIds(projected, `geography:nta2020:${SHEEPSHEAD.membership.nta2020.id}`),
    [],
  );

  const vendorRow = MATERIALIZED.rows.find((row) => row.kind === "vendor_address_identity");
  assert.ok(vendorRow);
  assert.equal(vendorRow.identity_only.emits_service_geography, false);
});

test("A4: point containment may say located_in; polygon overlap alone never serves, represents, or affects", () => {
  const point = classifySpatialEvidence({ kind: SPATIAL_EVIDENCE_KINDS.POINT_CONTAINMENT });
  assert.equal(point.allowed_relation, GEOGRAPHY_RELATIONS.LOCATED_IN);
  assert.equal(point.may_claim_service_role, false);

  const overlap = classifySpatialEvidence({ kind: SPATIAL_EVIDENCE_KINDS.POLYGON_OVERLAP });
  assert.equal(overlap.allowed_relation, null);
  assert.equal(overlap.may_claim_service_role, false);
  assert.ok(overlap.forbidden_relations.includes("serves"));
  assert.ok(overlap.forbidden_relations.includes("represents"));
  assert.ok(overlap.forbidden_relations.includes("affects"));

  const refused = admitContractPlaceAssertion({
    contract_id: "CT999900000000002",
    place_role: CONTRACT_PLACE_ROLES.SERVICE_AREA,
    named_geography: "Brooklyn Community District 15",
    input_kind: PLACE_INPUT_KINDS.NAMED_GEOGRAPHY,
    source_document_id: "doc-overlap-1",
    locator: "map overlay note",
    spatial_evidence_kind: SPATIAL_EVIDENCE_KINDS.POLYGON_OVERLAP,
    claimed_relation: "serves",
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some((reason) => reason.startsWith("polygon_overlap_cannot_claim_")));
});

test("A5: exact addresses use the entry resolver; named areas use registry/crosswalk; ambiguous matches stay unresolved", () => {
  const addressAssertion = admitContractPlaceAssertion({
    contract_id: BHRAGS_CONTRACT_ID,
    place_role: CONTRACT_PLACE_ROLES.FACILITY_SITE,
    address: BHRAGS_ADDRESS,
    units: 60,
    source_document_id: `city_record:${BHRAGS_NOTICE_ID}`,
    notice_id: BHRAGS_NOTICE_ID,
    locator: `notice ${BHRAGS_NOTICE_ID} facility description`,
  }).assertion;
  const addressResolved = resolveContractPlaceAssertion(addressAssertion, {
    layerData: LAYER_DATA,
    geocode: emmonsGeocode,
  });
  assert.equal(addressResolved.ok, true);
  assert.equal(addressResolved.entry.selected_key, `geography:nta2020:${SHEEPSHEAD.membership.nta2020.id}`);

  const namedAssertion = admitContractPlaceAssertion({
    contract_id: "CT999900000000003",
    place_role: CONTRACT_PLACE_ROLES.SERVICE_AREA,
    input_kind: PLACE_INPUT_KINDS.NAMED_GEOGRAPHY,
    named_geography: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
    geography_type: "nta2020",
    source_document_id: "doc-named-area-1",
    locator: "Service Area",
  }).assertion;
  const namedResolved = resolveContractPlaceAssertion(namedAssertion, {
    layerData: LAYER_DATA,
    crosswalkRows: CROSSWALK_CD.rows,
  });
  assert.equal(namedResolved.ok, true);
  assert.ok(namedResolved.geographies.some((row) => row.key === `geography:nta2020:${SHEEPSHEAD.membership.nta2020.id}`));
  assert.ok(namedResolved.geographies.some((row) => (
    row.key === `geography:community_district:${SHEEPSHEAD.membership.community_district.id}`
    && row.method === "versioned_crosswalk"
  )));

  const ambiguousAssertion = admitContractPlaceAssertion({
    contract_id: "CT999900000000004",
    place_role: CONTRACT_PLACE_ROLES.WORK_SITE,
    address: "100 Broadway, New York",
    source_document_id: "doc-ambiguous-1",
    locator: "page 2",
  }).assertion;
  const ambiguous = resolveContractPlaceAssertion(ambiguousAssertion, {
    layerData: LAYER_DATA,
    geocode: () => ({
      status: "ambiguous",
      candidates: [
        {
          key: "geography:nta2020:MN0101",
          type: "nta2020",
          id: "MN0101",
          label: "Financial District-Battery Park City",
          boundary_vintage: "26B",
          method: "candidate",
        },
        {
          key: "geography:nta2020:MN0102",
          type: "nta2020",
          id: "MN0102",
          label: "Tribeca-Civic Center",
          boundary_vintage: "26B",
          method: "candidate",
        },
      ],
    }),
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.state, RESOLUTION_STATES.AMBIGUOUS);
  assert.equal(ambiguous.resident_accepted, false);
  assert.equal(ambiguous.candidates.length, 2);
  assert.deepEqual(ambiguous.geographies, []);
});

test("A6: citywide, boroughwide, and multi-site clauses keep real scopes instead of collapsing", () => {
  const citywide = admitContractPlaceAssertion({
    contract_id: "CT999900000000005",
    place_role: CONTRACT_PLACE_ROLES.SERVICE_AREA,
    input_kind: PLACE_INPUT_KINDS.BROAD_SCOPE,
    scope_kind: BROAD_SCOPE_KINDS.CITYWIDE,
    label: "Citywide",
    source_document_id: "doc-citywide-1",
    locator: "section Scope",
  });
  assert.equal(citywide.ok, true);
  const citywideResolved = resolveContractPlaceAssertion(citywide.assertion);
  assert.equal(citywideResolved.state, RESOLUTION_STATES.BROAD_SCOPE);
  assert.equal(citywideResolved.collapsed, false);
  assert.deepEqual(citywideResolved.geographies, []);

  const multiSite = admitContractPlaceAssertion({
    contract_id: "CT999900000000006",
    place_role: CONTRACT_PLACE_ROLES.WORK_SITE,
    input_kind: PLACE_INPUT_KINDS.BROAD_SCOPE,
    scope_kind: BROAD_SCOPE_KINDS.MULTI_SITE,
    site_labels: [
      "3218 Emmons Avenue, Brooklyn",
      "1 Metrotech Center, Brooklyn",
      "120 Schermerhorn Street, Brooklyn",
    ],
    source_document_id: "doc-multi-site-1",
    locator: "Schedule A Sites",
  });
  assert.equal(multiSite.ok, true);
  const multiResolved = resolveContractPlaceAssertion(multiSite.assertion);
  assert.equal(multiResolved.state, RESOLUTION_STATES.BROAD_SCOPE);
  assert.equal(multiResolved.scope_kind, BROAD_SCOPE_KINDS.MULTI_SITE);
  assert.equal(multiResolved.site_labels.length, 3);
  assert.equal(multiResolved.collapsed, false);

  const projected = projectContractPlacesIntoGeographyItems([
    { assertion: citywide.assertion, resolution: citywideResolved },
    { assertion: multiSite.assertion, resolution: multiResolved },
  ]);
  assert.deepEqual(projected.by_key, {});
  assert.ok(projected.skipped.every((row) => row.reason === "broad_scope_not_collapsed_to_membership"));
});

test("A7: canonical geography keys and place roles feed geography_items.by_key for contract ids", () => {
  const admitted = facilitySiteFromNoticePlaceFact(bhragsPlaceFact(), {
    contractId: BHRAGS_CONTRACT_ID,
  });
  const resolved = resolveContractPlaceAssertion(admitted.assertion, {
    layerData: LAYER_DATA,
    geocode: emmonsGeocode,
  });
  const secondSite = admitContractPlaceAssertion({
    contract_id: "CT999900000000007",
    place_role: CONTRACT_PLACE_ROLES.WORK_SITE,
    input_kind: PLACE_INPUT_KINDS.COORDINATE,
    lon: SHEEP_LON,
    lat: SHEEP_LAT,
    source_document_id: "doc-second-site",
    locator: "page 3",
  });
  const secondResolved = resolveContractPlaceAssertion(secondSite.assertion, { layerData: LAYER_DATA });

  const geographyItems = projectContractPlacesIntoGeographyItems([
    { assertion: admitted.assertion, resolution: resolved },
    { assertion: secondSite.assertion, resolution: secondResolved },
  ], { builtAt: "2026-09-19T00:00:00.000Z" });

  assert.equal(geographyItems.schema, "cityscroll.geography_items.v1");
  const ntaKey = `geography:nta2020:${SHEEPSHEAD.membership.nta2020.id}`;
  const ids = nearYouLocalContractIds(geographyItems, ntaKey);
  assert.deepEqual(ids, [BHRAGS_CONTRACT_ID, "CT999900000000007"].sort());
  assert.equal(ids.length, geographyItems.by_key[ntaKey].money.length);
  assert.deepEqual(ids, geographyItems.by_key[ntaKey].money);
  assert.deepEqual(geographyItems.by_key[ntaKey].place_roles[BHRAGS_CONTRACT_ID], [
    CONTRACT_PLACE_ROLES.FACILITY_SITE,
  ]);
  assert.ok(geographyItems.definitions[ntaKey]);
  assert.equal(geographyItems.definitions[ntaKey].boundary_vintage, SHEEPSHEAD.membership.nta2020.boundary_vintage);
});

test("A8: fixtures cover BHRAGS, vendor-HQ trap, multi-site, named service area, ambiguous address, vintage drift, and count-equals-list", () => {
  const kinds = new Set(MATERIALIZED.rows.map((row) => {
    if (row.kind === "vendor_address_identity") return "vendor_hq";
    if ((row.resolution?.vintage_drift || []).length) return "vintage_drift";
    if (row.resolution?.state === RESOLUTION_STATES.AMBIGUOUS) return "ambiguous";
    if (row.assertion?.input?.scope_kind === BROAD_SCOPE_KINDS.MULTI_SITE) return "multi_site";
    if (row.assertion?.place_role === CONTRACT_PLACE_ROLES.SERVICE_AREA) return "named_service_area";
    if (row.assertion?.contract_id === BHRAGS_CONTRACT_ID) return "bhrags";
    return row.assertion?.place_role || row.kind;
  }));
  for (const required of [
    "bhrags",
    "vendor_hq",
    "multi_site",
    "named_service_area",
    "ambiguous",
    "vintage_drift",
  ]) {
    assert.ok(kinds.has(required), required);
  }

  const admitted = facilitySiteFromNoticePlaceFact(bhragsPlaceFact(), {
    contractId: BHRAGS_CONTRACT_ID,
  });
  const drifted = resolveContractPlaceAssertion(admitted.assertion, {
    layerData: LAYER_DATA,
    geocode: emmonsGeocode,
    expectedBoundaryVintage: "25A",
  });
  assert.equal(drifted.ok, true);
  assert.ok(drifted.vintage_drift.length >= 1);
  assert.ok(drifted.vintage_drift.every((row) => row.expected_vintage === "25A"));

  const geographyItems = projectContractPlacesIntoGeographyItems(
    MATERIALIZED.rows.filter((row) => row.kind === "contract_place" && row.resolution?.ok),
  );
  for (const [key, lenses] of Object.entries(geographyItems.by_key)) {
    assert.equal(lenses.money.length, new Set(lenses.money).size, key);
    assert.deepEqual(lenses.money, [...lenses.money].sort());
    assert.deepEqual(nearYouLocalContractIds(geographyItems, key), lenses.money);
  }

  const rebuilt = buildContractServiceGeographyDocument([
    {
      contract_id: BHRAGS_CONTRACT_ID,
      place_role: "facility_service_site",
      address: BHRAGS_ADDRESS,
      units: 60,
      request_id: BHRAGS_NOTICE_ID,
      source_observation_ref: `city_record:${BHRAGS_NOTICE_ID}`,
      locator: `notice ${BHRAGS_NOTICE_ID} facility description`,
    },
    {
      contract_id: BHRAGS_CONTRACT_ID,
      place_role: VENDOR_ADDRESS_ROLE,
      address: "999 Vendor Headquarters Plaza, Albany, NY",
      source_document_id: "vendor-profile-1",
    },
  ], { generatedAt: "2026-09-19T00:00:00.000Z" });
  assert.equal(validateContractServiceGeographyDocument(rebuilt).ok, true);
  assert.equal(rebuilt.rows.length, 2);
});
