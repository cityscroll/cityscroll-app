#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { measureFranchiseMocsPlanJoin } from "./lib/franchise_mocs_plan_join.mjs";

function parseArgs(argv) {
  const args = { sample_size: 100, observed_at: new Date().toISOString() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--plans") args.plans = argv[++i];
    else if (flag === "--franchises") args.franchises = argv[++i];
    else if (flag === "--review-file") args.review_file = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--sample-size") args.sample_size = Number(argv[++i]);
    else if (flag === "--observed-at") args.observed_at = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.plans || !args.franchises || !args.out) {
    throw new Error("Usage: --plans <mocs jsonl> --franchises <endpoint json> --out <receipt json>");
  }
  return args;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const planPath = resolve(args.plans);
const franchisePath = resolve(args.franchises);
const plans = readFileSync(planPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const franchises = JSON.parse(readFileSync(franchisePath, "utf8"));
const reviewLabels = args.review_file ? JSON.parse(readFileSync(resolve(args.review_file), "utf8")) : {};
const result = measureFranchiseMocsPlanJoin(franchises.notices || [], plans, {
  sample_size: args.sample_size,
  review_labels: reviewLabels,
});
const receipt = {
  schema: "cityscroll.franchise_mocs_plan_join_receipt.v1",
  observed_at_utc: args.observed_at,
  mode: "production",
  source_contracts: ["mocs-ll63-plans", "mocs-ll1-plans", "city-record"],
  sources: {
    mocs_plans: {
      indexes: [
        "https://www.nyc.gov/site/mocs/resources/standard-prof-services-ll63.page",
        "https://www.nyc.gov/site/mocs/resources/m-wbe-ll1.page"
      ],
      sha256: sha256(planPath),
    },
    franchise_notices: {
      endpoint: "https://api.cityscroll.org/franchise-concessions",
      sha256: sha256(franchisePath),
    },
  },
  ...result,
};
writeFileSync(resolve(args.out), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ out: resolve(args.out), ...receipt.join_measurement }));
