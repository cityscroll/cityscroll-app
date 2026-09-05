#!/usr/bin/env node
/** Build/check the bounded LDP-12 Community Board / Borough President land-bridge receipt. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { measureBoardBpLandBridge } from "../warehouse/lib/board_bp_land_bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_MEETING_MODEL = path.join(ROOT, "site/data/shared_meeting_read_model.json");
const ZAP_PROJECTS = path.join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const LAND_DEFAULT_ULURP = path.join(ROOT, "site/data/land_default_ulurp.json");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/board_bp_land_bridge_latest.json");
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
  const model = JSON.parse(readFileSync(SHARED_MEETING_MODEL, "utf8"));
  const zap = JSON.parse(readFileSync(ZAP_PROJECTS, "utf8"));
  const landDefault = JSON.parse(readFileSync(LAND_DEFAULT_ULURP, "utf8"));
  return measureBoardBpLandBridge({
    rows: model.rows,
    zapRows: zap.rows,
    dispositionsByProject: landDefault.outcomes?.by_project || {},
    generatedAt: MEASURED_ON,
    sourceVintage: {
      shared_meeting_read_model_generated_at: model.generated_at,
      shared_meeting_read_model_counts: model.counts,
      zap_projects_warehouse_lookup_materialized_at: zap.materialized_at,
      land_default_ulurp_generated_at: landDefault.generated_at,
    },
  });
}

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => arg !== "--check")) {
  throw new Error("Usage: node tools/build_board_bp_land_bridge.mjs [--check]");
}

const next = stringify(build());
if (args.has("--check")) {
  const current = readFileSync(RECEIPT, "utf8");
  if (current !== next) throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run the builder`);
  console.log(`board/BP land-bridge receipt OK (${JSON.parse(next).gate.result})`);
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
  console.log(`wrote ${path.relative(ROOT, RECEIPT)}`);
}
