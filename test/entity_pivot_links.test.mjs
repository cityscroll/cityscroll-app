import assert from "node:assert/strict";
import test from "node:test";

import {
  ENTITY_PIVOT_SCHEMA,
  assertEntityPivotClosure,
  normalizeEntityPivot,
  normalizeEdgeSummaryRecord,
  renderEntityPivotLink,
} from "../site/edge_summary.mjs";

const source = (kind, id, name, canonical_href) => ({ kind, id, name, canonical_href });

test("accepted fixture pivots cover the civic sideways moves with typed accessible names", () => {
  const fixtures = [
    {
      relation_label: "top vendor by award value",
      target_kind: "vendor",
      target_id: "CAMBA",
      target_name: "CAMBA",
      canonical_href: "/vendors/CAMBA/",
      source: source("agency", "homeless-services", "Homeless Services", "/agencies/homeless-services/"),
    },
    {
      relation_label: "hosts meeting",
      target_kind: "meeting",
      target_id: "20260805001",
      target_name: "Public hearing on shelter services",
      canonical_href: "/notices/20260805001",
      source: source("agency", "homeless-services", "Homeless Services", "/agencies/homeless-services/"),
    },
    {
      relation_label: "related land-use project",
      target_kind: "project",
      target_id: "2022M0258",
      target_name: "Timbale Terrace",
      canonical_href: "#land/2022M0258",
      source: source("notice", "20260805001", "Shelter services hearing", "/notices/20260805001"),
    },
    {
      relation_label: "applicant agency",
      target_kind: "agency",
      target_id: "city-planning",
      target_name: "City Planning",
      canonical_href: "/agencies/city-planning/",
      source: source("project", "2022M0258", "Timbale Terrace", "#land/2022M0258"),
    },
    {
      relation_label: "expected public hearing",
      target_kind: "meeting",
      target_id: "20260805001",
      target_name: "Public hearing on shelter services",
      canonical_href: "/notices/20260805001?as_of=2026-08-11",
      source: source("mandate", "mandate-1", "Hold a public hearing", "/agencies/homeless-services/"),
      scope: { agency_id: "homeless-services", as_of: "2026-08-11" },
    },
  ];

  assertEntityPivotClosure(fixtures);
  for (const fixture of fixtures) {
    const pivot = normalizeEntityPivot(fixture);
    assert.equal(pivot.schema, ENTITY_PIVOT_SCHEMA);
    assert.equal(pivot.status, "accepted");
    assert.equal(pivot.relation_label, fixture.relation_label);
    assert.equal(pivot.target_kind, fixture.target_kind);
    assert.equal(pivot.target_id, fixture.target_id);
    assert.equal(pivot.target_name, fixture.target_name);
    assert.deepEqual(pivot.source, fixture.source);
    const html = renderEntityPivotLink(fixture);
    assert.match(html, /href=/);
    assert.match(html, new RegExp(`data-pivot-target-kind="${fixture.target_kind}"`));
    assert.match(html, new RegExp(`data-pivot-relation-label="${fixture.relation_label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, new RegExp(fixture.target_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /aria-label="[^"]+from/);
  }
});

test("edge-summary normalization reuses the pivot payload and preserves scoped destinations", () => {
  const record = normalizeEdgeSummaryRecord({
    source_kind: "agency",
    source_id: "parks-and-recreation",
    source_name: "Parks and Recreation",
    source_href: "/agencies/parks-and-recreation/",
    relation: "hosts_meeting",
    target_kind: "meeting",
    target_id: "20260805001",
    target_name: "Meetings and hearings",
    href: "/browse/meetings/?facet=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Aparks-and-recreation%22%5D%7D&as_of=2026-08-11",
    scope: { agency_id: "parks-and-recreation", as_of: "2026-08-11" },
    as_of: "2026-08-11",
  });
  assert.equal(record.relation_label, "related meetings and hearings");
  assert.equal(record.target_id, "20260805001");
  assert.equal(record.canonical_href, record.href);
  assert.deepEqual(record.source, source("agency", "parks-and-recreation", "Parks and Recreation", "/agencies/parks-and-recreation/"));
  assert.match(record.href, /as_of=2026-08-11/);
  assert.equal(record.scope.as_of, "2026-08-11");
});

test("unsupported destinations are held and the closure assertion fails instead of fabricating a URL", () => {
  const held = normalizeEntityPivot({
    relation_label: "committee membership",
    target_kind: "committee",
    target_id: "5261",
    target_name: "Subcommittee on Land Use",
    canonical_href: "/committees/5261/",
    source: source("official", "7801", "Member", "/officials/7801/"),
  });
  assert.equal(held.status, "held");
  assert.equal(held.canonical_href, null);
  const html = renderEntityPivotLink(held);
  assert.doesNotMatch(html, /href="\/committees\/5261\//);
  assert.match(html, /data-pivot-status="held"/);
  assert.match(html, /Provisional: destination not verified/);
  assert.throws(
    () => assertEntityPivotClosure([{ canonical_href: "/committees/5261/" }]),
    /route closure failed/,
  );
});
