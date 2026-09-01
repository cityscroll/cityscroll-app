#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeLaterHousingActivity } from "../warehouse/lib/later_housing_activity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
const stable = (value) => `${JSON.stringify(value, null, 2)}\n`;
const check = process.argv.includes("--check");

const source = read("warehouse/fixtures/housing-project-activity/source.v1.json");
const projectsDoc = read("site/data/zap_projects_warehouse_lookup.json");
const lotsDoc = read("site/data/zap_bbl_warehouse_lookup.json");
const generatedAt = "2026-08-31T00:00:00.000Z";
const built = materializeLaterHousingActivity({
  projects: projectsDoc.rows,
  projectLots: lotsDoc.rows,
  sourceRows: source.rows,
  sourceVintage: source.source_vintage,
  generatedAt,
});
const outputs = [
  ["site/data/later_housing_activity.json", built.payload],
  ["warehouse/receipts/proof/later_housing_activity_latest.json", built.receipt],
];

if (check) {
  for (const [relative, value] of outputs) {
    if (readFileSync(path.join(ROOT, relative), "utf8") !== stable(value)) throw new Error(`${relative} drifted`);
  }
}
if (!check) {
  for (const [relative, value] of outputs) writeFileSync(path.join(ROOT, relative), stable(value));
}
console.log(`${check ? "checked" : "wrote"} later housing activity: ${built.receipt.counts.projects_with_later_activity} projects, ${built.receipt.counts.later_activity_events} events, ${built.receipt.counts.matched_jobs} jobs`);
