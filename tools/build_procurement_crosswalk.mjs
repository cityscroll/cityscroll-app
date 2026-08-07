#!/usr/bin/env node
/** Materialize the bounded Checkbook ↔ PASSPort procurement crosswalk. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPassportCheckbookCrosswalk } from "../entity_resolution/cross_domain/procurement_crosswalk.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = path.join(ROOT, "site/data/procurement_spine_sources.json");
const OUTPUTS = [
  path.join(ROOT, "site/data/passport_checkbook_crosswalk.json"),
  path.join(ROOT, "worker/src/data/passport_checkbook_crosswalk.json"),
];

function readInput() {
  if (!existsSync(INPUT)) throw new Error(`missing ${INPUT}`);
  const doc = JSON.parse(readFileSync(INPUT, "utf8"));
  return {
    observed_on: doc.observed_on || null,
    generated_at: doc.generated_at || null,
    passportContracts: doc.rows?.passport_contracts_materialization || [],
    checkbookContracts: doc.rows?.checkbook_contracts || [],
  };
}
function buildDocument(input) {
  const crosswalk = buildPassportCheckbookCrosswalk(input);
  return {
    schema_version: 1,
    title: "Bounded Checkbook Contracts ↔ PASSPort Public crosswalk",
    observed_on: input.observed_on,
    generated_at: input.generated_at,
    sources: {
      passport: "site/data/procurement_spine_sources.json#rows.passport_contracts_materialization",
      checkbook: "site/data/procurement_spine_sources.json#rows.checkbook_contracts",
    },
    metrics: crosswalk.metrics,
    rows: crosswalk.rows,
  };
}

function stable(doc) {
  const { generated_at, ...rest } = doc;
  return JSON.stringify(rest);
}

const check = process.argv.includes("--check");
const doc = buildDocument(readInput());
if (check) {
  for (const output of OUTPUTS) {
    if (!existsSync(output)) throw new Error(`missing ${output}`);
    const current = JSON.parse(readFileSync(output, "utf8"));
    if (stable(current) !== stable(doc)) {
      throw new Error(`crosswalk drift — rebuild with tools/build_procurement_crosswalk.mjs: ${output}`);
    }
  }
  console.log(`procurement crosswalk ok: rows=${doc.rows.length} matched=${doc.metrics.matched}`);
} else {
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  for (const output of OUTPUTS) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, body);
  }
  console.log(`wrote procurement crosswalk: rows=${doc.rows.length} matched=${doc.metrics.matched}`);
}
