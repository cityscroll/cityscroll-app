import assert from "node:assert/strict";
import test from "node:test";

import {
  EDGE_SUMMARY_SCHEMA,
  normalizeEdgeSummaryRecord,
  rankEdgeSummaryRecords,
  renderEdgeSummaryProvenance,
  renderEdgeSummaryRail,
} from "../site/edge_summary.mjs";
import { renderEdgeProvenanceInspector } from "../site/graph_edge_provenance.mjs";
import { buildAgencyEdgeSummary } from "../site/agency_constellation_model.mjs";
import { buildBrowseEdgeSummary, buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { renderVendorFootprintHTML } from "../site/vendor_footprint.mjs";

test("normalizes one typed edge without turning null into zero", () => {
  const record = normalizeEdgeSummaryRecord({
    source_kind: "agency",
    source_id: null,
    edge_type: "published_by_agency",
    label: "Contracts: published by this agency",
    target_kind: "contract",
    target_name: "Contracts",
    count: null,
    state: "unknown",
    href: "/browse/contracts/",
    scope: { facet: "contracts", mode: "open" },
    as_of: "2026-08-11",
  });

  assert.equal(record.schema, EDGE_SUMMARY_SCHEMA);
  assert.equal(record.source_id, null);
  assert.equal(record.count, null);
  assert.equal(record.state, "unknown");
  assert.equal(record.href, "/browse/contracts/?as_of=2026-08-11");
  assert.deepEqual(record.scope, { facet: "contracts", mode: "open" });
});

test("preserves null provenance and treats ingestion gaps as unknown", () => {
  const record = normalizeEdgeSummaryRecord({
    source: null,
    status: "not_yet_ingested",
    count: 0,
    href: null,
    target_kind: "rule",
    target_name: "Rules",
  });
  assert.equal(record.source, null);
  assert.equal(record.href, null);
  assert.equal(record.count, 0);
  assert.equal(record.state, "unknown");
});

test("ranking reorders by signal without hiding any supported family", () => {
  const ranked = rankEdgeSummaryRecords([
    { edge_type: "issued_rule", target_kind: "rule", target_name: "Rules", state: "empty", count: 0 },
    { edge_type: "hosts_meeting", target_kind: "meeting", target_name: "Meetings", state: "matched", count: 1, cross_spine: { confidence: "confirmed" } },
    { edge_type: "published_by_agency", target_kind: "contract", target_name: "Contracts", state: "matched", count: 8 },
    { edge_type: "certified_to_agency", target_kind: "exam", target_name: "Exams", state: "unknown", count: null },
  ]);
  assert.deepEqual(ranked.map((record) => record.target_kind), ["meeting", "contract", "rule", "exam"]);
  assert.equal(ranked.length, 4);
  assert.equal(new Set(ranked.map((record) => record.target_kind)).size, 4);
});

test("empty and unknown states render as explicit states, never asserted zeroes", () => {
  const html = renderEdgeSummaryRail([
    {
      source_kind: "agency",
      source_id: "parks-and-recreation",
      edge_type: "issued_rule",
      label: "Rules: issued rules",
      target_kind: "rule",
      target_name: "Rules",
      count: 0,
      state: "empty",
      href: "/browse/rules/?agency=parks-and-recreation",
    },
    {
      source_kind: "vendor",
      source_id: "vendor:stem:EXAMPLE",
      edge_type: "linked_to_vendor",
      label: "Meetings: related meetings",
      target_kind: "meeting",
      target_name: "Meetings",
      count: null,
      state: "unknown",
      href: null,
    },
  ]);

  assert.match(html, /data-edge-state="empty"/);
  assert.match(html, /No rules linked yet/);
  assert.match(html, /data-edge-state="unknown"/);
  assert.match(html, /Availability is not known yet/);
  assert.match(html, /data-edge-availability="empty-in-scope"/);
  assert.match(html, /data-edge-availability="unknown-unindexed"/);
  assert.match(html, /aria-label="issued rules; No rules linked yet"/);
  assert.doesNotMatch(html, /Empty in this scoped materialization|current materialization|none in this materialization/i);
  assert.match(html, /aria-label="related meetings; Availability is not known yet"/);
  assert.doesNotMatch(html, /scope:|universe:|entity ref:/);
  assert.doesNotMatch(html, /<a class="edge-summary-link"/);
});

test("matched edges link with typed accessible metadata while names never mint routes", () => {
  const html = renderEdgeSummaryRail([
    {
      source_kind: "agency",
      source_id: "parks-and-recreation",
      edge_type: "hosts_meeting",
      relation_label: "related meetings and hearings",
      target_kind: "meeting",
      target_id: "20260805001",
      target_name: "Public hearing",
      href: "/notices/20260805001",
      count: 1,
      state: "matched",
      scope: { facet: "meetings", entity_ref: "agency:id:parks-and-recreation" },
      as_of: "2026-08-11",
    },
    {
      source_kind: "agency",
      source_id: "parks-and-recreation",
      edge_type: "related_committee",
      relation_label: "related committees",
      target_kind: "committee",
      target_id: "5261",
      target_name: "Land Use Committee",
      count: 2,
      state: "matched",
      scope: { facet: "meetings", entity_ref: "agency:id:parks-and-recreation" },
      as_of: "2026-08-11",
    },
  ]);

  assert.match(html, /<a class="edge-summary-link" href="\/notices\/20260805001\?as_of=2026-08-11"/);
  assert.match(html, /aria-label="related meetings and hearings; Available: 1 record"/);
  assert.match(html, /as of 2026-08-11/);
  assert.doesNotMatch(html, /scope:|universe:|entity ref:/);
  assert.doesNotMatch(html, /href="[^"]*5261/);
  assert.match(html, /data-edge-state="matched"/);
});

test("agency category totals produce the same typed records used by the rail", () => {
  const records = buildAgencyEdgeSummary({
    canonical_id: "parks-and-recreation",
    categories: [
      {
        id: "contracts",
        label: "Contracts",
        relation: "published_by_agency",
        status: "matched",
        count: 6,
        browse_facet: "contracts",
        universe: "open",
        view_all_href: "/browse/contracts/?facet=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Aparks-and-recreation%22%5D%7D&mode=open",
        as_of: "2026-08-11",
      },
      {
        id: "rules",
        label: "Rules",
        relation: "issued_rule",
        status: "empty",
        count: 0,
        browse_facet: "rules",
      },
      {
        id: "staffing",
        label: "Staffing exams",
        relation: "certified_to_agency",
        status: "not_yet_ingested",
        count: 0,
        browse_facet: "staffing",
      },
    ],
  });

  assert.deepEqual(records.map((record) => [record.target_kind, record.count, record.state]), [
    ["contract", 6, "matched"],
    ["rule", 0, "empty"],
    ["exam", null, "unknown"],
  ]);
  assert.match(records[0].href, /mode=open/);
  assert.match(records[0].href, /as_of=2026-08-11/);
  assert.equal(records[2].source_id, "parks-and-recreation");
});

test("Browse intersections expose the same typed edge contract", () => {
  const view = buildBrowseView("contracts", {
    open_as_of: "2026-08-11",
    notices: [
      {
        request_id: "edge-contract-1",
        short_title: "A scoped solicitation",
        agency_name: "Parks and Recreation",
        entity_refs_all: ["agency:id:parks-and-recreation", "vendor:stem:EXAMPLE"],
        due_date: "2026-09-01",
      },
    ],
  }, new URLSearchParams("facet=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Aparks-and-recreation%22%5D%7D"));
  const records = buildBrowseEdgeSummary(view);
  assert.ok(records.length >= 1);
  const vendor = records.find((record) => record.target_kind === "vendor");
  assert.ok(vendor);
  assert.equal(vendor.count, 1);
  assert.equal(vendor.target_id, "stem:EXAMPLE");
  assert.match(vendor.href, /\/vendors\/EXAMPLE\//);
  const html = renderBrowseView(view);
  assert.match(html, /edge-summary-rail/);
  assert.match(html, /Related records/);
});

test("vendor footprint consumes the shared renderer and retains unknown denominators", () => {
  const html = renderVendorFootprintHTML({
    root: { kind: "vendor", ref: "vendor:stem:EXAMPLE", display_name: "Example Vendor", stem: "EXAMPLE" },
    vendor_footprint: {
      qualifier_required: true,
      summary: {
        section_denominators: {
          payments: { status: "unknown", rows: null },
        },
      },
      section_counts: {},
    },
    domains: {
      money: { objects: [{ confidence: "strong", object_kind: "award", label: "Award" }] },
    },
  });
  assert.match(html, /data-edge-summary-schema="cityscroll\.edge_summary\.v1"/);
  assert.match(html, /Vendor connections/);
  assert.doesNotMatch(html, /Payments[^<]*0/);
});

test("edge summaries disclose cross-spine review without linking or filling null evidence", () => {
  const record = normalizeEdgeSummaryRecord({
    edge_type: "related_committee",
    relation_label: "related committees",
    target_kind: "committee",
    target_name: "Land Use Committee",
    count: 1,
    state: "matched",
    href: "/browse/meetings/",
    cross_spine: { confidence: "review" },
    provenance: {
      source_system: "legistar",
      source_record_id: null,
      source_fields: null,
      basis: "committee_id",
      observed_at: null,
    },
  });
  const html = renderEdgeSummaryRail([record]);
  assert.equal(record.provenance.source_record_id, null);
  assert.equal(record.provenance.source_fields, null);
  assert.equal(record.cross_spine_confidence, "review");
  assert.doesNotMatch(html, /<a class="edge-summary-link"/);
  assert.doesNotMatch(html, /data-edge-provenance="1"/);
  assert.match(html, /data-cross-spine-confidence="review"/);
  assert.match(html, /edge-summary-confidence-review"[^>]*>Needs review</);
  assert.doesNotMatch(html, /Unavailable|compare evidence|does not choose a winner or merge identities/);
  assert.match(renderEdgeSummaryProvenance(record), /<dt>Source<\/dt><dd>NYC Council Legistar<\/dd>/);
  assert.doesNotMatch(renderEdgeSummaryProvenance(record), /Source record|Source fields/);
});

test("shared reader labels humanize raw relations and omit debug provenance by default", () => {
  const record = normalizeEdgeSummaryRecord({
    edge_type: "votes_on",
    relation_label: "votes_on",
    target_kind: "notice",
    target_name: "Public notice",
    count: 1,
    state: "matched",
    href: "/notices/20260101001",
    provenance: {
      source_system: "Unavailable",
      source_record_id: "Unavailable",
      source_fields: ["boro_cd", "coundist"],
      join_method: "Unavailable",
    },
  });

  assert.equal(record.relation_label, "voted on");
  assert.equal(record.provenance.source_system, null);
  assert.equal(record.provenance.source_fields.join(", "), "boro_cd, coundist");
  const html = renderEdgeSummaryRail([record]);
  assert.match(html, /voted on/);
  assert.doesNotMatch(html, /Unavailable|boro_cd|coundist|edge-summary-provenance|compare evidence/);
  assert.match(renderEdgeSummaryProvenance(record), /borough and community district/);
  assert.match(renderEdgeSummaryProvenance(record), /Council District/);
  assert.match(renderEdgeSummaryProvenance(record), /Technical details/);
});

test("connection evidence is readable, finite, and keeps raw provenance opt-in", () => {
  const html = renderEdgeProvenanceInspector({
    claim_id: "staffing:exam:7002",
    label: "Administrative Housing Development Specialist",
    relation: "certified_to_agency",
    object_href: "/exams/7002/",
    how: {
      method: { available: true, value: "publisher_certification_record_v1" },
      warrant_class: "exact",
    },
    where: {
      source_system: { available: true, value: "socrata" },
      source_record_id: { available: true, value: "a9md-ynri:exam:7002:agency:816" },
      source_fields: { available: true, value: ["exam_no", "list_agency_code"] },
      observed_at: { available: true, value: "2026-08-06" },
    },
    cross_spine: { confidence: "unmatched", explicit: false },
    share_href: "/agencies/health-and-mental-hygiene/?claim=staffing%3Aexam%3A7002",
  }, { open: true });

  assert.doesNotMatch(html, /NaN|Exact match|Evidence details|Join method|Share this claim|>unmatched</);
  assert.match(html, /Matched by a published record/);
  assert.match(html, /Matched using the agency code in the published staffing record/);
  assert.match(html, /NYC Open Data/);
  assert.match(html, /Technical details/);
  assert.match(html, /a9md-ynri:exam:7002:agency:816/);
});
