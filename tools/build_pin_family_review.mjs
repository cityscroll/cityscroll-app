#!/usr/bin/env node
/** Materialize the PIN-family Checkbook ↔ PASSPort identity-review artifact. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPinFamilyReview } from "../entity_resolution/cross_domain/pin_family_mismatch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CROSSWALK = path.join(ROOT, "site/data/passport_checkbook_crosswalk.json");
const SPINE = path.join(ROOT, "site/data/procurement_spine_sources.json");
const OUTPUTS = [
  path.join(ROOT, "site/data/pin_family_mismatch_review.json"),
  path.join(ROOT, "worker/src/data/pin_family_mismatch_review.json"),
];

function readJson(file) {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function buildDocument() {
  const crosswalk = readJson(CROSSWALK);
  const spine = readJson(SPINE);
  return buildPinFamilyReview({
    crosswalk,
    observed_on: crosswalk.observed_on || spine.observed_on || null,
    generated_at: crosswalk.generated_at || spine.generated_at || null,
    passportContracts: spine.rows?.passport_contracts || [],
    checkbookContracts: spine.rows?.checkbook_contracts || [],
  });
}

function stable(doc) {
  const { generated_at, ...rest } = doc;
  return JSON.stringify(rest);
}

const check = process.argv.includes("--check");
const doc = buildDocument();
if (check) {
  for (const output of OUTPUTS) {
    if (!existsSync(output)) throw new Error(`missing ${output}`);
    const current = JSON.parse(readFileSync(output, "utf8"));
    if (stable(current) !== stable(doc)) {
      throw new Error(`pin-family review drift — rebuild with tools/build_pin_family_review.mjs: ${output}`);
    }
  }
  console.log(
    `pin-family review ok: pairs=${doc.metrics.pin_family_id_mismatches} auto=${doc.metrics.auto_related_instrument} needs_review=${doc.metrics.needs_review}`,
  );
} else {
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  for (const output of OUTPUTS) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, body);
  }
  console.log(
    `wrote pin-family review: pairs=${doc.metrics.pin_family_id_mismatches} auto=${doc.metrics.auto_related_instrument} needs_review=${doc.metrics.needs_review}`,
  );
}
