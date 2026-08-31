import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadOntologyRegistry } from "../ontology/index.mjs";
import {
  CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
  CIVIC_INSTITUTION_ROLE_RELATIONS,
} from "../ontology/civic_institution.mjs";
import { renderAgencyIdentitySection } from "../site/agency_identity_evidence.mjs";
import { buildCommitteeDocumentView, renderCommitteeDocument } from "../site/committee_document.mjs";
import { AGENCY_CONSTELLATION_CATEGORIES } from "../site/agency_constellation.mjs";
import {
  COUNCIL_CANONICAL_ID,
  COMMITTEE_PROCEEDING_JOIN_METHOD,
  SPECIMEN_MEETING_ID,
  SPECIMEN_MEETING_REQUEST_ID,
  TARGET_LAND_MATTER_ID,
  TARGET_PROCEEDING_DATE,
  ZONING_FRANCHISES_BODY_ID,
  ZONING_FRANCHISES_COMMITTEE_ID,
  councilCommitteeRolesForCommittee,
  councilCommitteeRolesForInstitution,
  isNameOnlyCommitteeIdentity,
  landMatterJoinState,
  resolveCouncilCommitteeRoles,
  verifyCommitteeMeetingJoin,
} from "../site/civic_institution_council_committees.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";
import proceedings from "../site/data/council_committee_proceedings.json" with { type: "json" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/civic_institution_council_committees/cases.json", import.meta.url), "utf8"),
);

const GRAPH = Object.freeze({
  schema: "cityscroll.committee_graph.v1",
  publication: "published",
  generated_at: "2026-08-12T14:37:51Z",
  nodes: [{
    id: ZONING_FRANCHISES_COMMITTEE_ID,
    type: "committee",
    name: "Subcommittee on Zoning and Franchises",
    properties: { body_id: ZONING_FRANCHISES_BODY_ID, body_name: "Subcommittee on Zoning and Franchises" },
    provenance: {
      source: {
        system: "nyc_legistar_office_records",
        id: ZONING_FRANCHISES_BODY_ID,
        url: "https://webapi.legistar.com/v1/nyc/persons/7785/officerecords",
      },
      source_fields: ["OfficeRecordBodyId", "OfficeRecordBodyName"],
      observed_at: "2026-08-12T14:37:51Z",
    },
  }],
  public_edges: [
    {
      type: "member_of",
      from: FIXTURES.chair.official_id,
      to: ZONING_FRANCHISES_COMMITTEE_ID,
      title: FIXTURES.chair.title,
      is_chair: true,
      valid_from: FIXTURES.chair.valid_from,
      valid_to: FIXTURES.chair.valid_to,
      source_url: "https://webapi.legistar.com/v1/nyc/persons/7785/officerecords",
      source_row_hash: FIXTURES.chair.source_row_hash,
      provenance: {
        source: {
          system: "nyc_legistar_office_records",
          id: `officerecord:7785:34:${FIXTURES.chair.source_row_hash}`,
          url: "https://webapi.legistar.com/v1/nyc/persons/7785/officerecords",
        },
        source_fields: ["OfficeRecordPersonId", "OfficeRecordBodyId", "OfficeRecordTitle", "OfficeRecordStartDate"],
        observed_at: "2026-08-12T14:37:51Z",
      },
    },
    {
      type: "member_of",
      from: FIXTURES.member.official_id,
      to: ZONING_FRANCHISES_COMMITTEE_ID,
      title: FIXTURES.member.title,
      is_chair: false,
      valid_from: FIXTURES.member.valid_from,
      valid_to: FIXTURES.member.valid_to,
      source_url: "https://webapi.legistar.com/v1/nyc/persons/5289/officerecords",
      source_row_hash: FIXTURES.member.source_row_hash,
      provenance: {
        source: {
          system: "nyc_legistar_office_records",
          id: `officerecord:5289:34:${FIXTURES.member.source_row_hash}`,
          url: "https://webapi.legistar.com/v1/nyc/persons/5289/officerecords",
        },
        observed_at: "2026-08-12T14:37:51Z",
      },
    },
  ],
});

const PEOPLE = Object.freeze({
  by_person_id: {
    "7785": { person_id: "7785", person_name: "Kevin C. Riley" },
    "5289": { person_id: "5289", person_name: "Simcha Felder" },
  },
});

const OUTCOMES = Object.freeze({
  by_notice: {
    [SPECIMEN_MEETING_REQUEST_ID]: {
      request_id: SPECIMEN_MEETING_REQUEST_ID,
      snapshot_state: "present",
      event: { event_id: FIXTURES.event_id, date: "2026-07-21" },
      matters: [{ matter_id: "79201", matter_file: "LU 0115-2026" }],
    },
  },
});

function sources() {
  return { committeeGraph: GRAPH, proceedings, meetingOutcomes: OUTCOMES };
}

test("registry registers Council committee relations with exact-id contracts", () => {
  const registry = loadOntologyRegistry();
  const ids = new Map(registry.link_types.map((row) => [row.id, row]));
  assert.match(ids.get("has_committee").from, /civic-institution/);
  assert.match(ids.get("has_committee").to, /committee/);
  assert.match(ids.get("hosts_meeting").from, /committee/);
  assert.match(ids.get("chairs").from, /official/);
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.has_committee.object_kind, "committee");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.hosts_meeting.from_kind, "committee");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.member_of.from_kind, "official");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.chairs.from_kind, "official");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.considers.object_kind, "land-matter");
  assert.match(CIVIC_INSTITUTION_ROLE_RELATIONS.has_committee.negative_rule, /display name/);
});

test("exact committee 34, meeting 20260707021, and official memberships traverse with receipts", () => {
  const resolved = resolveCouncilCommitteeRoles(sources());
  const hasCommittee = resolved.accepted.find((edge) => edge.relation_id === "has_committee");
  const hosted = resolved.accepted.find((edge) => edge.relation_id === "hosts_meeting");
  const chair = resolved.accepted.find((edge) => edge.relation_id === "chairs");
  const member = resolved.accepted.find((edge) => (
    edge.relation_id === "member_of" && edge.from === FIXTURES.member.official_id
  ));
  assert.equal(hasCommittee.status, "accepted");
  assert.equal(hasCommittee.schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(hasCommittee.from, `civic-institution:${COUNCIL_CANONICAL_ID}`);
  assert.equal(hasCommittee.to, ZONING_FRANCHISES_COMMITTEE_ID);
  assert.equal(hasCommittee.href, "/committees/34/");
  assert.equal(hasCommittee.provenance.source_field, "officerecordbodyid");
  assert.equal(hasCommittee.provenance.source_value, ZONING_FRANCHISES_BODY_ID);
  assert.equal(hosted.to, SPECIMEN_MEETING_ID);
  assert.equal(hosted.join_method, COMMITTEE_PROCEEDING_JOIN_METHOD);
  assert.equal(hosted.request_id, SPECIMEN_MEETING_REQUEST_ID);
  assert.ok(hosted.source_receipt);
  assert.match(hosted.href, /meeting%3Acity_record%3A20260707021/);
  assert.equal(chair.from, FIXTURES.chair.official_id);
  assert.equal(chair.valid_from, FIXTURES.chair.valid_from);
  assert.equal(chair.valid_to, FIXTURES.chair.valid_to);
  assert.equal(member.valid_from, FIXTURES.member.valid_from);
  assert.equal(resolved.accepted.some((edge) => edge.relation_id === "considers"), false);
});

test("Council profile Committees rail links committee 34 without search", () => {
  const evidence = buildAgencyIdentityEvidence({
    identity: { canonical_id: COUNCIL_CANONICAL_ID, canonical_name: "New York City Council" },
    publisherRow: {
      canonical_name: "New York City Council",
      org_type: "Elected Official",
      match_method: "normalized",
      variants: ["City Council"],
    },
    view: { path: "/agencies/city-council/", categories: [] },
    generatedAt: "2026-08-12T14:37:51Z",
    committeeRoleSources: sources(),
  });
  const html = renderAgencyIdentitySection({
    path: "/agencies/city-council/",
    display_name: "New York City Council",
    identity_evidence: evidence,
  });
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "has_committee" && edge.to === ZONING_FRANCHISES_COMMITTEE_ID), true);
  assert.match(html, /id="agency-institution-committees"/);
  assert.match(html, /data-committee-rail="1"/);
  assert.match(html, /href="\/committees\/34\/"/);
  assert.match(html, /data-role-relation="has_committee"/);
  assert.doesNotMatch(html, /text search/i);
});

test("committee document shows the July 21 meeting, chair evidence, and an explicit matter gap", () => {
  const view = buildCommitteeDocumentView(GRAPH, PEOPLE, ZONING_FRANCHISES_BODY_ID, {
    proceedings,
    meetingOutcomes: OUTCOMES,
  });
  const html = renderCommitteeDocument(view);
  const join = landMatterJoinState(view.proceeding_roles);
  assert.equal(view.land_matter_join.status, "unavailable");
  assert.equal(join.matter_id, TARGET_LAND_MATTER_ID);
  assert.match(html, /data-role-relation="hosts_meeting"/);
  assert.match(html, /data-meeting-id="meeting:city_record:20260707021"/);
  assert.match(html, /data-join-method="exact_event_body_id"/);
  assert.match(html, /data-role-relation="chairs"/);
  assert.match(html, /data-valid-from="2026-01-15"/);
  assert.match(html, /href="\/agencies\/city-council\/"/);
  assert.match(html, /data-matter-join="unavailable"/);
  assert.match(html, /data-proceeding-gap="2026-08-12"/);
  assert.match(html, /Matter join unavailable/);
  assert.doesNotMatch(html, /LU 0120-2026<\/a>/);
});

test("name-only committees, nearby dates, and Council publication never mint edges", () => {
  assert.equal(isNameOnlyCommitteeIdentity(FIXTURES.negatives.name_only_committee), true);
  assert.equal(isNameOnlyCommitteeIdentity(ZONING_FRANCHISES_COMMITTEE_ID), false);
  const nameJoin = verifyCommitteeMeetingJoin({
    committee_name: FIXTURES.negatives.name_only_committee,
    join_method: "name_match",
    request_id: SPECIMEN_MEETING_REQUEST_ID,
    meeting_id: SPECIMEN_MEETING_ID,
  });
  assert.equal(nameJoin.accepted, false);
  const nearby = verifyCommitteeMeetingJoin({
    body_id: ZONING_FRANCHISES_BODY_ID,
    event_body_id: ZONING_FRANCHISES_BODY_ID,
    request_id: SPECIMEN_MEETING_REQUEST_ID,
    meeting_id: SPECIMEN_MEETING_ID,
    event_id: FIXTURES.event_id,
    join_method: COMMITTEE_PROCEEDING_JOIN_METHOD,
    event_date: FIXTURES.negatives.nearby_date,
  }, {
    meetingOutcomes: { by_notice: { [SPECIMEN_MEETING_REQUEST_ID]: { snapshot_state: "present", event: { event_id: "99999" } } } },
  });
  assert.equal(nearby.accepted, false);
  assert.equal(nearby.reason, "event_receipt_missing");
  const publisher = verifyCommitteeMeetingJoin({
    body_id: "",
    agency_name: FIXTURES.negatives.publisher_only,
    request_id: SPECIMEN_MEETING_REQUEST_ID,
    meeting_id: SPECIMEN_MEETING_ID,
  });
  assert.equal(publisher.accepted, false);
  const probed = resolveCouncilCommitteeRoles({ ...sources(), includeNegativeProbes: true });
  assert.equal(probed.unresolved.some((edge) => edge.reason === "name_only_endpoint"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "council_publisher_not_join"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "nearby_date_not_join"), true);
  assert.equal(probed.accepted.every((edge) => edge.relation_id !== "considers"), true);
  assert.equal(
    probed.gaps.some((gap) => gap.target === TARGET_LAND_MATTER_ID && gap.reason === "matter_join_unavailable"),
    true,
  );
  assert.equal(
    probed.gaps.some((gap) => gap.target === TARGET_PROCEEDING_DATE),
    true,
  );
});

test("Council routes, meeting facets, official rows, and agency subject refs stay on existing contracts", () => {
  const lookup = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
  const council = lookup.by_id[COUNCIL_CANONICAL_ID];
  assert.equal(council.subject_ref, "agency:id:city-council");
  assert.equal(council.path, "/agencies/city-council/");
  assert.equal(AGENCY_CONSTELLATION_CATEGORIES.length, 6);
  assert.deepEqual(AGENCY_CONSTELLATION_CATEGORIES.map((row) => row.id), [
    "contracts",
    "vendors",
    "meetings",
    "rules",
    "obligations",
    "staffing",
  ]);
  assert.deepEqual(Object.keys(council.categories).sort(), [...AGENCY_CONSTELLATION_CATEGORIES.map((row) => row.id)].sort());
  assert.equal(AGENCY_CONSTELLATION_CATEGORIES.find((row) => row.id === "meetings").relation, "hosts_meeting");
  const membershipsPath = join(ROOT, "worker/src/data/official_committee_memberships_lookup.json");
  const memberships = JSON.parse(readFileSync(membershipsPath, "utf8"));
  const memberRows = Object.values(memberships.by_member_id || {}).flatMap((row) => row.rows || []);
  assert.ok(memberRows.some((row) => String(row.committee_id) === ZONING_FRANCHISES_BODY_ID));
  const graphPath = join(ROOT, "worker/src/data/committee_graph_lookup.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  assert.ok(graph.nodes.some((node) => node.id === ZONING_FRANCHISES_COMMITTEE_ID));
  const scoped = councilCommitteeRolesForInstitution("sanitation", sources());
  assert.equal(scoped.accepted.length, 0);
  const otherCommittee = councilCommitteeRolesForCommittee("5261", sources());
  assert.equal(otherCommittee.accepted.length, 0);
});
