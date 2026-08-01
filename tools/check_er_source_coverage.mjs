#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  console.error(`ER source coverage FAILED: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const index = argv.indexOf("--matrix");
  return index >= 0 ? argv[index + 1] : null;
}

const matrixArg = parseArgs(process.argv.slice(2));
if (!matrixArg) {
  fail("provide --matrix <path>");
} else {
  const matrixPath = resolve(matrixArg);
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  const rows = Array.isArray(matrix.sources) ? matrix.sources : [];
  const ids = new Set();
  const states = new Set(["complete", "gap"]);

  if (!rows.length) fail("sources must be a non-empty array");
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) fail(`source id is missing or duplicated: ${row.id || "<blank>"}`);
    ids.add(row.id);
    for (const field of ["source_system", "importer", "stable_source_key"]) {
      if (!row[field]) fail(`${row.id}: ${field} is required`);
    }
    const importerPath = row.importer?.split("#", 1)[0];
    if (importerPath && !existsSync(resolve(importerPath))) {
      fail(`${row.id}: importer does not exist: ${importerPath}`);
    }
    if (!Array.isArray(row.identity_entities) || !row.identity_entities.length) {
      fail(`${row.id}: identity_entities must be non-empty`);
    }
    for (const phase of ["before", "after"]) {
      if (!states.has(row.dual_write?.[phase])) fail(`${row.id}: invalid dual_write.${phase}`);
    }
    if (row.fixture && !existsSync(resolve(row.fixture))) fail(`${row.id}: fixture does not exist: ${row.fixture}`);
    if (row.dual_write.after === "complete") {
      if (!row.dual_write.flag || row.dual_write.default !== "off" || row.dual_write.fail_soft !== true) {
        fail(`${row.id}: complete rows require an off-by-default, fail-soft flag`);
      }
      if (!row.observation_schema || !row.fixture || !row.replay_test) {
        fail(`${row.id}: complete rows require schema, fixture, and replay_test`);
      }
      if (!existsSync(resolve(row.observation_schema))) fail(`${row.id}: observation schema does not exist`);
      if (!existsSync(resolve(row.replay_test))) fail(`${row.id}: replay test does not exist`);
      if (row.known_gap !== null) fail(`${row.id}: complete rows must clear known_gap`);
    } else if (!row.known_gap) {
      fail(`${row.id}: incomplete rows must name the known gap`);
    }
  }

  const measured = (phase) => rows.filter((row) => row.dual_write?.[phase] === "complete").length;
  for (const phase of ["before", "after"]) {
    const expected = matrix.measurement?.[phase];
    const covered = measured(phase);
    const rate = Number((covered / rows.length).toFixed(4));
    if (expected?.covered !== covered || expected?.total !== rows.length || expected?.rate !== rate) {
      fail(`${phase} measurement drift: expected ${covered}/${rows.length} (${rate})`);
    }
  }

  if (!process.exitCode) {
    const before = matrix.measurement.before;
    const after = matrix.measurement.after;
    console.log(`ER source coverage OK — ${rows.length} streams inventoried; ${before.covered}/${before.total} before → ${after.covered}/${after.total} after`);
  }
}
