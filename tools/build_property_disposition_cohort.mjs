#!/usr/bin/env node
/**
 * Materialize exact-BBL Property hearing-to-auction cohort evidence.
 *
 *   node tools/build_property_disposition_cohort.mjs
 *   node tools/build_property_disposition_cohort.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPropertyDispositionCohort,
  propertyDispositionCohortReceipt,
} from "./lib/property_disposition_cohort.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVATIONS = join(ROOT, "site/data/property_domain_observations.json");
const CROSS_DOMAIN = join(ROOT, "site/data/property_cross_domain_lookup.json");
const OUT = join(ROOT, "site/data/property_disposition_cohort.json");
const RECEIPT = join(
  ROOT,
  "site/data/property_sources/verification_receipts/property_disposition_cohort_latest.json",
);
const checkOnly = process.argv.includes("--check");

const observations = JSON.parse(readFileSync(OBSERVATIONS, "utf8"));
const crossDomain = JSON.parse(readFileSync(CROSS_DOMAIN, "utf8"));
const cohort = buildPropertyDispositionCohort(observations, crossDomain);
const receipt = propertyDispositionCohortReceipt(cohort);

if (checkOnly) {
  const existingCohort = JSON.parse(readFileSync(OUT, "utf8"));
  const existingReceipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
  if (JSON.stringify(existingCohort) !== JSON.stringify(cohort)) {
    console.error("property_disposition_cohort.json is stale — re-run without --check");
    process.exit(1);
  }
  if (JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
    console.error("property_disposition_cohort_latest.json is stale — re-run without --check");
    process.exit(1);
  }
  console.log("ok property disposition cohort evidence is current");
  process.exit(0);
}

writeFileSync(OUT, `${JSON.stringify(cohort, null, 2)}\n`);
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      n: cohort.cohort.n,
      status: cohort.eligibility.status,
      out: [OUT, RECEIPT],
    },
    null,
    2,
  ),
);
