#!/usr/bin/env node

/** Bounded, read-only read-back for the deployed consultation publication path. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "cityscroll.consultation_deployment_readback.v1";
export const MAX_REQUESTS = 6;
export const MAX_BYTES = 2_000_000;
const ROOT = join(new URL("..", import.meta.url).pathname);

const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => String(value || "");
const has = (body, value) => body.includes(value);

export function consumerIdentity({ status, body, path, expected = [] }) {
  return {
    path,
    status,
    sha256: digest(body),
    admitted_round_ids: expected.filter((id) => has(body, id)),
    all_expected_present: expected.every((id) => has(body, id)),
  };
}

export function compareConsumerIdentities(consumers, expectedIds) {
  // A canonical detail route is intentionally scoped to one round; the
  // cross-consumer comparison applies to collection surfaces only.
  const comparable = consumers.filter((row) => row.kind !== "canonical_detail");
  const admitted = comparable.map((row) => row.admitted_round_ids.join(","));
  return {
    same_admitted_rounds: admitted.length > 0 && admitted.every((value) => value === admitted[0]),
    expected_rounds: expectedIds,
    consumers,
    status: consumers.every((row) => row.status === 200) && comparable.every((row) => row.all_expected_present) && admitted.every((value) => value === admitted[0]) ? "pass" : "fail",
  };
}

export async function checkConsultationDeployment({
  baseUrl,
  fetchImpl = globalThis.fetch,
  revision = null,
  dataVintage = null,
  expectedIds = ["dot-fast-buses-central-brooklyn", "dot-coney-island-transportation-study", "dot-secure-bike-parking", "dot-public-ebike-charging"],
  paths = {},
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  const requests = [
    ["canonical_detail", paths.detail || `/consultations/${expectedIds[0]}/`],
    ["search", paths.search || "/search/?q=secure%20bike%20parking"],
    ["local", paths.local || "/near-you/?community_district=K14"],
    ["now", paths.now || "/now/"],
  ];
  const results = [];
  let bytes = 0;
  for (const [kind, path] of requests.slice(0, MAX_REQUESTS)) {
    const url = new URL(path, baseUrl).href;
    const response = await fetchImpl(url, { method: "GET", redirect: "error" });
    const body = text(await response.text());
    bytes += Buffer.byteLength(body);
    if (bytes > MAX_BYTES) throw new Error("deployment read-back byte limit exceeded");
    results.push({ kind, ...consumerIdentity({ status: response.status, body, path, expected: kind === "canonical_detail" ? [expectedIds[0]] : expectedIds }) });
  }
  const comparison = compareConsumerIdentities(results, expectedIds);
  return {
    schema: SCHEMA,
    evidence_class: "live-production-read",
    observed_at: new Date().toISOString(),
    base_url: new URL(baseUrl).origin,
    code_revision: revision,
    data_vintage: dataVintage,
    source_observation: { source_contract_id: "public-consultations", observation_ids: expectedIds.map((id) => `${id}:deployment-readback`) },
    consumers: results,
    comparison,
    bounds: { max_requests: MAX_REQUESTS, max_bytes: MAX_BYTES, requests: results.length, bytes },
    status: comparison.status,
  };
}

export function validateDeploymentReadback(receipt) {
  const errors = [];
  if (receipt?.schema !== SCHEMA) errors.push("schema mismatch");
  if (receipt?.evidence_class !== "live-production-read") errors.push("evidence class must be live-production-read");
  if (!receipt?.code_revision) errors.push("code revision is required");
  if (!receipt?.data_vintage) errors.push("data vintage is required");
  if (!receipt?.source_observation?.observation_ids?.length) errors.push("source observation identity is required");
  if (!receipt?.comparison?.same_admitted_rounds) errors.push("consumer round identities diverge");
  if (receipt?.bounds?.requests > MAX_REQUESTS || receipt?.bounds?.bytes > MAX_BYTES) errors.push("read-back bounds exceeded");
  return errors;
}

async function main() {
  const baseUrl = process.env.CITYSCROLL_CONSULTATIONS_BASE_URL;
  if (!baseUrl) throw new Error("CITYSCROLL_CONSULTATIONS_BASE_URL is required");
  const receipt = await checkConsultationDeployment({ baseUrl, revision: process.env.GITHUB_SHA || "unknown", dataVintage: process.env.CITYSCROLL_CONSULTATIONS_DATA_VINTAGE || "unknown" });
  const errors = validateDeploymentReadback(receipt);
  const output = process.env.CITYSCROLL_CONSULTATIONS_READBACK || join(ROOT, "docs/evidence/consultation-delivery/read-back.json");
  mkdirSync(join(output, ".."), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (errors.length) throw new Error(errors.join("; "));
  process.stdout.write(`consultation deployment read-back PASS: ${output}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
