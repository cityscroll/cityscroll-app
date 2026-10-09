import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROUTE_PUBLICATION_STATE_KEY = "route-read-model:publication-state:v1";
export const ROUTE_MANIFEST_KEYS = Object.freeze({
  nearYou: "route-read-model:near-you:manifest:v1",
  meetings: "route-read-model:meetings:manifest:v1",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestKeys(manifest) {
  return new Set([
    ...Object.values(manifest?.slices || {}),
    ...Object.values(manifest?.id_to_slice || {}),
  ].filter(Boolean));
}

function referencedKeys(generation) {
  return new Set([
    ...manifestKeys(generation?.manifests?.near_you),
    ...manifestKeys(generation?.manifests?.meetings),
  ]);
}

export function loadRoutePublicationCandidate(routeDir) {
  const nearYou = readJson(join(routeDir, "near-you.manifest.json"));
  const meetings = readJson(join(routeDir, "meetings.manifest.json"));
  const entries = {
    near_you: readJson(join(routeDir, "near-you.bulk.json")),
    meetings: readJson(join(routeDir, "meetings.bulk.json")),
  };
  if (nearYou?.schema_version !== 1 || nearYou?.kind !== "near-you" || !nearYou.version) {
    throw new Error("invalid Near You publication candidate");
  }
  if (meetings?.schema_version !== 1 || meetings?.kind !== "meetings" || !meetings.version) {
    throw new Error("invalid meetings publication candidate");
  }
  for (const [section, rows] of Object.entries(entries)) {
    if (!Array.isArray(rows) || rows.some((row) => typeof row?.key !== "string" || typeof row?.value !== "string")) {
      throw new Error(`invalid ${section} bulk publication candidate`);
    }
  }
  const manifests = { near_you: nearYou, meetings };
  return {
    schema: "cityscroll.worker_route_publication_candidate.v1",
    content_version: `sha256:${sha256(JSON.stringify(manifests))}`,
    manifests,
    entries,
  };
}

export function planRoutePublication(candidate, previousState = null) {
  if (previousState?.schema && previousState.schema !== "cityscroll.worker_route_publication_state.v1") {
    throw new Error("unsupported route publication state schema");
  }
  if (previousState?.content_version === candidate.content_version) {
    return {
      schema: "cityscroll.worker_route_publication_plan.v1",
      decision: "unchanged-content",
      content_version: candidate.content_version,
      candidate,
      previous_state: previousState,
      entries: { near_you: [], meetings: [] },
      attempted: { kv_reads: 1, route_key_puts: 0, manifest_puts: 0, state_puts: 0 },
      writes_avoided: candidate.entries.near_you.length + candidate.entries.meetings.length + 2,
    };
  }

  const reusable = new Set([
    ...referencedKeys(previousState?.active),
    ...referencedKeys(previousState?.rollback),
  ]);
  const entries = {
    near_you: candidate.entries.near_you.filter((row) => !reusable.has(row.key)),
    meetings: candidate.entries.meetings.filter((row) => !reusable.has(row.key)),
  };
  const routeKeyPuts = entries.near_you.length + entries.meetings.length;
  const totalCandidateKeys = candidate.entries.near_you.length + candidate.entries.meetings.length;
  return {
    schema: "cityscroll.worker_route_publication_plan.v1",
    decision: previousState ? "changed-content" : "state-missing-republish",
    content_version: candidate.content_version,
    candidate,
    previous_state: previousState,
    entries,
    attempted: { kv_reads: 1, route_key_puts: routeKeyPuts, manifest_puts: 2, state_puts: 1 },
    writes_avoided: totalCandidateKeys - routeKeyPuts,
  };
}

export function completedRoutePublicationState(plan, completedAt = new Date().toISOString()) {
  if (plan.decision === "unchanged-content") return plan.previous_state;
  return {
    schema: "cityscroll.worker_route_publication_state.v1",
    content_version: plan.content_version,
    completed_at: completedAt,
    active: { manifests: plan.candidate.manifests },
    rollback: plan.previous_state?.active || null,
  };
}

function writeBulkChunks(dir, section, entries, maxBytes = 8 * 1024 * 1024) {
  const paths = [];
  let chunk = [];
  let bytes = 2;
  const flush = () => {
    if (!chunk.length) return;
    const path = join(dir, `${section}.${String(paths.length).padStart(3, "0")}.json`);
    writeFileSync(path, JSON.stringify(chunk));
    paths.push(path);
    chunk = [];
    bytes = 2;
  };
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (chunk.length && bytes + entryBytes > maxBytes) flush();
    chunk.push(entry);
    bytes += entryBytes;
  }
  flush();
  return paths;
}

function kvArgs(configPath) {
  return ["--binding", "ALERT_STATE", "--remote", "--config", configPath];
}

function parseState(raw) {
  const text = String(raw || "").trim();
  if (text === "Value not found") return null;
  return text ? JSON.parse(text) : null;
}

function isMissingPublicationState(error) {
  const providerText = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
  if (error?.status !== 1) return false;
  return /\b404:?\s+Not Found\b/.test(providerText)
    || /\b(?:code|error)(?::)?\s*10009\b/i.test(providerText);
}

/**
 * Publish immutable payloads first, then the two independently readable
 * manifests, and advance state only after every prior write succeeds. KV does
 * not offer a multi-key transaction; delayed visibility is handled by readers
 * as an honest section-specific unavailable state.
 */
export async function publishRouteReadModels({
  routeDir,
  invoke,
  configPath = "worker/wrangler.toml",
  completedAt = new Date().toISOString(),
  previousState,
} = {}) {
  if (typeof invoke !== "function") throw new Error("publishRouteReadModels requires a Wrangler invoker");
  let prior = previousState;
  if (prior === undefined) {
    try {
      const result = await invoke([
        "kv", "key", "get", ROUTE_PUBLICATION_STATE_KEY,
        ...kvArgs(configPath), "--text",
      ]);
      prior = parseState(result?.stdout);
    } catch (error) {
      // Wrangler reports a genuinely absent remote KV value as a provider 404.
      // Only that exact read is absence; auth, transport, and other failures stay fatal.
      if (!isMissingPublicationState(error)) throw error;
      prior = null;
    }
  }
  const candidate = loadRoutePublicationCandidate(routeDir);
  const plan = planRoutePublication(candidate, prior || null);
  if (plan.decision === "unchanged-content") {
    return { ...plan, confirmed: { route_key_puts: 0, manifest_puts: 0, state_puts: 0 } };
  }

  const temp = mkdtempSync(join(tmpdir(), "cityscroll-route-publication-"));
  const confirmed = { route_key_puts: 0, manifest_puts: 0, state_puts: 0 };
  try {
    for (const [section, rows] of Object.entries(plan.entries)) {
      for (const path of writeBulkChunks(temp, section, rows)) {
        await invoke(["kv", "bulk", "put", path, ...kvArgs(configPath)]);
        confirmed.route_key_puts += readJson(path).length;
      }
    }
    for (const [name, key, filename] of [
      ["near_you", ROUTE_MANIFEST_KEYS.nearYou, "near-you.manifest.json"],
      ["meetings", ROUTE_MANIFEST_KEYS.meetings, "meetings.manifest.json"],
    ]) {
      const path = join(routeDir, filename);
      await invoke(["kv", "key", "put", key, "--path", path, ...kvArgs(configPath)]);
      confirmed.manifest_puts += 1;
      if (!plan.candidate.manifests[name]) throw new Error(`missing ${name} manifest after publication`);
    }
    const state = completedRoutePublicationState(plan, completedAt);
    const statePath = join(temp, "publication-state.json");
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await invoke(["kv", "key", "put", ROUTE_PUBLICATION_STATE_KEY, "--path", statePath, ...kvArgs(configPath)]);
    confirmed.state_puts = 1;
    return { ...plan, state, confirmed };
  } catch (error) {
    error.publication_receipt = {
      schema: "cityscroll.worker_route_publication_failure.v1",
      decision: plan.decision,
      content_version: plan.content_version,
      attempted: plan.attempted,
      confirmed,
      state_advanced: false,
    };
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
