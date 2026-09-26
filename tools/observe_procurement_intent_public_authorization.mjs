#!/usr/bin/env node
/**
 * Observe whether retained production shadow observations authorize the
 * meeting/procurement intent lifecycle panels.
 *
 * This is instrumentation for an event gate. It never claims the gate is met
 * on its own: it reads a retained production aggregate, refuses fixture-only
 * or absent served data, and writes a receipt pinned to a merge commit.
 *
 * Usage:
 *   node tools/observe_procurement_intent_public_authorization.mjs \
 *     --aggregate docs/evidence/procurement-intent-radar/shadow-mode-production-aggregate.json \
 *     --merge-commit <40-char-sha> \
 *     --out docs/evidence/procurement-intent-radar/public-authorization-observation.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH,
  readProductionShadowObservation,
} from "../site/procurement_intent_public_surfaces.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function loadAggregate(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`production observation absent at ${path}`);
    }
    throw error;
  }
}

export function observePublicAuthorization({
  aggregatePath = resolve(root, PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH),
  mergeCommit = null,
  minResolved = 20,
} = {}) {
  const aggregate = loadAggregate(aggregatePath);
  return readProductionShadowObservation(aggregate, {
    source_path: aggregatePath.replace(`${root}/`, ""),
    merge_commit: mergeCommit,
    min_resolved: minResolved,
  });
}

function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(`Observe production authorization for intent lifecycle panels.

Requires a retained production aggregate and a pinned merge commit.
Refuses fixture-only or absent served data.

Options:
  --aggregate <path>     default: ${PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH}
  --merge-commit <sha>   required 40-character merge commit
  --min-resolved <n>     default: 20
  --out <path>           write the observation receipt as JSON
  --check                exit 0 only when product_promotion_allowed is true
`);
    return 0;
  }

  const aggregatePath = resolve(
    root,
    argValue(argv, "--aggregate") || PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH,
  );
  const mergeCommit = argValue(argv, "--merge-commit");
  const minResolved = Number(argValue(argv, "--min-resolved") || 20);
  const outPath = argValue(argv, "--out")
    ? resolve(root, argValue(argv, "--out"))
    : null;

  let receipt;
  try {
    receipt = observePublicAuthorization({
      aggregatePath,
      mergeCommit,
      minResolved: Number.isFinite(minResolved) ? minResolved : 20,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const payload = `${JSON.stringify(receipt, null, 2)}\n`;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, payload);
  } else {
    process.stdout.write(payload);
  }

  if (hasFlag(argv, "--check") && receipt.product_promotion_allowed !== true) {
    process.stderr.write("publication authorization remains held\n");
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = main();
}
