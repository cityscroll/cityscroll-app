#!/usr/bin/env node
/**
 * Module-graph digest for site/app/*.mjs.
 *
 *   node tools/site_module_architecture.mjs --check   # exit 1 if digest stale
 *   node tools/site_module_architecture.mjs --update  # rewrite committed digest
 *
 * Fingerprint rules match test/site_module_architecture.test.mjs:
 * concatenate each module's behavior source (before live-binding publication
 * footers) in SITE_MODULES loader order, normalizing moved-module dynamic
 * imports from "../" to "./".
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_MODULES } from "../test/helpers/site_source.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVIDENCE_PATH = path.join(ROOT, "docs/evidence/index-module-split.json");
const APP_DIR = path.join(ROOT, "site/app");

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

function loadEvidence() {
  return JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
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

  const evidence = loadEvidence();
  const current = evidence.current_module_graph || {};

  if (args.has("--check")) {
    const ok =
      current.normalized_source_bytes === computed.normalized_source_bytes &&
      current.normalized_source_sha256 === computed.normalized_source_sha256;
    if (!ok) {
      console.error("module-graph digest is stale.");
      console.error(
        `  committed: ${current.normalized_source_sha256} (${current.normalized_source_bytes} bytes)`,
      );
      console.error(
        `  computed:  ${computed.normalized_source_sha256} (${computed.normalized_source_bytes} bytes)`,
      );
      console.error("Refresh with: node tools/site_module_architecture.mjs --update");
      process.exit(1);
    }
    console.log(
      `module-graph digest ok: ${computed.normalized_source_sha256} (${computed.normalized_source_bytes} bytes, ${computed.module_count} modules)`,
    );
    return;
  }

  if (args.has("--update")) {
    const today = new Date().toISOString().slice(0, 10);
    evidence.current_module_graph = {
      normalization:
        current.normalization ||
        "Concatenate module source before live-binding publication footers in loader order and normalize moved-module dynamic imports from ../ to ./ paths. Intentional post-split behavior changes update this digest without rewriting the original source-equivalence evidence.",
      normalized_source_bytes: computed.normalized_source_bytes,
      normalized_source_sha256: computed.normalized_source_sha256,
      note:
        current.note ||
        `Digest refreshed ${today} via tools/site_module_architecture.mjs --update.`,
      updated_at: today,
    };
    // Keep historical after.module_count honest when module list length changes.
    if (evidence.after && typeof evidence.after.module_count === "number") {
      evidence.after.module_count = computed.module_count;
    }
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(
      `updated ${path.relative(ROOT, EVIDENCE_PATH)}: ${computed.normalized_source_sha256} (${computed.normalized_source_bytes} bytes)`,
    );
    return;
  }

  usage();
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
