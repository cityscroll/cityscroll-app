/**
 * Read the Contracts Browse population from disk through its index, so a
 * build-time consumer never has to know whether the population is sharded.
 * Shard paths are resolved against the index's own directory, which is the
 * same relation the browser and the Worker resolve them by.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  combineProcurementBrowsePopulation,
  isShardedProcurementBrowsePopulation,
  procurementBrowsePopulationShardPaths,
} from "../../site/procurement_browse_population_shards.mjs";

export function readProcurementBrowsePopulation(path) {
  const filePath = path instanceof URL ? fileURLToPath(path) : String(path);
  const manifest = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isShardedProcurementBrowsePopulation(manifest)) return manifest;
  const directory = dirname(filePath);
  const shards = procurementBrowsePopulationShardPaths(manifest)
    .map((shardPath) => JSON.parse(readFileSync(join(directory, shardPath), "utf8")));
  return combineProcurementBrowsePopulation(manifest, shards);
}
