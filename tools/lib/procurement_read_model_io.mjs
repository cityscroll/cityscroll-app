import { readFileSync } from "node:fs";

import { combineSharedProcurementReadModel } from "../../site/procurement_read_model_shards.mjs";

export function readSharedProcurementReadModel(pathOrUrl) {
  const manifest = JSON.parse(readFileSync(pathOrUrl, "utf8"));
  if (Array.isArray(manifest?.rows) || !Array.isArray(manifest?.shards)) return manifest;
  const shards = manifest.shards.map((descriptor) => {
    const shardPath = new URL(`../../site/data/${descriptor.path}`, import.meta.url);
    return JSON.parse(readFileSync(shardPath, "utf8"));
  });
  return combineSharedProcurementReadModel(manifest, shards);
}
