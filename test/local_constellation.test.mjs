import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLocalConstellation,
  LOCAL_CONSTELLATION_MAX_NODES,
  renderLocalConstellationHTML,
} from "../site/local_constellation.mjs";
import { buildCommitteeLocalConstellation } from "../site/committee_memberships.mjs";
import { buildPlaceLocalConstellation } from "../site/community_board_geography.mjs";

const kinds = ["official", "committee", "vendor", "agency", "community-board", "place", "record"];
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));
const boundaries = JSON.parse(readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url)));
const constellationStyles = readFileSync(new URL("../site/local_constellation.css", import.meta.url), "utf8");

test("local constellation registry covers the Browse object kinds", () => {
  for (const kind of kinds) {
    const view = buildLocalConstellation({ kind, subject_ref: `${kind}:1`, source: null, neighbors: [] });
    assert.equal(view.kind, kind);
    assert.equal(view.status, "empty");
    assert.equal(view.source, null);
    const html = renderLocalConstellationHTML(view);
    assert.match(html, /data-local-constellation-status="empty"/);
    assert.doesNotMatch(html, /materialization|published neighbors/);
  }
});

test("place empty state explains the connection without a fabricated example", () => {
  const view = buildLocalConstellation({ kind: "place", subject_ref: "community-district:M03", neighbors: [] });
  const html = renderLocalConstellationHTML(view);
  assert.match(html, /Nearby place records link this district to civic areas\./);
  assert.match(html, /See its community board and the City Council districts that overlap it\./);
  assert.doesNotMatch(html, /local-constellation-preview|Example preview|A place link can look like this\./);
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
  assert.equal(place.nodes[0].href, "/near-you/?council=8");
  assert.doesNotMatch(renderLocalConstellationHTML(place), /data-local-constellation-preview/);

  const held = buildPlaceLocalConstellation({
    gate: { publication_allowed: false },
    nodes: [{ id: "community-district:X01", type: "community-district", name: "X01" }],
    public_edges: [{ type: "intersects", from: "community-district:X01", to: "council-district:8" }],
  }, "community-district:X01");
  assert.equal(held.status, "unknown");
  const heldHtml = renderLocalConstellationHTML(held);
  assert.match(heldHtml, /Place connections for this district are not published yet\./);
  assert.doesNotMatch(heldHtml, /data-local-constellation-preview/);
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
