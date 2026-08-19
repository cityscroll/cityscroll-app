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

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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

export function verifyCapabilityEvidence(receipt) {
  if (receipt?.schema !== "cityscroll.capability_evidence.v1") {
    throw new Error("capability evidence schema is invalid");
  }
  if (receipt.card === "cs-02-entity-dossier-capability") return verifyDossierEvidence(receipt);
  if (receipt.card === "cs-03-entity-relationships-capability") return verifyRelationshipsEvidence(receipt);
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
