import {
  CURATION_VERDICT_SCHEMA_VERSION,
  projectCurationVerdictState,
} from "./review/curation_verdicts.mjs";

/**
 * Evidence-bearing civic graph foundation.
 *
 * This is a pure, versioned adjacency-list read model over immutable source,
 * resolution, and curation records. It is not a storage layer or graph
 * database. Decision receipts and actor records are private graph nodes;
 * public callers must use publicProvenanceProjection's explicit allowlist.
 */

export const PROVENANCE_GRAPH_SCHEMA_VERSION = "cityscroll.provenance-graph.v1";
export const PROVENANCE_PUBLIC_SCHEMA_VERSION = "cityscroll.provenance-public.v1";

export const PROVENANCE_NODE_TYPES = Object.freeze([
  "assertion",
  "evidence",
  "decision",
  "actor",
  "entity_link",
]);

export const PROVENANCE_EDGE_TYPES = Object.freeze([
  "supported_by",
  "produced_by",
  "shaped_by",
  "considered",
  "made_by",
  "reverses",
  "materialized_as",
  "supersedes",
]);

const NODE_TYPES = new Set(PROVENANCE_NODE_TYPES);
const EDGE_TYPES = new Set(PROVENANCE_EDGE_TYPES);
const CLAIM_CLASSES = new Set([
  "source_assertion",
  "cityscroll_interpretation",
  "derived_conclusion",
]);
const WARRANT_CLASSES = new Set([
  "exact",
  "probabilistic",
  "reviewed",
  "not_yet_classified",
]);
const ACTOR_ATTESTATIONS = new Set(["authenticated", "service", "self_asserted"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const KIND = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const clone = (value) => structuredClone(value);
const refKey = (reference) => `${reference.node_type}\0${reference.id}`;
const targetKey = (target) => `${target.kind}\0${target.id}`;

function cleanToken(value, label) {
  const token = clean(value);
  if (!TOKEN.test(token)) throw new Error(`${label} must be a stable token`);
  return token;
}

function cleanKind(value, label) {
  const kind = clean(value).toLowerCase();
  if (!KIND.test(kind)) throw new Error(`${label} must be a lowercase kind`);
  return kind;
}

function cleanVersion(value) {
  const version = clean(value);
  if (!VERSION.test(version)) throw new Error("assertion version must be a stable token");
  return version;
}

function nodeRef(node_type, id) {
  return Object.freeze({ node_type, id });
}

function evidenceRef(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an evidence reference`);
  }
  return {
    kind: cleanKind(value.kind, `${label}.kind`),
    id: cleanToken(value.id, `${label}.id`),
  };
}

function decisionTarget(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a decision target`);
  }
  return {
    kind: cleanKind(value.kind, `${label}.kind`),
    id: cleanToken(value.id, `${label}.id`),
  };
}

function normalizedReferences(value, label) {
  const seen = new Set();
  const refs = [];
  for (const [index, raw] of (Array.isArray(value) ? value : []).entries()) {
    const ref = evidenceRef(raw, `${label}[${index}]`);
    const key = `${ref.kind}\0${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/** Stable proposition identity plus an immutable version suffix. */
export function versionedAssertionId(assertionKey, version) {
  const key = cleanToken(assertionKey, "assertion_key");
  const normalizedVersion = cleanVersion(version);
  return `assertion:${key}:v${normalizedVersion}`;
}

function normalizeAssertion(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`assertions[${index}] must be an object`);
  }
  const assertion_key = cleanToken(raw.assertion_key, `assertions[${index}].assertion_key`);
  const version = cleanVersion(raw.version);
  const expectedId = versionedAssertionId(assertion_key, version);
  const suppliedId = clean(raw.assertion_id);
  if (suppliedId && suppliedId !== expectedId) {
    throw new Error(`assertion_id must equal ${expectedId}`);
  }
  const claim_class = clean(raw.claim_class);
  if (!CLAIM_CLASSES.has(claim_class)) {
    throw new Error(`${expectedId} has unsupported claim_class ${claim_class || "<empty>"}`);
  }
  const warrant = clean(raw.warrant_class) || "not_yet_classified";
  if (!WARRANT_CLASSES.has(warrant)) {
    throw new Error(`${expectedId} has unsupported warrant_class ${warrant}`);
  }

  const payload = clone(raw);
  delete payload.assertion_id;
  delete payload.assertion_key;
  delete payload.version;
  delete payload.claim_class;
  delete payload.evidence_refs;
  delete payload.produced_by_refs;
  delete payload.decision_target;
  delete payload.supersedes_assertion_id;
  delete payload.warrant_class;

  return {
    ...payload,
    node_type: "assertion",
    id: expectedId,
    assertion_id: expectedId,
    assertion_key,
    version,
    claim_class,
    warrant_class: warrant,
    evidence_refs: normalizedReferences(raw.evidence_refs, `${expectedId}.evidence_refs`),
    produced_by_refs: normalizedReferences(
      raw.produced_by_refs,
      `${expectedId}.produced_by_refs`,
    ),
    decision_target: raw.decision_target
      ? decisionTarget(raw.decision_target, `${expectedId}.decision_target`)
      : null,
    supersedes_assertion_id: raw.supersedes_assertion_id
      ? cleanToken(raw.supersedes_assertion_id, `${expectedId}.supersedes_assertion_id`)
      : null,
  };
}

function normalizeEvidence(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`evidence[${index}] must be an object`);
  }
  const kind = cleanKind(raw.kind, `evidence[${index}].kind`);
  const id = cleanToken(raw.id, `evidence[${index}].id`);
  const payload = clone(raw);
  delete payload.kind;
  delete payload.id;
  delete payload.node_type;
  return { ...payload, node_type: "evidence", id, kind };
}

function normalizeActor(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`actors[${index}] must be an object`);
  }
  const id = cleanToken(raw.id, `actors[${index}].id`);
  const actor_kind = cleanKind(raw.actor_kind || "curator", `actors[${index}].actor_kind`);
  const attestation = clean(raw.attestation) || "self_asserted";
  if (!ACTOR_ATTESTATIONS.has(attestation)) {
    throw new Error(`${id} has unsupported actor attestation ${attestation}`);
  }
  const payload = clone(raw);
  delete payload.id;
  delete payload.node_type;
  delete payload.actor_kind;
  delete payload.attestation;
  return { ...payload, node_type: "actor", id, actor_kind, attestation };
}

function normalizeDecision(receipt, index) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`decisions[${index}] must be a curation receipt`);
  }
  if (receipt.schema_version !== CURATION_VERDICT_SCHEMA_VERSION) {
    throw new Error(`decisions[${index}] must use ${CURATION_VERDICT_SCHEMA_VERSION}`);
  }
  const id = cleanToken(receipt.id, `decisions[${index}].id`);
  const actor_id = cleanToken(receipt.actor, `${id}.actor`);
  const target = decisionTarget(receipt.target, `${id}.target`);
  return {
    node_type: "decision",
    id,
    decision: clean(receipt.decision).toUpperCase(),
    timestamp: clean(receipt.timestamp),
    target,
    actor_id,
    reverses_decision_id: receipt.reverses_receipt_id
      ? cleanToken(receipt.reverses_receipt_id, `${id}.reverses_receipt_id`)
      : null,
    receipt: clone(receipt),
  };
}

function materializationFromDecision(decision) {
  const edge = decision.receipt?.reversible_effect?.edge;
  if (!edge) return null;
  const id = cleanToken(edge.id, `${decision.id}.reversible_effect.edge.id`);
  const payload = clone(edge);
  delete payload.id;
  delete payload.node_type;
  return {
    ...payload,
    node_type: "entity_link",
    id,
    materialized_by_decision_id: decision.id,
  };
}

function addUniqueNode(index, nodes, node) {
  const key = refKey(node);
  if (index.has(key)) throw new Error(`duplicate node identity ${node.node_type}:${node.id}`);
  index.set(key, node);
  nodes.push(node);
}

function addEdge(edges, seen, edge_type, from, to, extra = {}) {
  const key = `${edge_type}\0${refKey(from)}\0${refKey(to)}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ edge_type, from: nodeRef(from.node_type, from.id), to: nodeRef(to.node_type, to.id), ...extra });
}

function buildAdjacency(nodes, edges) {
  const byNode = new Map(nodes.map((node) => [refKey(node), {
    node_type: node.node_type,
    id: node.id,
    outgoing: [],
    incoming: [],
  }]));
  for (const edge of edges) {
    byNode.get(refKey(edge.from)).outgoing.push({
      edge_type: edge.edge_type,
      to: edge.to,
      ...(edge.evidence_kind ? { evidence_kind: edge.evidence_kind } : {}),
    });
    byNode.get(refKey(edge.to)).incoming.push({
      edge_type: edge.edge_type,
      from: edge.from,
      ...(edge.evidence_kind ? { evidence_kind: edge.evidence_kind } : {}),
    });
  }
  const relationSort = (left, right) => left.edge_type.localeCompare(right.edge_type)
    || refKey(left.to || left.from).localeCompare(refKey(right.to || right.from));
  return [...byNode.values()]
    .map((entry) => ({
      ...entry,
      outgoing: entry.outgoing.sort(relationSort),
      incoming: entry.incoming.sort(relationSort),
    }))
    .sort((left, right) => refKey(left).localeCompare(refKey(right)));
}

function validationMessage(error) {
  if (error.code === "dangling_node_reference") {
    return `dangling node reference: ${error.reference.node_type}:${error.reference.id}`
      + ` from ${error.from.node_type}:${error.from.id} via ${error.edge_type}`;
  }
  if (error.code === "evidence_kind_mismatch") {
    return `evidence kind mismatch: expected ${error.expected}, observed ${error.observed}`;
  }
  return `${error.code}: ${error.message || "invalid provenance graph"}`;
}

/** Validate referential integrity without reading storage or mutating the graph. */
export function validateProvenanceGraph(graph) {
  const errors = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const index = new Map();
  for (const node of nodes) {
    if (!NODE_TYPES.has(node?.node_type) || !clean(node?.id)) {
      errors.push({ code: "invalid_node", message: "node_type and id are required" });
      continue;
    }
    const key = refKey(node);
    if (index.has(key)) {
      errors.push({ code: "duplicate_node", message: `${node.node_type}:${node.id}` });
    } else {
      index.set(key, node);
    }
  }
  for (const edge of edges) {
    if (!EDGE_TYPES.has(edge?.edge_type)) {
      errors.push({ code: "invalid_edge_type", message: clean(edge?.edge_type) });
      continue;
    }
    for (const [side, reference] of [["from", edge.from], ["to", edge.to]]) {
      if (!reference || !index.has(refKey(reference))) {
        errors.push({
          code: "dangling_node_reference",
          edge_type: edge.edge_type,
          from: edge.from,
          side,
          reference: reference || { node_type: "unknown", id: "unknown" },
        });
      }
    }
    if (edge.evidence_kind && index.has(refKey(edge.to))) {
      const target = index.get(refKey(edge.to));
      if (target.node_type !== "evidence" || target.kind !== edge.evidence_kind) {
        errors.push({
          code: "evidence_kind_mismatch",
          edge_type: edge.edge_type,
          expected: edge.evidence_kind,
          observed: target.kind || target.node_type,
        });
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Assemble one bounded provenance subgraph from existing append-only records.
 * Invalid identities or references fail closed; no partial graph is returned.
 */
export function buildProvenanceGraph(input = {}) {
  const assertions = (Array.isArray(input.assertions) ? input.assertions : [])
    .map(normalizeAssertion);
  const evidence = (Array.isArray(input.evidence) ? input.evidence : [])
    .map(normalizeEvidence);
  const decisions = (Array.isArray(input.decisions) ? input.decisions : [])
    .map(normalizeDecision)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  const explicitActors = (Array.isArray(input.actors) ? input.actors : [])
    .map(normalizeActor);

  const nodes = [];
  const nodeIndex = new Map();
  for (const node of [...assertions, ...evidence, ...explicitActors, ...decisions]) {
    addUniqueNode(nodeIndex, nodes, node);
  }

  for (const decision of decisions) {
    const actorKey = refKey({ node_type: "actor", id: decision.actor_id });
    if (!nodeIndex.has(actorKey)) {
      addUniqueNode(nodeIndex, nodes, {
        node_type: "actor",
        id: decision.actor_id,
        actor_kind: "curator",
        attestation: "self_asserted",
      });
    }
    const materialization = materializationFromDecision(decision);
    if (materialization) addUniqueNode(nodeIndex, nodes, materialization);
  }

  const targetAssertions = new Map();
  for (const assertion of assertions) {
    if (!assertion.decision_target) continue;
    const key = targetKey(assertion.decision_target);
    if (targetAssertions.has(key)) {
      throw new Error(`decision target ${assertion.decision_target.kind}:${assertion.decision_target.id} maps to multiple assertion versions`);
    }
    targetAssertions.set(key, assertion);
  }

  const edges = [];
  const edgeKeys = new Set();
  for (const assertion of assertions) {
    for (const ref of assertion.evidence_refs) {
      addEdge(
        edges,
        edgeKeys,
        "supported_by",
        assertion,
        { node_type: "evidence", id: ref.id },
        { evidence_kind: ref.kind },
      );
    }
    for (const ref of assertion.produced_by_refs) {
      addEdge(
        edges,
        edgeKeys,
        "produced_by",
        assertion,
        { node_type: "evidence", id: ref.id },
        { evidence_kind: ref.kind },
      );
    }
    if (assertion.supersedes_assertion_id) {
      addEdge(
        edges,
        edgeKeys,
        "supersedes",
        assertion,
        { node_type: "assertion", id: assertion.supersedes_assertion_id },
      );
    }
  }

  for (const decision of decisions) {
    const assertion = targetAssertions.get(targetKey(decision.target));
    if (!assertion) {
      throw new Error(`decision ${decision.id} target ${decision.target.kind}:${decision.target.id} has no assertion`);
    }
    addEdge(edges, edgeKeys, "shaped_by", assertion, decision);
    addEdge(
      edges,
      edgeKeys,
      "made_by",
      decision,
      { node_type: "actor", id: decision.actor_id },
    );
    for (const ref of normalizedReferences(decision.receipt.evidence_refs, `${decision.id}.evidence_refs`)) {
      addEdge(
        edges,
        edgeKeys,
        "considered",
        decision,
        { node_type: "evidence", id: ref.id },
        { evidence_kind: ref.kind },
      );
    }
    if (decision.reverses_decision_id) {
      addEdge(
        edges,
        edgeKeys,
        "reverses",
        decision,
        { node_type: "decision", id: decision.reverses_decision_id },
      );
    }
    const materialization = materializationFromDecision(decision);
    if (materialization) addEdge(edges, edgeKeys, "materialized_as", assertion, materialization);
  }

  nodes.sort((left, right) => refKey(left).localeCompare(refKey(right)));
  edges.sort((left, right) => refKey(left.from).localeCompare(refKey(right.from))
    || left.edge_type.localeCompare(right.edge_type)
    || refKey(left.to).localeCompare(refKey(right.to)));

  const current_assertions = assertions.map((assertion) => {
    const history = decisions
      .filter((decision) => targetKey(decision.target) === targetKey(assertion.decision_target || { kind: "none", id: "none" }))
      .map((decision) => decision.receipt);
    const current = projectCurationVerdictState(history, assertion.decision_target?.id || "");
    return {
      assertion_id: assertion.id,
      state: current.state,
      active: current.state === "accepted" && Boolean(current.edge),
      decision_count: current.receipt_count,
      active_decision_id: current.active_receipt_id,
      materialized_entity_link_id: current.edge?.id || null,
    };
  });

  const graph = {
    schema_version: PROVENANCE_GRAPH_SCHEMA_VERSION,
    nodes,
    edges,
    adjacency: [],
    current_assertions,
  };
  const validation = validateProvenanceGraph(graph);
  if (!validation.valid) throw new Error(validationMessage(validation.errors[0]));
  graph.adjacency = buildAdjacency(nodes, edges);
  return graph;
}

function graphNodeIndex(graph) {
  return new Map((Array.isArray(graph?.nodes) ? graph.nodes : []).map((node) => [refKey(node), node]));
}

/** Traverse the stored adjacency in either direction without changing the read model. */
export function walkProvenance(graph, start, options = {}) {
  const direction = options.direction || "outgoing";
  if (!new Set(["outgoing", "incoming", "both"]).has(direction)) {
    throw new Error(`unsupported traversal direction ${direction}`);
  }
  const maxDepth = options.max_depth == null ? Number.POSITIVE_INFINITY : Number(options.max_depth);
  if (maxDepth !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    throw new Error("max_depth must be a non-negative integer");
  }
  const startRef = {
    node_type: cleanKind(start?.node_type, "start.node_type"),
    id: cleanToken(start?.id, "start.id"),
  };
  const nodesByRef = graphNodeIndex(graph);
  if (!nodesByRef.has(refKey(startRef))) {
    throw new Error(`unknown provenance node ${startRef.node_type}:${startRef.id}`);
  }
  const adjacency = new Map((Array.isArray(graph?.adjacency) ? graph.adjacency : [])
    .map((entry) => [refKey(entry), entry]));
  const visited = new Set([refKey(startRef)]);
  const traversedEdges = new Map();
  const queue = [{ reference: startRef, depth: 0 }];

  while (queue.length) {
    const { reference, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const entry = adjacency.get(refKey(reference));
    if (!entry) continue;
    const relations = [];
    if (direction === "outgoing" || direction === "both") {
      relations.push(...entry.outgoing.map((edge) => ({
        edge_type: edge.edge_type,
        from: reference,
        to: edge.to,
      })));
    }
    if (direction === "incoming" || direction === "both") {
      relations.push(...entry.incoming.map((edge) => ({
        edge_type: edge.edge_type,
        from: edge.from,
        to: reference,
      })));
    }
    for (const edge of relations) {
      const edgeKey = `${edge.edge_type}\0${refKey(edge.from)}\0${refKey(edge.to)}`;
      traversedEdges.set(edgeKey, edge);
      const next = refKey(edge.from) === refKey(reference) ? edge.to : edge.from;
      const key = refKey(next);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ reference: next, depth: depth + 1 });
    }
  }

  return {
    start: startRef,
    nodes: [...visited].map((key) => nodesByRef.get(key)),
    edges: [...traversedEdges.values()],
  };
}

function adjacencyEntry(graph, reference) {
  return (Array.isArray(graph?.adjacency) ? graph.adjacency : [])
    .find((entry) => refKey(entry) === refKey(reference));
}

/** Private, typed assertion → evidence → decision → actor/materialization walk. */
export function provenanceForAssertion(graph, assertionId) {
  const assertionRef = {
    node_type: "assertion",
    id: cleanToken(assertionId, "assertion_id"),
  };
  const nodes = graphNodeIndex(graph);
  const assertion = nodes.get(refKey(assertionRef));
  if (!assertion) throw new Error(`unknown assertion ${assertionRef.id}`);
  const assertionAdjacency = adjacencyEntry(graph, assertionRef);
  const outgoing = assertionAdjacency?.outgoing || [];
  const evidenceIds = new Set(outgoing
    .filter((edge) => edge.edge_type === "supported_by" || edge.edge_type === "produced_by")
    .map((edge) => refKey(edge.to)));
  const decisions = outgoing
    .filter((edge) => edge.edge_type === "shaped_by")
    .map((edge) => nodes.get(refKey(edge.to)))
    .filter(Boolean)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  const actorIds = new Set();
  for (const decision of decisions) {
    const entry = adjacencyEntry(graph, decision);
    for (const edge of entry?.outgoing || []) {
      if (edge.edge_type === "considered") evidenceIds.add(refKey(edge.to));
      if (edge.edge_type === "made_by") actorIds.add(refKey(edge.to));
    }
  }
  const materializations = outgoing
    .filter((edge) => edge.edge_type === "materialized_as")
    .map((edge) => nodes.get(refKey(edge.to)))
    .filter(Boolean);
  const current = (Array.isArray(graph?.current_assertions) ? graph.current_assertions : [])
    .find((state) => state.assertion_id === assertion.id) || null;
  return {
    assertion,
    evidence: [...evidenceIds].map((key) => nodes.get(key)).filter(Boolean),
    decisions,
    actors: [...actorIds].map((key) => nodes.get(key)).filter(Boolean),
    materializations,
    current,
  };
}

function presentFields(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value != null && value !== ""));
}

/** Explicit public allowlist; never serializes decision receipts or actor nodes. */
export function publicProvenanceProjection(graph, assertionId) {
  const provenance = provenanceForAssertion(graph, assertionId);
  const assertion = provenance.assertion;
  const evidence_sources = provenance.evidence
    .filter((node) => node.kind === "source_record" || node.kind === "source_field")
    .map((node) => presentFields({
      kind: node.kind,
      source_system: node.source_system,
      source_system_id: node.source_system_id,
      source_url: node.source_url,
      observed_at: node.observed_at,
    }));
  return {
    schema_version: PROVENANCE_PUBLIC_SCHEMA_VERSION,
    assertion: presentFields({
      assertion_id: assertion.id,
      assertion_key: assertion.assertion_key,
      version: assertion.version,
      claim_class: assertion.claim_class,
      assertion_kind: assertion.assertion_kind,
      predicate: assertion.predicate,
      warrant_class: assertion.warrant_class,
    }),
    evidence_sources,
    publication: {
      active: Boolean(provenance.current?.active),
    },
  };
}
