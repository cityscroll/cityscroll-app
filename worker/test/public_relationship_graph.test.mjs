import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_MAX_DEPTH,
  PUBLIC_GRAPH_MAX_FAN_OUT,
  PUBLIC_GRAPH_NODE_TYPES,
  PUBLIC_RELATIONSHIP_GRAPH_VERSION,
  handlePublicRelationshipGraph,
  readPublicRelationshipGraph,
} from "../src/public_relationship_graph.mjs";
import { serializePublicRelationshipGraph } from "../../entity_resolution/publication/relationship_graph.mjs";

const ENTITY_ID = "vendor:stem:ACME CONSTRUCTION";

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async all() { return { results: statement.all(...args) }; },
          };
        },
      };
    },
  };
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of ["0008_source_records.sql", "0009_entity_link.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const entityInsert = sqlite.prepare(
    `INSERT INTO canonical_entity
       (id, entity_type, display_name, attrs_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  entityInsert.run(
    ENTITY_ID,
    "vendor",
    "Acme Construction LLC",
    JSON.stringify({ private: "private-attrs-marker" }),
    "2026-07-30T14:00:00.000Z",
    "2026-08-01T09:30:00.000Z",
  );

  const sourceInsert = sqlite.prepare(
    `INSERT INTO source_records
       (source_system, source_system_id, content_hash, raw_snapshot, normalized_snapshot, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  sourceInsert.run(
    "city_record",
    "20260730001",
    "private-hash-marker-a",
    JSON.stringify({
      type_of_notice_description: "Award",
      short_title: "Bridge inspection services",
      vendor_name: "Acme Construction LLC",
      agency_name: "Department of Design and Construction",
      contract_id: "CT-850-1",
      pin: "85026B0001001",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260730001",
      reviewer: "private-reviewer-marker",
    }),
    JSON.stringify({ private: "private-normalized-marker" }),
    "2026-07-30T14:00:00.000Z",
  );
  sourceInsert.run(
    "city_record",
    "20260730002",
    "private-hash-marker-b",
    JSON.stringify({
      type_of_notice_description: "Solicitation",
      short_title: "Waterfront engineering services",
      vendor_name: "Acme Construction LLC",
      agency_name: "Department of Design and Construction",
      epin: "85026P0002001",
      evidence_json: "private-evidence-marker",
    }),
    JSON.stringify({ private: "private-normalized-marker" }),
    "2026-08-01T09:30:00.000Z",
  );
  sourceInsert.run(
    "city_record",
    "20260730003",
    "private-hash-marker-c",
    JSON.stringify({
      type_of_notice_description: "Public Hearing",
      vendor_name: "Acme Construction LLC",
      agency_name: "Department of Design and Construction",
    }),
    "{}",
    "2026-08-01T10:00:00.000Z",
  );

  const linkInsert = sqlite.prepare(
    `INSERT INTO entity_link
       (id, source_record_id, canonical_entity_id, decision, confidence, method,
        matcher_version, evidence_json, resolution_run_id, review_status, created_at)
     VALUES (?, ?, ?, 'auto_link', ?, ?, ?, ?, NULL, ?, ?)`,
  );
  for (const [suffix, sourceId, confidence] of [
    ["a", "20260730001", 0.98],
    ["b", "20260730002", 0.84],
    ["c", "20260730003", 0.72],
  ]) {
    linkInsert.run(
      `link-${suffix}`,
      `city_record:${sourceId}:private-hash-marker-${suffix}`,
      ENTITY_ID,
      confidence,
      "private-method-marker",
      "private-matcher-marker",
      "private-evidence-marker",
      "private-review-marker",
      "2026-08-01T11:00:00.000Z",
    );
  }
  return { sqlite, env: { DB: d1(sqlite) } };
}

function assertSensitivityBoundary(value) {
  const output = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of [
    "private-attrs-marker",
    "private-hash-marker",
    "private-normalized-marker",
    "private-reviewer-marker",
    "private-evidence-marker",
    "private-method-marker",
    "private-matcher-marker",
    "private-review-marker",
  ]) {
    assert.doesNotMatch(output, new RegExp(marker));
  }
  assert.doesNotMatch(output, /raw_snapshot|normalized_snapshot|content_hash|source_record_id/);
  assert.doesNotMatch(output, /matcher_version|evidence_json|resolution_run_id|review_status/);
}

test("public graph returns only typed, evidence-bearing procurement relationships", async () => {
  const { sqlite, env } = fixture();
  try {
    const graph = await readPublicRelationshipGraph(env.DB, ENTITY_ID, { depth: 2, fanOut: 20 });
    assert.equal(graph.version, PUBLIC_RELATIONSHIP_GRAPH_VERSION);
    assert.deepEqual(PUBLIC_GRAPH_NODE_TYPES, [
      "vendor", "agency", "solicitation", "contract", "award", "official", "person-leader",
      "mandate", "project", "procedure", "borough", "community-district", "council-district",
    ]);
    assert.deepEqual(PUBLIC_GRAPH_EDGE_TYPES, [
      "named_vendor_on_award",
      "named_vendor_on_solicitation",
      "published_by_agency",
      "references_contract",
      "votes_on",
      "agency_led_by",
      "mandate_governs_procedure",
      "project_participates_in_procedure",
      "located_in",
    ]);
    assert.equal(graph.root.id, ENTITY_ID);
    // Procurement fixture graph does not emit official nodes; allowlist still includes them.
    assert.deepEqual(new Set(graph.nodes.map((node) => node.type)), new Set([
      "vendor", "agency", "solicitation", "contract", "award",
    ]));
    assert.ok(graph.edges.length > 0);
    for (const edge of graph.edges) {
      assert.ok(PUBLIC_GRAPH_EDGE_TYPES.includes(edge.type));
      assert.ok(edge.label);
      assert.ok(edge.from && edge.to);
      assert.equal(edge.provenance.source.system, "city_record");
      assert.match(edge.provenance.observed_at, /^2026-/);
      assert.ok(edge.provenance.source_fields.length >= 2);
      if (edge.type === "agency_led_by") {
        assert.deepEqual(edge.confidence, { status: "strong", basis: "publisher_record" });
      } else {
        assert.deepEqual(edge.confidence, { status: "not_scored", basis: "publisher_record" });
      }
    }
    assert.equal(graph.nodes.some((node) => node.name === "Public Hearing"), false);
    assertSensitivityBoundary(graph);
  } finally {
    sqlite.close();
  }
});

test("graph traversal clamps depth and fan-out with an explicit boundary", async () => {
  const { sqlite, env } = fixture();
  try {
    const graph = await readPublicRelationshipGraph(env.DB, ENTITY_ID, {
      depth: PUBLIC_GRAPH_MAX_DEPTH + 10,
      fanOut: 1,
    });
    assert.equal(graph.bounds.applied_depth, PUBLIC_GRAPH_MAX_DEPTH);
    assert.equal(graph.bounds.applied_fan_out, 1);
    assert.equal(graph.bounds.max_fan_out, PUBLIC_GRAPH_MAX_FAN_OUT);
    assert.equal(graph.bounds.truncated, true);
    assert.deepEqual(graph.bounds.boundary_reached.sort(), ["depth", "fan_out"]);
    assert.match(graph.bounds.note, /stopped at the published boundary/i);
    assert.equal(graph.edges.filter((edge) => edge.from === ENTITY_ID).length, 1);
  } finally {
    sqlite.close();
  }
});

test("graph route refuses unsupported node or edge types", async () => {
  const { sqlite, env } = fixture();
  try {
    const unsupportedNode = await handlePublicRelationshipGraph(new Request(
      `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}&node_type=person`,
    ), env);
    assert.equal(unsupportedNode.status, 400);
    assert.equal((await unsupportedNode.json()).error, "unsupported-node-type");

    const unsupportedEdge = await handlePublicRelationshipGraph(new Request(
      `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}&edge_type=associated_with`,
    ), env);
    assert.equal(unsupportedEdge.status, 400);
    assert.equal((await unsupportedEdge.json()).error, "unsupported-edge-type");
  } finally {
    sqlite.close();
  }
});

test("graph route serves JSON and an accessible typed-edge table", async () => {
  const { sqlite, env } = fixture();
  try {
    const jsonResponse = await handlePublicRelationshipGraph(new Request(
      `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}&format=json`,
    ), env);
    assert.equal(jsonResponse.status, 200);
    const graph = await jsonResponse.json();
    assert.ok(graph.edges.every((edge) => edge.type && edge.label));
    assertSensitivityBoundary(graph);

    const htmlResponse = await handlePublicRelationshipGraph(new Request(
      `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}`,
    ), env);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, /Relationship evidence/);
    assert.match(html, /<table/);
    assert.match(html, /Named vendor on award/);
    assert.match(html, /Every connection below is typed/);
    assertSensitivityBoundary(html);
  } finally {
    sqlite.close();
  }
});

test("graph unknown id returns not_yet_public — not a live empty product surface", async () => {
  const { sqlite, env } = fixture();
  try {
    for (const id of [
      "vendor:name:camba inc",
      "contract:CT126020278800692",
    ]) {
      const response = await handlePublicRelationshipGraph(new Request(
        `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(id)}&format=json`,
      ), env);
      assert.equal(response.status, 404, id);
      const body = await response.json();
      assert.equal(body.error, "not-found");
      assert.equal(body.public_status, "not_yet_public");
      assert.match(body.message || "", /not yet public|subject-registry|canonical/i);
    }
  } finally {
    sqlite.close();
  }
});

test("public graph omits evidence-only cross-spine candidates", () => {
  const graph = serializePublicRelationshipGraph([{
    entity_id: ENTITY_ID,
    entity_type: "vendor",
    display_name: "Acme Construction LLC",
    source_system: "city_record",
    source_system_id: "20260730001",
    raw_snapshot: JSON.stringify({
      type_of_notice_description: "Award",
      short_title: "Bridge inspection services",
      vendor_name: "Acme Construction LLC",
      contract_id: "CT-850-1",
    }),
    ingested_at: "2026-08-01T11:00:00.000Z",
  }], {
    crossSpineEdges: [{
      type: "references_contract",
      relation: "mandate_rule",
      from: ENTITY_ID,
      to: "contract:name:ct-850-1",
      features: { agency_exact: true, topic_overlap: ["rule"] },
      provenance: { source_system: "city_record", source_record_id: "rule-1" },
    }],
  });
  assert.equal(graph.edge_routing.evidence_only, 1);
  assert.equal(graph.edges.some((edge) => edge.from === ENTITY_ID && edge.type === "references_contract"), false);
});

test("public graph traverses a reified procedure only through evaluated public edges", () => {
  const provenance = {
    source: { system: "cityscroll_procedure_vocabulary", id: "land_use_procedure_v1" },
    source_fields: ["procedure_kind"],
    observed_at: "2026-08-09T00:00:00.000Z",
  };
  const mandateEdge = {
    type: "mandate_governs_procedure",
    relation: "mandate_governs_procedure",
    from: "mandate:54431-002",
    to: "procedure:landmark_designation",
    features: {
      mandate_quote_verified: true,
      procedure_kind_exact: true,
      procedure_vocabulary_member: true,
    },
    provenance,
  };
  const projectEdge = {
    type: "project_participates_in_procedure",
    relation: "project_participates_in_procedure",
    from: "project:2026K0443",
    to: "procedure:landmark_designation",
    features: {
      project_subject_exact: true,
      publisher_action_kind_exact: true,
      procedure_vocabulary_member: true,
    },
    provenance: {
      source: { system: "zoning_application_portal", id: "2026K0443" },
      source_fields: ["project_id", "actions"],
      observed_at: "2026-08-09T00:00:00.000Z",
    },
  };
  const rows = [{
    entity_id: "mandate:54431-002",
    entity_type: "mandate",
    display_name: "Landmark public-hearing mandate",
    raw_snapshot: "{}",
  }];
  const crossSpineNodes = [
    { id: "procedure:landmark_designation", type: "procedure", name: "Landmark designation procedure" },
    { id: "project:2026K0443", type: "project", name: "Public School 15 Annex" },
  ];
  const graph = serializePublicRelationshipGraph(rows, {
    depth: 2,
    crossSpineNodes,
    crossSpineEdges: [mandateEdge, projectEdge],
  });
  assert.deepEqual(graph.edges.map((edge) => edge.type).sort(), [
    "mandate_governs_procedure",
    "project_participates_in_procedure",
  ]);
  assert.ok(graph.nodes.some((node) => node.id === "procedure:landmark_designation"));
  assert.ok(graph.nodes.some((node) => node.id === "project:2026K0443"));

  const heldProject = serializePublicRelationshipGraph(rows, {
    depth: 2,
    crossSpineNodes,
    crossSpineEdges: [
      mandateEdge,
      {
        ...projectEdge,
        features: { project_subject_exact: true, procedure_vocabulary_member: true },
      },
    ],
  });
  assert.equal(heldProject.edge_routing.evidence_only, 1);
  assert.deepEqual(heldProject.edges.map((edge) => edge.type), ["mandate_governs_procedure"]);
  assert.equal(heldProject.nodes.some((node) => node.id === "project:2026K0443"), false);
});
