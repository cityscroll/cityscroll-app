import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGENCY_SOURCE_IDENTITY_CONTRACT_METHOD,
  AGENCY_SOURCE_IDENTITY_CONTRACT_SCHEMA,
  AGENCY_SOURCE_IDENTITY_NON_LINKING_STATUSES,
  AGENCY_OBJECT_KEY_PATTERN,
  PERSON_LEADER_KEY_PATTERN,
  PROPERTY_SITE_KEY_PATTERN,
  ROUTE_ALIAS_OF_INVERSE,
  ROUTE_ALIAS_OF_RELATION,
  ROUTE_ALIAS_SOURCE_CONTRACT,
  STAFFING_AGENCY_KEY_PATTERN,
  buildAgencySourceIdentityContract,
  classifyAgencySourceIdentity,
  isAgencyObjectKey,
  isAgencySubjectRef,
  isCommunityBoardBodyId,
  isPersonLeaderKey,
  isPropertyDispositionKey,
  isStaffingAgencyKey,
  projectReviewedRouteAliasEdges,
} from "../site/agency_source_identity_contract.mjs";
import {
  projectInstitutionProfileNavigation,
  projectReviewedRouteAliases,
} from "../site/civic_institution_profile_navigation.mjs";
import { buildAgencySourceIdentitySnapshot } from "../tools/lib/agency_source_identity_snapshot.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASES = JSON.parse(
  readFileSync(
    new URL("./fixtures/agency_source_identity_compatibility/cases.json", import.meta.url),
    "utf8",
  ),
);
const SNAPSHOT = JSON.parse(
  readFileSync(
    new URL("./fixtures/agency_source_identity_compatibility/snapshot.v1.json", import.meta.url),
    "utf8",
  ),
);
const REPORT = JSON.parse(
  readFileSync(join(ROOT, "site/data/agency_route_identity_report.json"), "utf8"),
);
const CROSSWALK = JSON.parse(
  readFileSync(join(ROOT, "worker/src/data/agency_crosswalk.json"), "utf8"),
);
const ROUTES = buildAgencySourceIdentitySnapshot({ root: ROOT }).contract.routes.paths
  .map((path) => path.replace(/^\/agencies\//, "").replace(/\/$/, ""));
const ROUTE_SET = new Set(ROUTES);

function classify(id) {
  return classifyAgencySourceIdentity(id, { crosswalk: CROSSWALK, routes: ROUTE_SET });
}

function contract() {
  return buildAgencySourceIdentityContract({
    crosswalk: CROSSWALK,
    routes: ROUTES,
  });
}

test("reviewed aliases project through route_alias_of with exact compatibility evidence", () => {
  const edges = projectReviewedRouteAliasEdges(REPORT);
  assert.equal(edges.length, CASES.alias_edge_count);
  const alias = edges.find((edge) => edge.source_id === CASES.reviewed_alias.source_id);
  assert.equal(alias.relation_id, ROUTE_ALIAS_OF_RELATION);
  assert.equal(alias.inverse, ROUTE_ALIAS_OF_INVERSE);
  assert.equal(alias.canonical_id, CASES.reviewed_alias.canonical_id);
  assert.equal(alias.redirect_path, CASES.reviewed_alias.redirect_path);
  assert.equal(alias.destination_path, CASES.reviewed_alias.destination_path);
  assert.equal(alias.disposition_basis, CASES.reviewed_alias.disposition_basis);
  assert.equal(alias.collision, CASES.reviewed_alias.collision);
  assert.equal(alias.source_contract, ROUTE_ALIAS_SOURCE_CONTRACT);
  assert.ok(alias.vintage);

  // Generic self-aliases, unresolved routes, and colliding ids never mint edges.
  assert.equal(edges.some((edge) => edge.source_id === "board-meetings"), false);
  for (const id of CASES.collision.source_ids) {
    assert.equal(edges.some((edge) => edge.source_id === id || edge.to === id), false);
  }
  for (const id of CASES.unresolved.source_ids) {
    assert.equal(edges.some((edge) => edge.source_id === id), false);
  }
  assert.equal(edges.every((edge) => edge.source_id !== edge.canonical_id), true);

  // The machine edges and the resident projection agree on every shared
  // compatibility field; the resident copy only adds reader chrome fields.
  const projectionFields = ({ schema, href, linking, source_report, ...shared }) => shared;
  assert.deepEqual(
    edges.map(projectionFields),
    projectReviewedRouteAliases(REPORT).map(projectionFields),
  );
});

test("EEP collision, unresolved, route-only, and source-only identities stay non-linking", () => {
  const eep = classify(CASES.collision.source_ids[0]);
  assert.equal(eep.status, "collision");
  assert.equal(eep.links_to_canonical, CASES.collision.links_to_canonical);
  assert.equal(eep.canonical_id, null);
  assert.equal(eep.institution_kind, CASES.collision.institution_kind);
  assert.deepEqual(eep.collision_ids, [...CASES.collision.source_ids].sort());
  assert.equal(eep.comparison_key, CASES.collision.comparison_key);
  for (const id of CASES.collision.source_ids) {
    assert.equal(classify(id).status, "collision");
  }

  for (const id of CASES.unresolved.source_ids) {
    const state = classify(id);
    assert.equal(state.status, "unresolved");
    assert.equal(state.links_to_canonical, CASES.unresolved.links_to_canonical);
    assert.equal(state.canonical_id, null);
    assert.equal(state.source_id, id);
    assert.equal(state.institution_kind, CASES.unresolved.institution_kind);
  }

  for (const id of CASES.route_only.source_ids) {
    const state = classify(id);
    assert.equal(state.status, "route_only");
    assert.equal(state.links_to_canonical, CASES.route_only.links_to_canonical);
    assert.equal(state.canonical_id, null);
    assert.ok(state.route);
  }

  for (const id of CASES.source_only_specimens) {
    const state = classify(id);
    assert.equal(state.status, "source_only");
    assert.equal(state.links_to_canonical, false);
    assert.equal(state.route, null);
    assert.ok(CROSSWALK.entries[id]);
  }

  const built = contract();
  const nonLinking = built.identity_states.non_linking;
  assert.ok(nonLinking.length > 0);
  for (const row of nonLinking) {
    assert.ok(AGENCY_SOURCE_IDENTITY_NON_LINKING_STATUSES.includes(row.status));
    assert.equal(row.links_to_canonical, false);
    assert.equal(row.canonical_id, null);
    assert.equal(row.institution_kind, null);
  }
  // Collisions and unresolved identities are never an edge endpoint. A
  // reviewed target may itself be route-retained (route_only); what is barred
  // is minting a link into an ambiguous, unresolved, or route-less identity.
  const barred = new Set([
    ...nonLinking.filter((row) => row.status === "collision" || row.status === "unresolved")
      .map((row) => row.source_id),
    ...nonLinking.filter((row) => row.status === "source_only").map((row) => row.source_id),
  ]);
  const statesById = new Map(built.identity_states.states.map((row) => [row.source_id, row]));
  for (const edge of built.route_alias_of) {
    assert.equal(barred.has(edge.source_id), false);
    assert.equal(barred.has(edge.canonical_id), false);
    assert.ok(statesById.get(edge.canonical_id)?.route);
  }
});

test("machine classifier agrees with the resident projection on shared specimens", () => {
  const specimens = [
    CASES.specimens.dsny,
    CASES.specimens.nycedc,
    CASES.collision.source_ids[0],
    CASES.unresolved.source_ids[0],
  ];
  for (const id of specimens) {
    const projection = projectInstitutionProfileNavigation({
      identity: { canonical_id: id, canonical_name: CROSSWALK.entries[id]?.canonical_name || id },
      publisherRow: CROSSWALK.entries[id] || null,
      routeIdentityReport: REPORT,
    });
    const machine = classify(id);
    assert.equal(
      machine.status === "alias_route" ? "matched" : machine.status,
      projection.identity_evidence_state.status,
      `status mismatch for ${id}`,
    );
  }
});

test("property, person-leader, staffing, agency, and board key shapes stay compatible", () => {
  const shapes = CASES.key_shape_cases;
  for (const value of shapes.agency_subject_refs.positive) assert.equal(isAgencySubjectRef(value), true);
  for (const value of shapes.agency_subject_refs.negative) assert.equal(isAgencySubjectRef(value), false);
  for (const value of shapes.agency_object_keys.positive) assert.equal(isAgencyObjectKey(value), true);
  for (const value of shapes.agency_object_keys.negative) assert.equal(isAgencyObjectKey(value), false);
  for (const value of shapes.property_disposition_keys.positive) {
    assert.equal(isPropertyDispositionKey(value), true);
  }
  for (const value of shapes.property_disposition_keys.negative) {
    assert.equal(isPropertyDispositionKey(value), false);
  }
  for (const value of shapes.person_leader_keys.positive) assert.equal(isPersonLeaderKey(value), true);
  for (const value of shapes.person_leader_keys.negative) assert.equal(isPersonLeaderKey(value), false);
  for (const value of shapes.community_board_body_ids.positive) {
    assert.equal(isCommunityBoardBodyId(value), true);
  }
  for (const value of shapes.community_board_body_ids.negative) {
    assert.equal(isCommunityBoardBodyId(value), false);
  }
  assert.equal(isStaffingAgencyKey("agency:id:sanitation"), true);
  assert.equal(isStaffingAgencyKey("sanitation"), false);

  const built = contract();
  assert.equal(built.key_shapes.agency.pattern, AGENCY_OBJECT_KEY_PATTERN);
  assert.equal(built.key_shapes.agency.canonical_id_keys.includes("agency:sanitation"), true);
  assert.equal(built.key_shapes.agency.name_keys.includes("agency:Sanitation"), true);
  assert.equal(built.key_shapes.property_site.pattern, PROPERTY_SITE_KEY_PATTERN);
  for (const ref of shapes.property_disposition_keys.positive.filter((value) => value.startsWith("disposition:"))) {
    assert.equal(built.key_shapes.property_site.disposition_subject_refs.includes(ref), true);
  }
  assert.equal(
    built.key_shapes.property_site.notice_subject_refs.includes("notice:20211118008"),
    true,
  );
  assert.equal(built.key_shapes.person_leader.pattern, PERSON_LEADER_KEY_PATTERN);
  assert.equal(
    built.key_shapes.person_leader.keys.includes("person-leader:sanitation:name:gregory%20anderson"),
    true,
  );
  assert.equal(
    built.key_shapes.person_leader.keys.includes("person-leader:police-department:name:jessica%20tisch"),
    true,
  );
  assert.equal(built.key_shapes.staffing.pattern, STAFFING_AGENCY_KEY_PATTERN);
  assert.equal(built.key_shapes.staffing.relation, "certified_to_agency");
  assert.equal(built.key_shapes.staffing.agency_refs.includes("agency:id:sanitation"), true);
  for (const ref of built.key_shapes.staffing.agency_refs) {
    assert.equal(isStaffingAgencyKey(ref), true);
  }
});

test("all 59 Community Board body ids stay byte compatible and non-merged", () => {
  const built = contract();
  const bodyIds = built.community_boards.body_ids;
  assert.equal(built.community_boards.count, CASES.community_boards.count);
  assert.equal(bodyIds.length, CASES.community_boards.count);
  assert.equal(new Set(bodyIds).size, bodyIds.length);
  assert.deepEqual(bodyIds, [...bodyIds].sort());
  for (const id of bodyIds) assert.equal(isCommunityBoardBodyId(id), true);
  assert.equal(bodyIds.includes(CASES.community_boards.body_id), true);
});

test("routes, subject refs, scopes, and follows pass the committed regression snapshot", () => {
  const snapshot = buildAgencySourceIdentitySnapshot({ root: ROOT });
  assert.equal(snapshot.schema, SNAPSHOT.schema);
  assert.deepEqual(snapshot, SNAPSHOT);

  const contractSnapshot = snapshot.contract;
  assert.equal(contractSnapshot.schema, AGENCY_SOURCE_IDENTITY_CONTRACT_SCHEMA);
  assert.equal(contractSnapshot.method, AGENCY_SOURCE_IDENTITY_CONTRACT_METHOD);
  assert.equal(contractSnapshot.routes.count, CASES.route_count);
  assert.equal(contractSnapshot.subject_refs.count, CASES.subject_ref_count);
  assert.deepEqual(contractSnapshot.identity_states.counts, CASES.identity_counts);
  assert.ok(contractSnapshot.routes.paths.includes(`/agencies/${CASES.specimens.dsny}/`));
  assert.ok(contractSnapshot.routes.paths.includes(`/agencies/${CASES.specimens.nycedc}/`));
  assert.ok(contractSnapshot.subject_refs.refs.includes(`agency:id:${CASES.specimens.dsny}`));
  for (const ref of contractSnapshot.subject_refs.refs) {
    assert.equal(isAgencySubjectRef(ref), true);
  }

  const scopeEntries = Object.entries(snapshot.scope_hrefs);
  assert.equal(scopeEntries.length, CASES.subject_ref_count);
  for (const [ref, href] of scopeEntries) {
    // Unresolvable identities (collisions, generic routes) stay unscoped
    // rather than minting a guessed agency facet link.
    if (href === "#rules") continue;
    assert.match(href, /^#rules\?facet=/);
    assert.equal(href.includes(encodeURIComponent(ref)), true);
  }
  assert.equal(
    snapshot.scope_hrefs["agency:id:sanitation"],
    "#rules?facet=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Asanitation%22%5D%7D",
  );
  const followEntries = Object.entries(snapshot.follow_hrefs);
  assert.equal(followEntries.length, CASES.subject_ref_count);
  for (const [ref, href] of followEntries) {
    assert.match(href, /^https:\/\/cityscroll\.org\/following\?/);
    assert.equal(href.includes(encodeURIComponent(ref)), true);
  }
});

test("the machine contract is consumable without resident chrome or a global rename", () => {
  const moduleSource = readFileSync(
    join(ROOT, "site/agency_source_identity_contract.mjs"),
    "utf8",
  );
  assert.equal(moduleSource.includes("civic_document_chrome"), false);
  assert.equal(moduleSource.includes("renderInstitution"), false);
  assert.equal(/import .*pages_edge/.test(moduleSource), false);

  const built = contract();
  assert.deepEqual(built.guard_rails, {
    index_wide_role_filters: false,
    index_evidence_chips: false,
    global_agency_rename: false,
    community_board_child_relation: null,
    resident_chrome_required: false,
  });
  assert.equal(built.key_shapes.agency.canonical_id_keys.includes("agency:sanitation"), true);
  assert.equal(built.subject_refs.refs.includes("agency:id:sanitation"), true);

  const registry = loadOntologyRegistry();
  const link = registry.link_types.find((row) => row.id === ROUTE_ALIAS_OF_RELATION);
  assert.equal(link.status, "registered");
  assert.equal(link.inverse, ROUTE_ALIAS_OF_INVERSE);
  assert.deepEqual(link.required_evidence, [
    "source_id",
    "canonical_id",
    "redirect_path",
    "disposition_basis",
    "non_collision_status",
  ]);
  // No generic Community Board child relation was added to buy compatibility.
  const cbChild = registry.link_types.filter((row) =>
    String(row.from).split("|").includes("community-board")
    && String(row.to).split("|").includes("agency"));
  assert.deepEqual(cbChild, []);
});
