import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOfficialLocalConstellation,
  buildLocalConstellation,
  LOCAL_CONSTELLATION_MAX_NODES,
  renderLocalConstellationHTML,
} from "../site/local_constellation.mjs";
import {
  filterNoticeConstellationNeighbors,
  representedNoticeRelationships,
} from "../site/notice_reader_presentation.mjs";
import { buildCommitteeLocalConstellation } from "../site/committee_memberships.mjs";
import { buildPlaceLocalConstellation } from "../site/community_board_geography.mjs";
import { renderEdgeNotice } from "../site/pages_edge.mjs";
import procurementProjectContextMaterialization from "../site/data/procurement_project_context.json" with { type: "json" };
import { withPinnedClock } from "./helpers/test_clock.mjs";

const kinds = ["official", "committee", "vendor", "agency", "community-board", "place", "record"];
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));
const boundaries = JSON.parse(readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url)));
const constellationStyles = readFileSync(new URL("../site/local_constellation.css", import.meta.url), "utf8");
const mandateBacklinksLookup = JSON.parse(readFileSync(
  new URL("../site/data/notice_mandate_backlinks_lookup.json", import.meta.url),
  "utf8",
));

test("local constellation registry covers the Browse object kinds", () => {
  for (const kind of kinds) {
    const view = buildLocalConstellation({ kind, subject_ref: `${kind}:1`, source: null, neighbors: [] });
    assert.equal(view.kind, kind);
    assert.equal(view.status, "empty");
    assert.equal(view.source, null);
    const html = renderLocalConstellationHTML(view);
    assert.equal(html, "");
    assert.doesNotMatch(html, /materialization|published neighbors/);
  }
});

test("place empty state stays off the reader surface", () => {
  const view = buildLocalConstellation({ kind: "place", subject_ref: "community-district:M03", neighbors: [] });
  const html = renderLocalConstellationHTML(view);
  assert.equal(html, "");
});

test("local constellation is bounded, list-equivalent, and never invents a destination", () => {
  const neighbors = Array.from({ length: LOCAL_CONSTELLATION_MAX_NODES + 3 }, (_, index) => ({
    edge_type: "related_record",
    target_kind: "record",
    target_id: `notice-${index}`,
    target_name: `Record ${index}`,
    href: `/notices/${index}`,
    state: "matched",
  }));
  neighbors.push({
    edge_type: "related_record",
    target_kind: "record",
    target_id: "held",
    target_name: "Held record",
    href: "/made-up-route/held",
    state: "matched",
  });
  const view = buildLocalConstellation({ kind: "record", subject_ref: "notice:root", source: null, neighbors });
  assert.equal(view.nodes.length, LOCAL_CONSTELLATION_MAX_NODES);
  assert.equal(view.omitted_count, 4);
  assert.equal(view.nodes.every((node) => node.href), true);
  const html = renderLocalConstellationHTML(view);
  assert.equal((html.match(/class="local-constellation-list-item"/g) || []).length, view.nodes.length);
  assert.match(html, /aria-label="Record 0, related record"/);
  assert.doesNotMatch(html, /local-constellation-lines|local-constellation-center|local-constellation-dots/);
  assert.doesNotMatch(html, /made-up-route/);
});

test("committee and place adapters use only published exact-key neighbors", () => {
  const committee = buildCommitteeLocalConstellation({
    publication: "published",
    nodes: [{ id: "committee:12", type: "committee", name: "Landmarks" }],
    public_edges: [{
      type: "member_of", from: "official:7801", to: "committee:12",
      provenance: { source: { system: "legistar" } },
    }],
  }, "committee:12", { by_person_id: { "7801": { person_name: "A Member" } } });
  assert.equal(committee.nodes[0].target_kind, "official");
  assert.equal(committee.nodes[0].href, "/officials/7801/");

  const place = buildPlaceLocalConstellation({
    gate: { publication_allowed: true },
    nodes: [
      { id: "community-district:X01", type: "community-district", name: "X01" },
      { id: "council-district:8", type: "council-district", name: "Council 8" },
    ],
    public_edges: [{ type: "intersects", from: "community-district:X01", to: "council-district:8" }],
  }, "community-district:X01");
  assert.equal(place.nodes[0].target_kind, "council-district");
  assert.equal(place.nodes[0].href, "/near-you/?v=0&lens=meetings&council=8");
  assert.doesNotMatch(renderLocalConstellationHTML(place), /data-local-constellation-preview/);

  const held = buildPlaceLocalConstellation({
    gate: { publication_allowed: false },
    nodes: [{ id: "community-district:X01", type: "community-district", name: "X01" }],
    public_edges: [{ type: "intersects", from: "community-district:X01", to: "council-district:8" }],
  }, "community-district:X01");
  assert.equal(held.status, "unknown");
  const heldHtml = renderLocalConstellationHTML(held);
  assert.equal(heldHtml, "");
  assert.doesNotMatch(heldHtml, /data-local-constellation-preview/);
});

test("missing published place endpoints do not render a relationship or diagnostic row", () => {
  const view = buildPlaceLocalConstellation({
    gate: { publication_allowed: true },
    nodes: [{ id: "community-district:K15", type: "community-district", name: "K15" }],
    public_edges: [{ type: "intersects", from: "community-district:K15", to: "council-district:43" }],
  }, "community-district:K15");
  assert.equal(view.nodes.length, 0);
  assert.equal(renderLocalConstellationHTML(view), "");
});

test("notice local connections omit agency and vendor roles already shown as primary facts", () => {
  const represented = representedNoticeRelationships({
    agency: { id: "dhs", name: "Homeless Services" },
    vendor: { id: "BHRAGS Operating LLC", name: "BHRAGS Operating LLC" },
  });
  const neighbors = filterNoticeConstellationNeighbors([
    {
      edge_type: "published_by_agency",
      target_kind: "agency",
      target_id: "dhs",
      target_name: "Homeless Services",
      href: "/agencies/dhs/",
      state: "matched",
    },
    {
      edge_type: "named_vendor",
      target_kind: "vendor",
      target_id: "BHRAGS Operating LLC",
      target_name: "BHRAGS Operating LLC",
      href: "/vendors/bhrags-operating-llc/",
      state: "matched",
    },
    {
      edge_type: "related_record",
      target_kind: "record",
      target_id: "20240829199",
      target_name: "Related hearing",
      href: "/notices/20240829199",
      state: "matched",
    },
  ], represented);
  const view = buildLocalConstellation({
    kind: "record",
    subject_ref: "notice:20240829105",
    subject_id: "20240829105",
    subject_name: "City Sanctuary Facility",
    neighbors,
  });
  assert.equal(view.nodes.length, 1);
  assert.equal(view.nodes[0].target_id, "20240829199");
  const html = renderLocalConstellationHTML(view, {
    heading: "Nearby record connections",
    id: "notice-local-constellation-heading",
  });
  assert.doesNotMatch(html, /Homeless Services|BHRAGS Operating LLC/);
  assert.match(html, /Related hearing/);
});

test("A8: existing project-context and mandate examples remain positive controls", async () => {
  await withPinnedClock("2026-09-16T12:00:00.000Z", async () => {
    const museumHtml = renderEdgeNotice({
      request_id: "20260810048",
      short_title: "ACEDCA215 Brooklyn Childrens Museum HVAC Upgrade",
      type_of_notice_description: "Solicitation",
      agency_name: "Department of Design and Construction",
      vendor_name: "Museum HVAC Vendor",
      pin: "85026B0110",
      additional_description_1: "The notice body publishes PIN 85026B01107.",
      start_date: "2026-08-10",
    }, "20260810048", null, null, {
      projectContextMaterialization: procurementProjectContextMaterialization,
    });

    assert.match(museumHtml, /data-notice-tools-region="1"/);
    assert.doesNotMatch(museumHtml, /data-notice-tools-region="1"[^>]*\sopen/);
    assert.match(museumHtml, /data-notice-enrichment-region="project-context"/);
    assert.match(museumHtml, /data-project-context="1"/);
    assert.match(museumHtml, /data-project-context-notice-id="20260810048"/);
    assert.match(museumHtml, /ACEDCA215/);
    assert.match(museumHtml, /The wider project/);
    assert.doesNotMatch(museumHtml, /notice-local-constellation-heading/);

    const mandateRows = mandateBacklinksLookup.by_notice?.["20210820102"];
    assert.ok(Array.isArray(mandateRows) && mandateRows.length >= 1, "retained mandate example must exist");
    const mandateId = mandateRows[0].mandate_id;
    assert.ok(mandateId, "retained mandate example must carry a bare mandate id");

    const mandateHtml = renderEdgeNotice({
      request_id: "20210820102",
      short_title: "Shelter renewal",
      agency_name: "Homeless Services",
      vendor_name: "Shelter Operations Vendor",
      type_of_notice_description: "Award",
      section_name: "Procurement",
      start_date: "2021-08-20",
    }, "20210820102", null, {
      schema: mandateBacklinksLookup.schema,
      method: mandateBacklinksLookup.method,
      by_notice: { "20210820102": mandateRows },
    });

    assert.match(mandateHtml, /data-notice-tools-region="1"/);
    assert.doesNotMatch(mandateHtml, /data-notice-tools-region="1"[^>]*\sopen/);
    assert.match(mandateHtml, /data-notice-enrichment-region="mandate-backlinks"/);
    assert.match(mandateHtml, /data-connected-mandate="1"/);
    assert.match(mandateHtml, /Connected mandate/);
    assert.match(mandateHtml, new RegExp(`data-mandate-id="${mandateId}"`));
    assert.match(mandateHtml, new RegExp(`href="/mandates/${mandateId}"`));
    assert.doesNotMatch(mandateHtml, /notice-local-constellation-heading/);
  });
});

test("official local connections omit duplicate committees and retain only linked meeting records", () => {
  const view = buildOfficialLocalConstellation({
    official: { ref: "entity:official:7801" },
    events: [
      { event_id: "event-1", notice_id: "20260801001", event_date: "2026-08-01" },
      { event_id: "event-without-notice", notice_id: null, event_date: "2026-08-02" },
    ],
  }, [{ committee_id: "committee:5261", committee: "Land Use", href: "/committees/5261/" }], "7801", "A Member");
  assert.equal(view.nodes.length, 1);
  assert.equal(view.nodes[0].target_kind, "meeting");
  assert.equal(view.nodes[0].href, "/notices/20260801001");
  assert.equal(view.nodes[0].node_name, "Meeting notice · 2026-08-01");
  assert.ok(view.nodes.every((node) => node.target_kind !== "committee"));
  assert.ok(view.nodes.every((node) => node.href));
});

test("published place connections use district polygons and resident-safe copy", () => {
  const view = buildPlaceLocalConstellation(geography, "community-district:K15", boundaries);
  assert.equal(view.map.schema, "cityscroll.local_district_map.v1");
  assert.equal(view.map.features.find((feature) => feature.role === "central")?.id, "K15");
  assert.equal(view.map.features.at(-1)?.role, "central");
  assert.ok(view.map.features.some((feature) => feature.id === "43" && feature.role === "adjacent"));
  assert.ok(view.map.features.every((feature) => feature.path.startsWith("M")));

  const html = renderLocalConstellationHTML(view);
  assert.match(html, /local-district-map-central/);
  assert.match(html, /local-district-map-adjacent/);
  assert.match(html, /This community district overlaps City Council District 43\./);
  assert.doesNotMatch(html, /Why this connection|unmatched|Unavailable|Source fields|the_geom|coundist|compares claims/);
});

test("local district labels use contrast-aware edge treatments", () => {
  assert.match(
    constellationStyles,
    /\.local-district-map-label-central\{[^}]*fill:var\(--color-surface,[^}]*stroke:var\(--color-text,/,
  );
  assert.match(
    constellationStyles,
    /\.local-district-map-label-adjacent\{[^}]*fill:var\(--color-text,[^}]*\}/,
  );
  assert.doesNotMatch(constellationStyles, /local-constellation-lines|local-constellation-center|local-constellation-dots|local-constellation-preview/);
});
