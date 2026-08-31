import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadOntologyRegistry } from "../ontology/index.mjs";
import {
  CITED_AS_AUTHORITY_BY_RELATION,
  CITES_AUTHORITY_RELATION,
  publicCodeProvisionId,
} from "../ontology/code_provision.mjs";
import { renderAdminCodeProvisionDocument } from "../site/admin_code.mjs";
import {
  AUTHORITY_UNRESOLVED_REASONS,
  CITES_AUTHORITY_EXTRACTION_VERSION,
  CITES_AUTHORITY_METHOD,
  CITES_AUTHORITY_SCHEMA,
  POSSIBLE_AUTHORITY_BASIS_CHANGE_COPY,
  attachRulemakingAuthority,
  authorityCitedBy,
  projectRulemakingAuthority,
  renderProvisionAuthorityCitations,
  renderRulemakingAuthority,
} from "../site/rulemaking_authority.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import { projectCityRecordSearchObject } from "../site/city_record_search_producers.mjs";
import { edgeRequestKind } from "../site/pages_edge.mjs";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/rulemaking_authority.json", import.meta.url), "utf8"));

function project(name, extra = {}) {
  const caseRow = fixtures.cases[name];
  return projectRulemakingAuthority({
    rulemaking: fixtures.rulemaking,
    documents: caseRow.documents,
    provision: extra.provision === undefined ? fixtures.provision : extra.provision,
    versions: extra.versions === undefined ? fixtures.versions : extra.versions,
    changes: extra.changes || [],
    observed_at: extra.observed_at,
  });
}

test("ontology registers the cites_authority relation without collapsing objects", () => {
  const registry = loadOntologyRegistry();
  const provision = registry.object_types.find((row) => row.id === "code_provision");
  const rulemaking = registry.object_types.find((row) => row.id === "rulemaking");
  const link = registry.link_types.find((row) => row.id === "cites_authority");
  assert.equal(provision.status, "registered");
  assert.equal(rulemaking.status, "registered");
  assert.equal(link.status, "registered");
  assert.equal(link.from, "rulemaking");
  assert.equal(link.to, "code_provision");
  assert.equal(link.relation, CITES_AUTHORITY_RELATION);
  assert.equal(link.inverse, CITED_AS_AUTHORITY_BY_RELATION);
  assert.equal(link.edge_schema, CITES_AUTHORITY_SCHEMA);
  assert.equal(link.edge_schema, "cityscroll.cites_authority.v1");
  assert.match(link.negative_rule, /RCNY|generic authority|external statute/i);
});

test("exact Administrative Code authority links one existing provision", () => {
  const projection = project("exact_admin_code");
  assert.equal(projection.accepted_count, 1);
  assert.equal(projection.duplicated_objects, false);
  const [edge] = projection.edges;
  assert.equal(edge.status, "accepted");
  assert.equal(edge.schema, CITES_AUTHORITY_SCHEMA);
  assert.equal(edge.relation, CITES_AUTHORITY_RELATION);
  assert.equal(edge.inverse, CITED_AS_AUTHORITY_BY_RELATION);
  assert.equal(edge.from_ref, fixtures.rulemaking.rulemaking_id);
  assert.equal(edge.to_ref, "nyc-administrative-code:16-120");
  assert.equal(edge.provision_id, publicCodeProvisionId("16-120"));
  assert.equal(edge.citation, "§ 16-120");
  assert.equal(edge.corpus_id, "nyc-administrative-code");
  assert.equal(edge.href, "/administrative-code/16-120/");
  assert.equal(edge.source_document_id, "nyc_rules:dsny:receptacles:adopted");
  assert.equal(edge.source_record_id, "20260317099");
  assert.equal(edge.source_url, "https://rules.cityofnewyork.us/rule/receptacle-covers/");
  assert.ok(edge.source_fields.includes("document_text"));
  assert.equal(edge.observed_at, "2026-03-26T12:00:00.000Z");
  assert.equal(edge.extraction_method, CITES_AUTHORITY_METHOD);
  assert.equal(edge.extraction_version, CITES_AUTHORITY_EXTRACTION_VERSION);
  assert.equal(edge.duplicated_rulemaking, false);
  assert.equal(edge.duplicated_provision, false);
  assert.match(edge.source_span.text, /Administrative Code/);
  assert.equal(projection.unresolved.length, 0);
  assert.equal(projection.edges.filter((row) => row.provision_id === edge.provision_id).length, 1);
  const reciprocal = authorityCitedBy(edge.provision_id, [projection]);
  assert.equal(reciprocal.length, 1);
  assert.equal(reciprocal[0].relation, CITED_AS_AUTHORITY_BY_RELATION);
  assert.equal(reciprocal[0].from_ref, fixtures.rulemaking.rulemaking_id);
});

test("authority-at-publication uses the legally valid version on the rule date", () => {
  const projection = project("rule_date_version");
  const asOf = projection.edges[0].authority_at_publication;
  assert.equal(asOf.as_of, "2026-03-25");
  assert.equal(asOf.status, "current");
  assert.equal(asOf.text, "Receptacles must be kept covered at the time of publication.");
  assert.equal(asOf.used_publisher_current_text, false);
  assert.equal(asOf.clocks.valid_from, "2024-01-01");
  assert.equal(asOf.clocks.valid_to, "2026-11-01");
  assert.equal(asOf.clocks.observed_at, "2024-01-15T00:00:00.000Z");
  assert.notEqual(asOf.text, fixtures.provision.current_text);
  assert.notEqual(asOf.text, "Amended receptacles text after the rule was published.");
});

test("amended or repealed authority is a possible basis change only", () => {
  const amended = project("amended_authority", { changes: [fixtures.amend_change] });
  const repealed = project("repealed_authority", {
    versions: fixtures.repealed_versions,
    changes: [fixtures.repeal_change],
  });
  assert.equal(amended.edges[0].possible_basis_change.status, "possible");
  assert.equal(amended.edges[0].possible_basis_change.copy, POSSIBLE_AUTHORITY_BASIS_CHANGE_COPY);
  assert.deepEqual(amended.edges[0].possible_basis_change.later_operations, ["amend"]);
  assert.equal(repealed.edges[0].possible_basis_change.copy, POSSIBLE_AUTHORITY_BASIS_CHANGE_COPY);
  assert.match(amended.edges[0].possible_basis_change.copy, /not a new duty, deadline, power, or compliance result/);
  const html = renderRulemakingAuthority(amended);
  assert.match(html, /possible authority-basis change/);
  assert.match(html, /data-authority-basis-change="possible"/);
  assert.equal(html.includes("not a new duty, deadline, power, or compliance result"), true);
});

test("ambiguous, RCNY, external, malformed, missing, unsupported, and generic citations stay unresolved", () => {
  const cases = [
    ["ambiguous_citation", AUTHORITY_UNRESOLVED_REASONS.ambiguous_citation],
    ["rcny_citation", AUTHORITY_UNRESOLVED_REASONS.rcny_citation],
    ["external_statute", AUTHORITY_UNRESOLVED_REASONS.external_statute],
    ["malformed_section", AUTHORITY_UNRESOLVED_REASONS.malformed_section],
    ["missing_source_document", AUTHORITY_UNRESOLVED_REASONS.missing_source_document],
    ["unsupported_corpus", AUTHORITY_UNRESOLVED_REASONS.unsupported_corpus],
    ["generic_authority", AUTHORITY_UNRESOLVED_REASONS.generic_authority],
  ];
  for (const [name, reason] of cases) {
    const projection = project(name);
    assert.equal(projection.edges.length, 0, name);
    assert.ok(projection.unresolved.some((row) => row.unresolved_reason === reason), name);
    assert.equal(projection.unresolved.every((row) => row.linking === false), true, name);
    assert.equal(projection.unresolved.every((row) => row.to_ref === null), true, name);
  }
  const rcny = project("rcny_citation");
  assert.equal(rcny.unresolved.some((row) => row.corpus_id === "rcny"), true);
  assert.equal(rcny.unresolved.every((row) => row.corpus_id !== "nyc-administrative-code" || row.to_ref === null), true);
});

test("unresolved version keeps the citation and withholds historical comparison", () => {
  const projection = project("unresolved_version", { versions: [] });
  assert.equal(projection.edges.length, 1);
  assert.equal(projection.edges[0].status, "accepted");
  assert.equal(projection.edges[0].provision_id, "nyc-administrative-code:16-120");
  assert.equal(projection.edges[0].authority_at_publication.status, "unknown");
  assert.equal(projection.edges[0].authority_at_publication.text, null);
  assert.equal(projection.edges[0].unresolved_reason, AUTHORITY_UNRESOLVED_REASONS.unresolved_version);
  assert.match(projection.edges[0].authority_at_publication.reason, /known legal validity/);
});

test("rulemaking pages and provision pages keep existing objects and add reciprocal links", () => {
  const projection = project("exact_admin_code", { changes: [fixtures.amend_change] });
  const object = attachRulemakingAuthority({
    ...fixtures.rulemaking,
    versions: [],
    legal_effects: [],
    source_documents: [],
    notices: [],
    events: [],
    nyc_rules: { url: "https://rules.cityofnewyork.us/rule/receptacle-covers/" },
  }, {
    documents: fixtures.cases.exact_admin_code.documents,
    versions: fixtures.versions,
    changes: [fixtures.amend_change],
    provision: fixtures.provision,
  });
  assert.equal(object.schema, "cityscroll.rulemaking.v1");
  assert.equal(object.object_type, "rulemaking");
  assert.equal(object.authority.edges.length, 1);
  const html = renderRulemakingDocument(object);
  assert.match(html, /data-civic-object-kind="rulemaking"/);
  assert.match(html, /Statutory authority/);
  assert.match(html, /Administrative Code § 16-120/);
  assert.match(html, /\/administrative-code\/16-120\//);
  assert.match(html, /possible authority-basis change/);
  assert.doesNotMatch(html, /data-civic-object-kind="legal-code-provision"/);
  const cited = authorityCitedBy("16-120", [projection]);
  const provisionPage = renderAdminCodeProvisionDocument(fixtures.provision, {
    authority_citations: cited,
  });
  assert.match(provisionPage, /Cited as authority by/);
  assert.match(provisionPage, /rulemaking:dsny:receptacles/);
  assert.match(renderProvisionAuthorityCitations(cited), /data-rulemaking-id="rulemaking:dsny:receptacles"/);
});

test("existing rulemaking routes and Rules search projections stay on the rulemaking object", () => {
  const rows = [
    {
      request_id: "20260317026",
      agency: "DOT",
      title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks",
      notice_date: "2026-03-25",
      stage: "proposed",
      rulemaking_subject_ref: "rulemaking:dot:bicycle-racks",
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      nyc_rules: { url: "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/", title: "City-Owned Bicycle Racks" },
    },
    {
      request_id: "20260706041",
      agency: "DOT",
      title: "Notice of Adoption: City-Owned Bicycle Racks",
      notice_date: "2026-07-14",
      stage: "adopted",
      rulemaking_subject_ref: "rulemaking:dot:bicycle-racks",
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
    },
  ];
  const [object] = buildRulemakingObjects(rows, { now: "2026-08-20" });
  assert.equal(object.schema, "cityscroll.rulemaking.v1");
  assert.equal(object.object_type, "rulemaking");
  assert.equal(object.canonical_href, "/rules/rulemaking%3Adot%3Abicycle-racks/");
  assert.equal(edgeRequestKind("https://cityscroll.org/rules/rulemaking%3Adot%3Abicycle-racks"), "rulemaking");
  assert.equal(edgeRequestKind("https://cityscroll.org/administrative-code/16-120/"), "legal-code");
  const search = projectCityRecordSearchObject({
    request_id: "20260728026",
    title: "Agency Rules notice",
    section: "Agency Rules",
    notice_type: "Notice",
  }, {
    ruleIndex: new Map([["20260728026", {
      request_id: "20260728026",
      short_title: "Agency Rules notice",
      type_of_notice_description: "Notice",
      stage: "hearing",
    }]]),
  });
  assert.equal(search.object.object_type, "rulemaking");
  assert.equal(search.object.object_ref, "rulemaking:notice:20260728026");
  assert.notEqual(search.object.object_type, "code_provision");
});
