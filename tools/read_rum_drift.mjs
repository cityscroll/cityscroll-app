#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBaseline,
  buildCandidates,
  buildDriftOverlay,
  unavailableSnapshot,
} from "./lib/performance_drift.mjs";
import { readPerformanceAnalytics } from "../worker/src/lib/performance_query.mjs";
import {
  buildQueueDocument,
  emptyLedger,
  reconcileQueue,
  updateLedger,
} from "../ontology/card_queue.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    out: resolve(ROOT, "artifacts/performance-drift"),
    baseline: null,
    ledger: null,
    generation: null,
    now: new Date(),
    sourceRun: process.env.GITHUB_RUN_ID || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = resolve(argv[++i]);
    else if (arg === "--baseline") args.baseline = resolve(argv[++i]);
    else if (arg === "--ledger") args.ledger = resolve(argv[++i]);
    else if (arg === "--generation") args.generation = resolve(argv[++i]);
    else if (arg === "--now") args.now = new Date(argv[++i]);
    else if (arg === "--source-run") args.sourceRun = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node tools/read_rum_drift.mjs [--out dir] [--baseline path] [--ledger path] [--now ISO]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.now.getTime())) throw new Error("--now must be a valid ISO timestamp");
  return args;
}

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readSnapshot(now, trafficClass) {
  try {
    return await readPerformanceAnalytics(process.env, {
      window: "7d",
      filters: { traffic_class: trafficClass },
      group_by: ["metric_id", "surface_id"],
    }, {
      now,
      sampleFloor: process.env.RUM_MIN_SAMPLED_ROWS || 30,
    });
  } catch (error) {
    // A read failure is evidence, not an enforcement signal. Keep the run
    // successful so the unavailable overlay reaches human reviewers.
    return {
      ...unavailableSnapshot(String(error?.message || "rum-read-failed"), now),
      query: { filters: { traffic_class: trafficClass }, window: "7d", group_by: ["metric_id", "surface_id"] },
    };
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  mkdirSync(args.out, { recursive: true });
  const baseline = readJson(args.baseline, null);
  const [snapshot, labSnapshot] = await Promise.all([
    readSnapshot(args.now, "production"),
    readSnapshot(args.now, "lab"),
  ]);
  const generation = readJson(args.generation, null);
  const overlay = buildDriftOverlay(snapshot, {
    baseline,
    labSnapshot,
    generation,
    now: args.now,
    sourceRun: args.sourceRun,
  });
  const candidates = buildCandidates(overlay);
  const ledger = readJson(args.ledger, emptyLedger({ updated_at: overlay.generated_at }));
  const reconciled = reconcileQueue(candidates, ledger, {
    refresh_open: true,
    limit: 100,
  });
  const queue = buildQueueDocument({
    cards: reconciled.cards,
    dimension_metrics: {
      surfaces: overlay.surfaces.length,
      flowing_metrics: overlay.surfaces.flatMap((surface) => Object.values(surface.metrics))
        .filter((metric) => metric.data_status === "flowing").length,
      candidates: candidates.length,
    },
    skipped: reconciled.skipped,
    regressions: reconciled.regressions,
    generated_at: overlay.generated_at,
    mode: "live",
    ledger_path: args.ledger,
  });
  const nextLedger = updateLedger(ledger, reconciled.cards, { seen_at: overlay.generated_at });
  const nextBaseline = buildBaseline(overlay);
  const receipt = {
    schema: "cityscroll.performance.drift_receipt.v1",
    generated_at: overlay.generated_at,
    source: "rum-daily",
    source_run: overlay.source_run,
    query_status: overlay.query_status,
    lab_query_status: overlay.lab?.query_status || "unavailable",
    generation_verdict: overlay.generation?.verdict || "unavailable",
    evidence_hash: overlay.evidence_hash,
    query_hash: overlay.query_hash,
    candidate_count: candidates.length,
    emitted_count: queue.stats.card_count,
    skipped_count: queue.stats.skipped,
    regressions: queue.stats.regressions,
    enforcement: overlay.enforcement,
  };
  writeJson(resolve(args.out, "rum-status.json"), overlay);
  writeFileSync(resolve(args.out, "rum-candidates.jsonl"), `${reconciled.cards.map((card) => JSON.stringify(card)).join("\n")}${reconciled.cards.length ? "\n" : ""}`);
  writeJson(resolve(args.out, "queue.json"), queue);
  writeJson(resolve(args.out, "receipt.json"), receipt);
  writeJson(resolve(args.out, "baseline.json"), nextBaseline);
  if (args.ledger) writeJson(args.ledger, nextLedger);
  console.log(JSON.stringify({
    query_status: overlay.query_status,
    surfaces: overlay.surfaces.length,
    candidates: queue.stats.card_count,
    evidence_hash: overlay.evidence_hash,
  }));
}

main().catch((error) => {
  // Preserve the no-enforcement boundary for unexpected read/config failures.
  console.error(`performance drift unavailable: ${error.message}`);
  process.exitCode = 0;
});
