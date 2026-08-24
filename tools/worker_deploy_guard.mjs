#!/usr/bin/env node
// Pre-deploy guard shared by CI and local verification. It is deliberately
// independent of Wrangler so an oversize fixture can prove the failure path.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LIMIT_BYTES = 52 * 1024 * 1024;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function fail(message) {
  console.error(`Worker deploy guard failed: ${message}`);
  process.exitCode = 1;
}

function checkBundle(path) {
  const meta = JSON.parse(readFileSync(path, "utf8"));
  const output = Object.values(meta.outputs || {}).find((entry) => entry.entryPoint);
  if (!output) throw new Error("Worker bundle output missing from Wrangler metafile");
  const largest = Object.entries(output.inputs || {})
    .map(([input, value]) => ({ input, bytes: Number(value.bytesInOutput) || 0 }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 5);
  console.log(JSON.stringify({
    bundle_bytes: output.bytes,
    bundle_mib: Number(output.bytes / 1024 / 1024).toFixed(2),
    five_largest_inputs: largest,
    budget_bytes: LIMIT_BYTES,
  }, null, 2));
  if (Number(output.bytes) > LIMIT_BYTES) {
    throw new Error(`Worker bundle ${output.bytes} bytes exceeds 52 MiB budget`);
  }
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

const metafile = arg("--metafile");
const readModels = arg("--read-model-dir");
try {
  if (!metafile && !readModels) throw new Error("expected --metafile and/or --read-model-dir");
  if (metafile) checkBundle(metafile);
  if (readModels) checkReadModels(readModels);
} catch (error) {
  fail(error.message);
}
