#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommunityBoardGeography,
  COMMUNITY_BOARD_GEOGRAPHY_VINTAGE,
} from "../site/community_board_geography.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUTS = [
  path.join(ROOT, "site/data/community_board_geography_lookup.json"),
  path.join(ROOT, "worker/src/data/community_board_geography_lookup.json"),
];
const RECEIPT = path.join(
  ROOT,
  "site/data/community_board_geography/verification_receipts/overlay_2026-08-12.json",
);
const OBSERVED_AT = "2026-08-12T00:00:00.000Z";

async function json(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
}

async function main() {
  const [sourceRegistry, boundaries] = await Promise.all([
    json("site/data/non_council_outcome_sources/source_registry.json"),
    json("site/data/district_boundaries.json"),
  ]);
  const doc = buildCommunityBoardGeography({ sourceRegistry, boundaries, observedAt: OBSERVED_AT });
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    for (const output of OUTPUTS) {
      const existing = await readFile(output, "utf8");
      if (existing !== serialized) throw new Error(`stale community-board geography: ${output}`);
    }
    const receipt = await readFile(RECEIPT, "utf8");
    const expectedReceipt = `${JSON.stringify({
      schema: doc.schema,
      generated_at: doc.generated_at,
      boundary_vintage: doc.boundary_vintage,
      inventory: doc.inventory,
      gate: doc.gate,
      receipt: doc.receipt,
    }, null, 2)}\n`;
    if (receipt !== expectedReceipt) throw new Error("stale community-board geography receipt");
    console.log(`community-board geography ok pairs=${doc.gate.observed_pair_count} publication=${doc.gate.publication_status}`);
    return;
  }
  for (const output of OUTPUTS) {
    mkdirSync(path.dirname(output), { recursive: true });
    await writeFile(output, serialized);
  }
  const receipt = {
    schema: doc.schema,
    generated_at: doc.generated_at,
    boundary_vintage: doc.boundary_vintage,
    inventory: doc.inventory,
    gate: doc.gate,
    receipt: doc.receipt,
  };
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({
    outputs: OUTPUTS.map((output) => path.relative(ROOT, output)),
    receipt: path.relative(ROOT, RECEIPT),
    pair_count: doc.gate.observed_pair_count,
    average_per_community_district: doc.receipt.average_council_districts_per_community_district,
    publication: doc.gate.publication_status,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
