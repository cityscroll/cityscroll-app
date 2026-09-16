#!/usr/bin/env node
/**
 * Carry frozen retained PASSPort contract families into the committed spine.
 * Does not bump spine acquisition timestamps.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRetainedContractFamiliesToSpine,
  loadRetainedContractFamilies,
} from "../site/passport_retained_families.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPINE = resolve(ROOT, "site/data/procurement_spine_sources.json");
const RECEIPT = resolve(ROOT, "warehouse/receipts/proof/passport_retained_families_latest.json");

function parseArgs(argv) {
  const args = { write: false, check: false };
  for (const arg of argv) {
    if (arg === "--write") args.write = true;
    else if (arg === "--check") args.check = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requiredCtrIds(retained) {
  return retained.rows.map((row) => String(row.ctr_id)).sort();
}

function missingFromSpine(spine, retained) {
  const have = new Set(
    (spine.rows?.passport_contracts || []).map((row) => String(row.ctr_id || "")),
  );
  return requiredCtrIds(retained).filter((ctrId) => !have.has(ctrId));
}

const args = parseArgs(process.argv.slice(2));
const spine = readJson(SPINE);
const retained = loadRetainedContractFamilies();
const beforeMissing = missingFromSpine(spine, retained);
const applied = applyRetainedContractFamiliesToSpine(spine, retained);
const afterMissing = missingFromSpine(applied.spine, retained);

if (args.check && !args.write) {
  const problems = [];
  if (beforeMissing.length) {
    problems.push(`spine missing retained ctr_id(s): ${beforeMissing.join(", ")}`);
  }
  if (spine.generated_at !== applied.spine.generated_at || spine.observed_on !== applied.spine.observed_on) {
    problems.push("merge would alter spine acquisition timestamps");
  }
  const bhrags = (spine.rows?.passport_contracts || []).find((row) => String(row.ctr_id) === "5050251");
  const retainedBhrags = retained.rows.find((row) => String(row.ctr_id) === "5050251");
  if (bhrags && retainedBhrags) {
    if (Number(bhrags.paid_amount) !== Number(retainedBhrags.paid_amount)) {
      problems.push(`BHRAGS paid_amount ${bhrags.paid_amount} != retained ${retainedBhrags.paid_amount}`);
    }
    if (Number(bhrags.encumbered_amount) !== Number(retainedBhrags.encumbered_amount)) {
      problems.push(
        `BHRAGS encumbered_amount ${bhrags.encumbered_amount} != retained ${retainedBhrags.encumbered_amount}`,
      );
    }
  }
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(
    `retained passport families present: admitted=${applied.merge.stages.admitted_missing} refreshed=${applied.merge.stages.refreshed_existing} selected=${applied.merge.stages.selected}`,
  );
  process.exit(0);
}

if (!args.write) {
  console.log(JSON.stringify({
    ...applied.receipt,
    before_missing_ctr_ids: beforeMissing,
    after_missing_ctr_ids: afterMissing,
  }, null, 2));
  process.exit(0);
}

if (applied.spine.generated_at !== spine.generated_at || applied.spine.observed_on !== spine.observed_on) {
  throw new Error("refusing to write: acquisition timestamps would change");
}

writeFileSync(SPINE, `${JSON.stringify(applied.spine, null, 2)}\n`);
writeFileSync(RECEIPT, `${JSON.stringify(applied.receipt, null, 2)}\n`);
console.log(
  `wrote retained families into spine: admitted=${applied.merge.stages.admitted_missing} refreshed=${applied.merge.stages.refreshed_existing} selected=${applied.merge.stages.selected}`,
);
