#!/usr/bin/env node
// Resync site/data/exam_sources/list_depth_closed_exams.json's volatile fields
// (expected_list_count, expected_established_date) from the already-refreshed
// civil_service_list_aggregates.json, and restamp the freshness clock.
//
// The row set and every reviewed field (title, title_code, application window,
// eligibility) are intentionally preserved as committed: title_code in
// particular is a reviewed exact match from title_code_alias_registry.json,
// not a mechanical join, and this tool does not re-derive it. Only the two
// fields the freshness gate exists to keep current are refreshed here, so a
// row whose exam_number no longer joins civil_service_list_aggregates.json
// fails closed rather than being silently dropped or guessed at.
//
//   node tools/rebuild_list_depth_closed_exams.mjs
//   node tools/rebuild_list_depth_closed_exams.mjs --check
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "site/data/exam_sources");
const CLOSED_FILE = join(SOURCE_DIR, "list_depth_closed_exams.json");
const AGGREGATES_FILE = join(SOURCE_DIR, "civil_service_list_aggregates.json");

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function rebuildListDepthClosed({ today, closed, aggregates } = {}) {
  const day = today || new Date().toISOString().slice(0, 10);
  const aggByExam = new Map(aggregates.records.map((row) => [row.exam_number, row]));
  const records = closed.records.map((row) => {
    const agg = aggByExam.get(row.exam_number);
    assert(agg, `${row.exam_number} no longer joins civil_service_list_aggregates.json; this file's own invariant requires a non-null list join for every row`);
    return {
      ...row,
      expected_list_count: agg.list_count,
      expected_established_date: agg.established_date ?? null,
    };
  });
  return {
    ...closed,
    source: { ...closed.source, fetched_at: day },
    records,
  };
}

async function main() {
  const check = process.argv.includes("--check");
  const [closed, aggregates] = await Promise.all([readJson(CLOSED_FILE), readJson(AGGREGATES_FILE)]);
  const rebuilt = await rebuildListDepthClosed({ closed, aggregates });
  const output = stableJson(rebuilt);
  if (check) {
    const current = await readFile(CLOSED_FILE, "utf8");
    assert.equal(output, current, "list_depth_closed_exams.json is stale against civil_service_list_aggregates.json; run node tools/rebuild_list_depth_closed_exams.mjs");
    console.log("list_depth_closed_exams.json is current");
    return;
  }
  await writeFile(CLOSED_FILE, output);
  console.log(`rebuilt list_depth_closed_exams.json (${rebuilt.records.length} exams)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
