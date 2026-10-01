#!/usr/bin/env node
/**
 * Stamp the two-artifact notice-context tail disagreement onto the committed
 * field-coverage lattice read-back.
 *
 * The lattice already carries the observation counts and the p75/p95 figures.
 * This builder records, beside that tail, the two committed artifacts that
 * measure it (by path), the value each reports, and the difference between
 * them — including difference_ms 0 when they agree.
 *
 *   node tools/build_field_coverage_tail_disagreement.mjs
 *   node tools/build_field_coverage_tail_disagreement.mjs --check
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildTailArtifactDisagreement,
  latticeNoticeContextMeasurement,
  readinessPrimaryMeasurement,
} from "./lib/tail_artifact_disagreement.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATTICE = join(ROOT, "docs/evidence/field-coverage-lattice-read-back/read-back.json");
const READINESS = join(ROOT, "docs/evidence/notice-context-readiness/read-back.json");

const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function resolveRepositoryRevision() {
  const fromEnv = process.env.CITYSCROLL_TAIL_DISAGREEMENT_REVISION;
  if (fromEnv && /^[0-9a-f]{40}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  return execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim().toLowerCase();
}

/**
 * @param {{
 *   lattice?: object,
 *   readiness?: object,
 *   repository_revision?: string | null,
 * }} [overrides]
 */
export function buildFieldCoverageTailDisagreement(overrides = {}) {
  const lattice = overrides.lattice ?? readJson(LATTICE);
  const readiness = overrides.readiness ?? readJson(READINESS);
  const repository_revision = overrides.repository_revision === undefined
    ? resolveRepositoryRevision()
    : overrides.repository_revision;

  const disagreement = buildTailArtifactDisagreement({
    lattice: latticeNoticeContextMeasurement(lattice),
    readiness: readinessPrimaryMeasurement(readiness),
    repository_revision,
  });

  // Preserve every existing lattice field; only replace the disagreement block.
  const { evidence_hash, query_hash, ...rest } = lattice;
  const next = {
    ...rest,
    tail_artifact_disagreement: disagreement,
  };
  if (evidence_hash !== undefined) next.evidence_hash = evidence_hash;
  if (query_hash !== undefined) next.query_hash = query_hash;
  return next;
}

async function main() {
  const next = buildFieldCoverageTailDisagreement();
  const bytes = serialized(next);
  if (process.argv.includes("--check")) {
    const current = readFileSync(LATTICE, "utf8");
    if (current !== bytes) {
      throw new Error(`stale field-coverage tail disagreement: ${LATTICE}`);
    }
    process.stdout.write("checked field-coverage tail disagreement\n");
    return;
  }
  writeFileSync(LATTICE, bytes);
  process.stdout.write(`wrote ${LATTICE}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
