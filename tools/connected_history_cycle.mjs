#!/usr/bin/env node
/**
 * Scheduled acquisition, materialization and publication cycle for connected
 * histories. `.github/workflows/connected-history-cycle.yml` runs it; see
 * site/data/connected_history_sources/README.md for the contract.
 *
 *   node tools/connected_history_cycle.mjs --run
 *   node tools/connected_history_cycle.mjs --run --pending-receipt <path>
 *   node tools/connected_history_cycle.mjs --run --dry-run --receipt-out <path>
 *   node tools/connected_history_cycle.mjs --check-declaration
 *   node tools/connected_history_cycle.mjs --summarize site/data/connected_history_cycle.json
 *
 * `--run` acquires from the publishers, contacts the served origin for its
 * revision, and writes the receipt to site/data/connected_history_cycle.json.
 * It changes a served history materialization only when the derived decision
 * is `published`. `--pending-receipt` carries an unmerged automation-branch
 * receipt into `prior_runs` so a later run cannot drop it. `--dry-run` writes
 * nothing under site/ and needs `--receipt-out` outside it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contentHashOf } from "../warehouse/lib/document_processing.mjs";
import { createLiveHttpGet } from "./lib/connected_history_documents.mjs";
import {
  CONNECTED_HISTORY_CYCLE,
  CONNECTED_HISTORY_CYCLE_RECEIPT_SCHEMA,
  CONNECTED_HISTORY_MATERIALIZATIONS,
  checkConnectedHistoryCycleDeclaration,
  loadPendingCycleReceipt,
  runConnectedHistoryCycle,
} from "./lib/connected_history_cycle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER_AGENT = "CityScrollConnectedHistoryCycle/1.0";

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

/** Every `--pending-receipt <path>` argument, in order. */
function pendingReceiptPaths(argv) {
  const paths = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--pending-receipt") continue;
    const path = argv[index + 1];
    if (!path || path.startsWith("--")) {
      throw new Error("--pending-receipt needs a receipt path");
    }
    paths.push(path);
    index += 1;
  }
  return paths;
}

async function fetchServed(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let payload = null;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      payload = null;
    }
    return {
      http_status: response.status,
      content_type: response.headers.get("content-type"),
      sha256: contentHashOf(bytes),
      payload,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The served revision a run ran against, and at start the receipt the origin serves. */
function servedObserver(origin, committedReceiptDigest) {
  return async (phase) => {
    // determinism-lint: allow clock a served-origin read records when it was made
    const observedAt = new Date().toISOString();
    const manifest = await fetchServed(`${origin}/artifact-manifest.json`);
    const revision = manifest.payload?.source_commit_sha;
    const observation = /^[0-9a-f]{40}$/.test(revision || "")
      ? {
          status: "observed",
          origin,
          observed_at: observedAt,
          revision,
          deployment_at: manifest.payload.deployment_at ?? null,
          manifest_sha256: manifest.sha256,
        }
      : {
          status: "unavailable",
          origin,
          observed_at: observedAt,
          reason: `HTTP ${manifest.http_status} ${manifest.content_type || ""} carried no served revision`.trim(),
        };
    if (phase !== "start") return observation;
    const served = await fetchServed(`${origin}${CONNECTED_HISTORY_CYCLE.served_path}`);
    observation.previous_receipt = served.payload?.schema === CONNECTED_HISTORY_CYCLE_RECEIPT_SCHEMA
      ? {
          status: "observed",
          run_id: served.payload.run?.run_id ?? null,
          outcome: served.payload.run?.outcome ?? null,
          finished_at: served.payload.run?.finished_at ?? null,
          sha256: served.sha256,
          matches_committed_receipt: served.sha256 === committedReceiptDigest,
        }
      : {
          status: "absent",
          reason: `HTTP ${served.http_status} ${served.content_type || ""} is not a cycle receipt`.trim(),
        };
    return observation;
  };
}

/** The owning builders' own check modes over the tree the run leaves behind. */
function builderChecks(root) {
  return async () => CONNECTED_HISTORY_MATERIALIZATIONS
    .filter((entry) => entry.mode !== "frozen_baseline")
    .flatMap((entry) => {
      const run = spawnSync(process.execPath, [join(root, entry.builder), "--check"], { cwd: root, encoding: "utf8" });
      if (run.status === 0) return [];
      const tail = `${run.stderr || run.stdout || ""}`.trim().split("\n").at(-1) || `exit ${run.status}`;
      return [`${entry.builder}: ${tail}`];
    });
}

function runContext(root) {
  const env = process.env;
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const githubRunId = /^\d+$/.test(env.GITHUB_RUN_ID || "") ? Number(env.GITHUB_RUN_ID) : null;
  return {
    run_id: githubRunId ? `github-actions:${githubRunId}:${env.GITHUB_RUN_ATTEMPT || "1"}` : null,
    github_run_id: githubRunId,
    run_url: githubRunId && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${githubRunId}`
      : null,
    trigger: env.GITHUB_EVENT_NAME || "local",
    code_revision: revision.status === 0 ? revision.stdout.trim() : env.GITHUB_SHA || null,
  };
}

export function summarizeConnectedHistoryCycleReceipt(receipt) {
  const run = receipt.run || {};
  const lines = [
    `## Connected-history cycle: ${run.outcome}`,
    "",
    `- run: ${run.run_id} (${run.trigger}), ${run.started_at} → ${run.finished_at}`,
    `- served revision: ${run.served?.revision || run.served?.reason || "not observed"}`,
    `- publication: ${receipt.publication?.decision} — ${receipt.publication?.reason}`,
  ];
  if (run.failed_stage) lines.push(`- failed stage: ${run.failed_stage} (${run.error})`);
  const sources = receipt.acquisition?.documents?.sources || [];
  const counts = sources.reduce((acc, row) => ({ ...acc, [row.comparison]: (acc[row.comparison] || 0) + 1 }), {});
  const compared = Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(", ") || "no sources compared";
  lines.push(`- acquisition: ${receipt.acquisition?.documents?.request_count ?? 0} requests; ${compared}`);
  lines.push("", "| materialization | byte-identical | generated_at |", "| --- | --- | --- |");
  for (const record of receipt.materialization || []) {
    lines.push(`| ${record.path} | ${record.byte_identical} | ${record.generated_at?.materialized ?? "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const root = resolve(option(argv, "--source-dir", ROOT));
  if (argv.includes("--check-declaration")) {
    const text = readFileSync(join(root, CONNECTED_HISTORY_CYCLE.workflow), "utf8");
    const result = checkConnectedHistoryCycleDeclaration(text);
    if (!result.valid) throw new Error(`connected-history cycle declaration is incomplete:\n${result.errors.join("\n")}`);
    console.log(`connected-history cycle declared in ${CONNECTED_HISTORY_CYCLE.workflow}: ${result.triggers.schedules.join(", ")} (at most ${CONNECTED_HISTORY_CYCLE.cadence_hours}h apart)`);
    return 0;
  }
  const summarize = option(argv, "--summarize");
  if (summarize) {
    process.stdout.write(summarizeConnectedHistoryCycleReceipt(JSON.parse(readFileSync(resolve(summarize), "utf8"))));
    return 0;
  }
  if (!argv.includes("--run")) {
    console.error("usage: node tools/connected_history_cycle.mjs --run [--pending-receipt <path>] [--dry-run --receipt-out <path>] | --check-declaration | --summarize <receipt>");
    return 2;
  }
  const dryRun = argv.includes("--dry-run");
  const receiptOut = option(argv, "--receipt-out") ? resolve(option(argv, "--receipt-out")) : null;
  if (dryRun && (!receiptOut || !relative(join(root, "site"), receiptOut).startsWith(".."))) {
    throw new Error("--dry-run needs --receipt-out outside site/ so a rehearsal never looks like a served cycle");
  }
  const pendingReceipts = pendingReceiptPaths(argv).map((path) => {
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error(`pending cycle receipt is missing: ${path}`);
    return loadPendingCycleReceipt(readFileSync(absolute, "utf8"));
  });
  const origin = String(option(argv, "--origin", CONNECTED_HISTORY_CYCLE.origin)).replace(/\/+$/, "");
  const receiptPath = join(root, CONNECTED_HISTORY_CYCLE.receipt_path);
  const committedReceiptDigest = existsSync(receiptPath) ? contentHashOf(readFileSync(receiptPath)) : null;
  const { receipt, exitCode } = await runConnectedHistoryCycle({
    root,
    httpGet: createLiveHttpGet(),
    observeServed: servedObserver(origin, committedReceiptDigest),
    verifyPublished: builderChecks(root),
    run: runContext(root),
    dryRun,
    receiptOut,
    heldDir: join(root, CONNECTED_HISTORY_CYCLE.held_dir),
    pendingReceipts,
  });
  console.log(JSON.stringify({
    run_id: receipt.run.run_id,
    outcome: receipt.run.outcome,
    failed_stage: receipt.run.failed_stage,
    served_revision: receipt.run.served?.revision ?? null,
    changed_paths: receipt.publication.changed_paths,
    receipt: relative(root, receiptOut || receiptPath),
  }, null, 2));
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
