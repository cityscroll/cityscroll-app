#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENTITY_DOSSIER_AVAILABILITY,
  ENTITY_DOSSIER_CAPABILITY_REFERENCE,
  ENTITY_DOSSIER_CAPABILITY_VERSION,
  ENTITY_DOSSIER_LIMITS,
  ENTITY_DOSSIER_PROVIDER_ID,
  ENTITY_DOSSIER_PUBLIC_SCHEMA_VERSION,
  ENTITY_DOSSIER_REPRESENTATIONS,
} from "../capabilities/entity_dossier.mjs";
import {
  ENTITY_RELATIONSHIPS_AVAILABILITY,
  ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
  ENTITY_RELATIONSHIPS_CAPABILITY_VERSION,
  ENTITY_RELATIONSHIPS_EDGE_TYPES,
  ENTITY_RELATIONSHIPS_LIMITS,
  ENTITY_RELATIONSHIPS_NODE_TYPES,
  ENTITY_RELATIONSHIPS_PROVIDER_ID,
  ENTITY_RELATIONSHIPS_PUBLIC_SCHEMA_VERSION,
  ENTITY_RELATIONSHIPS_REPRESENTATIONS,
} from "../capabilities/entity_relationships.mjs";
import {
  CITED_PASSAGES_AVAILABILITY,
  CITED_PASSAGES_CAPABILITY_REFERENCE,
  CITED_PASSAGES_CAPABILITY_VERSION,
  CITED_PASSAGES_CONTRACT_VERSION,
  CITED_PASSAGES_EXACT_JOIN_METHOD,
  CITED_PASSAGES_LIMITS,
  CITED_PASSAGES_PROVIDER_ID,
  CITED_PASSAGES_REPRESENTATIONS,
  CITED_PASSAGES_RESPONSE_SCHEMA,
  CITED_PASSAGES_SOURCE_FAMILIES,
} from "../capabilities/cited_passages.mjs";
import {
  MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS,
  MCP_PUBLIC_READ_ANNOTATIONS,
} from "../capabilities/mcp_tool_declarations.mjs";
import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";

const REMOTE_MCP_STATIC_READ_TOOLS = new Set([
  "search_federated",
  "retrieve_cited_passages",
  "get_contract",
  "browse_contracts",
  "get_person_or_organization",
  "browse_organizations",
]);

const DOSSIER_REQUIRED_PARITY_FIELDS = [
  "version",
  "entity.id",
  "entity.type",
  "entity.name",
  "scope.record_limit",
  "scope.truncated",
  "linked_records.length",
  "assertions",
  "derived_assertions",
  "provenance",
  "redaction",
];
const DOSSIER_REQUIRED_TESTS = [
  "direct-provider",
  "availability-states",
  "json-byte-parity",
  "html-byte-parity",
  "public-redaction",
  "record-limit",
];
const RELATIONSHIPS_REQUIRED_PARITY_FIELDS = [
  "version",
  "root.id",
  "root.type",
  "root.name",
  "node_ids",
  "edge_ids",
  "bounds",
  "scope",
  "edge_routing",
  "edges[].provenance",
  "edges[].confidence",
  "redaction",
];
const RELATIONSHIPS_REQUIRED_TESTS = [
  "direct-provider",
  "availability-states",
  "closed-vocabulary",
  "bounded-input",
  "depth-fan-out-ceilings",
  "json-byte-parity",
  "html-byte-parity",
  "public-redaction",
];
const RELATIONSHIPS_FIXTURE_NODE_IDS = [
  "agency:name:department%20of%20design%20and%20construction",
  "award:city_record:20260730001",
  "contract:name:ct-850-1",
  "solicitation:city_record:20260730002",
  "vendor:stem:ACME CONSTRUCTION",
];
const RELATIONSHIPS_FIXTURE_EDGE_IDS = [
  "edge:named_vendor_on_award:vendor%3Astem%3AACME%20CONSTRUCTION:award%3Acity_record%3A20260730001:city_record:20260730001",
  "edge:named_vendor_on_solicitation:vendor%3Astem%3AACME%20CONSTRUCTION:solicitation%3Acity_record%3A20260730002:city_record:20260730002",
  "edge:published_by_agency:award%3Acity_record%3A20260730001:agency%3Aname%3Adepartment%2520of%2520design%2520and%2520construction:city_record:20260730001",
  "edge:references_contract:award%3Acity_record%3A20260730001:contract%3Aname%3Act-850-1:city_record:20260730001",
  "edge:published_by_agency:solicitation%3Acity_record%3A20260730002:agency%3Aname%3Adepartment%2520of%2520design%2520and%2520construction:city_record:20260730002",
];
const CITED_PASSAGES_REQUIRED_PARITY_FIELDS = [
  "schema",
  "contract_version",
  "query",
  "retrieval.method",
  "retrieval.corpus",
  "retrieval.index",
  "hard_scope",
  "coverage",
  "citations[].citation_id",
  "citations[].source",
  "citations[].passage",
  "citations[].freshness",
  "citations[].exact_join_evidence",
];
const CITED_PASSAGES_REQUIRED_TESTS = [
  "direct-provider",
  "all-source-families",
  "bounded-input-output",
  "exact-join-provenance",
  "score-answer-relationship-redaction",
  "mcp-structured-byte-parity",
  "mcp-text-meaning-parity",
];
const CITED_PASSAGES_FIXTURES = Object.freeze({
  attachment_text: {
    query: "forest management",
    response_sha256: "794eac7cf702f530e83872cded589f970530d051222689416a92d52cc400d6ab",
    citation_ids: [
      "attachment_text:20240515016%23attachment-37470:p0001",
      "attachment_text:20240515016%23attachment-37470:p0002",
    ],
  },
  city_record_notice: {
    query: "energy conservation",
    response_sha256: "aecc3836d330a30ffdefdbba82237f5e8565fdc687333258036872d96c9eeb90",
    citation_ids: ["city_record_notice:20260715041:p0001"],
  },
  community_board_minutes: {
    query: "mountain bike trail",
    response_sha256: "90605850ab818f020c4cf56d261dfe74b84458843374de276683e426ea905afb",
    citation_ids: [
      "community_board_minutes:queens-cb-08%3A2026-06-10%3Aminutes:p0003",
      "community_board_minutes:queens-cb-08%3A2026-06-10%3Aminutes:p0002",
    ],
  },
});
const SHA256 = /^[a-f0-9]{64}$/;

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameCanonical(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function verifyDossierEvidence(receipt) {
  if (receipt?.schema !== "cityscroll.capability_evidence.v1") {
    throw new Error("capability evidence schema is invalid");
  }
  if (receipt.card !== "cs-02-entity-dossier-capability") {
    throw new Error("capability evidence card is invalid");
  }
  const capability = receipt.capability || {};
  if (capability.reference !== ENTITY_DOSSIER_CAPABILITY_REFERENCE
      || capability.version !== ENTITY_DOSSIER_CAPABILITY_VERSION
      || capability.provider_id !== ENTITY_DOSSIER_PROVIDER_ID) {
    throw new Error("capability evidence identity drifted");
  }
  if (!same(capability.availability, ENTITY_DOSSIER_AVAILABILITY)) {
    throw new Error("capability evidence availability drifted");
  }
  if (!same(capability.bounds, ENTITY_DOSSIER_LIMITS)) {
    throw new Error("capability evidence bounds drifted");
  }
  if (!same(
    capability.representations,
    ENTITY_DOSSIER_REPRESENTATIONS.map(({ id, mediaType }) => ({ id, media_type: mediaType })),
  )) {
    throw new Error("capability evidence representations drifted");
  }
  if (receipt.fixture?.entity_id !== "vendor:stem:ACME CONSTRUCTION") {
    throw new Error("capability evidence fixture identity drifted");
  }
  if (!same(receipt.fixture.source_ids, ["city_record:20260730001", "checkbook:CT-850-1"])) {
    throw new Error("capability evidence fixture sources drifted");
  }
  if (receipt.fixture.dossier_version !== ENTITY_DOSSIER_PUBLIC_SCHEMA_VERSION) {
    throw new Error("capability evidence dossier version drifted");
  }
  if (!same(receipt.parity_fields, DOSSIER_REQUIRED_PARITY_FIELDS)) {
    throw new Error("capability evidence parity fields drifted");
  }
  if (receipt.redaction?.authority !== "entity_resolution/publication/dossier.mjs") {
    throw new Error("capability evidence redaction authority drifted");
  }
  const tests = new Map((receipt.test_results || []).map((entry) => [entry.id, entry]));
  for (const id of DOSSIER_REQUIRED_TESTS) {
    if (tests.get(id)?.status !== "pass") {
      throw new Error(`capability evidence test is not passing: ${id}`);
    }
  }
  return true;
}

function verifyRelationshipsEvidence(receipt) {
  const capability = receipt.capability || {};
  if (capability.reference !== ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE
      || capability.version !== ENTITY_RELATIONSHIPS_CAPABILITY_VERSION
      || capability.provider_id !== ENTITY_RELATIONSHIPS_PROVIDER_ID) {
    throw new Error("relationship capability evidence identity drifted");
  }
  if (!same(capability.availability, ENTITY_RELATIONSHIPS_AVAILABILITY)
      || !same(capability.bounds, ENTITY_RELATIONSHIPS_LIMITS)
      || !same(capability.node_types, ENTITY_RELATIONSHIPS_NODE_TYPES)
      || !same(capability.edge_types, ENTITY_RELATIONSHIPS_EDGE_TYPES)) {
    throw new Error("relationship capability contract drifted");
  }
  if (!same(
    capability.representations,
    ENTITY_RELATIONSHIPS_REPRESENTATIONS.map(({ id, mediaType }) => ({ id, media_type: mediaType })),
  )) {
    throw new Error("relationship capability representations drifted");
  }
  if (receipt.fixture?.entity_id !== "vendor:stem:ACME CONSTRUCTION"
      || receipt.fixture.graph_version !== ENTITY_RELATIONSHIPS_PUBLIC_SCHEMA_VERSION
      || !same(receipt.fixture.source_ids, ["city_record:20260730001", "city_record:20260730002"])) {
    throw new Error("relationship capability fixture drifted");
  }
  if (!same(receipt.fixture.node_ids, RELATIONSHIPS_FIXTURE_NODE_IDS)
      || !same(receipt.fixture.edge_ids, RELATIONSHIPS_FIXTURE_EDGE_IDS)
      || receipt.fixture.graph_sha256 !== "ef33517f3e3e373f16ba0b7adc798eb2e84962a5099830389c755361dbe11f89") {
    throw new Error("relationship capability graph identity drifted");
  }
  if (!same(receipt.fixture.requested_bounds, { depth: 2, fan_out: 12 })
      || !same(receipt.fixture.applied_bounds, { depth: 2, fan_out: 12, max_depth: 2, max_fan_out: 25 })) {
    throw new Error("relationship capability fixture bounds drifted");
  }
  if (!same(receipt.parity_fields, RELATIONSHIPS_REQUIRED_PARITY_FIELDS)) {
    throw new Error("relationship capability parity fields drifted");
  }
  if (receipt.redaction?.authority !== "entity_resolution/publication/relationship_graph.mjs") {
    throw new Error("relationship capability redaction authority drifted");
  }
  const evidence = receipt.edge_evidence;
  if (!Array.isArray(evidence) || evidence.length !== RELATIONSHIPS_FIXTURE_EDGE_IDS.length) {
    throw new Error("relationship capability edge evidence is incomplete");
  }
  for (const edge of evidence) {
    if (!RELATIONSHIPS_FIXTURE_EDGE_IDS.includes(edge.id)
        || !/^city_record:2026073000[12]$/.test(edge.source || "")
        || !Array.isArray(edge.source_fields) || !edge.source_fields.length
        || !edge.observed_at
        || !edge.confidence?.status || !edge.confidence?.basis) {
      throw new Error("relationship capability edge evidence drifted");
    }
  }
  const tests = new Map((receipt.test_results || []).map((entry) => [entry.id, entry]));
  for (const id of RELATIONSHIPS_REQUIRED_TESTS) {
    if (tests.get(id)?.status !== "pass") {
      throw new Error(`relationship capability evidence test is not passing: ${id}`);
    }
  }
  return true;
}

function verifyCitedPassagesEvidence(receipt) {
  const capability = receipt.capability || {};
  if (capability.reference !== CITED_PASSAGES_CAPABILITY_REFERENCE
      || capability.version !== CITED_PASSAGES_CAPABILITY_VERSION
      || capability.provider_id !== CITED_PASSAGES_PROVIDER_ID
      || capability.response_schema !== CITED_PASSAGES_RESPONSE_SCHEMA
      || capability.contract_version !== CITED_PASSAGES_CONTRACT_VERSION) {
    throw new Error("cited passage capability evidence identity drifted");
  }
  if (!same(capability.availability, CITED_PASSAGES_AVAILABILITY)
      || !same(capability.bounds, CITED_PASSAGES_LIMITS)
      || !same(capability.source_families, CITED_PASSAGES_SOURCE_FAMILIES)) {
    throw new Error("cited passage capability contract drifted");
  }
  if (!same(
    capability.representations,
    CITED_PASSAGES_REPRESENTATIONS.map(({ id, mediaType }) => ({ id, media_type: mediaType })),
  )) {
    throw new Error("cited passage capability representations drifted");
  }
  const corpusReceipt = receipt.retrieval_receipts?.corpus;
  const passageMapReceipt = receipt.retrieval_receipts?.passage_map;
  if (corpusReceipt?.schema !== "cityscroll.semantic_retrieval.corpus_manifest.v1"
      || corpusReceipt?.manifest_version !== 1
      || !/^[a-f0-9]{64}$/.test(corpusReceipt?.manifest_sha256 || "")
      || !/^[a-f0-9]{64}$/.test(corpusReceipt?.content_sha256 || "")
      || passageMapReceipt?.schema !== "cityscroll.semantic_retrieval.source_passage_map.v1"
      || !/^[a-f0-9]{64}$/.test(passageMapReceipt?.version || "")
      || !/^[a-f0-9]{64}$/.test(passageMapReceipt?.corpus_sha256 || "")) {
    throw new Error("cited passage retrieval receipts drifted");
  }
  if (!same(receipt.parity_fields, CITED_PASSAGES_REQUIRED_PARITY_FIELDS)) {
    throw new Error("cited passage capability parity fields drifted");
  }
  if (receipt.boundary?.maximum_results !== CITED_PASSAGES_LIMITS.maximumResults
      || receipt.boundary?.matched_join_method !== CITED_PASSAGES_EXACT_JOIN_METHOD
      || receipt.boundary?.unknown_join_infers_identifiers !== false
      || receipt.boundary?.public_scores !== "forbidden"
      || receipt.boundary?.generated_answers !== "forbidden"
      || receipt.boundary?.civic_relationships !== "forbidden") {
    throw new Error("cited passage capability boundary drifted");
  }
  const fixtures = new Map((receipt.fixtures || []).map((fixture) => [fixture.source_family, fixture]));
  if (fixtures.size !== CITED_PASSAGES_SOURCE_FAMILIES.length) {
    throw new Error("cited passage source-family fixtures are incomplete");
  }
  for (const [sourceFamily, expected] of Object.entries(CITED_PASSAGES_FIXTURES)) {
    const fixture = fixtures.get(sourceFamily);
    if (!fixture || fixture.query !== expected.query || fixture.limit !== 5
        || fixture.coverage_state !== "partial"
        || fixture.response_sha256 !== expected.response_sha256
        || fixture.corpus_manifest_sha256 !== corpusReceipt.manifest_sha256
        || fixture.corpus_content_sha256 !== corpusReceipt.content_sha256
        || fixture.passage_map_sha256 !== passageMapReceipt.version
        || !same((fixture.citations || []).map(({ citation_id: id }) => id), expected.citation_ids)) {
      throw new Error(`cited passage fixture drifted: ${sourceFamily}`);
    }
    for (const citation of fixture.citations) {
      const evidence = citation.exact_join_evidence;
      if (!/^https:\/\//.test(citation.source_url || "")
          || !/^[a-f0-9]{64}$/.test(citation.passage_text_sha256 || "")
          || citation.coverage_state !== "partial"
          || citation.freshness?.state !== "observed"
          || !citation.freshness?.observed_on
          || !citation.freshness?.source_published_at
          || evidence?.state !== "matched"
          || evidence?.method !== CITED_PASSAGES_EXACT_JOIN_METHOD
          || evidence?.candidate_id !== citation.citation_id
          || evidence?.source_record_id !== citation.source_id
          || evidence?.passage_id !== citation.citation_id) {
        throw new Error(`cited passage evidence drifted: ${citation.citation_id || sourceFamily}`);
      }
    }
  }
  const tests = new Map((receipt.test_results || []).map((entry) => [entry.id, entry]));
  for (const id of CITED_PASSAGES_REQUIRED_TESTS) {
    if (tests.get(id)?.status !== "pass") {
      throw new Error(`cited passage capability evidence test is not passing: ${id}`);
    }
  }
  return true;
}

function verifyRemoteMcpEvidence(receipt) {
  if (receipt?.schema !== "cityscroll.remote_mcp_public_adapter_receipt.v1"
      || receipt.card !== "cs-06-remote-mcp-public-adapter") {
    throw new Error("remote MCP evidence identity is invalid");
  }
  if (receipt.protocol?.transport !== "Streamable HTTP"
      || receipt.protocol?.negotiated_version !== "2025-06-18"
      || receipt.protocol?.endpoint !== "POST /mcp"
      || receipt.protocol?.stateless !== true) {
    throw new Error("remote MCP transport evidence drifted");
  }
  const lock = JSON.parse(readFileSync(new URL("../worker/package-lock.json", import.meta.url), "utf8"));
  const pinnedClientVersion = lock.packages?.["node_modules/@modelcontextprotocol/sdk"]?.version;
  if (receipt.client?.package !== "@modelcontextprotocol/sdk"
      || receipt.client?.version !== pinnedClientVersion
      || receipt.client?.transport !== "StreamableHTTPClientTransport") {
    throw new Error("remote MCP client evidence drifted");
  }
  if (!SHA256.test(receipt.fixture_sha256 || "")) {
    throw new Error("remote MCP fixture hash is invalid");
  }
  const inventory = receipt.public_tool_inventory || [];
  const registry = new Map(CAPABILITY_REGISTRY.map((capability) => [capability.reference, capability]));
  if (inventory.length !== MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.length) {
    throw new Error("remote MCP public tool inventory is incomplete");
  }
  for (let index = 0; index < MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.length; index += 1) {
    const binding = MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS[index];
    const tool = inventory[index];
    const maximumRows = binding.bounds.maximum
      ?? binding.bounds.recordLimit
      ?? binding.bounds.maximumResults;
    if (tool?.name !== binding.name
        || tool.capability_reference !== binding.capabilityReference
        || tool.adapter_id !== binding.adapterId
        || tool.provider_id !== registry.get(binding.capabilityReference)?.provider.id
        || tool.authority_class !== "public_read"
        || tool.operation_class !== "read"
        || tool.store_access !== "provider-only"
        || !sameCanonical(tool.bounds, binding.bounds)
        || !sameCanonical(tool.annotations, MCP_PUBLIC_READ_ANNOTATIONS)
        || tool.calls !== 1
        || !Number.isInteger(tool.store_read_operations)
        || tool.store_read_operations < 0
        || !Number.isInteger(tool.store_rows_read)
        || tool.store_rows_read < 0
        || !SHA256.test(tool.direct_semantic_sha256 || "")
        || tool.direct_semantic_sha256 !== tool.adapter_semantic_sha256
        || tool.parity !== "pass") {
      throw new Error(`remote MCP tool evidence drifted: ${binding.name}`);
    }
    const staticRead = REMOTE_MCP_STATIC_READ_TOOLS.has(binding.name);
    if (staticRead ? tool.store_read_operations !== 0 : tool.store_read_operations < 1) {
      throw new Error(`remote MCP store-read bound drifted: ${binding.name}`);
    }
  }
  if (receipt.request_counts?.initialize !== 1
      || receipt.request_counts?.list_tools !== 1
      || receipt.request_counts?.capability_calls !== 10
      || receipt.request_counts?.post_requests !== 13
      || receipt.request_counts?.optional_get_probe !== 1) {
    throw new Error("remote MCP request counts drifted");
  }
  if (receipt.policy_boundary?.registered_public_tools !== 10
      || receipt.policy_boundary?.mutation_capabilities !== 0
      || receipt.policy_boundary?.raw_store_bindings_exposed !== 0
      || receipt.policy_boundary?.unregistered_public_tools !== 0) {
    throw new Error("remote MCP public-read policy boundary drifted");
  }
  if (!receipt.layers?.semantic_core?.includes("transport-neutral")
      || !receipt.layers?.adapter_policy?.includes("worker/src/mcp.mjs")
      || receipt.layers?.cloudflare_os_runtime !== "downstream and not built by cs-06") {
    throw new Error("remote MCP layer separation drifted");
  }
  if (receipt.source_scan?.core_transport_imports !== 0
      || receipt.source_scan?.core_cloudflare_agents_imports !== 0
      || receipt.source_scan?.adapter_cloudflare_os_imports !== 0
      || receipt.status !== "pass") {
    throw new Error("remote MCP boundary scan did not pass");
  }
  return true;
}

export function verifyCapabilityEvidence(receipt) {
  if (receipt?.card === "cs-06-remote-mcp-public-adapter") {
    return verifyRemoteMcpEvidence(receipt);
  }
  if (receipt?.schema !== "cityscroll.capability_evidence.v1") {
    throw new Error("capability evidence schema is invalid");
  }
  if (receipt.card === "cs-02-entity-dossier-capability") return verifyDossierEvidence(receipt);
  if (receipt.card === "cs-03-entity-relationships-capability") return verifyRelationshipsEvidence(receipt);
  if (receipt.card === "cs-04-cited-passages-capability") return verifyCitedPassagesEvidence(receipt);
  throw new Error("capability evidence card is invalid");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node tools/verify_capability_evidence.mjs <receipt.json>");
    process.exitCode = 2;
  } else {
    try {
      const receipt = JSON.parse(readFileSync(resolve(path), "utf8"));
      verifyCapabilityEvidence(receipt);
      process.stdout.write(`capability evidence verified: ${path}\n`);
    } catch (error) {
      console.error(String(error?.message || error));
      process.exitCode = 1;
    }
  }
}
