#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  receiptSemanticPayload,
  sha256Canonical,
} from "./run_capability_semantic_scout.mjs";

const REQUIRED_REFERENCES = [
  "notice.search@1",
  "entity.dossier.get@1",
  "entity.relationships.get@1",
  "cited.passages.retrieve@1",
];

function display(value) {
  const serialized = canonicalJson(value) ?? String(value);
  return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized;
}

export function semanticDiff(expected, actual, path = "", differences = []) {
  if (differences.length >= 50) return differences;
  if (Object.is(expected, actual)) return differences;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      semanticDiff(expected[index], actual[index], `${path}[${index}]`, differences);
    }
    return differences;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object"
      && !Array.isArray(expected) && !Array.isArray(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) semanticDiff(expected[key], actual[key], path ? `${path}.${key}` : key, differences);
    return differences;
  }
  differences.push(`${path || "$"}: expected ${display(expected)}, actual ${display(actual)}`);
  return differences;
}

export function verifyCapabilitySemanticScout(receipt) {
  const failures = [];
  if (receipt?.schema !== "cityscroll.capability_semantic_scout_receipt.v1") {
    failures.push("schema: expected cityscroll.capability_semantic_scout_receipt.v1");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(receipt?.generated_at || "")) {
    failures.push("generated_at: expected an explicit UTC timestamp");
  }
  if (!/^[a-f0-9]{64}$/.test(receipt?.fixture?.sha256 || "")) failures.push("fixture.sha256: invalid");
  const references = (receipt?.registry || []).map(({ reference }) => reference);
  if (canonicalJson(references) !== canonicalJson(REQUIRED_REFERENCES)) {
    failures.push(`registry: expected exactly ${REQUIRED_REFERENCES.join(", ")}`);
  }
  const checks = receipt?.checks || [];
  if (canonicalJson(checks.map(({ capability_reference: reference }) => reference)) !== canonicalJson(REQUIRED_REFERENCES)) {
    failures.push("checks: expected exactly one ordered check for every registered capability");
  }
  const boundary = receipt?.runtime_boundary || {};
  for (const field of ["network_calls", "model_calls", "browser_actions", "production_writes", "transport_imports"]) {
    if (boundary[field] !== 0) failures.push(`runtime_boundary.${field}: expected 0, actual ${display(boundary[field])}`);
  }
  if (boundary.cloudflare_os_required !== false) {
    failures.push("runtime_boundary.cloudflare_os_required: expected false");
  }

  for (const [index, check] of checks.entries()) {
    const prefix = `checks[${index}]`;
    const expectedHash = sha256Canonical(check.expected_projection);
    const actualHash = sha256Canonical(check.actual_projection);
    if (check.provider_parity?.static_projection_sha256 !== expectedHash) {
      failures.push(`${prefix}.provider_parity.static_projection_sha256: hash does not match expected projection`);
    }
    if (check.provider_parity?.worker_projection_sha256 !== actualHash) {
      failures.push(`${prefix}.provider_parity.worker_projection_sha256: hash does not match actual projection`);
    }
    const differences = semanticDiff(check.expected_projection, check.actual_projection, `${prefix}.actual_projection`);
    failures.push(...differences);
    const expectedStatus = differences.length ? "fail" : "pass";
    if (check.provider_parity?.status !== expectedStatus) {
      failures.push(`${prefix}.provider_parity.status: expected ${expectedStatus}, actual ${display(check.provider_parity?.status)}`);
    }
    if (check.actual_projection?.public_redaction?.passed !== true
        || check.actual_projection?.public_redaction?.forbidden_paths?.length !== 0) {
      failures.push(`${prefix}.actual_projection.public_redaction: public boundary failed`);
    }
  }

  const expectedSemanticHash = sha256Canonical(receiptSemanticPayload(receipt, "expected_projection"));
  const actualSemanticHash = sha256Canonical(receiptSemanticPayload(receipt, "actual_projection"));
  if (receipt?.expected_semantic_sha256 !== expectedSemanticHash) {
    failures.push("expected_semantic_sha256: does not match receipt projections");
  }
  if (receipt?.actual_semantic_sha256 !== actualSemanticHash) {
    failures.push("actual_semantic_sha256: does not match receipt projections");
  }
  if (expectedSemanticHash !== actualSemanticHash) failures.push("status: semantic digest drifted");
  if (receipt?.status !== "pass") failures.push(`status: expected pass, actual ${display(receipt?.status)}`);

  if (failures.length) {
    throw new Error(`capability semantic scout failed:\n- ${failures.join("\n- ")}`);
  }
  return true;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node tools/verify_capability_semantic_scout.mjs <receipt.json>");
    process.exitCode = 2;
  } else {
    try {
      verifyCapabilitySemanticScout(JSON.parse(readFileSync(resolve(path), "utf8")));
      process.stdout.write(`capability semantic scout verified: ${path}\n`);
    } catch (error) {
      console.error(String(error?.message || error));
      process.exitCode = 1;
    }
  }
}
