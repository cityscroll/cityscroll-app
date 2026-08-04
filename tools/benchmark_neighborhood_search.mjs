#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { resolveNeighborhood } from "../site/neighborhood_search.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gazetteer = JSON.parse(await readFile(resolve(ROOT, "site/data/neighborhood_gazetteer.json"), "utf8"));
const queries = [...gazetteer.common_neighborhoods, "Canarsy", "Bed Stuy", "Chelsea Hudson Yards"];
const iterations = 100;
const samples = [];
let resolved = 0;

for (let pass = 0; pass < iterations; pass += 1) {
  for (const query of queries) {
    const start = performance.now();
    if (resolveNeighborhood(query, gazetteer)) resolved += 1;
    samples.push(performance.now() - start);
  }
}
samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const receipt = {
  schema: "cityscroll.neighborhood_search_performance.v1",
  measured_at: new Date().toISOString(),
  runtime: process.version,
  gazetteer_entries: gazetteer.neighborhood_count,
  query_count: queries.length,
  iterations,
  resolutions: samples.length,
  resolved,
  mean_ms: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(4)),
  p95_ms: Number(percentile(0.95).toFixed(4)),
  p99_ms: Number(percentile(0.99).toFixed(4)),
  max_ms: Number(samples.at(-1).toFixed(4)),
  budget_p95_ms: 2,
  within_budget: percentile(0.95) < 2,
};
if (!receipt.within_budget || resolved !== samples.length) {
  throw new Error(`neighborhood resolver benchmark failed: ${JSON.stringify(receipt)}`);
}
const out = resolve(ROOT, "warehouse/receipts/proof/neighborhood_search_latest.json");
await writeFile(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
