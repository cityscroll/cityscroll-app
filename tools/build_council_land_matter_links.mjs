#!/usr/bin/env node
/**
 * Build/check the compact Council land-matter connection lookup both reader
 * surfaces read.
 *
 * This builder does not invent a second join. It re-runs the accepted bridge
 * over the same committed inputs, refuses to continue unless the result is
 * byte-identical to the committed bridge receipt, and only then projects the
 * compact lookup. That is what keeps the land project detail, the published
 * matter history, and the receipt on one generation: three artifacts cannot
 * describe different populations when two of them are checked against the
 * third before either is written.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flattenCouncilMatterRows, measureCouncilLandBridge } from "../warehouse/lib/council_land_bridge.mjs";
import { buildCouncilLandMatterLinks } from "../warehouse/lib/council_land_matter_links.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEETING_OUTCOMES_SNAPSHOT = path.join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const ZAP_PROJECTS = path.join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const BRIDGE_RECEIPT = path.join(ROOT, "warehouse/receipts/proof/council_land_bridge_latest.json");
const LOOKUP = path.join(ROOT, "site/data/council_land_matter_links.json");

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
  const receiptText = readFileSync(BRIDGE_RECEIPT, "utf8");
  const receipt = JSON.parse(receiptText);
  const measurement = measureCouncilLandBridge({
    rows: flattenCouncilMatterRows(snapshot),
    zapRows: zap.rows,
    // The receipt owns the generation. Re-deriving it here would let this
    // artifact drift onto a second clock the receipt never saw.
    generatedAt: receipt.generated_at,
    sourceVintage: receipt.source_vintage,
  });
  if (stringify(measurement) !== receiptText) {
    throw new Error("the committed Council land-bridge receipt does not reproduce; run tools/build_council_land_bridge.mjs first");
  }
  return buildCouncilLandMatterLinks({ measurement, zapRows: zap.rows });
}

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => arg !== "--check")) {
  throw new Error("Usage: node tools/build_council_land_matter_links.mjs [--check]");
}

const next = stringify(build());
if (args.has("--check")) {
  const current = readFileSync(LOOKUP, "utf8");
  if (current !== next) throw new Error(`${path.relative(ROOT, LOOKUP)} is stale; run the builder`);
  const parsed = JSON.parse(next);
  console.log(`council land-matter links OK (${parsed.bridge.linked_matters} matters, ${parsed.bridge.linked_projects} projects)`);
} else {
  mkdirSync(path.dirname(LOOKUP), { recursive: true });
  writeFileSync(LOOKUP, next);
  console.log(`wrote ${path.relative(ROOT, LOOKUP)}`);
}
