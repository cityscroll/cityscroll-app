import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalConstellation,
  LOCAL_CONSTELLATION_MAX_NODES,
  renderLocalConstellationHTML,
} from "../site/local_constellation.mjs";
import { buildCommitteeLocalConstellation } from "../site/committee_memberships.mjs";
import { buildPlaceLocalConstellation } from "../site/community_board_geography.mjs";

const kinds = ["official", "committee", "vendor", "agency", "place", "record"];

test("local constellation registry covers the six Browse object kinds", () => {
  for (const kind of kinds) {
    const view = buildLocalConstellation({ kind, subject_ref: `${kind}:1`, source: null, neighbors: [] });
    assert.equal(view.kind, kind);
    assert.equal(view.status, "empty");
    assert.equal(view.source, null);
    const html = renderLocalConstellationHTML(view);
    assert.match(html, /data-local-constellation-status="empty"/);
    assert.match(html, /Empty in this scoped materialization/);
  }
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

  const held = buildPlaceLocalConstellation({
    gate: { publication_allowed: false },
    nodes: [{ id: "community-district:X01", type: "community-district", name: "X01" }],
    public_edges: [{ type: "intersects", from: "community-district:X01", to: "council-district:8" }],
  }, "community-district:X01");
  assert.equal(held.status, "unknown");
  assert.match(renderLocalConstellationHTML(held), /Unknown \/ not indexed/);
});
