// Bounded public civic relationship graph.
//
// This serializer constructs a new allowlisted graph from linked public source
// observations. It never emits an unlabeled edge, matcher score, desk state, or
// arbitrary relationship inferred from proximity in a source record.

import { assertionSnapshot } from "../review/assertion_evidence.mjs";
import { buildPersonLeaderEntity } from "../leaders/index.mjs";
import { routeCrossSpineEdges } from "../cross_domain/edge_policy.mjs";

export const PUBLIC_RELATIONSHIP_GRAPH_VERSION = "public_relationship_graph_v3";
export const PUBLIC_GRAPH_MAX_DEPTH = 2;
export const PUBLIC_GRAPH_MAX_FAN_OUT = 25;
export const PUBLIC_GRAPH_DEFAULT_DEPTH = 2;
export const PUBLIC_GRAPH_DEFAULT_FAN_OUT = 12;

export const PUBLIC_GRAPH_NODE_TYPES = Object.freeze([
  "vendor",
  "agency",
  "solicitation",
  "contract",
  "award",
  // Official person-level identity for Council roll-call votes (meeting outcomes).
  "official",
  // Publisher-backed agency principal officer.
  "person-leader",
  "mandate",
  "project",
  "procedure",
  "borough",
  "community-district",
  "council-district",
]);

export const PUBLIC_GRAPH_EDGE_TYPES = Object.freeze([
  "named_vendor_on_award",
  "named_vendor_on_solicitation",
  "published_by_agency",
  "references_contract",
  // official → matter|agenda_item (populated from retained Legistar person votes).
  "votes_on",
  // agency → person-leader (from the agency governance crosswalk).
  "agency_led_by",
  "mandate_governs_procedure",
  "project_participates_in_procedure",
  "located_in",
]);

export const PUBLIC_GRAPH_EDGE_LABELS = Object.freeze({
  named_vendor_on_award: "Named vendor on award",
  named_vendor_on_solicitation: "Named vendor on solicitation",
  published_by_agency: "Published by agency",
  references_contract: "References contract",
  votes_on: "Votes on",
  agency_led_by: "Agency led by",
  mandate_governs_procedure: "Mandate governs procedure",
  project_participates_in_procedure: "Project participates in procedure",
  located_in: "Located in",
});

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function publicEntity(row) {
  const id = clean(row?.entity_id ?? row?.id);
  const type = clean(row?.entity_type ?? row?.type);
  const name = clean(row?.display_name ?? row?.name);
  return id && type && name ? { id, type, name } : null;
}

function safeUrl(value) {
  const candidate = clean(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function field(raw, aliases) {
  for (const name of aliases) {
    const value = clean(raw?.[name]);
    if (value) return { name, value };
  }
  return null;
}

function sourceFor(row, raw) {
  const system = clean(row.source_system);
  const id = clean(row.source_system_id);
  if (!system || !id) return null;
  const source = { system, id };
  const supplied = safeUrl(raw.source_url ?? raw.record_url ?? raw.url);
  if (supplied) source.url = supplied;
  else if (system === "city_record") {
    source.url = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  }
  return source;
}

function sourceRecordType(raw) {
  const noticeType = field(raw, [
    "type_of_notice_description",
    "notice_type",
    "record_type",
    "type",
  ]);
  if (!noticeType) return null;
  const normalized = noticeType.value.toLowerCase();
  if (/\baward\b/.test(normalized)) return { type: "award", field: noticeType };
  if (/\bsolicitation\b|\brequest for\b|\brf[pxq]\b|\binvitation (?:for|to) bid\b/.test(normalized)) {
    return { type: "solicitation", field: noticeType };
  }
  if (/\bcontract\b/.test(normalized)) return { type: "contract", field: noticeType };
  return null;
}

function stableTextId(type, value) {
  return `${type}:name:${encodeURIComponent(clean(value).toLowerCase())}`;
}

function sourceNodeId(type, source) {
  return `${type}:${encodeURIComponent(source.system)}:${encodeURIComponent(source.id)}`;
}

function publicProvenance(source, observedAt, sourceFields) {
  return {
    source,
    source_fields: [...new Set(sourceFields.map(clean).filter(Boolean))].sort(),
    observed_at: clean(observedAt),
  };
}

function publicConfidence() {
  return { status: "not_scored", basis: "publisher_record" };
}

function addNode(nodes, node) {
  if (!node?.id || !PUBLIC_GRAPH_NODE_TYPES.includes(node.type)) return;
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function edgeId(edge) {
  return [
    "edge",
    edge.type,
    edge.from,
    edge.to,
    edge.provenance.source.system,
    edge.provenance.source.id,
  ].map((part) => encodeURIComponent(clean(part))).join(":");
}

function addEdge(edges, edge) {
  if (!PUBLIC_GRAPH_EDGE_TYPES.includes(edge.type)) return;
  const complete = {
    ...edge,
    id: edgeId(edge),
    label: PUBLIC_GRAPH_EDGE_LABELS[edge.type],
    confidence: edge.confidence || publicConfidence(),
  };
  if (!edges.has(complete.id)) edges.set(complete.id, complete);
}

function observationGraph(root, row) {
  const raw = assertionSnapshot(row.raw_snapshot);
  const source = sourceFor(row, raw);
  const observedAt = clean(row.ingested_at);
  const recordType = sourceRecordType(raw);
  if (!source || !observedAt || !recordType) return { nodes: [], edges: [] };

  const title = field(raw, ["short_title", "title", "description"]);
  const vendor = field(raw, ["vendor_name", "payee_name", "entity_name"]);
  const agency = field(raw, ["agency_name", "contracting_agency", "agency"]);
  const contract = field(raw, ["contract_id", "prime_contract_id", "contract_number"]);
  const procurementId = field(raw, ["epin", "epin_number", "pin", "pin_number"]);
  const recordId = sourceNodeId(recordType.type, source);
  const recordName = title?.value
    || `${recordType.type[0].toUpperCase()}${recordType.type.slice(1)} · ${procurementId?.value || source.id}`;
  const provenanceFields = [recordType.field.name, title?.name, procurementId?.name].filter(Boolean);
  const nodes = [{
    id: recordId,
    type: recordType.type,
    name: recordName,
    classification: "source_observation",
    provenance: publicProvenance(source, observedAt, provenanceFields),
    confidence: publicConfidence(),
  }];
  const edges = [];

  if (vendor && recordType.type === "award") {
    edges.push({
      type: "named_vendor_on_award",
      from: root.id,
      to: recordId,
      provenance: publicProvenance(source, observedAt, [vendor.name, recordType.field.name]),
    });
  } else if (vendor && recordType.type === "solicitation") {
    edges.push({
      type: "named_vendor_on_solicitation",
      from: root.id,
      to: recordId,
      provenance: publicProvenance(source, observedAt, [vendor.name, recordType.field.name]),
    });
  }

  if (agency) {
    const agencyId = stableTextId("agency", agency.value);
    nodes.push({
      id: agencyId,
      type: "agency",
      name: agency.value,
      classification: "source_assertion",
      provenance: publicProvenance(source, observedAt, [agency.name]),
      confidence: publicConfidence(),
    });
    edges.push({
      type: "published_by_agency",
      from: recordId,
      to: agencyId,
      provenance: publicProvenance(source, observedAt, [recordType.field.name, agency.name]),
    });

    const headName = field(raw, ["agency_head_name", "head_name"]);
    const headTitle = field(raw, ["agency_head_title", "head_title"]);
    const leader = buildPersonLeaderEntity({
      agencyId,
      agencyName: agency.value,
      headName: headName?.value,
      headTitle: headTitle?.value,
    });
    if (leader) {
      nodes.push({
        id: leader.id,
        type: leader.entity_type,
        name: leader.display_name,
        role: leader.role,
        classification: "publisher_assertion",
        provenance: publicProvenance(source, observedAt, [headName.name, headTitle?.name, agency.name].filter(Boolean)),
        confidence: leader.confidence,
      });
      edges.push({
        type: "agency_led_by",
        from: agencyId,
        to: leader.id,
        confidence: leader.confidence,
        provenance: publicProvenance(source, observedAt, [headName.name, headTitle?.name, agency.name].filter(Boolean)),
      });
    }
  }

  if (contract && recordType.type === "award") {
    const contractId = stableTextId("contract", contract.value);
    nodes.push({
      id: contractId,
      type: "contract",
      name: `Contract ${contract.value}`,
      classification: "source_assertion",
      provenance: publicProvenance(source, observedAt, [contract.name]),
      confidence: publicConfidence(),
    });
    edges.push({
      type: "references_contract",
      from: recordId,
      to: contractId,
      provenance: publicProvenance(source, observedAt, [recordType.field.name, contract.name]),
    });
  }

  return { nodes, edges };
}

function requestedInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function selectedTypes(requested, allowlist) {
  const list = Array.isArray(requested) ? requested.map(clean).filter(Boolean) : [];
  return list.length ? new Set(list.filter((value) => allowlist.includes(value))) : new Set(allowlist);
}

/**
 * Convert linked canonical-entity/source rows into a bounded public graph.
 * Unsupported records and relationships are omitted rather than inferred.
 */
export function serializePublicRelationshipGraph(rows = [], opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const root = publicEntity(list[0]);
  if (!root || !PUBLIC_GRAPH_NODE_TYPES.includes(root.type)) return null;

  const requestedDepth = requestedInteger(opts.depth, PUBLIC_GRAPH_DEFAULT_DEPTH);
  const requestedFanOut = requestedInteger(opts.fanOut, PUBLIC_GRAPH_DEFAULT_FAN_OUT);
  const depth = Math.min(requestedDepth, PUBLIC_GRAPH_MAX_DEPTH);
  const fanOut = Math.min(requestedFanOut, PUBLIC_GRAPH_MAX_FAN_OUT);
  const nodeTypes = selectedTypes(opts.nodeTypes, PUBLIC_GRAPH_NODE_TYPES);
  const edgeTypes = selectedTypes(opts.edgeTypes, PUBLIC_GRAPH_EDGE_TYPES);
  const allNodes = new Map([[root.id, {
    ...root,
    classification: "canonical_entity",
    confidence: { status: "not_published", basis: "canonical_link" },
  }]]);
  const allEdges = new Map();

  for (const row of list) {
    const observation = observationGraph(root, row);
    for (const node of observation.nodes) addNode(allNodes, node);
    for (const edge of observation.edges) addEdge(allEdges, edge);
  }

  for (const node of Array.isArray(opts.crossSpineNodes) ? opts.crossSpineNodes : []) {
    addNode(allNodes, node);
  }

  // Optional cross-spine candidates use the same automatic router as the
  // materialized intelligence surface. Evidence-only and no-edge routes never
  // enter the public graph, even when a caller supplies them here.
  const routedCrossSpine = routeCrossSpineEdges(opts.crossSpineEdges || [], {
    policy: opts.crossSpinePolicy,
  });
  for (const edge of routedCrossSpine.public_edges) addEdge(allEdges, edge);

  const eligibleNodes = new Set([root.id]);
  for (const node of allNodes.values()) {
    if (nodeTypes.has(node.type)) eligibleNodes.add(node.id);
  }
  const sortedEdges = [...allEdges.values()] // Derived from allowlisted public observations above.
    .filter((edge) => edgeTypes.has(edge.type)
      && eligibleNodes.has(edge.from)
      && eligibleNodes.has(edge.to))
    .sort((left, right) => left.from.localeCompare(right.from)
      || left.type.localeCompare(right.type)
      || left.to.localeCompare(right.to)
      || left.id.localeCompare(right.id));

  const includedNodeIds = new Set([root.id]);
  const includedEdges = [];
  const includedEdgeIds = new Set();
  let frontier = [root.id];
  let fanOutReached = false;
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next = new Set();
    for (const from of [...frontier].sort()) {
      const incident = sortedEdges.filter((edge) => !includedEdgeIds.has(edge.id)
        && (edge.from === from || edge.to === from));
      if (incident.length > fanOut) fanOutReached = true;
      for (const edge of incident.slice(0, fanOut)) {
        includedEdges.push(edge);
        includedEdgeIds.add(edge.id);
        const other = edge.from === from ? edge.to : edge.from;
        if (!includedNodeIds.has(other)) next.add(other);
        includedNodeIds.add(edge.from);
        includedNodeIds.add(edge.to);
      }
    }
    frontier = [...next];
  }

  const boundaryReached = [];
  if (requestedDepth > PUBLIC_GRAPH_MAX_DEPTH) boundaryReached.push("depth");
  if (requestedFanOut > PUBLIC_GRAPH_MAX_FAN_OUT || fanOutReached) boundaryReached.push("fan_out");
  const truncated = boundaryReached.length > 0;
  const observedTimes = includedEdges.map((edge) => edge.provenance.observed_at).filter(Boolean).sort();

  return {
    version: PUBLIC_RELATIONSHIP_GRAPH_VERSION,
    root,
    bounds: {
      requested_depth: requestedDepth,
      applied_depth: depth,
      max_depth: PUBLIC_GRAPH_MAX_DEPTH,
      requested_fan_out: requestedFanOut,
      applied_fan_out: fanOut,
      max_fan_out: PUBLIC_GRAPH_MAX_FAN_OUT,
      truncated,
      boundary_reached: boundaryReached,
      note: truncated
        ? "Traversal stopped at the published boundary; additional relationships may exist."
        : "This graph is limited to the displayed linked public records; absence is not proof that no relationship exists.",
    },
    scope: {
      completeness: "linked_public_records_only",
      observed_from: observedTimes[0] || "",
      observed_through: observedTimes.at(-1) || "",
    },
    edge_routing: routedCrossSpine.counts,
    nodes: [...includedNodeIds]
      .map((id) => allNodes.get(id))
      .filter(Boolean)
      .sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id)),
    edges: includedEdges,
  };
}
