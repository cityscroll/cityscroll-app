#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

import { resolveCivicGeographies } from "../site/civic_geography.mjs";
import { resolveDistricts } from "../site/council_district_lookup.mjs";

const COMPATIBILITY_GZIP_BUDGET = 56_000;
const COMPATIBILITY_PARSE_P95_MS = 2;
const COMPATIBILITY_RESOLVE_US = 10;
const GENERIC_RESOLVE_US = 30;

const compatibilityText = readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8");
const compatibilityLayer = JSON.parse(compatibilityText);
const registry = JSON.parse(readFileSync(new URL("../site/data/geography/layer_registry.json", import.meta.url), "utf8"));
const layerData = registry.layers.map((row) => JSON.parse(readFileSync(
  new URL(`../${row.artifacts.simplified.site_path}`, import.meta.url),
  "utf8",
)));
const points = [
  [40.7473, -73.8832],
  [40.7128, -74.0060],
  [40.7255, -73.9835],
  [40.6782, -73.9442],
  [40.5795, -74.1502],
];

function p95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function benchmark(iterations, callback) {
  for (let index = 0; index < 1_000; index += 1) callback(points[index % points.length]);
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) callback(points[index % points.length]);
  return (performance.now() - started) * 1_000 / iterations;
}

const parseSamples = [];
for (let index = 0; index < 100; index += 1) {
  const started = performance.now();
  JSON.parse(compatibilityText);
  parseSamples.push(performance.now() - started);
}

const receipt = {
  schema: "cityscroll.civic_geography_benchmark.v1",
  compatibility_gzip_bytes: gzipSync(compatibilityText).byteLength,
  compatibility_parse_p95_ms: Number(p95(parseSamples).toFixed(3)),
  compatibility_resolve_us_per_op: Number(benchmark(
    50_000,
    ([lat, lon]) => resolveDistricts(lat, lon, compatibilityLayer),
  ).toFixed(3)),
  generic_three_layer_resolve_us_per_op: Number(benchmark(
    50_000,
    ([lat, lon]) => resolveCivicGeographies(lat, lon, { layerData }),
  ).toFixed(3)),
  budgets: {
    compatibility_gzip_bytes: COMPATIBILITY_GZIP_BUDGET,
    compatibility_parse_p95_ms: COMPATIBILITY_PARSE_P95_MS,
    compatibility_resolve_us_per_op: COMPATIBILITY_RESOLVE_US,
    generic_three_layer_resolve_us_per_op: GENERIC_RESOLVE_US,
  },
};

const failures = Object.entries(receipt.budgets)
  .filter(([metric, budget]) => receipt[metric] > budget)
  .map(([metric, budget]) => `${metric} ${receipt[metric]} > ${budget}`);

console.log(JSON.stringify(receipt, null, 2));
if (process.argv.includes("--check") && failures.length) {
  console.error(`civic geography benchmark failed: ${failures.join("; ")}`);
  process.exitCode = 1;
}
