#!/usr/bin/env node
/**
 * Module-graph digest for site/app/*.mjs.
 *
 *   node tools/site_module_architecture.mjs --check   # validate graph and print digest
 *   node tools/site_module_architecture.mjs --update  # compatibility alias for --check
 *   node tools/site_module_architecture.mjs --print   # print digest as JSON
 *
 * Fingerprint rules match test/site_module_architecture.test.mjs:
 * concatenate each module's behavior source (before live-binding publication
 * footers) in SITE_MODULES loader order, normalizing moved-module dynamic
 * imports from "../" to "./".
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_ISLAND_MODULES, SITE_MODULES } from "../test/helpers/site_source.mjs";
import { runArchitectureFitness } from "./architecture_fitness.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_DIR = path.join(ROOT, "site/app");
const LOADER_PATH = path.join(APP_DIR, "main.mjs");

const LIVE_BINDING_MARKER =
  "\n// Publish live bindings for neighboring modules and legacy inline handlers.";

function behaviorSource(name) {
  const raw = readFileSync(path.join(APP_DIR, name), "utf8");
  return raw
    .split(LIVE_BINDING_MARKER)[0]
    .replaceAll('import("../', 'import("./');
}

export function computeModuleGraphDigest() {
  const source = SITE_MODULES.map(behaviorSource).join("\n");
  return {
    normalized_source_bytes: Buffer.byteLength(source),
    normalized_source_sha256: createHash("sha256").update(source).digest("hex"),
    module_count: SITE_MODULES.length,
  };
}

export function validateModuleGraph() {
  const loader = readFileSync(LOADER_PATH, "utf8");
  const loaderModules = [...loader.matchAll(/import\("\.\/(.+?)"\)/g)].map(
    (match) => match[1],
  );
  const applicationModules = readdirSync(APP_DIR)
    .filter((name) => name.endsWith(".mjs") && name !== "main.mjs")
    .sort();

  if (new Set(loaderModules).size !== loaderModules.length) {
    throw new Error("site/app/main.mjs registers a module more than once");
  }
  if (JSON.stringify(loaderModules) !== JSON.stringify(SITE_MODULES)) {
    throw new Error("site/app/main.mjs and SITE_MODULES disagree on import order");
  }
  if (new Set(ROUTE_ISLAND_MODULES).size !== ROUTE_ISLAND_MODULES.length) {
    throw new Error("route-only island registry contains a duplicate module");
  }
  if (ROUTE_ISLAND_MODULES.some((name) => loaderModules.includes(name))) {
    throw new Error("route-only island is also registered on the home loader");
  }
  if (JSON.stringify([...loaderModules, ...ROUTE_ISLAND_MODULES].sort()) !== JSON.stringify(applicationModules)) {
    throw new Error("site/app contains an orphan or unregistered module");
  }
}

function usage() {
  console.log(`Usage:
  node tools/site_module_architecture.mjs --check
  node tools/site_module_architecture.mjs --update
  node tools/site_module_architecture.mjs --print`);
}

function main(argv) {
  const args = new Set(argv);
  if (args.has("-h") || args.has("--help") || args.size === 0) {
    usage();
    process.exit(args.size === 0 ? 1 : 0);
  }

  const computed = computeModuleGraphDigest();

  if (args.has("--print")) {
    console.log(JSON.stringify(computed, null, 2));
    return;
  }

  if (args.has("--check") || args.has("--update")) {
    validateModuleGraph();
    runArchitectureFitness();
    console.log(
      `module-graph digest ok: ${computed.normalized_source_sha256} (${computed.normalized_source_bytes} bytes, ${computed.module_count} modules)`,
    );
    return;
  }

  usage();
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
