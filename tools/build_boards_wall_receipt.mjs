#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchLegistarBodies } from "../worker/src/lib/legistar_client.mjs";
import {
  buildBoardsWallReceipt,
  measureCommunityBoardExtraction,
} from "../entity_resolution/candidate_generation/boards_wall.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVED_ON = "2026-08-06";
const OUTPUT = path.join(ROOT, "entity_resolution/review/boards_wall_measurement.json");

async function json(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const [sourceRegistry, sourceContracts, extractionFixture, mayoralRegistry, bodyFixture] = await Promise.all([
    json("site/data/non_council_outcome_sources/source_registry.json"),
    json("site/data/source_contracts.json"),
    json("test/fixtures/boards/community_board_extraction.json"),
    json("entity_resolution/review/mayoral_board_registry.json"),
    json("test/fixtures/legistar/bodies.json"),
  ]);
  const legistarContract = sourceContracts.contracts.find((row) => row.id === "nyc-council-legistar");
  assert.ok(legistarContract, "nyc-council-legistar source contract is required");
  const boards = sourceRegistry.sources.filter((row) => row.body_type === "community_board");
  const knownBodyTypes = new Set(["community_board", "borough_president"]);
  const unclassifiedSourceBodyTypes = [...new Set(
    sourceRegistry.sources.map((row) => row.body_type).filter((type) => type && !knownBodyTypes.has(type)),
  )];
  const excludedSourceCounts = {
    borough_president: sourceRegistry.sources.filter((row) => row.body_type === "borough_president").length,
  };
  const byBorough = Object.fromEntries([...new Set(boards.map((row) => row.borough))].sort().map((borough) => [
    borough,
    boards.filter((row) => row.borough === borough).length,
  ]));
  const communityExtraction = measureCommunityBoardExtraction(extractionFixture);
  const live = process.argv.includes("--live");
  if (live && !process.env.LEGISTAR_API_TOKEN) {
    throw new Error("LEGISTAR_API_TOKEN is required for --live board receipt acquisition");
  }
  const legistarBodies = live
    ? await fetchLegistarBodies({ token: process.env.LEGISTAR_API_TOKEN })
    : bodyFixture;
  const receipt = buildBoardsWallReceipt({
    observedOn: OBSERVED_ON,
    legistarBodies,
    legistarMode: live ? "live_ci_token" : "fixture",
    legistarCoverage: {
      source_contract_observed_on: legistarContract.join_measurement?.observed_on || null,
      modern_notices_strict: legistarContract.join_measurement?.rates?.modern_notices_strict || null,
      modern_joined_with_event_items: legistarContract.join_measurement?.rates?.modern_joined_with_event_items || null,
      auth_token_env: legistarContract.auth_token_env || null,
    },
    communityInventory: { inventoried: boards.length, expected: 59, by_borough: byBorough },
    unclassifiedSourceBodyTypes,
    excludedSourceCounts,
    communityExtraction,
    mayoralRegistry,
  });
  const serialized = serialize(receipt);
  if (process.argv.includes("--check")) {
    assert.equal(await readFile(OUTPUT, "utf8"), serialized, "boards wall receipt is stale");
    console.log("boards wall receipt is current");
    return;
  }
  await writeFile(OUTPUT, serialized);
  console.log(JSON.stringify({
    output: path.relative(ROOT, OUTPUT),
    mode: live ? "live_ci_token" : "fixture",
    council_adjacent_bodies: receipt.strata.council_adjacent.bodies_observed,
    community_boards: receipt.strata.community_boards.inventory.observed,
    community_fixture_precision: receipt.strata.community_boards.extraction.precision,
    mayoral_registry_entries: receipt.strata.mayoral_commissions.entries,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
