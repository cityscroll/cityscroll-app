#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import { loadWatermark } from "./architecture_watermark.mjs";
import { buildReport } from "./reconcile_architecture.mjs";
import {
  PRODUCT_UPDATE_JOINS,
  buildProductUpdatesArtifact,
  serializeProductUpdatesArtifact,
  validatePublicProductUpdatesArtifact,
} from "../site/product_updates_source.mjs";

export const CHANGELOG_URL = new URL("../site/changelog-data.json", import.meta.url);
export const DEMO_MANIFEST_URL = new URL("../site/demo/demo-links.json", import.meta.url);
export const OUTPUT_URL = new URL("../site/product-updates.json", import.meta.url);

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

export function loadCheckedReconciliation({ root } = {}) {
  const report = buildReport(root ? { root } : {});
  const watermark = loadWatermark(root ? { root } : {});
  return {
    schema: report.schema,
    status: report.status,
    path: "architecture/generated/reconciliation.json",
    observed_commit: watermark?.commit || report.facts?.regenerated_commit || null,
    as_of: watermark?.generated_at || report.generated_at || null,
    baseline: report.facts?.baseline || "architecture/generated/watermark.json",
  };
}

export function loadProductUpdateSources(options = {}) {
  return {
    changelog: options.changelog || readJson(CHANGELOG_URL),
    reconciliation: options.reconciliation || loadCheckedReconciliation(options),
    capabilities: options.capabilities || CAPABILITY_REGISTRY,
    demoManifest: options.demoManifest || readJson(DEMO_MANIFEST_URL),
    joins: options.joins || PRODUCT_UPDATE_JOINS,
  };
}

export function generateProductUpdatesArtifact(options = {}) {
  return buildProductUpdatesArtifact(loadProductUpdateSources(options));
}

export function productUpdatesArtifactText(artifact) {
  return serializeProductUpdatesArtifact(artifact);
}

export function checkProductUpdatesArtifact(options = {}) {
  const expected = generateProductUpdatesArtifact(options);
  const outputPath = options.outputPath || fileURLToPath(OUTPUT_URL);
  if (!existsSync(outputPath)) {
    return ["site/product-updates.json is missing; rebuild product-update candidates"];
  }
  let actual = null;
  try {
    actual = readFileSync(outputPath, "utf8");
  } catch (error) {
    return [`site/product-updates.json cannot be read: ${error?.message || error}`];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(actual);
  } catch {
    return ["site/product-updates.json is invalid JSON"];
  }
  const validationErrors = validatePublicProductUpdatesArtifact(parsed);
  if (validationErrors.length) {
    return ["site/product-updates.json is invalid", ...validationErrors];
  }
  if (actual === productUpdatesArtifactText(expected)) return [];
  return [
    `site/product-updates.json is stale; expected content hash ${expected.content_hash}, found ${parsed.content_hash}`,
  ];
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  if (check) {
    const errors = checkProductUpdatesArtifact();
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
      return;
    }
    const artifact = generateProductUpdatesArtifact();
    console.log(`checked site/product-updates.json candidates=${artifact.candidates.length} eligible=${artifact.eligible_ids.length} hash=${artifact.content_hash}`);
    return;
  }
  const artifact = generateProductUpdatesArtifact();
  const errors = validatePublicProductUpdatesArtifact(artifact);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  writeFileSync(new URL(OUTPUT_URL), productUpdatesArtifactText(artifact));
  console.log(`wrote site/product-updates.json candidates=${artifact.candidates.length} eligible=${artifact.eligible_ids.length} hash=${artifact.content_hash}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
