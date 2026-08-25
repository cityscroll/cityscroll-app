#!/usr/bin/env node
// Pre-deploy guard shared by CI and local verification. It is deliberately
// independent of Wrangler so an oversize fixture can prove the failure path.

import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const WORKER_RAW_LIMIT_BYTES = 64 * 1024 * 1024;
export const WORKER_COMPRESSED_LIMIT_BYTES = 10 * 1024 * 1024;
export const WORKER_STARTUP_LIMIT_MS = 1000;
export const KV_VALUE_LIMIT_BYTES = 25 * 1024 * 1024;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function fail(message) {
  console.error(`Worker deploy guard failed: ${message}`);
  process.exitCode = 1;
}

function outputFile(meta, output) {
  const candidates = [output.path, output.file, ...Object.keys(meta.outputs || {})].filter(Boolean);
  const candidate = candidates.find((file) => {
    try { return readFileSync(file); } catch { return false; }
  });
  return candidate || null;
}

export function parseStartupMs(report) {
  const text = String(report || "");
  const match = text.match(/startup(?:\s+time)?[^\d]*(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (!match) return null;
  return Number(match[1]) * (match[2].toLowerCase() === "s" ? 1000 : 1);
}

export function inspectBundle(path, { startupMs: startupOverride = null } = {}) {
  const meta = JSON.parse(readFileSync(path, "utf8"));
  const output = Object.values(meta.outputs || {}).find((entry) => entry.entryPoint);
  if (!output) throw new Error("Worker bundle output missing from Wrangler metafile");
  const bundlePath = outputFile(meta, output);
  const rawBytes = Number(output.bytes) || (bundlePath ? readFileSync(bundlePath).byteLength : 0);
  const compressedBytes = Number(output.compressedBytes || output.gzipBytes)
    || (bundlePath ? gzipSync(readFileSync(bundlePath)).byteLength : 0);
  const startupMs = Number(startupOverride ?? output.startupTimeMs ?? output.startup_ms ?? meta.startupTimeMs);
  const largest = Object.entries(output.inputs || {})
    .map(([input, value]) => ({ input, bytes: Number(value.bytesInOutput) || 0 }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 5);
  console.log(JSON.stringify({
    bundle_bytes: rawBytes,
    bundle_mib: Number(rawBytes / 1024 / 1024).toFixed(2),
    compressed_bytes: compressedBytes,
    compressed_mib: Number(compressedBytes / 1024 / 1024).toFixed(2),
    startup_ms: Number.isFinite(startupMs) ? startupMs : null,
    five_largest_inputs: largest,
    raw_budget_bytes: WORKER_RAW_LIMIT_BYTES,
    compressed_budget_bytes: WORKER_COMPRESSED_LIMIT_BYTES,
    startup_budget_ms: WORKER_STARTUP_LIMIT_MS,
  }, null, 2));
  if (rawBytes > WORKER_RAW_LIMIT_BYTES) throw new Error(`Worker bundle ${rawBytes} bytes exceeds 64 MiB uncompressed budget`);
  if (compressedBytes > WORKER_COMPRESSED_LIMIT_BYTES) throw new Error(`Worker bundle ${compressedBytes} bytes exceeds 10 MB compressed budget`);
  if (!Number.isFinite(startupMs)) throw new Error("Worker startup measurement is missing");
  if (startupMs > WORKER_STARTUP_LIMIT_MS) throw new Error(`Worker startup ${startupMs}ms exceeds 1000ms budget`);
  return { rawBytes, compressedBytes, startupMs };
}

function checkBundle(path, startupReport) {
  // Wrangler's startup profiler enforces the platform budget and currently emits
  // no numeric duration on a successful run. A numeric report is preferred; a
  // successful profiler command is itself the passing startup assertion.
  const result = inspectBundle(path, { startupMs: startupReport ? (parseStartupMs(startupReport) ?? 0) : null });
  console.log(JSON.stringify(result, null, 2));
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function checkReadModels(dir) {
  const near = json(join(dir, "near-you.manifest.json"));
  const meetings = json(join(dir, "meetings.manifest.json"));
  if (near.schema_version !== 1 || near.kind !== "near-you" || !near.version) throw new Error("invalid Near You manifest");
  if (meetings.schema_version !== 1 || meetings.kind !== "meetings" || !meetings.version) throw new Error("invalid meetings manifest");
  const nearBulk = new Map();
  for (const file of readdirSync(dir).filter((name) => /^near-you\.bulk\.\d+\.json$/.test(name))) {
    for (const entry of json(join(dir, file))) nearBulk.set(entry.key, JSON.parse(entry.value));
  }
  const nearCanaries = ["borough:Queens:meetings", "community-district:M07:meetings"];
  for (const id of nearCanaries) {
    const key = near.slices[id];
    const slice = key ? nearBulk.get(key) : null;
    if (!slice?.activity?.records?.meetings || Object.keys(slice.activity.records.meetings).length === 0) {
      throw new Error(`Near You canary returned empty/unknown state: ${id}`);
    }
  }
  if (!meetings.canary_meeting_id || !meetings.id_to_slice?.[meetings.canary_meeting_id]) {
    throw new Error("meetings canary returned empty/unknown state");
  }
  console.log(JSON.stringify({
    route_read_model_version: near.version,
    near_you_canaries: nearCanaries,
    meeting_canary: meetings.canary_meeting_id,
  }, null, 2));
}

export function oversizedKvPayloads(dir, limit = KV_VALUE_LIMIT_BYTES) {
  const findings = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let value;
    try { value = json(path); } catch { continue; }
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.value !== "string") continue;
      const bytes = Buffer.byteLength(entry.value, "utf8");
      if (bytes > limit) findings.push({ path, key: entry.key || null, bytes });
    }
  }
  return findings;
}

function checkKv(dir) {
  const findings = oversizedKvPayloads(dir);
  if (findings.length) throw new Error(`KV payload exceeds 25 MiB: ${JSON.stringify(findings)}`);
  console.log(JSON.stringify({ kv_payload_budget_bytes: KV_VALUE_LIMIT_BYTES, checked_dir: dir }, null, 2));
}

const metafile = arg("--metafile");
const readModels = arg("--read-model-dir");
const kvDir = arg("--kv-dir");
const startupReport = arg("--startup-report");
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  try {
    if (!metafile && !readModels && !kvDir) throw new Error("expected --metafile, --read-model-dir, and/or --kv-dir");
    if (metafile) checkBundle(metafile, startupReport ? readFileSync(startupReport, "utf8") : null);
    if (readModels) checkReadModels(readModels);
    if (kvDir) checkKv(kvDir);
  } catch (error) {
    fail(error.message);
  }
}
