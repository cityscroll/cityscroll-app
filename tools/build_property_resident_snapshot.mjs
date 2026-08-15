#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachDispositionSpines } from "../worker/src/lib/property_disposition_spine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = path.join(ROOT, "site", "data", "property_domain_observations.json");
const OUTPUT = path.join(ROOT, "site", "data", "property_resident_snapshot.json");

export function buildPropertyResidentSnapshot(observations) {
  const properties = Array.isArray(observations?.property_rows)
    ? observations.property_rows
    : [];
  return attachDispositionSpines({
    schema_version: 1,
    delivery_tier: "resident-snapshot",
    generated_at: observations?.generated_at || observations?.source_generated_at || null,
    // Never publish the collector's machine-local intake path. The committed
    // observation artifact is the stable provenance boundary for this snapshot.
    source: "site/data/property_domain_observations.json",
    counts: {
      total: properties.length,
      local: properties.filter((row) => row?.property_location?.scope === "local").length,
      unlocated: properties.filter((row) => row?.property_location?.scope === "unlocated").length,
      geometry: properties.filter((row) => row?.property_location?.geometry).length,
    },
    properties,
  });
}

async function main() {
  const observations = JSON.parse(await readFile(INPUT, "utf8"));
  const rendered = `${JSON.stringify(buildPropertyResidentSnapshot(observations), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    assert.equal(
      await readFile(OUTPUT, "utf8").catch(() => null),
      rendered,
      "site/data/property_resident_snapshot.json is stale; rebuild with node tools/build_property_resident_snapshot.mjs",
    );
  } else {
    await writeFile(OUTPUT, rendered);
    process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
