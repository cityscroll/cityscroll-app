import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ENTITY_RELATIONSHIPS_AVAILABILITY,
  ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
  ENTITY_RELATIONSHIPS_EDGE_TYPES,
  ENTITY_RELATIONSHIPS_LIMITS,
  ENTITY_RELATIONSHIPS_NODE_TYPES,
  executeEntityRelationships,
} from "../../capabilities/entity_relationships.mjs";
import {
  GRAPH_NOT_YET_PUBLIC,
  PUBLIC_RELATIONSHIP_GRAPH_VERSION,
  handlePublicRelationshipGraph,
  renderPublicRelationshipGraphPage,
  workerD1EntityRelationships,
} from "../src/public_relationship_graph.mjs";

const ENTITY_ID = "vendor:stem:ACME CONSTRUCTION";
const EVIDENCE_RECEIPT = JSON.parse(readFileSync(
  new URL("../../artifacts/capability-spine/cs-03-entity-relationships.json", import.meta.url),
  "utf8",
));

function rows() {
  return [
    {
      entity_id: ENTITY_ID,
      entity_type: "vendor",
      display_name: "Acme Construction LLC",
      source_system: "city_record",
      source_system_id: "20260730001",
      raw_snapshot: JSON.stringify({
        type_of_notice_description: "Award",
        short_title: "Bridge inspection services",
        vendor_name: "Acme Construction LLC",
        agency_name: "Department of Design and Construction",
        contract_id: "CT-850-1",
        pin: "85026B0001001",
        source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260730001",
        reviewer: "private-reviewer-marker",
      }),
      ingested_at: "2026-07-30T14:00:00.000Z",
    },
    {
      entity_id: ENTITY_ID,
      entity_type: "vendor",
      display_name: "Acme Construction LLC",
      source_system: "city_record",
      source_system_id: "20260730002",
      raw_snapshot: JSON.stringify({
        type_of_notice_description: "Solicitation",
        short_title: "Waterfront engineering services",
        vendor_name: "Acme Construction LLC",
        agency_name: "Department of Design and Construction",
        epin: "85026P0002001",
        evidence_json: "private-evidence-marker",
      }),
      ingested_at: "2026-08-01T09:30:00.000Z",
    },
    {
      entity_id: ENTITY_ID,
      entity_type: "vendor",
      display_name: "Acme Construction LLC",
      source_system: "city_record",
      source_system_id: "20260730003",
      raw_snapshot: JSON.stringify({
        type_of_notice_description: "Public Hearing",
        vendor_name: "Acme Construction LLC",
      }),
      ingested_at: "2026-08-01T10:00:00.000Z",
    },
  ];
}

function dbReturning(resultRows) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() { return { results: resultRows }; },
          };
        },
      };
    },
  };
}

function assertPublicBoundary(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.doesNotMatch(serialized, /private-/);
  assert.doesNotMatch(serialized, /raw_snapshot|normalized_snapshot|content_hash|source_record_id/);
  assert.doesNotMatch(serialized, /matcher_version|evidence_json|resolution_run_id|review_status/);
}

const input = () => ({ entityId: ENTITY_ID, depth: 2, fanOut: 12 });

test("direct provider preserves closed vocabularies, evidence, confidence, bounds, and redaction", async () => {
  const result = await executeEntityRelationships(
    workerD1EntityRelationships(dbReturning(rows())),
    input(),
  );

  assert.equal(result.capability_reference, ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE);
  assert.equal(result.availability, "available");
  assert.equal(result.graph.version, PUBLIC_RELATIONSHIP_GRAPH_VERSION);
  assert.deepEqual(result.graph.root, {
    id: ENTITY_ID,
    type: "vendor",
    name: "Acme Construction LLC",
  });
  assert.deepEqual(result.graph.bounds, {
    requested_depth: 2,
    applied_depth: 2,
    max_depth: ENTITY_RELATIONSHIPS_LIMITS.maximumDepth,
    requested_fan_out: 12,
    applied_fan_out: 12,
    max_fan_out: ENTITY_RELATIONSHIPS_LIMITS.maximumFanOut,
    truncated: false,
    boundary_reached: [],
    note: "This graph is limited to the displayed linked public records; absence is not proof that no relationship exists.",
  });
  assert.ok(result.graph.nodes.every(({ type }) => ENTITY_RELATIONSHIPS_NODE_TYPES.includes(type)));
  assert.ok(result.graph.edges.length > 0);
  for (const edge of result.graph.edges) {
    assert.ok(ENTITY_RELATIONSHIPS_EDGE_TYPES.includes(edge.type));
    assert.ok(edge.provenance.source.system);
    assert.ok(edge.provenance.source.id);
    assert.ok(edge.provenance.source_fields.length);
    assert.ok(edge.provenance.observed_at);
    assert.ok(edge.confidence.status);
    assert.ok(edge.confidence.basis);
    assert.equal(Object.keys(edge.confidence).some((field) => /score|probability/i.test(field)), false);
  }
  assert.equal(result.graph.nodes.some((node) => node.name === "Public Hearing"), false);
  assert.deepEqual(result.graph.nodes.map(({ id }) => id), EVIDENCE_RECEIPT.fixture.node_ids);
  assert.deepEqual(result.graph.edges.map(({ id }) => id), EVIDENCE_RECEIPT.fixture.edge_ids);
  assert.equal(
    createHash("sha256").update(JSON.stringify(result.graph)).digest("hex"),
    EVIDENCE_RECEIPT.fixture.graph_sha256,
  );
  assertPublicBoundary(result);
});

test("direct provider keeps not_yet_public distinct from unavailable", async () => {
  const notYetPublic = await executeEntityRelationships(
    workerD1EntityRelationships(dbReturning([])),
    { entityId: "vendor:unknown" },
  );
  assert.equal(notYetPublic.availability, "not_yet_public");
  assert.equal(notYetPublic.graph, null);
  assert.equal(notYetPublic.error, "not-found");

  const noStore = await executeEntityRelationships(
    workerD1EntityRelationships(null),
    { entityId: ENTITY_ID },
  );
  assert.equal(noStore.availability, "unavailable");
  assert.equal(noStore.error, "no-store");

  const failed = await executeEntityRelationships(
    workerD1EntityRelationships({ prepare() { throw new Error("fixture outage"); } }),
    { entityId: ENTITY_ID },
  );
  assert.equal(failed.availability, "unavailable");
  assert.equal(failed.error, "relationship-graph-unavailable");
  assert.deepEqual(ENTITY_RELATIONSHIPS_AVAILABILITY, [
    "available",
    "not_yet_public",
    "unavailable",
  ]);
});

test("direct input rejects arbitrary query fields and unsupported vocabulary", async () => {
  const provider = workerD1EntityRelationships(dbReturning(rows()));
  await assert.rejects(
    executeEntityRelationships(provider, { entityId: ENTITY_ID, query: "MATCH (n)-[*]->(m)" }),
    /does not accept arbitrary field/,
  );
  await assert.rejects(
    executeEntityRelationships(provider, { entityId: ENTITY_ID, depth: 0 }),
    /depth must be a positive integer/,
  );
  await assert.rejects(
    executeEntityRelationships(provider, { entityId: ENTITY_ID, nodeTypes: ["person"] }),
    /unsupported or duplicate type/,
  );
  await assert.rejects(
    executeEntityRelationships(provider, { entityId: ENTITY_ID, edgeTypes: ["associated_with"] }),
    /unsupported or duplicate type/,
  );
});

test("oversized traversal requests are clamped at the public serializer boundary", async () => {
  const result = await executeEntityRelationships(
    workerD1EntityRelationships(dbReturning(rows())),
    {
      entityId: ENTITY_ID,
      depth: ENTITY_RELATIONSHIPS_LIMITS.maximumDepth + 100,
      fanOut: ENTITY_RELATIONSHIPS_LIMITS.maximumFanOut + 100,
    },
  );
  assert.equal(result.graph.bounds.applied_depth, ENTITY_RELATIONSHIPS_LIMITS.maximumDepth);
  assert.equal(result.graph.bounds.applied_fan_out, ENTITY_RELATIONSHIPS_LIMITS.maximumFanOut);
  assert.equal(result.graph.bounds.truncated, true);
  assert.deepEqual(result.graph.bounds.boundary_reached, ["depth", "fan_out"]);
});

test("capability validation fails closed on vocabulary, evidence, confidence, and redaction drift", async () => {
  const direct = await executeEntityRelationships(
    workerD1EntityRelationships(dbReturning(rows())),
    input(),
  );
  const providerFor = (graph) => ({
    capabilityReference: ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
    providerId: "worker-d1.entity-relationships",
    async execute() {
      return { ...direct, graph };
    },
  });
  const [firstEdge, ...remainingEdges] = direct.graph.edges;

  await assert.rejects(
    executeEntityRelationships(providerFor({
      ...direct.graph,
      edges: [{ ...firstEdge, type: "associated_with" }, ...remainingEdges],
    }), input()),
    /invalid edge/,
  );
  await assert.rejects(
    executeEntityRelationships(providerFor({
      ...direct.graph,
      edges: [{ ...firstEdge, provenance: { ...firstEdge.provenance, source_fields: [] } }, ...remainingEdges],
    }), input()),
    /evidence fields/,
  );
  await assert.rejects(
    executeEntityRelationships(providerFor({
      ...direct.graph,
      edges: [{ ...firstEdge, confidence: { score: 0.98 } }, ...remainingEdges],
    }), input()),
    /confidence labels/,
  );
  await assert.rejects(
    executeEntityRelationships(providerFor({
      ...direct.graph,
      raw_snapshot: "private-marker",
    }), input()),
    /exposes private field/,
  );
});

test("JSON and HTML adapters are byte-compatible with the provider graph", async () => {
  const db = dbReturning(rows());
  const direct = await executeEntityRelationships(
    workerD1EntityRelationships(db),
    input(),
  );

  const jsonResponse = await handlePublicRelationshipGraph(new Request(
    `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}&depth=2&fan_out=12&format=json`,
  ), { DB: db });
  assert.equal(jsonResponse.status, 200);
  assert.equal(await jsonResponse.text(), JSON.stringify(direct.graph));

  const htmlResponse = await handlePublicRelationshipGraph(new Request(
    `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}&depth=2&fan_out=12`,
  ), { DB: db });
  assert.equal(htmlResponse.status, 200);
  assert.equal(await htmlResponse.text(), renderPublicRelationshipGraphPage(direct.graph));
  assertPublicBoundary(await handlePublicRelationshipGraph(new Request(
    `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}&format=json`,
  ), { DB: db }).then((response) => response.text()));
});

test("HTTP adapter preserves not_yet_public and unavailable response bytes", async () => {
  const missing = await handlePublicRelationshipGraph(new Request(
    "https://api.cityscroll.org/entity-relationships?id=vendor%3Aunknown&format=json",
  ), { DB: dbReturning([]) });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), JSON.stringify(GRAPH_NOT_YET_PUBLIC));

  const unavailable = await handlePublicRelationshipGraph(new Request(
    `https://api.cityscroll.org/entity-relationships?id=${encodeURIComponent(ENTITY_ID)}&format=json`,
  ), { DB: { prepare() { throw new Error("fixture outage"); } } });
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), JSON.stringify({ error: "relationship-graph-unavailable" }));
});
