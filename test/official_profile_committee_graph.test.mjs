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
  assert.doesNotMatch(panel, /Reverse coverage unavailable/);

  const local = renderOfficialLocalConstellationHTML(
    { official: { ref: "entity:official:5259" }, events: [] },
    bag,
    person.person_id,
    person.person_name,
  );
  assert.match(local, /data-local-constellation-status="matched"/);
  assert.match(local, /data-edge-type="member_of"/);
  assert.match(local, /data-pivot-relation-label="member of"/);
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
