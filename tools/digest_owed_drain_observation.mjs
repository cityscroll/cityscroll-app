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

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCredentialSource } from "./lib/credential_files.mjs";
import {
  assertProductionProvenance,
  productionProvenance,
} from "./lib/production_provenance.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCHEMA = "cityscroll.digest_owed_drain_observation.v1";
export const EVIDENCE_RELATIVE = "docs/evidence/digest-owed-drain/district-owed-drain-read.json";
export const DEFAULT_API_BASE = "https://api.cityscroll.org";
export const PHASES = Object.freeze(["before", "after"]);
export const OBSERVER_TOOL = "tools/digest_owed_drain_observation.mjs";

export function evidencePath(root = ROOT) {
  return join(root, EVIDENCE_RELATIVE);
}

export function gitRevision(root = ROOT) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function summaryFromBacklog(backlog) {
  const summary = backlog?.summary;
  if (!summary || typeof summary !== "object") return null;
  return {
    subscriber_count: Number(summary.subscriber_count) || 0,
    owed_count: Number(summary.owed_count) || 0,
    overdue_subscriber_count: Number(summary.overdue_subscriber_count) || 0,
  };
}

export function selectDistrictOwedSubscriber(backlog) {
  const rows = Array.isArray(backlog?.subscribers) ? backlog.subscribers : [];
  const district = rows.filter((row) => row?.oldest_lens === "district" || String(row?.oldest_item_id || "").startsWith("district:"));
  const pool = district.length ? district : rows;
  return pool.slice().sort((a, b) => String(a.oldest_owed_at || "").localeCompare(String(b.oldest_owed_at || "")))[0] || null;
}

/** Pin an existing envelope subscriber so an after read cannot jump to a different row. */
export function selectSubscriber(backlog, subscriberId, fallback = null) {
  const rows = Array.isArray(backlog?.subscribers) ? backlog.subscribers : [];
  if (!subscriberId) return selectDistrictOwedSubscriber(backlog);
  const found = rows.find((row) => row?.subscriber_id === subscriberId);
  if (found) return found;
  return {
    subscriber_id: subscriberId,
    owed_count: 0,
    oldest_owed_at: null,
    oldest_lens: null,
    oldest_item_id: null,
    oldest_watch_id: null,
    last_sent_at: fallback?.last_sent_at || null,
    last_delivery_status: fallback?.last_delivery_status || null,
  };
}

export function observationFromBacklog(backlog, {
  phase,
  takenAt,
  drainedCount = 0,
  subscriberId = null,
  fallback = null,
  httpStatus = null,
  productionCommit = null,
  productionEnvironment = null,
} = {}) {
  const row = selectSubscriber(backlog, subscriberId, fallback);
  if (!row?.subscriber_id) {
    throw new Error("owed-backlog has no subscriber row to observe");
  }
  if (!PHASES.includes(phase)) throw new Error(`phase must be before or after, got ${phase}`);
  const observation = {
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
  const backlogSummary = summaryFromBacklog(backlog);
  if (backlogSummary) observation.backlog_summary = backlogSummary;
  if (httpStatus != null) observation.http_status = httpStatus;
  if (productionCommit) observation.production_commit = productionCommit;
  if (productionEnvironment) observation.production_environment = productionEnvironment;
  return observation;
}

export function pairVerification(envelope) {
  const reads = Array.isArray(envelope?.reads) ? envelope.reads : [];
  const before = reads.find((row) => row?.phase === "before");
  const after = reads.find((row) => row?.phase === "after");
  if (!before || !after) {
    return {
      owed_count_fell: false,
      owed_drained_nonzero: false,
      backlog_did_not_grow: false,
      last_sent_advanced: false,
    };
  }
  const beforeOwed = Number(before.owed_count) || 0;
  const afterOwed = Number(after.owed_count) || 0;
  const drained = Number(after.drained_count) || 0;
  const beforeBacklog = Number(before.backlog_summary?.owed_count ?? beforeOwed);
  const afterBacklog = Number(after.backlog_summary?.owed_count ?? afterOwed);
  return {
    owed_count_fell: afterOwed < beforeOwed,
    owed_drained_nonzero: drained > 0,
    backlog_did_not_grow: afterBacklog <= beforeBacklog,
    last_sent_advanced: Boolean(
      after.last_sent_at
      && before.last_sent_at
      && String(after.last_sent_at) > String(before.last_sent_at),
    ),
  };
}

export function mergeEnvelope(existing, observation, { provenance = null } = {}) {
  const prior = existing && existing.schema === SCHEMA ? existing : null;
  const subscriberId = observation.subscriber_id;
  if (prior?.subscriber_id && prior.subscriber_id !== subscriberId) {
    throw new Error("observation subscriber_id does not match the retained envelope");
  }
  const reads = Array.isArray(prior?.reads) ? prior.reads.filter((row) => row?.phase !== observation.phase) : [];
  reads.push(observation);
  reads.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
  const envelope = {
    schema: SCHEMA,
    subscriber_id: subscriberId,
    reads,
  };
  const nextProvenance = provenance || prior?.provenance || null;
  if (nextProvenance) envelope.provenance = nextProvenance;
  const after = reads.find((row) => row?.phase === "after");
  if (after && reads.some((row) => row?.phase === "before")) {
    envelope.verification = pairVerification(envelope);
  }
  return envelope;
}

export function assertOwedDrainEnvelope(envelope, { requireAfter = false } = {}) {
  if (!envelope || envelope.schema !== SCHEMA) {
    throw new Error(`envelope is missing ${SCHEMA}`);
  }
  if (!Array.isArray(envelope.reads) || !envelope.reads.some((row) => row.phase === "before")) {
    throw new Error("before observation is required");
  }
  publicEnvelope(envelope);
  const after = envelope.reads.find((row) => row.phase === "after");
  if (requireAfter && !after) throw new Error("after observation is required");
  if (after) {
    if (!envelope.provenance) throw new Error("after observation requires production provenance");
    assertProductionProvenance(envelope.provenance, { requireSourceRevision: true });
    const phases = envelope.reads.map((row) => row.phase);
    if (phases[0] !== "before" || !phases.includes("after")) {
      throw new Error("reads must keep the ordered before/after pair");
    }
    if (envelope.reads.some((row) => row.subscriber_id !== envelope.subscriber_id)) {
      throw new Error("every read must keep the envelope subscriber_id");
    }
    const verification = envelope.verification || pairVerification(envelope);
    if (verification.backlog_did_not_grow !== true) {
      throw new Error("after observation shows the owed backlog grew");
    }
  }
  return envelope;
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

export async function fetchProductionWorkerHealth({ apiBase = DEFAULT_API_BASE, fetchImpl = fetch } = {}) {
  const url = new URL("/health", apiBase);
  const response = await fetchImpl(url);
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  return {
    http_status: response.status,
    commit: body.commit || null,
    environment: body.environment || null,
  };
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
  const root = options.root || ROOT;
  const path = options.evidencePath || evidencePath(root);
  if (args.check) {
    return assertOwedDrainEnvelope(readEnvelope(path), { requireAfter: true });
  }
  const apiBase = options.apiBase || DEFAULT_API_BASE;
  const fetchImpl = options.fetchImpl || fetch;
  const existing = readEnvelope(path);
  const health = options.health || (options.backlog ? { commit: null, environment: null } : await fetchProductionWorkerHealth({
    apiBase,
    fetchImpl,
  }));
  const backlog = options.backlog || await fetchOwedBacklog({
    apiBase,
    adminKey: options.adminKey || loadAdminKey(options.env || process.env),
    fetchImpl,
  });
  const takenAt = options.takenAt || backlog.generated_at || new Date().toISOString();
  const provenance = productionProvenance({
    observed_at: takenAt,
    tool: OBSERVER_TOOL,
    source_revision: options.sourceRevision || gitRevision(root),
    bases: [apiBase],
    methods: ["GET"],
  });
  const before = existing?.reads?.find((row) => row?.phase === "before") || null;
  const subscriberId = args.phase === "after" ? (existing?.subscriber_id || null) : null;
  if (args.phase === "after" && !subscriberId) {
    throw new Error("after observation requires a retained before envelope");
  }
  let observation = observationFromBacklog(backlog, {
    phase: args.phase,
    takenAt,
    subscriberId,
    fallback: before,
    httpStatus: options.httpStatus ?? 200,
    productionCommit: health.commit || null,
    productionEnvironment: health.environment || null,
  });
  if (args.phase === "after" && before) {
    observation = {
      ...observation,
      drained_count: Math.max(0, (Number(before.owed_count) || 0) - (Number(observation.owed_count) || 0)),
    };
  }
  const envelope = publicEnvelope(mergeEnvelope(existing, observation, {
    provenance: args.phase === "after" ? provenance : (existing?.provenance || provenance),
  }));
  if (args.phase === "after") assertOwedDrainEnvelope(envelope, { requireAfter: true });
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
