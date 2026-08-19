// Transport-neutral contract for one bounded public relationship traversal.
// The existing public graph serializer remains the vocabulary, evidence, and
// redaction authority; delivery adapters own HTTP status and representation bytes.

import {
  PUBLIC_GRAPH_DEFAULT_DEPTH,
  PUBLIC_GRAPH_DEFAULT_FAN_OUT,
  PUBLIC_GRAPH_EDGE_LABELS,
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_MAX_DEPTH,
  PUBLIC_GRAPH_MAX_FAN_OUT,
  PUBLIC_GRAPH_NODE_TYPES,
  PUBLIC_RELATIONSHIP_GRAPH_VERSION,
} from "../entity_resolution/publication/relationship_graph.mjs";

export const ENTITY_RELATIONSHIPS_CAPABILITY_ID = "entity.relationships.get";
export const ENTITY_RELATIONSHIPS_CAPABILITY_VERSION = "1.0.0";
export const ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE = "entity.relationships.get@1";
export const ENTITY_RELATIONSHIPS_PROVIDER_ID = "worker-d1.entity-relationships";
export const ENTITY_RELATIONSHIPS_PUBLIC_SCHEMA_VERSION = PUBLIC_RELATIONSHIP_GRAPH_VERSION;
export const ENTITY_RELATIONSHIPS_LIMITS = Object.freeze({
  entityIdMaximumLength: 300,
  recordLimit: 250,
  defaultDepth: PUBLIC_GRAPH_DEFAULT_DEPTH,
  maximumDepth: PUBLIC_GRAPH_MAX_DEPTH,
  defaultFanOut: PUBLIC_GRAPH_DEFAULT_FAN_OUT,
  maximumFanOut: PUBLIC_GRAPH_MAX_FAN_OUT,
});
export const ENTITY_RELATIONSHIPS_AVAILABILITY = Object.freeze([
  "available",
  "not_yet_public",
  "unavailable",
]);
export const ENTITY_RELATIONSHIPS_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "json",
    mediaType: "application/json",
    projection: "public relationship graph object",
  }),
  Object.freeze({
    id: "html",
    mediaType: "text/html",
    projection: "existing evidence-bearing relationship document",
  }),
]);
export const ENTITY_RELATIONSHIPS_NODE_TYPES = PUBLIC_GRAPH_NODE_TYPES;
export const ENTITY_RELATIONSHIPS_EDGE_TYPES = PUBLIC_GRAPH_EDGE_TYPES;

const INPUT_FIELDS = new Set(["entityId", "depth", "fanOut", "nodeTypes", "edgeTypes"]);
const PRIVATE_FIELD_NAMES = new Set([
  "raw_snapshot",
  "normalized_snapshot",
  "content_hash",
  "source_record_id",
  "link_confidence_score",
  "matcher_version",
  "evidence_json",
  "resolution_run_id",
  "review_status",
  "attrs_json",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const ENTITY_RELATIONSHIPS_CAPABILITY = deepFreeze({
  id: ENTITY_RELATIONSHIPS_CAPABILITY_ID,
  version: ENTITY_RELATIONSHIPS_CAPABILITY_VERSION,
  reference: ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
  owner: "entity-resolution",
  operation: "read",
  authority: {
    class: "public-read",
    sideEffect: "none",
    approval: "none",
    redaction: "public relationship graph serializer allowlist",
  },
  cost: {
    class: "bounded-d1-read",
    machineFanOut: "bounded-graph",
  },
  input: {
    schema: "cityscroll.capability.entity_relationships_get.input.v1",
    identity: "exact canonical entity id",
    traversal: "incident edges from one root; no graph query language",
    nodeTypes: ENTITY_RELATIONSHIPS_NODE_TYPES,
    edgeTypes: ENTITY_RELATIONSHIPS_EDGE_TYPES,
    limits: ENTITY_RELATIONSHIPS_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.entity_relationships_get.output.v1",
    graphSchema: ENTITY_RELATIONSHIPS_PUBLIC_SCHEMA_VERSION,
    fields: ["capability_reference", "availability", "graph", "error"],
    availability: ENTITY_RELATIONSHIPS_AVAILABILITY,
    representations: ENTITY_RELATIONSHIPS_REPRESENTATIONS,
    privateFieldsForbidden: [...PRIVATE_FIELD_NAMES],
  },
  provenance: {
    entityIdentity: "graph.root.id",
    relationshipIdentity: "graph.edges[].id",
    sourceIdentity: "graph.edges[].provenance.source",
    observationClock: "graph.edges[].provenance.observed_at",
    evidenceFields: "graph.edges[].provenance.source_fields",
    confidence: "graph.edges[].confidence status and basis; no private score",
  },
  freshness: {
    owner: "D1 entity-resolution read model plus committed public graph overlays",
    projection: "public serializer and adapter-owned representation",
  },
  provider: {
    id: ENTITY_RELATIONSHIPS_PROVIDER_ID,
    module: "worker/src/public_relationship_graph.mjs",
    export: "workerD1EntityRelationships",
    store: "Cloudflare D1 plus committed public graph overlay",
    readModel: "canonical entities plus accepted source-record and evaluated public edges",
  },
  adapters: [
    {
      id: "worker-http.entity-relationships@1",
      module: "worker/src/public_relationship_graph.mjs",
      kind: "http-route",
      route: "GET /entity-relationships",
      surface: "Public relationship graph",
      representations: ENTITY_RELATIONSHIPS_REPRESENTATIONS,
    },
    {
      id: "mcp.get_entity_relationships@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "get_entity_relationships",
      route: "POST /mcp",
      surface: "MCP",
    },
  ],
});

function assertNoPrivateFields(value, path = "output") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(field) || /(?:^|_)confidence_score$/.test(field)) {
      throw new TypeError(`entity.relationships output exposes private field: ${path}.${field}`);
    }
    assertNoPrivateFields(child, `${path}.${field}`);
  }
}

function validateTypeFilter(value, field, allowlist) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > allowlist.length) {
    throw new TypeError(`${field} must be a bounded array of registered types`);
  }
  const seen = new Set();
  for (const type of value) {
    if (typeof type !== "string" || !allowlist.includes(type) || seen.has(type)) {
      throw new TypeError(`${field} contains an unsupported or duplicate type`);
    }
    seen.add(type);
  }
}

export function validateEntityRelationshipsInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("entity.relationships.get input must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) {
      throw new TypeError(`entity.relationships.get does not accept arbitrary field: ${field}`);
    }
  }
  if (
    typeof input.entityId !== "string"
    || !input.entityId.trim()
    || input.entityId.length > ENTITY_RELATIONSHIPS_LIMITS.entityIdMaximumLength
  ) {
    throw new TypeError("entityId must be a non-empty bounded string");
  }
  for (const field of ["depth", "fanOut"]) {
    if (input[field] !== undefined && (!Number.isInteger(input[field]) || input[field] <= 0)) {
      throw new TypeError(`${field} must be a positive integer`);
    }
  }
  validateTypeFilter(input.nodeTypes, "nodeTypes", ENTITY_RELATIONSHIPS_NODE_TYPES);
  validateTypeFilter(input.edgeTypes, "edgeTypes", ENTITY_RELATIONSHIPS_EDGE_TYPES);
  return input;
}

function validateEvidence(edge) {
  const source = edge?.provenance?.source;
  if (!source?.system || !source.id) {
    throw new TypeError("entity.relationships edges require public source identity");
  }
  if (!Array.isArray(edge.provenance.source_fields) || !edge.provenance.source_fields.length) {
    throw new TypeError("entity.relationships edges require public evidence fields");
  }
  if (typeof edge.provenance.observed_at !== "string" || !edge.provenance.observed_at) {
    throw new TypeError("entity.relationships edges require an observation clock");
  }
  if (!edge.confidence || typeof edge.confidence !== "object"
      || typeof edge.confidence.status !== "string" || !edge.confidence.status
      || typeof edge.confidence.basis !== "string" || !edge.confidence.basis) {
    throw new TypeError("entity.relationships edges require public confidence labels");
  }
  if (Object.keys(edge.confidence).some((field) => /score|probability/i.test(field))) {
    throw new TypeError("entity.relationships confidence must not expose a private score");
  }
}

function maximumTraversalEdges(depth, fanOut) {
  let frontier = 1;
  let total = 0;
  for (let level = 0; level < depth; level += 1) {
    frontier *= fanOut;
    total += frontier;
  }
  return total;
}

function validatePublicGraph(graph, input) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new TypeError("available entity.relationships output requires a graph");
  }
  if (graph.version !== ENTITY_RELATIONSHIPS_PUBLIC_SCHEMA_VERSION) {
    throw new TypeError("entity.relationships public schema version drifted");
  }
  const entityId = input.entityId.trim();
  if (graph.root?.id !== entityId || !ENTITY_RELATIONSHIPS_NODE_TYPES.includes(graph.root?.type)) {
    throw new TypeError("entity.relationships root identity must match the exact requested entity");
  }
  const requestedDepth = input.depth ?? ENTITY_RELATIONSHIPS_LIMITS.defaultDepth;
  const requestedFanOut = input.fanOut ?? ENTITY_RELATIONSHIPS_LIMITS.defaultFanOut;
  const appliedDepth = Math.min(requestedDepth, ENTITY_RELATIONSHIPS_LIMITS.maximumDepth);
  const appliedFanOut = Math.min(requestedFanOut, ENTITY_RELATIONSHIPS_LIMITS.maximumFanOut);
  const bounds = graph.bounds;
  if (!bounds
      || bounds.requested_depth !== requestedDepth
      || bounds.applied_depth !== appliedDepth
      || bounds.max_depth !== ENTITY_RELATIONSHIPS_LIMITS.maximumDepth
      || bounds.requested_fan_out !== requestedFanOut
      || bounds.applied_fan_out !== appliedFanOut
      || bounds.max_fan_out !== ENTITY_RELATIONSHIPS_LIMITS.maximumFanOut
      || typeof bounds.truncated !== "boolean"
      || !Array.isArray(bounds.boundary_reached)
      || bounds.boundary_reached.some((boundary) => !["depth", "fan_out"].includes(boundary))) {
    throw new TypeError("entity.relationships traversal bounds drifted");
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError("entity.relationships graph requires node and edge arrays");
  }
  const maximumEdges = maximumTraversalEdges(appliedDepth, appliedFanOut);
  if (graph.edges.length > maximumEdges || graph.nodes.length > maximumEdges + 1) {
    throw new TypeError("entity.relationships graph exceeds the declared traversal bound");
  }
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!node?.id || !node.name || !ENTITY_RELATIONSHIPS_NODE_TYPES.includes(node.type) || nodes.has(node.id)) {
      throw new TypeError("entity.relationships graph contains an invalid node");
    }
    nodes.set(node.id, node);
  }
  if (!nodes.has(entityId)) throw new TypeError("entity.relationships graph omits its root node");
  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (!edge?.id || edgeIds.has(edge.id)
        || !ENTITY_RELATIONSHIPS_EDGE_TYPES.includes(edge.type)
        || edge.label !== PUBLIC_GRAPH_EDGE_LABELS[edge.type]
        || !nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new TypeError("entity.relationships graph contains an invalid edge");
    }
    validateEvidence(edge);
    edgeIds.add(edge.id);
  }
  assertNoPrivateFields(graph);
  return graph;
}

export function validateEntityRelationshipsOutput(result, input) {
  validateEntityRelationshipsInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("entity.relationships provider must return an object");
  }
  if (result.capability_reference !== ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE) {
    throw new TypeError("entity.relationships capability reference drifted");
  }
  if (!ENTITY_RELATIONSHIPS_AVAILABILITY.includes(result.availability)) {
    throw new TypeError("entity.relationships availability is invalid");
  }
  if (result.availability === "available") {
    validatePublicGraph(result.graph, input);
    if (result.error !== null) throw new TypeError("available entity.relationships output cannot carry an error");
  } else {
    if (result.graph !== null) throw new TypeError("unavailable entity.relationships output cannot carry a graph");
    if (typeof result.error !== "string" || !result.error) {
      throw new TypeError("non-available entity.relationships output requires an error code");
    }
    if (result.availability === "not_yet_public" && result.error !== "not-found") {
      throw new TypeError("not_yet_public entity.relationships output requires not-found");
    }
    if (result.availability === "unavailable"
        && !["no-store", "relationship-graph-unavailable"].includes(result.error)) {
      throw new TypeError("unavailable entity.relationships output has an invalid error code");
    }
  }
  assertNoPrivateFields(result);
  return result;
}

/** Execute one explicit provider. This is deliberately not a service locator. */
export async function executeEntityRelationships(provider, input) {
  validateEntityRelationshipsInput(input);
  if (
    !provider
    || provider.capabilityReference !== ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE
    || provider.providerId !== ENTITY_RELATIONSHIPS_PROVIDER_ID
    || typeof provider.execute !== "function"
  ) {
    throw new TypeError("entity.relationships.get requires the registered explicit provider");
  }
  const result = await provider.execute(input);
  return validateEntityRelationshipsOutput(result, input);
}
