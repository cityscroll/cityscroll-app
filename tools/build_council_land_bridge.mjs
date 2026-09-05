#!/usr/bin/env node
/** Build/check the bounded LDP-11 Council exact-identifier land-bridge receipt. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flattenCouncilMatterRows, measureCouncilLandBridge } from "../warehouse/lib/council_land_bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEETING_OUTCOMES_SNAPSHOT = path.join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const ZAP_PROJECTS = path.join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/council_land_bridge_latest.json");
// Pinned to the measurement date: this receipt is a bounded point-in-time
// reconciliation over already-committed inputs, not a live-refreshed feed,
// so a re-run against the same committed inputs must reproduce byte-for-byte.
const MEASURED_ON = "2026-09-05T00:00:00.000Z";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function build() {
  const snapshot = JSON.parse(readFileSync(MEETING_OUTCOMES_SNAPSHOT, "utf8"));
  const zap = JSON.parse(readFileSync(ZAP_PROJECTS, "utf8"));
  const rows = flattenCouncilMatterRows(snapshot);
  return measureCouncilLandBridge({
    rows,
    zapRows: zap.rows,
    generatedAt: MEASURED_ON,
    sourceVintage: {
      meeting_outcomes_snapshot_generated_at: snapshot.generated_at,
      meeting_outcomes_snapshot_counts: {
        record_count: snapshot.record_count,
        present_count: snapshot.present_count,
        absent_count: snapshot.absent_count,
      },
      zap_projects_warehouse_lookup_materialized_at: zap.materialized_at,
    },
  });
}

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => arg !== "--check")) {
  throw new Error("Usage: node tools/build_council_land_bridge.mjs [--check]");
}

const next = stringify(build());
if (args.has("--check")) {
  const current = readFileSync(RECEIPT, "utf8");
  if (current !== next) throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run the builder`);
  console.log(`council land-bridge receipt OK (${JSON.parse(next).gate.result})`);
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
  console.log(`wrote ${path.relative(ROOT, RECEIPT)}`);
}
