/**
 * Read the registered-contract analytical projection from disk through its
 * index, so a build-time consumer never has to know whether the population is
 * sharded. Shard paths are resolved against the index's own directory, which
 * is the same relation the browser and the Worker resolve them by.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyticalProjectionShardPaths,
  combineAnalyticalProjection,
  isShardedAnalyticalProjection,
} from "../../site/analytical_projection_shards.mjs";

export function readAnalyticalProjectionDocument(path) {
  const filePath = path instanceof URL ? fileURLToPath(path) : String(path);
  const manifest = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isShardedAnalyticalProjection(manifest)) return manifest;
  const directory = dirname(filePath);
  const shards = analyticalProjectionShardPaths(manifest)
    .map((shardPath) => JSON.parse(readFileSync(join(directory, shardPath), "utf8")));
  return combineAnalyticalProjection(manifest, shards);
}
