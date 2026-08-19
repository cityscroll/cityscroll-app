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

const REQUIRED_PARITY_FIELDS = [
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
const REQUIRED_TESTS = [
  "direct-provider",
  "availability-states",
  "json-byte-parity",
  "html-byte-parity",
  "public-redaction",
  "record-limit",
];

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function verifyCapabilityEvidence(receipt) {
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
  if (!same(receipt.parity_fields, REQUIRED_PARITY_FIELDS)) {
    throw new Error("capability evidence parity fields drifted");
  }
  if (receipt.redaction?.authority !== "entity_resolution/publication/dossier.mjs") {
    throw new Error("capability evidence redaction authority drifted");
  }
  const tests = new Map((receipt.test_results || []).map((entry) => [entry.id, entry]));
  for (const id of REQUIRED_TESTS) {
    if (tests.get(id)?.status !== "pass") {
      throw new Error(`capability evidence test is not passing: ${id}`);
    }
  }
  return true;
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
