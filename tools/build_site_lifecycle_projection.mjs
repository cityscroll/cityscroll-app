#!/usr/bin/env node
/** Build the parcel lifecycle artifact from retained materialized inputs. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeSiteLifecycle, shardSiteLifecycle } from "../site/site_lifecycle_projection.mjs";

export function writeSiteLifecycleProjection(document, { outputDir = "site/data/site_lifecycle", shardSize } = {}) {
  mkdirSync(outputDir, { recursive: true });
  const shards = shardSiteLifecycle(document, shardSize);
  for (const shard of shards) writeFileSync(join(outputDir, `${shard.shard}.json`), `${JSON.stringify(shard, null, 2)}\n`);
  const manifest = { schema: "cityscroll.site_lifecycle.manifest.v1", version: 1, generation: document.generation, content_hash: document.content_hash, counts: document.counts, shards: shards.map((shard) => `${shard.shard}.json`) };
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("Inputs are publisher-specific; call writeSiteLifecycleProjection from the materialization job.");
  process.exitCode = 2;
}
