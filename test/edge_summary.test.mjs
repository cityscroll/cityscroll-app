import assert from "node:assert/strict";
import test from "node:test";

import {
  EDGE_SUMMARY_SCHEMA,
  normalizeEdgeSummaryRecord,
  renderEdgeSummaryRail,
} from "../site/edge_summary.mjs";
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
  assert.match(html, /Empty in this scoped materialization/);
  assert.match(html, /data-edge-state="unknown"/);
  assert.match(html, /Unknown \/ not indexed/);
  assert.match(html, /data-edge-availability="empty-in-scope"/);
  assert.match(html, /data-edge-availability="unknown-unindexed"/);
  assert.match(html, /aria-label="issued rules; target kind: rule; count: Empty in this scoped materialization; scope: not specified; as of: unavailable"/);
  assert.match(html, /aria-label="related meetings; target kind: meeting; count: Unknown \/ not indexed; scope: not specified; as of: unavailable"/);
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
  assert.match(html, /aria-label="related meetings and hearings; target kind: meeting; count: Available: 1 record; scope: facet: meetings, entity ref: agency:id:parks-and-recreation; as of: 2026-08-11"/);
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
