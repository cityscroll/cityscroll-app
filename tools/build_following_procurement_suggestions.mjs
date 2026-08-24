#!/usr/bin/env node

/* Keep the Following suggestion input behaviorally identical while omitting
 * provenance-heavy fields that are not read by following_suggestions.mjs. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INPUT = resolve(ROOT, "site/data/procurement_browse_rows.json");
const OUTPUT = resolve(ROOT, "site/data/following_procurement_suggestions.json");
const FIELDS = [
  "procurement_id", "procurement_stages", "primary_stage", "request_id",
  "agency_name", "short_title", "due_date", "status", "temporal_status", "lifecycle_status",
  "type_of_notice_description", "borough", "affected_area", "place",
  "rule_evidence", "matter_subject",
];

const source = JSON.parse(readFileSync(INPUT, "utf8"));
const rows = (source.rows || []).map((row) => Object.fromEntries(
  FIELDS.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]),
));
const output = {
  schema: "cityscroll.following_procurement_suggestions.v1",
  generated_at: source.generated_at || null,
  source_model_schema: source.source_model_schema || null,
  row_count: rows.length,
  rows,
};
const serialized = `${JSON.stringify(output)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUTPUT, "utf8") !== serialized) {
    console.error(`stale Following procurement suggestions: ${OUTPUT}`);
    process.exit(1);
  }
} else {
  writeFileSync(OUTPUT, serialized);
}
console.log(`following procurement suggestions: ${serialized.length} bytes (${rows.length} rows)`);
