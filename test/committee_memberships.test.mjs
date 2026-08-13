import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCommitteeMembershipLookup } from "../site/committee_memberships_build.mjs";
import {
  committeeMembershipsForId,
  committeeReverseEdgesForId,
  renderCommitteeMembershipsHTML,
} from "../site/committee_memberships.mjs";

const people = JSON.parse(readFileSync(new URL("../site/data/people_domain_observations.json", import.meta.url)));

test("committee memberships join only exact member_id values", () => {
  const doc = buildCommitteeMembershipLookup([
    { member_id: "7801", full_name: "Christopher Marte", committee: "Land Use", appointment_type: "Member", id: "1" },
    { member_id: "7801", full_name: "Other Person", committee: "Budget", appointment_type: "Member", id: "2" },
    { member_id: "not-a-person", full_name: "Christopher Marte", committee: "Nope", id: "3" },
  ], people);
  assert.equal(doc.linked_row_count, 2);
  assert.equal(doc.linked_person_count, 1);
  assert.equal(doc.by_member_id["7801"].rows[1].provenance.name_conflict, true);
  assert.equal(committeeMembershipsForId(doc, "official:7801").length, 2);
  assert.equal(committeeMembershipsForId(doc, "7801")[0].provenance.join_key, "member_id");
});

test("committee membership panel shows populated rows and omits gap and methodology copy", () => {
  const html = renderCommitteeMembershipsHTML({
    rows: [{ committee: "Land Use", appointment_type: "Member", start_date: "2024-01-01", end_date: "2025-12-31" }],
    coverage: { eligible_rows: 5358, linked_rows: 308, row_rate: 0.0575 },
    vintage: "2026-08-05",
  }, { translate: (key, values = {}) => `${key}:${JSON.stringify(values)}`, escapeHtml: (value) => String(value) });
  assert.match(html, /data-membership-status="linked"/);
  assert.match(html, /Land Use/);
  assert.doesNotMatch(html, /coverage|cohort|source|vintage|5358|308|5\.8%/i);
  assert.equal(renderCommitteeMembershipsHTML({ rows: [] }), "");
});

test("committee reverse coverage is exact-key and visibly unavailable when the graph has no edge", () => {
  const graph = {
    publication: "published",
    public_reverse_edges: [{ type: "has_member", to: "official:7801", from: "committee:5261" }],
  };
  assert.equal(committeeReverseEdgesForId(graph, "official:7801").length, 1);
  assert.equal(committeeReverseEdgesForId(graph, "official:9999").length, 0);
  assert.equal(committeeReverseEdgesForId({ publication: "held" }, "official:7801").length, 0);
  const html = renderCommitteeMembershipsHTML({
    member_id: "7801",
    person_name: "Christopher Marte",
    rows: [{ committee_id: "5261", committee: "Land Use", appointment_type: "Member" }],
    reverse_edges: [],
  });
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /Reverse coverage unavailable/);
});
