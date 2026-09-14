#!/usr/bin/env node

/**
 * Read the production Worker receipt metadata needed to close PASSPort health.
 * The admin key is accepted only through CITYSCROLL_ADMIN_KEY_FILE and is
 * never printed, put in a URL, or included in the retained envelope.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  passportReceiptsFromMeta,
} from "../worker/src/lib/source_acquisition_receipt.mjs";
import {
  assertProductionProvenance,
  productionProvenance,
} from "./lib/production_provenance.mjs";
import { resolveCredentialSource } from "./lib/credential_files.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const API_BASE = "https://api.cityscroll.org";
export const ENDPOINT = "/admin/passport-ingest-meta";
export const OUTPUT_PATH = "warehouse/receipts/proof/passport_d1_ingest_meta_latest.json";
export const SCHEMA = "cityscroll.passport_ingest_meta_production_read.v1";
export const TOOL = "tools/capture_priority_source_health_production_read.mjs";

function gitRevision(root = ROOT) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readAdminKey(env = process.env) {
  const resolution = resolveCredentialSource({
    fileVars: ["CITYSCROLL_ADMIN_KEY_FILE"],
    env,
  });
  if (resolution.value) return resolution.value;
  if (resolution.failure === "unconfigured") throw new Error("CITYSCROLL_ADMIN_KEY_FILE is required");
  throw new Error(`CITYSCROLL_ADMIN_KEY_FILE is ${resolution.failure}`);
}

function validAt(value) {
  const epoch = Date.parse(String(value || ""));
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function assertReceipt(receipt) {
  for (const field of ["source_contract_id", "attempt_at", "result_at", "observed_at", "run_id", "producer"]) {
    if (!receipt?.[field]) throw new Error(`PASSPort receipt missing ${field}`);
  }
  if (!["passport-public-contracts", "passport-public-rfx"].includes(receipt.source_contract_id)) {
    throw new Error(`unexpected PASSPort source ${receipt.source_contract_id}`);
  }
  if (receipt.status !== "succeeded") throw new Error(`PASSPort receipt status is ${receipt.status}`);
  return receipt;
}

export async function capturePrioritySourceHealthProductionRead({
  fetchImpl = fetch,
  adminKey,
  now = new Date().toISOString(),
  apiBase = API_BASE,
  sourceRevision = null,
} = {}) {
  const observedAt = validAt(now);
  if (!observedAt) throw new Error("production read requires a valid now timestamp");
  if (!adminKey) throw new Error("CITYSCROLL_ADMIN_KEY_FILE is required");
  const url = `${apiBase.replace(/\/$/, "")}${ENDPOINT}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${adminKey}`,
      Accept: "application/json",
      "User-Agent": "cityscroll-priority-source-health-read",
    },
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || !body?.meta) {
    throw new Error(`PASSPort production read failed (HTTP ${response.status})`);
  }
  const provenance = productionProvenance({
    observed_at: observedAt,
    tool: TOOL,
    source_revision: sourceRevision,
    bases: [apiBase],
    methods: ["GET"],
  });
  assertProductionProvenance(provenance, { requireSourceRevision: true });
  const receipts = (Array.isArray(body.receipts) && body.receipts.length
    ? body.receipts
    : passportReceiptsFromMeta(body.meta, {
      run_id: body.meta.run_id || `passport-d1:${body.meta.ingested_at || body.meta.last_attempt_at}`,
      production_provenance: provenance,
    })).map((receipt) => ({
    ...receipt,
    attempt_at: validAt(receipt.attempt_at || body.meta.last_attempt_at || observedAt),
    result_at: validAt(receipt.result_at || body.meta.ingested_at || receipt.observed_at || observedAt),
    observed_at: validAt(receipt.observed_at || receipt.result_at || body.meta.ingested_at || observedAt),
    producer: receipt.producer || body.producer || "worker-d1-passport-ingest-meta",
    run_id: receipt.run_id || body.meta.run_id || `passport-d1:${body.meta.ingested_at || observedAt}`,
    production_provenance: provenance,
    path: `${apiBase}${ENDPOINT}`,
  })).map(assertReceipt);
  if (new Set(receipts.map((receipt) => receipt.source_contract_id)).size !== 2) {
    throw new Error("PASSPort production read did not return both canonical source IDs");
  }
  return {
    schema: SCHEMA,
    evidence_class: "live-production-read",
    isolated: false,
    observed_at: observedAt,
    producer: body.producer || "worker-d1-passport-ingest-meta",
    endpoint: url,
    meta: body.meta,
    receipts,
    provenance,
  };
}

export function checkRetainedPrioritySourceHealthRead(path = join(ROOT, OUTPUT_PATH)) {
  if (!existsSync(path)) throw new Error(`missing ${OUTPUT_PATH}`);
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  if (envelope.schema !== SCHEMA || envelope.evidence_class !== "live-production-read" || envelope.isolated !== false) {
    throw new Error("priority source production read envelope is invalid");
  }
  assertProductionProvenance(envelope.provenance, { requireSourceRevision: true });
  envelope.receipts.map(assertReceipt);
  return envelope;
}

function parseArgs(argv) {
  const args = { check: false, write: join(ROOT, OUTPUT_PATH), now: null, api: API_BASE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg === "--write") args.write = resolve(argv[++index]);
    else if (arg === "--now") args.now = argv[++index];
    else if (arg === "--api") args.api = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.check) {
    checkRetainedPrioritySourceHealthRead(args.write);
    console.log(`checked ${args.write}`);
    return;
  }
  const envelope = await capturePrioritySourceHealthProductionRead({
    adminKey: readAdminKey(env),
    now: args.now || new Date().toISOString(),
    apiBase: args.api,
    sourceRevision: gitRevision(),
  });
  mkdirSync(dirname(args.write), { recursive: true });
  writeFileSync(args.write, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`wrote ${args.write}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
