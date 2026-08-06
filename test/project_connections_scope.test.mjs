import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectConnectionEvidence,
  buildProjectConnectionView,
  normalizeProjectConnectionsPayload,
  projectApplyScopeHash,
  projectConnectionsPayloadState,
  projectConnectionScopeHash,
} from "../site/project_connections.mjs";
import * as CrolScope from "../site/scope_v0.mjs";
import { vendorAgencyIntersectionHref } from "../site/vendor_footprint.mjs";

const PROJECT_ID = "2022M0258";
const PROJECT_REF = `project:${PROJECT_ID}`;
const PROJECT = {
  project_id: PROJECT_ID,
  project_name: "Timbale Terrace",
  primary_applicant: "HPD - NYC Dept of Housing Preservation & Development",
};
const COVERAGE = {
  applicant: {
    eligible: 231,
    linked: 231,
    rate: 1,
    scope: "current_zap_snapshot",
    vintage: "2026-08-02T10:22:34.003Z",
  },
  parcels: {
    eligible: 231,
    linked: 224,
    rate: 224 / 231,
    scope: "current_zap_snapshot",
    vintage: "2026-08-05T10:41:38.120Z",
  },
  meetings: {
    eligible: null,
    linked: 6,
    rate: null,
    scope: "bounded_entity_materialization",
    vintage: "2026-08-05T16:58:19.251Z",
    gap: "eligible_denominator_not_measured",
  },
  decisions: {
    eligible: 50,
    linked: 45,
    rate: 0.9,
    scope: "fixed_completed_project_sample",
    vintage: "2026-07-30",
  },
  notices: {
    eligible: null,
    linked: null,
    rate: null,
    scope: "this_project",
    vintage: "2026-08-05T16:58:19.251Z",
    gap: "eligible_denominator_not_measured",
  },
};

function evidence(overrides = {}) {
  return buildProjectConnectionEvidence({
    projectId: PROJECT_ID,
    projectRows: [
      PROJECT,
      { ...PROJECT, project_id: "2025K0001", project_name: "Timbale Terrace" },
    ],
    bblRows: [
      { project_id: PROJECT_ID, bbls: ["1017670001", "1017670002"] },
      { project_id: "2025K0001", bbls: ["9999999999"] },
      { project_name: "Timbale Terrace", address: "101 East 118 Street", bbls: ["8888888888"] },
    ],
    entityLinks: [{
      entity_ref: "agency:id:housing-preservation-and-development",
      label: "Housing Preservation and Development",
      relation: "applicant_agency",
      confidence: "tentative",
      evidence: "land_primary_applicant",
    }],
    graphLinks: [{
      type: "decides_land_project",
      from: "notice:20240101001",
      to: PROJECT_REF,
      confidence: "strong",
      method: "exact_ulurp_token_v1",
      label: "City Planning Commission hearing",
      agency_name: "City Planning Commission",
      when: "2024-01-09",
    }],
    outcome: {
      project_id: PROJECT_ID,
      generated_at: "2026-08-05T17:00:00.000Z",
      dispositions: [{
        representing: "Community Board",
        community_board: "Conditional Favorable",
        vote_date: "2023-10-24",
      }],
      documents: [{ name: "Community Board recommendation", url: "https://example.test/doc" }],
      city_record_notices: [{
        request_id: "20240101001",
        short_title: "City Planning Commission hearing",
        agency_name: "City Planning Commission",
        event_date: "2024-01-09",
        join: { matched: true, method: "exact_ulurp_token" },
      }],
      spine: { gaps: [] },
    },
    coverage: COVERAGE,
    ...overrides,
  });
}

test("Timbale Terrace composes five reader-verb groups with confidence and coverage", () => {
  const result = evidence();
  assert.equal(result.project_ref, PROJECT_REF);
  assert.deepEqual(result.groups.map((group) => group.id), [
    "applicant", "parcels", "meetings", "decisions", "notices", "mih",
  ]);

  const applicant = result.groups.find((group) => group.id === "applicant");
  assert.equal(applicant.status, "matched");
  assert.equal(applicant.items[0].confidence, "tentative");
  assert.equal(applicant.coverage.eligible, 231);
  assert.equal(applicant.coverage.linked, 231);

  const parcels = result.groups.find((group) => group.id === "parcels");
  assert.deepEqual(parcels.items.map((item) => item.ref), ["bbl:1017670001", "bbl:1017670002"]);
  assert.equal(parcels.coverage.linked, 224);

  const meetings = result.groups.find((group) => group.id === "meetings");
  assert.equal(meetings.items[0].href, "#notice/20240101001");
  assert.equal(meetings.coverage.eligible, null);
  assert.equal(meetings.coverage.gap, "eligible_denominator_not_measured");

  const decisions = result.groups.find((group) => group.id === "decisions");
  assert.equal(decisions.coverage.scope, "fixed_completed_project_sample");
  assert.equal(decisions.coverage.rate, 0.9);
  assert.equal(decisions.documents.length, 1);

  const mih = result.groups.find((group) => group.id === "mih");
  assert.equal(mih.status, "not_observed");
  assert.equal(mih.gap, "no_exact_mih_edge_in_bounded_corpus");
});

test("MIH evidence uses exact project_id and keeps both source records", () => {
  const result = evidence({
    mihRows: [{
      project_id: PROJECT_ID,
      join: { confidence: "strong" },
      mih: { project_name: "MIH source name", status: "Adopted", mih_option: "Option 1", date_adopted: "2024-01-02" },
      zap: { project_name: "ZAP source name" },
    }],
  });
  const mih = result.groups.find((group) => group.id === "mih");
  assert.equal(mih.status, "matched");
  assert.equal(mih.items[0].confidence, "strong");
  assert.equal(mih.items[0].source_values.mih.project_name, "MIH source name");
  assert.equal(mih.items[0].source_values.zap.project_name, "ZAP source name");
});

test("exact project and BBL joins reject same-title and address-only candidates", () => {
  const result = evidence({
    projectRows: [{ ...PROJECT, project_id: "2025K0001" }],
    bblRows: [
      { project_id: "2025K0001", project_name: PROJECT.project_name, bbls: ["9999999999"] },
      { address: "101 East 118 Street", bbls: ["8888888888"] },
    ],
    outcome: { project_id: "2025K0001", dispositions: [], documents: [] },
  });
  assert.equal(result.status, "project_not_found");
  assert.equal(result.groups.find((group) => group.id === "parcels").items.length, 0);
  assert.ok(result.groups.every((group) => group.status !== "matched"));
});

test("missing meeting edges and decision documents remain explicit gaps", () => {
  const result = evidence({
    graphLinks: [],
    outcome: {
      project_id: PROJECT_ID,
      generated_at: "2026-08-05T17:00:00.000Z",
      dispositions: [],
      documents: [],
      city_record_notices: [],
      spine: { gaps: [{ slot: "city_record_notices", class: "not_published" }] },
    },
  });
  const meetings = result.groups.find((group) => group.id === "meetings");
  const decisions = result.groups.find((group) => group.id === "decisions");
  assert.equal(meetings.status, "not_observed");
  assert.equal(meetings.gap, "no_exact_meeting_edge_in_bounded_corpus");
  assert.equal(decisions.status, "not_observed");
  assert.equal(decisions.gap, "decision_documents_not_published");
});

test("response contract distinguishes complete, declared-unavailable, and incomplete 200s", () => {
  const available = { ok: true, record: { project_id: PROJECT_ID, project_connections: evidence() } };
  assert.equal(projectConnectionsPayloadState(available, PROJECT_ID), "available");

  const unavailable = {
    ok: true,
    sections: { project_connections: { schema_version: 1, status: "unavailable", reason: "read_model_unavailable" } },
    record: { project_id: PROJECT_ID },
  };
  assert.equal(projectConnectionsPayloadState(unavailable, PROJECT_ID), "unavailable");
  assert.equal(projectConnectionsPayloadState({ ok: true, record: { project_id: PROJECT_ID } }, PROJECT_ID), "incomplete");

  const normalized = normalizeProjectConnectionsPayload(
    { ok: true, record: { project_id: PROJECT_ID } },
    PROJECT_ID,
  );
  assert.equal(normalized.record.project_connections.status, "unavailable");
  assert.equal(normalized.record.project_connections.reason, "incomplete_response");
  assert.equal(normalized.sections.project_connections.status, "unavailable");
});

test("project scope links round-trip the typed project id and relation", () => {
  const result = evidence();
  const view = buildProjectConnectionView(result, { scope: CrolScope });
  const parcels = view.groups.find((group) => group.id === "parcels");
  const parsed = CrolScope.scopeFromRouteHash(parcels.view_all_href);
  assert.deepEqual(parsed.facets.domains, ["land"]);
  assert.deepEqual(parsed.facets.values.entity_refs_all, [PROJECT_REF]);
  assert.equal(parsed.facets.values.connection_relation, "sited_on_parcel");
  assert.equal(
    projectConnectionScopeHash(result, "parcels", { scope: CrolScope }),
    parcels.view_all_href,
  );
});

test("project pivot adds a third typed ref without changing the opened money lens", () => {
  const twoWayHref = vendorAgencyIntersectionHref(
    "vendor:stem:MAKE%20IT%20ZESTY",
    "Housing Preservation and Development",
  );
  const twoWayUrl = new URL(twoWayHref, "https://cityscroll.org");
  const composed = projectApplyScopeHash(
    evidence(),
    `#money${twoWayUrl.search}`,
    { scope: CrolScope },
  );
  const parsed = CrolScope.scopeFromRouteHash(composed);
  assert.deepEqual(parsed.facets.domains, ["money"]);
  assert.deepEqual(parsed.facets.values.entity_refs_all, [
    "agency:id:housing-preservation-and-development",
    "project:2022M0258",
    "vendor:stem:MAKE%20IT%20ZESTY",
  ]);
  assert.deepEqual(CrolScope.watchFromScope(parsed, { lens: "money" }).filter.entity_refs_all, parsed.facets.values.entity_refs_all);
});
