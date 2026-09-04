import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COUNCIL_ONLY_CAPABILITIES,
  PERSON_IDENTITY_LINK_METHOD,
  PERSON_IDENTITY_LINK_RELATION,
  PERSON_IDENTITY_LINK_SCHEMA,
  PERSON_PROJECTION_SCHEMA,
  acceptedCanonicalPersonRef,
  allowedPersonCapabilities,
  buildPersonIdentity,
  buildPersonIdentityLink,
  canLoadCouncilSurface,
  councilOfficialHref,
  parsePersonIdentity,
  projectCommunityBoardPersonAlias,
  projectCouncilOfficialAlias,
  projectPerson,
} from "../ontology/person.mjs";
import { buildPersonConstellation } from "../site/person_constellation.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";

const EVIDENCE = Object.freeze([{
  source_ref: "review:person-identity:001",
  source_url: "https://example.test/review/person-identity-001",
  excerpt: "The reviewed source records identify the same individual.",
  observed_at: "2026-08-20T12:00:00Z",
  fields: ["publisher_person_id", "display_name"],
}]);

test("registry registers the generic person projection and same_person link", () => {
  const registry = loadOntologyRegistry();
  const person = registry.object_types.find(({ id }) => id === "person");
  const samePerson = registry.link_types.find(({ id }) => id === "same_person");

  assert.equal(registry.version, "0.7.0");
  assert.equal(person.status, "registered");
  assert.equal(person.identity_contract.schema, PERSON_PROJECTION_SCHEMA);
  assert.equal(person.identity_contract.source_qualified, true);
  assert.equal(person.identity_contract.issuer_required, true);
  assert.equal(person.identity_contract.source_scope_required, true);
  assert.equal(person.identity_contract.display_name_never_identity, true);
  assert.equal(person.identity_contract.public_route, null);
  assert.equal(samePerson.status, "registered");
  assert.equal(samePerson.from, "person");
  assert.equal(samePerson.to, "person");
  assert.equal(samePerson.edge_schema, PERSON_IDENTITY_LINK_SCHEMA);
  assert.deepEqual(samePerson.allowed_statuses, ["candidate", "accepted", "rejected"]);
});
test("same display name does not create cross-source identity", () => {
  const rows = [
    projectCouncilOfficialAlias({ personId: "7801", displayName: "Ada Lovelace" }),
    projectCommunityBoardPersonAlias({ boardId: "manhattan-cb-06", personKey: "jane-001", displayName: "Ada Lovelace" }),
    projectCommunityBoardPersonAlias({ boardId: "queens-cb-07", personKey: "jane-001", displayName: "Ada Lovelace" }),
    projectPerson({
      identity: buildPersonIdentity({ sourceNamespace: "agency", sourceScope: "housing", nativeKey: "jane-001", issuer: "agency-publisher" }),
      sourceIdentity: "agency-person:housing:jane-001",
      sourceKind: "agency-person",
      displayName: "Ada Lovelace",
      profileFamily: "agency-person",
    }),
    projectPerson({
      identity: buildPersonIdentity({ sourceNamespace: "vendor", sourceScope: "acme", nativeKey: "jane-001", issuer: "vendor-publisher" }),
      sourceIdentity: "vendor-contact:acme:jane-001",
      sourceKind: "vendor-contact",
      displayName: "Ada Lovelace",
      profileFamily: "vendor-contact",
    }),
  ];

  assert.equal(new Set(rows.map(({ person_ref: id }) => id)).size, rows.length);
  assert.deepEqual(rows.map(({ display_name: name }) => name), rows.map(() => "Ada Lovelace"));
  assert.equal(rows[0].source_alias.identity, "official:7801");
  assert.equal(rows[0].person_ref, "person:legistar:7801");
  assert.equal(rows[1].source_alias.identity, "community-board-person:manhattan-cb-06:jane-001");
  assert.equal(rows[2].source_alias.identity, "community-board-person:queens-cb-07:jane-001");
  assert.equal(parsePersonIdentity(rows[1].person_ref).source_scope, "manhattan-cb-06");
});

test("Council and Community Board aliases preserve immutable source identities", () => {
  const council = projectCouncilOfficialAlias({ personId: "7801", displayName: "Ada Lovelace" });
  const board = projectCommunityBoardPersonAlias({ boardId: "manhattan-cb-06", personKey: "7801", displayName: "Ada Lovelace" });

  assert.equal(council.schema, PERSON_PROJECTION_SCHEMA);
  assert.equal(council.object_type, "person");
  assert.deepEqual(council.source_alias, {
    identity: "official:7801",
    source_kind: "official",
    compatibility_href: "/officials/7801/",
  });
  assert.equal(board.source_alias.identity, "community-board-person:manhattan-cb-06:7801");
  assert.equal(board.source_alias.compatibility_href, null);
  assert.equal(council.canonical_person_ref, null);
  assert.equal(board.canonical_person_ref, null);
});

test("same_person requires inspectable provenance and only accepted links expose a canonical ref", () => {
  const left = "person:legistar:7801";
  const right = "person:community-board:manhattan-cb-06:7801";
  const common = {
    leftIdentity: left,
    rightIdentity: right,
    evidence: EVIDENCE,
    observedAt: "2026-08-21T12:00:00Z",
    canonicalPersonRef: "person:reviewed:jane-doe-001",
  };
  const candidate = buildPersonIdentityLink({ ...common, status: "candidate" });
  const rejected = buildPersonIdentityLink({ ...common, status: "rejected", reviewedAt: "2026-08-22T12:00:00Z" });
  const accepted = buildPersonIdentityLink({ ...common, status: "accepted", reviewedAt: "2026-08-22T12:00:00Z" });

  for (const link of [candidate, rejected, accepted]) {
    assert.equal(link.schema, PERSON_IDENTITY_LINK_SCHEMA);
    assert.equal(link.relation, PERSON_IDENTITY_LINK_RELATION);
    assert.equal(link.method, PERSON_IDENTITY_LINK_METHOD);
    assert.equal(link.evidence[0].source_ref, "review:person-identity:001");
    assert.equal(link.provenance.evidence_count, 1);
    assert.equal(link.left_identity, left);
    assert.equal(link.right_identity, right);
  }
  assert.equal(candidate.canonical_person_ref, null);
  assert.equal(rejected.canonical_person_ref, null);
  assert.equal(acceptedCanonicalPersonRef(candidate, left), null);
  assert.equal(acceptedCanonicalPersonRef(rejected, left), null);
  assert.equal(acceptedCanonicalPersonRef(accepted, left), "person:reviewed:jane-doe-001");
  assert.throws(() => buildPersonIdentityLink({ ...common, status: "accepted", evidence: [] }), /require evidence/);
  assert.throws(() => buildPersonIdentityLink({ ...common, status: "accepted", evidence: [{ excerpt: "name only" }] }), /source locator/);
});

test("profile-family allowlist isolates generic, board, agency, and vendor people from Council", () => {
  const subjects = [
    projectCouncilOfficialAlias({ personId: "7801", displayName: "Ada Lovelace" }),
    projectCommunityBoardPersonAlias({ boardId: "manhattan-cb-06", personKey: "jane-001", displayName: "Ada Lovelace" }),
    projectPerson({
      identity: buildPersonIdentity({ sourceNamespace: "agency", sourceScope: "housing", nativeKey: "jane-001", issuer: "agency-publisher" }),
      profileFamily: "agency-person",
      displayName: "Ada Lovelace",
    }),
    projectPerson({
      identity: buildPersonIdentity({ sourceNamespace: "vendor", sourceScope: "acme", nativeKey: "jane-001", issuer: "vendor-publisher" }),
      profileFamily: "vendor-contact",
      displayName: "Ada Lovelace",
    }),
  ];

  for (const subject of subjects) {
    const capabilities = allowedPersonCapabilities(subject);
    assert.equal(subject.object_type, "person");
    assert.deepEqual(capabilities.filter((capability) => COUNCIL_ONLY_CAPABILITIES.includes(capability)), []);
    assert.equal(canLoadCouncilSurface(subject), false);
    assert.equal(councilOfficialHref(subject), null);
  }

  const legacyCouncil = { object_type: "official", id: "official:7801", profile_family: "council-official" };
  assert.ok(allowedPersonCapabilities(legacyCouncil).includes("council.votes"));
  assert.equal(canLoadCouncilSurface(legacyCouncil), true);
  assert.equal(councilOfficialHref(legacyCouncil), "/officials/7801/");
  assert.equal(canLoadCouncilSurface({ ...legacyCouncil, id: "community-board-person:manhattan-cb-06:jane-001" }), false);
});

test("person constellation surfaces verified source and cross-category edges without a generic route", () => {
  const boardPerson = projectCommunityBoardPersonAlias({
    boardId: "manhattan-cb-06",
    personKey: "jane-001",
    displayName: "Ada Lovelace",
    observedAt: "2026-08-25",
    sourceObservationRefs: ["cb6-roster-2026-08-25"],
  });
  const view = buildPersonConstellation({
    person: boardPerson,
    source: { kind: "community-board", id: "manhattan-cb-06", name: "Manhattan Community Board 6" },
    edges: [
      {
        relation: "member_of",
        target_kind: "community-board",
        target_ref: "community-board:manhattan-cb-06",
        target_name: "Manhattan Community Board 6",
        target_href: "/community-boards/manhattan-cb-06/",
        status: "matched",
        provenance: { source_record_id: "cb6-roster-2026-08-25" },
      },
      {
        relation: "member_of",
        target_kind: "community-board-committee",
        target_ref: "community-board-committee:manhattan-cb-06:transportation",
        target_name: "Transportation Committee",
        status: "matched",
      },
      {
        relation: "same_person",
        target_kind: "person",
        target_ref: "person:legistar:7801",
        target_name: "Ada Lovelace",
        status: "held",
      },
    ],
  });

  assert.equal(view.schema, "cityscroll.person_constellation.v1");
  assert.equal(view.person_ref, "person:community-board:manhattan-cb-06:jane-001");
  assert.equal(view.local_constellation.kind, "person");
  assert.equal(view.local_constellation.nodes.find((node) => node.edge_type === "member_of")?.href, "/community-boards/manhattan-cb-06/");
  assert.equal(view.local_constellation.nodes.find((node) => node.edge_type === "same_person")?.href, null);
  assert.equal(view.local_constellation.nodes.find((node) => node.edge_type === "source_identity")?.href, null);
});
