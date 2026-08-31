#!/usr/bin/env node
/*
 * Build the RD-M6 exception-mode coverage receipt from characterized fixtures.
 *
 * Per-mode coverage, date support, source freshness, and unresolved cases are
 * reported independently. A blended exception rate is never computed. The
 * ordinary Rules spine is not rewritten.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measureExceptionModeCoverage } from "../site/rules_exception_modes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/rules_exception_modes/gold.v1.json");
const RECEIPT = join(ROOT, "docs/evidence/rules-exception-modes/coverage.json");
const WAREHOUSE = join(ROOT, "warehouse/receipts/proof/rules_exception_modes_latest.json");

function args(argv) {
  return { check: argv.includes("--check"), fixture: argv.includes("--from-fixture") };
}

function materialize() {
  const gold = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (!gold.characterization_completed_at) {
    throw new Error("exception-mode receipt requires completed source characterization");
  }
  const coverage = measureExceptionModeCoverage(gold.cases);
  return {
    ...coverage,
    generated_from: "test/fixtures/rules_exception_modes/gold.v1.json",
    characterization_completed_at: gold.characterization_completed_at,
    case_ids: gold.cases.map((item) => item.id),
  };
}

const options = args(process.argv.slice(2));
if (!options.fixture && !options.check) throw new Error("use --from-fixture or --check");
if (!existsSync(FIXTURE)) throw new Error(`missing ${FIXTURE}`);
const receipt = materialize();
const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (options.check) {
  const current = readFileSync(RECEIPT, "utf8");
  if (current !== serialized) throw new Error("exception-mode coverage receipt is stale; run node tools/build_rules_exception_modes.mjs --from-fixture");
  const warehouse = readFileSync(WAREHOUSE, "utf8");
  if (warehouse !== serialized) throw new Error("exception-mode warehouse receipt is stale; rebuild coverage");
  console.log("rules exception-mode coverage is current");
} else {
  mkdirSync(dirname(RECEIPT), { recursive: true });
  mkdirSync(dirname(WAREHOUSE), { recursive: true });
  writeFileSync(RECEIPT, serialized);
  writeFileSync(WAREHOUSE, serialized);
  console.log(`wrote ${RECEIPT} and ${WAREHOUSE}`);
}
