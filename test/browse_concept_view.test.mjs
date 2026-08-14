import assert from "node:assert/strict";
import test from "node:test";

import { buildBrowseConceptLanding, renderBrowseConceptLanding } from "../site/browse_concept_view.mjs";

const geography = {
  nodes: [{
    id: "community-board:bronx-cb-01",
    type: "community-board",
    name: "Bronx Community Board 1",
    properties: {
      body_id: "bronx-cb-01",
      borough: "Bronx",
      district: 1,
      identity: {
        projections: {
          organization: {
            relation_families: [
              { type: "has_member", label: "Members", state: "unknown" },
              { type: "member_of", label: "Board roles", state: "unknown" },
              { type: "hosts_meeting", label: "Hosted meetings", state: "unknown" },
              { type: "issues_recommendation", label: "Recommendations", state: "unknown" },
            ],
          },
        },
      },
    },
  }],
  public_edges: [{
    type: "covers",
    from: "community-board:bronx-cb-01",
    to: "community-district:X01",
  }],
};

test("People + organizations exposes a board institution projection", () => {
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", { places: geography }));
  assert.match(html, /data-board-projection="organization"/);
  assert.match(html, /data-body-id="bronx-cb-01"/);
  assert.match(html, /href="\/community-boards\/bronx-cb-01\/"/);
  assert.match(html, /Covers Bronx Community District X01\./);
  assert.match(html, /Board identity · Published/);
  assert.match(html, /District coverage · Published/);
  assert.match(html, /Members · Unknown/);
  assert.match(html, /Hosted meetings · Unknown/);
  assert.match(html, /Recommendations · Unknown/);
  assert.doesNotMatch(html, /matter_title_place|venue_line|boro_cd|Source: Unavailable|Join method: Unavailable/);
});

test("Places delegates board place discovery to Near you without a duplicate board list", () => {
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("places", { places: geography }));
  assert.match(html, /Open Near you for place discovery/);
  assert.match(html, /href="\/near-you\/"/);
  assert.doesNotMatch(html, /Bronx Community Board 1/);
  assert.doesNotMatch(html, /Community District X01/);
  assert.match(html, /href="\/community-boards\/"/);
});
