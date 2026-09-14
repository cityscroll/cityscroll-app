#!/usr/bin/env node
/** Build the parcel lifecycle artifact from retained materialized inputs. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeSiteLifecycle, shardSiteLifecycle } from "../site/site_lifecycle_projection.mjs";

export function writeSiteLifecycleProjection(document, { outputDir = "site/data/site_lifecycle", receiptPath = "warehouse/receipts/proof/site_lifecycle_membership.json", shardSize, sourceVintage = null, evidence = [], negativeRules = [] } = {}) {
  mkdirSync(outputDir, { recursive: true });
  const shards = shardSiteLifecycle(document, shardSize);
  for (const shard of shards) writeFileSync(join(outputDir, `${shard.shard}.json`), `${JSON.stringify(shard, null, 2)}\n`);
  const manifest = { schema: "cityscroll.site_lifecycle.manifest.v1", version: 1, generation: document.generation, content_hash: document.content_hash, counts: document.counts, shards: shards.map((shard) => `${shard.shard}.json`) };
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const reverse = { schema: "cityscroll.site_lifecycle.reverse.v1", version: 1, generation: document.generation, content_hash: document.content_hash, members: document.members };
  writeFileSync(join(outputDir, "reverse.json"), `${JSON.stringify(reverse, null, 2)}\n`);
  const receipt = { schema: "cityscroll.site_lifecycle_membership_receipt.v1", projection_schema: document.schema, generated_at: document.generated_at, source_vintage: sourceVintage, generation: document.generation, content_hash: document.content_hash, counts: document.counts, shards: manifest.shards, reverse_index: { path: join(outputDir, "reverse.json"), generation: reverse.generation, content_hash: reverse.content_hash }, parcels: Object.fromEntries(Object.entries(document.parcels).map(([parcelId, parcel]) => [parcelId, { member_ids: parcel.members.map((member) => member.subject_id) }])), evidence, negative_rules: negativeRules };
  mkdirSync(join(receiptPath, ".."), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("Inputs are publisher-specific; call writeSiteLifecycleProjection from the materialization job.");
  process.exitCode = 2;
}
