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
  MOCS_GROWNYC_CONTRACT_ID,
  MOCS_GROWNYC_SITE_SCHEDULE_DOCUMENT_ID,
  MOCS_GROWNYC_SITE_SCHEDULE_LOCATOR,
  PORTFOLIO_EVALUATION_KIND,
  PLACE_INPUT_KINDS,
  RESOLUTION_STATES,
  SPATIAL_EVIDENCE_KINDS,
  VENDOR_ADDRESS_ROLE,
  admitContractPlaceAssertion,
  buildContractServiceGeographyDocument,
  classifySpatialEvidence,
  extractGrownycSiteScheduleAssertions,
  facilitySiteFromNoticePlaceFact,
  nearYouLocalContractIds,
  projectContractPlacesIntoGeographyItems,
  retainPortfolioEvaluationScope,
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
const ROLE_PASSAGES = JSON.parse(readFileSync(
  join(ROOT, "test/fixtures/contract-substance-real-corpus/role-passages.json"),
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

function grownycGeocode(query) {
  if (/Joyce Kilmer Park/i.test(query)) return { lon: -73.9166, lat: 40.8258 };
  return null;
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

test("A2: real GrowNYC Exhibit A yields two proposed site-schedule rows with printed locations and source locator", () => {
  const extracted = extractGrownycSiteScheduleAssertions({
    passage: ROLE_PASSAGES.mocs_exhibit_a_p72,
    contentHash: "sha256:0ec5d908a7a4dbe09ff52079cebd63756c054be39cc240c59a785cbb4209e4d8",
    publicUrl: "https://www.nyc.gov/assets/mocs/downloads/Opportunities/FCRC/agendas/2024/11nov/PublicMeetingDocuments_202411.pdf",
    publicationDate: "2024-11-01",
  });
  assert.equal(extracted.ok, true, extracted.errors.join("; "));
  assert.deepEqual(extracted.rows.map((row) => [
    row.site_name,
    row.schedule.day,
    row.schedule.hours,
  ]), [
    ["Joyce Kilmer Park", "Tuesdays", "6AM to 7PM"],
    ["Poe Park", "Tuesdays", "6AM to 5PM"],
  ]);
  for (const row of extracted.rows) {
    assert.equal(row.contract_id, MOCS_GROWNYC_CONTRACT_ID);
    assert.equal(row.source_document_id, MOCS_GROWNYC_SITE_SCHEDULE_DOCUMENT_ID);
    assert.equal(row.document_role, "proposed_agreement");
    assert.equal(row.source_document_role, "site_schedule");
    assert.equal(row.locator, MOCS_GROWNYC_SITE_SCHEDULE_LOCATOR);
    assert.match(row.location_description, /^Located /);
  }
});

test("A3: GrowNYC sites resolve only through the existing place resolver and retain proposed status", () => {
  const extracted = extractGrownycSiteScheduleAssertions({
    passage: ROLE_PASSAGES.mocs_exhibit_a_p72,
  });
  const resolved = extracted.rows.map((row) => {
    const admitted = admitContractPlaceAssertion(row);
    assert.equal(admitted.ok, true, row.site_name);
    const resolution = resolveContractPlaceAssertion(admitted.assertion, {
      layerData: LAYER_DATA,
      geocode: grownycGeocode,
    });
    return { row, assertion: admitted.assertion, resolution };
  });

  const joyce = resolved.find(({ row }) => row.site_name === "Joyce Kilmer Park");
  assert.equal(joyce.resolution.ok, true);
  assert.equal(joyce.resolution.entry.selected_key, "geography:nta2020:BX0401");
  assert.ok(joyce.resolution.geographies.every((match) => match.boundary_vintage));
  assert.ok(joyce.resolution.geographies.every((match) => match.method === "exact_address_entry_resolver"));
  assert.equal(joyce.assertion.document_role, "proposed_agreement");

  const poe = resolved.find(({ row }) => row.site_name === "Poe Park");
  assert.equal(poe.resolution.ok, false);
  assert.equal(poe.resolution.state, RESOLUTION_STATES.UNRESOLVED);
  assert.deepEqual(poe.resolution.geographies, []);
  assert.equal(poe.assertion.input.location_description.startsWith("Located on the south side"), true);
});

test("A4-A5: portfolio evaluations and non-service locations never become neighborhood sites", () => {
  const portfolio = retainPortfolioEvaluationScope({
    contract_id: "CT180620248801671",
    source_document_id: "comptroller-docgo-audit-20248801671",
    document_role: "performance_evaluation",
    locator: "PDF page 18 / hotel-service count",
    statement: "Services occurred at 32 hotels, including 16 in New York City and 16 outside it.",
    reported_site_count: 32,
    reported_nyc_site_count: 16,
    reported_outside_nyc_site_count: 16,
  });
  assert.equal(portfolio.kind, PORTFOLIO_EVALUATION_KIND);
  assert.equal(portfolio.emits_service_geography, false);
  const projectedPortfolio = projectContractPlacesIntoGeographyItems([portfolio]);
  assert.deepEqual(projectedPortfolio.by_key, {});
  assert.equal(projectedPortfolio.skipped[0].reason, "portfolio_evaluation_not_service_geography");

  for (const location_role of ["agency_office", "document_meeting_location", "map_centroid"]) {
    const refused = admitContractPlaceAssertion({
      contract_id: "CT999900000000008",
      place_role: CONTRACT_PLACE_ROLES.WORK_SITE,
      address: "1 Civic Plaza, New York",
      source_document_id: "doc-trap-1",
      locator: "meeting header",
      location_role,
    });
    assert.equal(refused.ok, false, location_role);
    assert.ok(refused.reasons.includes("non_service_location_role_is_not_service_geography"));
  }
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
  const joyceKey = "geography:nta2020:BX0401";
  assert.deepEqual(nearYouLocalContractIds(geographyItems, joyceKey), [MOCS_GROWNYC_CONTRACT_ID]);
  assert.deepEqual(geographyItems.by_key[joyceKey].place_roles[MOCS_GROWNYC_CONTRACT_ID], [
    CONTRACT_PLACE_ROLES.FACILITY_SITE,
  ]);
  assert.equal(
    geographyItems.skipped.some((row) => row.contract_id === MOCS_GROWNYC_CONTRACT_ID),
    false,
  );

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

  const blank = admitContractPlaceAssertion({
    contract_id: "CT999900000000009",
    place_role: CONTRACT_PLACE_ROLES.FACILITY_SITE,
    source_document_id: "doc-blank-location",
    locator: "Exhibit A",
  });
  assert.equal(blank.ok, false);
  assert.ok(blank.reasons.includes("missing_exact_address"));

  const ambiguousPark = admitContractPlaceAssertion({
    contract_id: MOCS_GROWNYC_CONTRACT_ID,
    place_role: CONTRACT_PLACE_ROLES.FACILITY_SITE,
    address: "Poe Park, 192nd Street, Bronx",
    source_document_id: MOCS_GROWNYC_SITE_SCHEDULE_DOCUMENT_ID,
    locator: MOCS_GROWNYC_SITE_SCHEDULE_LOCATOR,
  }).assertion;
  const ambiguousParkResolution = resolveContractPlaceAssertion(ambiguousPark, {
    layerData: LAYER_DATA,
    geocode: () => ({
      status: "ambiguous",
      candidates: [
        { type: "nta2020", id: "BX0702", label: "Bedford Park", boundary_vintage: "26B" },
        { type: "nta2020", id: "BX0703", label: "Norwood", boundary_vintage: "26B" },
      ],
    }),
  });
  assert.equal(ambiguousParkResolution.state, RESOLUTION_STATES.AMBIGUOUS);
  assert.deepEqual(ambiguousParkResolution.geographies, []);

  const outside = admitContractPlaceAssertion({
    contract_id: "CT999900000000010",
    place_role: CONTRACT_PLACE_ROLES.FACILITY_SITE,
    address: "1 Harbor Way, Boston, MA",
    source_document_id: "doc-outside-nyc",
    locator: "Schedule A",
  }).assertion;
  const outsideResolution = resolveContractPlaceAssertion(outside, {
    layerData: LAYER_DATA,
    geocode: () => ({ lon: -71.0589, lat: 42.3601 }),
  });
  assert.equal(outsideResolution.ok, false);
  assert.equal(outsideResolution.state, RESOLUTION_STATES.UNRESOLVED);
});
