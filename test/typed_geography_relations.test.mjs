// PS-05: typed institutional relations projected from geometric containment.
//
//   node --test test/typed_geography_relations.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CIVIC_GEOGRAPHY_LAYERS,
  GEOGRAPHY_LAYER_SCHEMA,
  civicGeographyLayer,
} from "../site/civic_geography_registry.mjs";
import { resolveCivicGeographies } from "../site/civic_geography.mjs";
import {
  EXPLICITLY_UNTYPED_GEOGRAPHY,
  GEOGRAPHY_RELATION_SCHEMA,
  INSTITUTIONAL_RELATION_PREDICATES,
  geographyRelationMapping,
  projectInstitutionalRelations,
} from "../site/geography_relations.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";

const SUBJECTIVE_GEOGRAPHY_TERMS = [
  "outer_borough",
  "urban_core",
  "transit_desert",
  "manhattan_oriented",
  "peripheral",
  "walkable",
];

function square(x = 0, y = 0, size = 1) {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function layerDoc(type, id, label, vintage = "2026-01-01") {
  const definition = civicGeographyLayer(type);
  return {
    schema: GEOGRAPHY_LAYER_SCHEMA,
    type,
    class: definition.class,
    vintage: { id: vintage },
    features: [{ id, label, geometry: { type: "Polygon", coordinates: [square()] } }],
  };
}

function fiveTypeFixtureMatches() {
  const layers = [
    layerDoc("council_district", "33", "City Council District 33"),
    layerDoc("police_precinct", "61", "Police Precinct 61"),
    layerDoc("nta2020", "BK1601", "Some NTA"),
    layerDoc("community_district", "K18", "Brooklyn Community District 18"),
    layerDoc("business_improvement_district", "test-bid", "Test Improvement District"),
  ];
  const result = resolveCivicGeographies(0.5, 0.5, {
    types: layers.map((layer) => layer.type),
    layerData: layers,
  });
  assert.equal(result.matches.length, 5, "fixture setup: all five layers should contain the point");
  return result.matches;
}

test("A1: the ontology distinguishes geometric containment from institutional meaning", () => {
  const matches = fiveTypeFixtureMatches();
  // Containment evidence uses one undifferentiated relation for every class.
  assert.ok(matches.every((match) => match.relation === "contains_point"));
  const institutional = projectInstitutionalRelations(matches);
  // Institutional evidence is typed per class, never "contains_point".
  assert.ok(institutional.every((relation) => relation.predicate !== "contains_point"));
  assert.ok(institutional.every((relation) => INSTITUTIONAL_RELATION_PREDICATES.includes(relation.predicate)));
  assert.ok(institutional.some((relation) => relation.predicate === "represented_by"));
  assert.ok(institutional.some((relation) => relation.predicate === "served_by"));
  assert.ok(institutional.some((relation) => relation.predicate === "statistically_classified_as"));
});

test("A2: existing containment evidence is not deleted or mutated when a semantic projection is added", () => {
  const matches = fiveTypeFixtureMatches();
  const before = JSON.parse(JSON.stringify(matches));
  const institutional = projectInstitutionalRelations(matches);
  assert.deepEqual(JSON.parse(JSON.stringify(matches)), before, "containment matches must be untouched");
  assert.equal(matches.length, 5, "no containment match may be dropped");
  assert.ok(institutional.length >= 1);
});

test("A3: each published semantic mapping documents source type, predicate, validity, provenance, and temporal limits", () => {
  const matches = fiveTypeFixtureMatches();
  const institutional = projectInstitutionalRelations(matches);
  assert.ok(institutional.length > 0);
  for (const relation of institutional) {
    assert.equal(relation.schema, GEOGRAPHY_RELATION_SCHEMA);
    assert.ok(relation.source_geography_type, "source geography type must be documented");
    assert.ok(INSTITUTIONAL_RELATION_PREDICATES.includes(relation.predicate));
    assert.ok(Array.isArray(relation.validity_assumptions) && relation.validity_assumptions.length > 0);
    assert.ok(relation.institutional_basis && relation.institutional_basis.length > 10);
    assert.ok(relation.provenance && relation.provenance.derived_from === "located_in");
    assert.ok("boundary_vintage" in relation.provenance);
    assert.ok(relation.temporal_limitations && relation.temporal_limitations.length > 10);
  }
});

test("A4: no represented_by edge is inferred from a polygon's label, only from its validated type/id", () => {
  const matches = fiveTypeFixtureMatches();
  const relabeled = matches.map((match) => ({ ...match, label: "Totally Unrelated Free Text" }));
  const institutional = projectInstitutionalRelations(relabeled);
  const represented = institutional.filter((relation) => relation.predicate === "represented_by");
  assert.equal(represented.length, 1);
  assert.equal(represented[0].source_geography_type, "council_district");
  assert.equal(represented[0].source_geography_id, "33");
  // A community district's label can read like a governance body, but the
  // mapping table -- not the label -- decides whether a predicate applies.
  const communityDistrictMatch = matches.find((match) => match.type === "community_district");
  assert.equal(geographyRelationMapping("community_district"), null);
  assert.ok(!institutional.some((relation) => relation.source_geography_type === "community_district"));
  assert.ok(communityDistrictMatch, "fixture sanity: community district containment still present");
});

test("A5: no service edge is published for a geography whose service meaning is unverified", () => {
  const matches = fiveTypeFixtureMatches();
  const institutional = projectInstitutionalRelations(matches);
  assert.ok(!institutional.some((relation) => relation.source_geography_type === "business_improvement_district"));
  assert.ok(EXPLICITLY_UNTYPED_GEOGRAPHY.business_improvement_district.length > 10);
  assert.equal(geographyRelationMapping("business_improvement_district"), null);
});

test("A6: council district, police precinct, and statistical NTA demonstrate the model end to end", () => {
  const matches = fiveTypeFixtureMatches();
  const institutional = projectInstitutionalRelations(matches);
  const byType = Object.fromEntries(institutional.map((relation) => [relation.source_geography_type, relation]));
  assert.equal(byType.council_district.predicate, "represented_by");
  assert.equal(byType.police_precinct.predicate, "served_by");
  assert.equal(byType.nta2020.predicate, "statistically_classified_as");
  assert.equal(institutional.length, 3, "only the three demonstrated classes should project a typed relation here");
});

test("A7: the predicates are registry-backed and reusable outside this module", () => {
  for (const type of ["council_district", "police_precinct", "sanitation_district", "nta2020"]) {
    assert.ok(geographyRelationMapping(type), `${type} should have a registered mapping`);
    assert.ok(civicGeographyLayer(type), `${type} must itself be a registered geography layer`);
  }
  const registry = loadOntologyRegistry();
  const links = new Map(registry.link_types.map((entry) => [entry.id, entry]));
  for (const id of INSTITUTIONAL_RELATION_PREDICATES) {
    assert.equal(links.get(id)?.status, "registered", id);
    assert.ok(links.get(id)?.grounding, id);
  }
});

test("mapping table only names geography kinds already present in the closed civic-geography registry", () => {
  const registeredTypes = new Set(CIVIC_GEOGRAPHY_LAYERS.map((layer) => layer.type));
  for (const type of ["council_district", "police_precinct", "sanitation_district", "nta2020"]) {
    assert.ok(registeredTypes.has(type));
  }
  for (const type of Object.keys(EXPLICITLY_UNTYPED_GEOGRAPHY)) {
    assert.ok(registeredTypes.has(type));
  }
});

test("negative rule: no subjective geography is invented anywhere in the module surface", () => {
  const dump = JSON.stringify({
    predicates: INSTITUTIONAL_RELATION_PREDICATES,
    untyped: EXPLICITLY_UNTYPED_GEOGRAPHY,
    mappings: [
      geographyRelationMapping("council_district"),
      geographyRelationMapping("police_precinct"),
      geographyRelationMapping("sanitation_district"),
      geographyRelationMapping("nta2020"),
    ],
  }).toLowerCase();
  for (const term of SUBJECTIVE_GEOGRAPHY_TERMS) {
    assert.ok(!dump.includes(term), `must not invent subjective geography term: ${term}`);
  }
});

test("community districts and business improvement districts stay deliberately untyped", () => {
  assert.equal(geographyRelationMapping("community_district"), null);
  assert.equal(geographyRelationMapping("business_improvement_district"), null);
  assert.equal(geographyRelationMapping("borough"), null);
  assert.ok(EXPLICITLY_UNTYPED_GEOGRAPHY.community_district);
  assert.ok(EXPLICITLY_UNTYPED_GEOGRAPHY.business_improvement_district);
});

test("an unknown or malformed containment match never produces a typed relation", () => {
  assert.deepEqual(projectInstitutionalRelations([]), []);
  assert.deepEqual(projectInstitutionalRelations([null, undefined, {}]), []);
  assert.deepEqual(
    projectInstitutionalRelations([{ type: "council_district", id: "33", relation: "unknown_layer" }]),
    [],
    "only verified contains_point evidence may seed a typed relation",
  );
});
