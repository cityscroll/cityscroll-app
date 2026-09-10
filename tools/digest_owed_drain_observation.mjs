#!/usr/bin/env node
/**
 * Read-only producer for the district owed-drain observation.
 *
 *   CITYSCROLL_ADMIN_KEY_FILE=<key-file> node tools/digest_owed_drain_observation.mjs --phase before
 *   CITYSCROLL_ADMIN_KEY_FILE=<key-file> node tools/digest_owed_drain_observation.mjs --phase after
 *
 * The admin credential is read in-process and is never printed. The observation
 * identifies the subscriber by opaque subscriber_id only.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCredentialSource } from "./lib/credential_files.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCHEMA = "cityscroll.digest_owed_drain_observation.v1";
export const EVIDENCE_RELATIVE = "docs/evidence/digest-owed-drain/district-owed-drain-read.json";
export const DEFAULT_API_BASE = "https://api.cityscroll.org";
export const PHASES = Object.freeze(["before", "after"]);

export function evidencePath(root = ROOT) {
  return join(root, EVIDENCE_RELATIVE);
}

export function selectDistrictOwedSubscriber(backlog) {
  const rows = Array.isArray(backlog?.subscribers) ? backlog.subscribers : [];
  const district = rows.filter((row) => row?.oldest_lens === "district" || String(row?.oldest_item_id || "").startsWith("district:"));
  const pool = district.length ? district : rows;
  return pool.slice().sort((a, b) => String(a.oldest_owed_at || "").localeCompare(String(b.oldest_owed_at || "")))[0] || null;
}

export function observationFromBacklog(backlog, { phase, takenAt, drainedCount = 0 } = {}) {
  const row = selectDistrictOwedSubscriber(backlog);
  if (!row?.subscriber_id) {
    throw new Error("owed-backlog has no subscriber row to observe");
  }
  if (!PHASES.includes(phase)) throw new Error(`phase must be before or after, got ${phase}`);
  return {
    phase,
    taken_at: takenAt || backlog.generated_at || new Date().toISOString(),
    owed_count: Number(row.owed_count) || 0,
    drained_count: Number(drainedCount) || 0,
    oldest_owed_row: {
      item_id: row.oldest_item_id || null,
      lens: row.oldest_lens || null,
      first_owed_at: row.oldest_owed_at || null,
      watch_id: row.oldest_watch_id || null,
    },
    last_sent_at: row.last_sent_at || null,
    last_delivery_status: row.last_delivery_status || null,
    source: "GET /admin/owed-backlog",
    subscriber_id: row.subscriber_id,
  };
}

export function mergeEnvelope(existing, observation) {
  const prior = existing && existing.schema === SCHEMA ? existing : null;
  const subscriberId = observation.subscriber_id;
  if (prior?.subscriber_id && prior.subscriber_id !== subscriberId) {
    throw new Error("observation subscriber_id does not match the retained envelope");
  }
  const reads = Array.isArray(prior?.reads) ? prior.reads.filter((row) => row?.phase !== observation.phase) : [];
  reads.push(observation);
  reads.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
  return {
    schema: SCHEMA,
    subscriber_id: subscriberId,
    reads,
  };
}

function publicEnvelope(envelope) {
  const json = JSON.stringify(envelope);
  if (json.includes("@")) throw new Error("observation would include an address; refusing to write");
  return envelope;
}

export async function fetchOwedBacklog({ apiBase = DEFAULT_API_BASE, adminKey, fetchImpl = fetch } = {}) {
  if (!adminKey) throw new Error("admin key is required");
  const url = new URL("/admin/owed-backlog", apiBase);
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${adminKey}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(`owed-backlog ${response.status}`);
  return body;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { phase: "before", check: false, write: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") out.check = true;
    else if (arg === "--phase") out.phase = argv[++i];
    else if (arg === "--dry-run") out.write = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.check) return out;
  if (!PHASES.includes(out.phase)) throw new Error(`phase must be before or after, got ${out.phase}`);
  return out;
}

function loadAdminKey(env = process.env) {
  const resolved = resolveCredentialSource({
    inlineVars: ["CITYSCROLL_ADMIN_KEY", "ADMIN_KEY"],
    fileVars: ["CITYSCROLL_ADMIN_KEY_FILE"],
    env,
  });
  if (!resolved.value) {
    const detail = resolved.variable ? `${resolved.variable} is ${resolved.failure}` : "CITYSCROLL_ADMIN_KEY_FILE is required";
    throw new Error(detail);
  }
  return resolved.value;
}

export function readEnvelope(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const path = options.evidencePath || evidencePath(options.root || ROOT);
  if (args.check) {
    const envelope = readEnvelope(path);
    if (!envelope || envelope.schema !== SCHEMA) throw new Error(`${path} is missing ${SCHEMA}`);
    if (!Array.isArray(envelope.reads) || !envelope.reads.some((row) => row.phase === "before")) {
      throw new Error("before observation is required");
    }
    publicEnvelope(envelope);
    return envelope;
  }
  const backlog = options.backlog || await fetchOwedBacklog({
    apiBase: options.apiBase || DEFAULT_API_BASE,
    adminKey: options.adminKey || loadAdminKey(options.env || process.env),
    fetchImpl: options.fetchImpl || fetch,
  });
  const observation = observationFromBacklog(backlog, { phase: args.phase });
  const envelope = publicEnvelope(mergeEnvelope(readEnvelope(path), observation));
  if (args.write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);
  }
  return envelope;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
