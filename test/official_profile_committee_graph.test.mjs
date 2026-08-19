import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOfficialCommitteeView } from "../site/official_connections.mjs";
import {
  committeeReverseEdgesForId,
  committeeRowsFromGraph,
  renderCommitteeMembershipsHTML,
  renderOfficialLocalConstellationHTML,
} from "../site/committee_memberships.mjs";

const graph = JSON.parse(readFileSync(new URL("../site/data/committee_graph_lookup.json", import.meta.url)));
const legacyLookup = JSON.parse(readFileSync(new URL("../site/data/official_committee_memberships_lookup.json", import.meta.url)));

test("official profiles render exact graph member_of edges when the legacy lookup is sparse", () => {
  const person = { person_id: "5259", person_name: "Gale A. Brewer" };
  const committeeView = buildOfficialCommitteeView(person, graph);
  const rows = committeeRowsFromGraph(graph, committeeView);
  const reverseEdges = committeeReverseEdgesForId(graph, person.person_id);
  const bag = {
    ...person,
    member_id: person.person_id,
    rows,
    graph_state: committeeView.state,
    reverse_edges: reverseEdges,
  };

  assert.equal(legacyLookup.by_member_id?.[person.person_id], undefined);
  assert.equal(committeeView.state, "matched");
  assert.equal(rows.length, 77);
  assert.equal(reverseEdges.length, rows.length);
  assert.ok(rows.every((row) => row.edge_type === "member_of" && row.relation_label === "member of"));
  assert.ok(rows.every((row) => /^\d+$/.test(row.committee_id)));

  const panel = renderCommitteeMembershipsHTML(bag, { escapeHtml: String });
  assert.match(panel, /data-membership-status="linked"/);
  assert.match(panel, /data-pivot-relation-label="member of"/);
  assert.match(panel, /href="\/committees\/\d+\/"/);
  assert.doesNotMatch(panel, /href="\/browse\/people\/#committees"/);
  assert.doesNotMatch(panel, /Reverse coverage unavailable/);
  assert.doesNotMatch(panel, /Provisional: destination not verified/);

  const local = renderOfficialLocalConstellationHTML(
    { official: { ref: "entity:official:5259" }, events: [] },
    bag,
    person.person_id,
    person.person_name,
  );
  assert.equal(local, "", "committee memberships are not repeated as local connections");
});

test("official 7811 diamond-marked committees are keyboard-native committee links", () => {
  const person = { person_id: "7811", person_name: "Vickie Paladino" };
  const committeeView = buildOfficialCommitteeView(person, graph);
  const rows = committeeRowsFromGraph(graph, committeeView);
  const reverseEdges = committeeReverseEdgesForId(graph, person.person_id);
  const bag = {
    ...person,
    member_id: person.person_id,
    rows,
    graph_state: committeeView.state,
    reverse_edges: reverseEdges,
  };

  assert.equal(committeeView.state, "matched");
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => /^\d+$/.test(row.committee_id) && row.href === `/committees/${row.committee_id}/`));

  const panel = renderCommitteeMembershipsHTML(bag, { escapeHtml: String });
  const diamonds = [...panel.matchAll(/<span aria-hidden="true">◆<\/span>/g)];
  const links = [...panel.matchAll(/<a class="ui-constellation-link"[^>]*href="(\/committees\/\d+\/)"[^>]*aria-label="([^"]+)"[^>]*>/g)];
  assert.equal(diamonds.length, rows.length);
  assert.equal(links.length, rows.length);
  assert.doesNotMatch(panel, /<span class="[^"]*ui-constellation-link/);
  assert.doesNotMatch(panel, /tabindex="-1"/);
  for (const row of rows) {
    const href = `/committees/${row.committee_id}/`;
    assert.ok(links.some((match) => match[1] === href), `${row.committee} must link to ${href}`);
    assert.match(panel, new RegExp(`<a class="ui-constellation-link"[^>]*href="${href.replaceAll("/", "\\/")}"[^>]*>\\s*<span aria-hidden="true">◆</span>`));
    assert.ok(
      links.some((match) => match[1] === href && match[2].includes(row.committee)),
      `${row.committee} needs accessible link text`,
    );
  }
});

test("unverified official committee names stay ordinary text without diamond styling", () => {
  const panel = renderCommitteeMembershipsHTML({
    member_id: "7811",
    person_name: "Vickie Paladino",
    rows: [{ committee_id: "not-a-body-id", committee: "Unverified committee", appointment_type: "Member" }],
  }, { escapeHtml: String });
  assert.match(panel, /Unverified committee/);
  assert.match(panel, /data-pivot-status="held"/);
  assert.match(panel, /class="[^"]*ui-static-fact/);
  assert.doesNotMatch(panel, /href=/);
  assert.doesNotMatch(panel, /<a\b/);
  assert.doesNotMatch(panel, /ui-constellation-link/);
  assert.doesNotMatch(panel, /◆/);
  assert.doesNotMatch(panel, /tabindex=/);
});

test("official profile committee composition preserves honest graph states", () => {
  const person = { person_id: "9999", person_name: "Unknown" };
  const committeeView = buildOfficialCommitteeView(person, { ...graph, publication: "published", public_edges: [], public_reverse_edges: [] });
  const rows = committeeRowsFromGraph(graph, committeeView);
  assert.equal(committeeView.state, "empty");
  assert.deepEqual(rows, []);

  const held = buildOfficialCommitteeView(person, { ...graph, publication: "held" });
  assert.equal(held.state, "unknown");
  assert.deepEqual(committeeRowsFromGraph(graph, held), []);
});
