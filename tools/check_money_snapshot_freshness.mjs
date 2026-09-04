#!/usr/bin/env node
// Pre-deployment freshness guard for the committed Contracts (Money) snapshot.
//
// Reuses the same open-contract projection the resident build/hydration paths
// share (site/resident_snapshot_queries.mjs) so this guard can never disagree
// with what the deployed page itself would show: a stale or unavailable
// snapshot fails the guard even when it still carries rows, and a fresh
// zero-row snapshot passes. Freshness is judged purely from open_as_of /
// generated_at against the evaluation clock; row count and deadlines never
// enter the decision.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OPEN_CONTRACTS_FRESHNESS_STATES,
  OPEN_CONTRACTS_MAX_SNAPSHOT_AGE_MS,
  openContractSnapshotProjection,
} from "../site/resident_snapshot_queries.mjs";

export const DEFAULT_SNAPSHOT_PATH = "site/data/money_default_open.json";

export function evaluateMoneySnapshotFreshness(payload, {
  now = new Date(),
  maxAgeMs = OPEN_CONTRACTS_MAX_SNAPSHOT_AGE_MS,
} = {}) {
  const projection = openContractSnapshotProjection(payload, { clock: now, maxAgeMs });
  const acceptable = new Set([
    OPEN_CONTRACTS_FRESHNESS_STATES.FRESH,
    OPEN_CONTRACTS_FRESHNESS_STATES.FRESH_EMPTY,
  ]);
  const ok = acceptable.has(projection.freshnessState);
  const findings = [];
  if (!ok) {
    findings.push(
      projection.freshnessState === OPEN_CONTRACTS_FRESHNESS_STATES.UNAVAILABLE
        ? "Contracts snapshot open_as_of/generated_at is missing or invalid"
        : `Contracts snapshot is stale: source vintage ${projection.sourceVintage || "unknown"} is older than the ${Math.round(maxAgeMs / (60 * 60 * 1000))}h freshness threshold`,
    );
  }
  return {
    ok,
    freshnessState: projection.freshnessState,
    sourceVintage: projection.sourceVintage,
    rowCount: Array.isArray(payload?.notices) ? payload.notices.length : null,
    maxAgeMs,
    checkedAt: now.toISOString(),
    findings,
  };
}

function parseArgs(argv) {
  const args = {
    snapshotPath: DEFAULT_SNAPSHOT_PATH,
    now: null,
    maxAgeMs: OPEN_CONTRACTS_MAX_SNAPSHOT_AGE_MS,
    evidenceOut: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--snapshot") args.snapshotPath = argv[++index];
    else if (arg === "--now") args.now = argv[++index];
    else if (arg === "--max-age-hours") args.maxAgeMs = Number(argv[++index]) * 60 * 60 * 1000;
    else if (arg === "--evidence-out") args.evidenceOut = argv[++index];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const snapshotPath = resolve(args.snapshotPath);
  let payload;
  try {
    payload = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    console.error(`Contracts snapshot freshness guard: could not read ${args.snapshotPath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const now = args.now ? new Date(args.now) : new Date();
  const result = evaluateMoneySnapshotFreshness(payload, { now, maxAgeMs: args.maxAgeMs });
  const evidence = { schema: "cityscroll.contracts_snapshot_freshness.v1", snapshot_path: args.snapshotPath, ...result };
  if (args.evidenceOut) {
    const evidencePath = resolve(args.evidenceOut);
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!result.ok) {
    for (const finding of result.findings) console.error(`Contracts snapshot freshness guard: ${finding}`);
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) main();
