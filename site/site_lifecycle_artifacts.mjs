/**
 * Committed site-lifecycle artifacts for synchronous land/procurement renders.
 * Loads every shard named by the committed manifest through the generation-
 * checked reader. When the manifest gains shards, add matching static imports.
 */

import manifest from "./data/site_lifecycle/manifest.json" with { type: "json" };
import reverse from "./data/site_lifecycle/reverse.json" with { type: "json" };
import shard0000 from "./data/site_lifecycle/0000.json" with { type: "json" };
import { assembleSiteLifecycleDocument } from "./site_lifecycle_reader.mjs";

const SHARD_MODULES = Object.freeze({
  "0000.json": shard0000,
});

/** Return the committed lifecycle document, refusing missing shard modules. */
export function loadCommittedSiteLifecycleDocument() {
  const missing = (manifest.shards || []).filter((name) => !SHARD_MODULES[name]);
  if (missing.length) {
    throw new Error(`site lifecycle shard modules missing: ${missing.join(",")}`);
  }
  const shards = (manifest.shards || []).map((name) => SHARD_MODULES[name]);
  return assembleSiteLifecycleDocument(manifest, shards, reverse);
}
