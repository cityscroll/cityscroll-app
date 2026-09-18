// Resident geography navigation contract.
//
//   node --test test/geography_navigation_contract.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CIVIC_GEOGRAPHY_LAYERS,
  civicGeographyKey,
  civicGeographyLayer,
} from "../site/civic_geography_registry.mjs";
import {
  EXPLICITLY_UNTYPED_GEOGRAPHY,
  geographyRelationMapping,
} from "../site/geography_relations.mjs";
import {
  GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE,
  GEOGRAPHY_NAVIGATION_CAPABILITY_SCHEMA,
  GEOGRAPHY_NAVIGATION_EXPLICIT_OMISSIONS,
  GEOGRAPHY_NAVIGATION_LAYER_TYPES,
  GEOGRAPHY_NAVIGATION_POINT_BUNDLES,
  GEOGRAPHY_NAVIGATION_RELATION_RULES,
  geographyNavigationLayer,
  geographyNavigationMoreBoundaryLayers,
  geographyNavigationPrimaryLayers,
  isResidentialNeighborhoodSubtype,
  ntaResidentLabelPolicy,
  projectGeographyNavigationCapability,
  resolveGeographyNavigationKey,
} from "../site/geography_navigation_capability.mjs";

const ROOT = process.cwd();
const ADR_PATH = join("docs", "adr", "friendly-geography-navigation.md");
const CAPABILITY_PATH = join("site", "geography_navigation_capability.mjs");
const LICENSE_PATH = "LICENSE";

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

test("A1: primary layer order and copy are Neighborhoods, Community districts, Council districts, then More boundaries Precincts", () => {
  const capability = projectGeographyNavigationCapability();
  assert.equal(capability.schema, GEOGRAPHY_NAVIGATION_CAPABILITY_SCHEMA);
  assert.deepEqual(
    geographyNavigationPrimaryLayers().map((layer) => [layer.type, layer.primary_label]),
    [
      ["nta2020", "Neighborhoods"],
      ["community_district", "Community districts"],
      ["council_district", "Council districts"],
    ],
  );
  assert.deepEqual(
    geographyNavigationMoreBoundaryLayers().map((layer) => [layer.type, layer.primary_label]),
    [["police_precinct", "Precincts"]],
  );
  assert.deepEqual(
    GEOGRAPHY_NAVIGATION_LAYER_TYPES,
    ["nta2020", "community_district", "council_district", "police_precinct"],
  );
  const neighborhoods = geographyNavigationLayer("nta2020");
  assert.equal(neighborhoods.detail_label, "NYC Neighborhood Tabulation Area (NTA 2020).");
  assert.equal(capability.default_layer_type, "nta2020");
  assert.equal(neighborhoods.default_selected, true);

  const adr = read(ADR_PATH);
  assert.match(adr, /Neighborhoods/);
  assert.match(adr, /Community districts/);
  assert.match(adr, /Council districts/);
  assert.match(adr, /More boundaries/);
  assert.match(adr, /Precincts/);
  assert.match(adr, /NYC Neighborhood Tabulation Area \(NTA 2020\)/);
  assert.match(adr, /nta2020/);
});

test("A2: point membership is independent per layer; area relationships are direct intersections, never NTA→CD→Council inference", () => {
  const rules = GEOGRAPHY_NAVIGATION_RELATION_RULES;
  assert.equal(rules.point_membership.method, "independent_per_layer_point_in_polygon");
  assert.equal(rules.point_membership.language, "at_this_location");
  assert.equal(rules.point_membership.resident_phrase, "At this location");
  assert.ok(rules.point_membership.prohibits.includes("derive_council_from_nta_via_community_district"));
  assert.ok(rules.point_membership.prohibits.includes("derive_any_layer_from_another_layer"));

  assert.equal(rules.area_relationship.method, "direct_polygon_intersection");
  assert.equal(rules.area_relationship.language, "overlaps");
  assert.ok(rules.area_relationship.prohibits.includes("nta_to_community_district_to_council_inference"));
  assert.ok(rules.area_relationship.prohibits.includes("centroid_or_dominant_district_shortcut"));

  assert.equal(rules.selection_versus_comparison.selection_persists_when_comparison_changes, true);
  assert.equal(rules.selection_versus_comparison.comparison_does_not_replace_selected_outline, true);

  const fixture = GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE;
  assert.equal(fixture.method, "direct_polygon_intersection");
  assert.equal(fixture.selected.key, "geography:nta2020:BK1503");

  const capabilitySource = read(CAPABILITY_PATH);
  assert.doesNotMatch(capabilitySource, /deriveCouncilFromNta|ntaToCommunityToCouncil|parent_nta/i);
  const adr = read(ADR_PATH);
  assert.match(adr, /independently/i);
  assert.match(adr, /direct polygon intersection/i);
  assert.match(adr, /never NTA/i);
});

test("A3: community districts do not acquire represented_by or served_by; typed-relation policy stays intact", () => {
  assert.equal(geographyRelationMapping("community_district"), null);
  assert.ok(EXPLICITLY_UNTYPED_GEOGRAPHY.community_district);

  const community = geographyNavigationLayer("community_district");
  assert.equal(community.typed_relation.status, "explicitly_untyped");
  assert.equal(community.typed_relation.predicate, null);

  assert.equal(geographyNavigationLayer("council_district").typed_relation.predicate, "represented_by");
  assert.equal(geographyNavigationLayer("police_precinct").typed_relation.predicate, "served_by");
  assert.equal(geographyNavigationLayer("nta2020").typed_relation.predicate, "statistically_classified_as");

  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    assert.ok(civicGeographyLayer(type), `${type} remains registry-backed`);
  }
});

test("A4: residential and special-use NTA subtypes remain distinguishable", () => {
  const capability = projectGeographyNavigationCapability();
  assert.deepEqual(capability.nta_subtypes.allowed, [
    "residential",
    "rikers_island",
    "special_use",
    "cemetery",
    "airport",
    "park",
  ]);
  assert.equal(capability.nta_subtypes.residential, "residential");
  assert.ok(capability.nta_subtypes.special.includes("park"));
  assert.ok(capability.nta_subtypes.special.includes("cemetery"));
  assert.ok(capability.nta_subtypes.special.includes("airport"));
  assert.ok(capability.nta_subtypes.special.includes("special_use"));

  assert.equal(isResidentialNeighborhoodSubtype("residential"), true);
  assert.equal(isResidentialNeighborhoodSubtype("park"), false);
  assert.equal(ntaResidentLabelPolicy("residential").may_label_as_neighborhood, true);
  for (const subtype of ["park", "cemetery", "airport", "special_use", "rikers_island"]) {
    const policy = ntaResidentLabelPolicy(subtype);
    assert.equal(policy.may_label_as_neighborhood, false, subtype);
    assert.match(policy.reason, /special/i);
  }

  const registrySubtypes = civicGeographyLayer("nta2020").subtypes.allowed;
  assert.deepEqual([...registrySubtypes], [...capability.nta_subtypes.allowed]);
});

test("A5: State Assembly, State Senate, sanitation districts, and BIDs are omitted, not disabled", () => {
  const capability = projectGeographyNavigationCapability();
  const switcherTypes = capability.layers.map((layer) => layer.type);
  for (const absent of [
    "state_assembly",
    "state_senate",
    "sanitation_district",
    "business_improvement_district",
  ]) {
    assert.ok(!switcherTypes.includes(absent), absent);
    assert.ok(GEOGRAPHY_NAVIGATION_EXPLICIT_OMISSIONS[absent], `${absent} needs an explicit omission reason`);
    assert.ok(GEOGRAPHY_NAVIGATION_EXPLICIT_OMISSIONS[absent].length > 20, absent);
  }

  const registered = new Set(CIVIC_GEOGRAPHY_LAYERS.map((layer) => layer.type));
  assert.ok(registered.has("sanitation_district"));
  assert.ok(registered.has("business_improvement_district"));
  assert.ok(!registered.has("state_assembly"));
  assert.ok(!registered.has("state_senate"));

  const capabilitySource = read(CAPABILITY_PATH);
  assert.doesNotMatch(capabilitySource, /disabled:\s*true|aria-disabled|layer_disabled/);
  assert.match(read(ADR_PATH), /not a missing option rendered disabled/i);
});

test("A6: seeded Sheepshead Bay and City Hall bundles, vintages, layer order, and prohibited shortcuts", () => {
  assert.equal(GEOGRAPHY_NAVIGATION_POINT_BUNDLES.length, 2);

  const sheepshead = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "sheepshead-bay-station");
  assert.ok(sheepshead);
  assert.deepEqual(sheepshead.coordinates, [-73.9542, 40.5869]);
  assert.equal(sheepshead.membership.nta2020.id, "BK1503");
  assert.equal(sheepshead.membership.nta2020.label, "Sheepshead Bay-Manhattan Beach-Gerritsen Beach");
  assert.equal(sheepshead.membership.nta2020.boundary_vintage, "26B");
  assert.equal(sheepshead.membership.nta2020.subtype, "residential");
  assert.equal(sheepshead.membership.community_district.id, "K15");
  assert.equal(sheepshead.membership.community_district.label, "Brooklyn Community District 15");
  assert.equal(sheepshead.membership.community_district.boundary_vintage, "2026-05-26");
  assert.equal(sheepshead.membership.council_district.id, "48");
  assert.equal(sheepshead.membership.council_district.label, "City Council District 48");
  assert.equal(sheepshead.membership.council_district.boundary_vintage, "2026-05-26");
  assert.equal(sheepshead.membership.police_precinct.id, "61");
  assert.equal(sheepshead.membership.police_precinct.label, "Police Precinct 61");
  assert.equal(sheepshead.membership.police_precinct.boundary_vintage, "26B");

  const cityHall = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "new-york-city-hall");
  assert.ok(cityHall);
  assert.deepEqual(cityHall.coordinates, [-74.0060, 40.7128]);
  assert.equal(cityHall.membership.nta2020.id, "MN0102");
  assert.equal(cityHall.membership.nta2020.label, "Tribeca-Civic Center");
  assert.equal(cityHall.membership.community_district.id, "M01");
  assert.equal(cityHall.membership.council_district.id, "1");
  assert.equal(cityHall.membership.police_precinct.id, "1");

  for (const fixture of GEOGRAPHY_NAVIGATION_POINT_BUNDLES) {
    for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
      const member = fixture.membership[type];
      assert.ok(member, `${fixture.id}:${type}`);
      assert.equal(civicGeographyKey(type, member.id), `geography:${type}:${member.id}`);
    }
  }

  const overlap = GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE;
  assert.equal(overlap.selected.id, "BK1503");
  assert.equal(overlap.projection, "EPSG:2263");
  const byKey = Object.fromEntries(
    overlap.relations.map((row) => [`${row.type}:${row.id}`, row]),
  );
  assert.equal(byKey["council_district:46"].pct_from, 31.008101);
  assert.equal(byKey["council_district:46"].display_pct, "31.0%");
  assert.equal(byKey["council_district:48"].pct_from, 68.986772);
  assert.equal(byKey["council_district:48"].display_pct, "69.0%");
  assert.equal(byKey["community_district:K15"].material_for_navigation, true);
  assert.equal(byKey["community_district:K13"].material_for_navigation, false);
  assert.equal(byKey["community_district:K18"].material_for_navigation, false);
  assert.equal(byKey["police_precinct:61"].material_for_navigation, true);
  assert.equal(byKey["police_precinct:60"].material_for_navigation, false);

  // Each point fixture membership is a flat per-layer map, not a derived chain.
  for (const fixture of GEOGRAPHY_NAVIGATION_POINT_BUNDLES) {
    assert.equal(Object.keys(fixture.membership).sort().join(","), GEOGRAPHY_NAVIGATION_LAYER_TYPES.slice().sort().join(","));
    assert.equal(fixture.membership.council_district.parent, undefined);
    assert.equal(fixture.membership.council_district.derived_from, undefined);
  }
});

test("A7: no BetaNYC dependency; repository license remains MIT-compatible", () => {
  const capability = projectGeographyNavigationCapability();
  assert.equal(capability.licensing.repository, "MIT");
  assert.equal(capability.licensing.betanyc_source_css_assets_tokens_or_runtime, false);

  const license = read(LICENSE_PATH);
  assert.match(license, /MIT License/);

  for (const path of [CAPABILITY_PATH, ADR_PATH]) {
    const text = read(path).toLowerCase();
    assert.ok(!text.includes("boundaries.beta.nyc/src"));
    assert.ok(!text.includes("gpl-3.0"));
    assert.doesNotMatch(text, /from betanyc|copy(?:ing)? from beta\.nyc|beta nyc css|betanyc token/i);
  }
  assert.match(read(ADR_PATH), /No BetaNYC source, CSS, assets, tokens, or runtime/i);
});

test("unknown or stale geography keys recover to the unselected navigator", () => {
  assert.equal(resolveGeographyNavigationKey("").ok, false);
  assert.equal(resolveGeographyNavigationKey("not-a-key").reason, "malformed_geography_key");
  assert.equal(resolveGeographyNavigationKey("geography:state_assembly:1").reason, "layer_not_in_first_slice");
  assert.equal(resolveGeographyNavigationKey("geography:nta2020:NOTREAL").reason, "invalid_geography_id");
  assert.deepEqual(resolveGeographyNavigationKey("geography:nta2020:BK1503"), {
    ok: true,
    key: "geography:nta2020:BK1503",
    type: "nta2020",
    id: "BK1503",
    reason: null,
    explanation: null,
  });
  assert.equal(resolveGeographyNavigationKey("nta2020:MN0102").key, "geography:nta2020:MN0102");
});

test("capability projects only from the closed civic-geography registry", () => {
  const capability = projectGeographyNavigationCapability();
  const registered = new Set(CIVIC_GEOGRAPHY_LAYERS.map((layer) => layer.type));
  for (const layer of capability.layers) {
    assert.ok(registered.has(layer.type), layer.type);
    assert.equal(layer.class, civicGeographyLayer(layer.type).class);
    assert.equal(layer.namespace, civicGeographyLayer(layer.type).namespace);
  }
  assert.equal(capability.layers.length, 4);
  assert.ok(!read(CAPABILITY_PATH).includes("GEOGRAPHY_LAYER_REGISTRY_SCHEMA_V2"));
});
