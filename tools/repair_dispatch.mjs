#!/usr/bin/env node
/**
 * The repair dispatcher: one leased queue item in, one bounded outcome out.
 *
 * This is the command the scheduler cycle is configured to run as
 * `CITYSCROLL_REPAIR_DISPATCH_COMMAND`. It reads the leased item from stdin —
 * never from a command line, so nothing a queue record carries can reach a
 * shell — selects the playbook the item's signature names, runs it under a
 * bound, verifies the condition actually cleared, and exits with the one code
 * the cycle's contract maps to a queue outcome:
 *
 *   0  repaired  — a scripted remedy ran and the monitor's own check now passes
 *   2  judgment  — nothing deterministic can close it; the summary says what would
 *   1  failed    — a remedy ran and did not work; the queue may retry it
 *   3  unkeyable — the signature is not an identity this rail reads at all
 *
 * There is no model in this path and no budget to spend: every decision is a
 * committed playbook and a re-run of a check that already existed. A finding no
 * playbook matches is judgment rather than failure, so an unknown class reaches
 * a person with its name on it instead of burning three silent attempts first.
 *
 * The last code separates two things that look alike from inside a queue and are
 * nothing alike to a reader. A parseable signature whose class has no playbook is
 * a real condition somebody has to decide about. A signature that is not in the
 * `monitor:<monitor>:<class>[:<subject>]` form is not a condition at all from
 * here — it is a record this rail cannot read, and no repeat, retry or day
 * passing will make it readable. The queue retires those instead of asking a
 * person the same unanswerable question every day.
 *
 * The prose summary is the last thing written to stdout, because the cycle
 * keeps the tail of the output as the sentence it reports back.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadSourceContracts } from "./source_contracts.mjs";
import { verifyLiveContract } from "./verify_source_contracts.mjs";
import {
  buildSourceHealthObservations,
  loadSourceHealthInputs,
} from "./source_health_observations.mjs";
import { runScheduledJob } from "./external_schedule_runner.mjs";
import { parseRepairSignature, upstreamFailureEvidence } from "./repair_findings.mjs";
import {
  REPAIR_DISPATCH_BUDGET_MS,
  selectRepairPlaybook,
} from "./repair_playbooks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_PATH = join(ROOT, "tools", "external_schedule_jobs.json");

export const REPAIR_RECEIPT_SCHEMA = "cityscroll.repair-dispatch-receipt.v1";
export const REPAIR_RECEIPT_ATTEMPT_LIMIT = 10;
export const REPAIR_SCOPE_EXPECTED = "diagnose-and-propose";
/** A read-only local command, never an ingestion; bounded so it cannot hang a dispatch. */
export const LOCAL_COMMAND_TIMEOUT_MS = 20 * 1000;

export const EXIT_CODES = Object.freeze({ repaired: 0, failed: 1, judgment: 2, unkeyable: 3 });

/**
 * Which scheduled job publishes the evidence a freshness reason is about. A
 * reason with no scheduled publisher maps to nothing, and the playbook then
 * names it rather than guessing at a path to re-run.
 */
export const FRESHNESS_PUBLICATION_PATHS = Object.freeze({
  "acquisition-missing": "source-contracts-live",
  "monitor-missing": null,
});

function stateDirectory(env = process.env) {
  return env.CROL_EXTERNAL_SCHEDULE_STATE_DIR || join(ROOT, ".external-schedule-state");
}

function safeName(signature) {
  return String(signature || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

/** Read the whole of stdin. An empty or unparseable item is a decision, not a crash. */
export async function readItemFromStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))).toString("utf8");
  if (!text.trim()) return { item: null, reason: "the dispatcher was handed no repair item on stdin" };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { item: null, reason: "the repair item on stdin is not an object" };
    }
    return { item: parsed, reason: null };
  } catch {
    return { item: null, reason: "the repair item on stdin is not readable as JSON" };
  }
}

function run(command, args, { cwd = ROOT, timeoutMs = LOCAL_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((settle) => {
    execFile(command, args, { cwd, timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      settle({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * Everything a playbook may touch. Each seam is a narrow, named capability
 * rather than a general escape hatch, so the registry's tests exercise the same
 * shape the scheduler host supplies.
 */
export function createDispatchContext({
  signature,
  monitor,
  subject,
  item = null,
  now = new Date(),
  root = ROOT,
  stateDir = stateDirectory(),
  jobsPath = JOBS_PATH,
  sleep = (ms) => new Promise((settle) => { setTimeout(settle, ms); }),
} = {}) {
  let jobsCache = null;
  const jobs = async () => {
    if (!jobsCache) jobsCache = await readJsonFile(jobsPath);
    return Array.isArray(jobsCache?.jobs) ? jobsCache.jobs : [];
  };
  let registryCache = null;
  let observationCache = null;

  return {
    signature,
    monitor,
    subject,
    item,
    now,
    root,
    stateDir,
    sleep,
    upstreamEvidence: upstreamFailureEvidence,

    repository: {
      // Read-only, and it answers exactly one question: is this path a file the
      // repository carries? A remedy for one is a repository change, which this
      // identity is not allowed to make.
      async isTracked(path) {
        if (!path) return false;
        const result = await run("git", ["-C", root, "ls-files", "--error-unmatch", "--", path]);
        return result.ok;
      },
    },

    contracts: {
      async load() {
        if (!registryCache) registryCache = loadSourceContracts();
        return registryCache;
      },
      /**
       * The monitor's own live check, scoped to the one contract.
       *
       * A freshness failure carries the verifier's two-clock finding — the
       * publisher's own stamp, the vintage our retained snapshot states, and
       * which side is behind — so the playbook reads that rather than probing
       * the publisher a second time. Two implementations of "which clock is
       * stale" would eventually disagree, and this is the one the monitor
       * opened the issue on.
       */
      async verifyLive(contract) {
        try {
          return { ok: true, detail: String(await verifyLiveContract(contract)).slice(0, 200), finding: null };
        } catch (error) {
          return {
            ok: false,
            detail: String(error?.message || error).slice(0, 200),
            finding: error?.finding || null,
          };
        }
      },
    },

    schedule: {
      // A playbook asks for a job by name and gets the registered one or null.
      // Nothing is resolved from the item: a monitor the cycle no longer
      // carries is a decision for a person, not a command to improvise.
      async job(id) {
        return (await jobs()).find((row) => row?.id === id) || null;
      },
      async load() { return jobs(); },
      async runJob(job, options = {}) {
        observationCache = null;
        return runScheduledJob(job, { stateDir, now: options.now || now, ...(options.runKey ? { runKey: options.runKey } : {}) });
      },
      async hasResult(jobId, runKey) {
        const name = `${String(runKey).replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`;
        return Boolean(await readJsonFile(join(stateDir, "results", jobId, name)));
      },
      async latestResult(jobId) {
        let names = [];
        try { names = (await readdir(join(stateDir, "results", jobId))).filter((name) => name.endsWith(".json")); } catch { return null; }
        const newest = names.sort().at(-1);
        return newest ? readJsonFile(join(stateDir, "results", jobId, newest)) : null;
      },
    },

    freshness: {
      publicationPath(reasons) {
        for (const reason of Array.isArray(reasons) ? reasons : []) {
          const path = FRESHNESS_PUBLICATION_PATHS[reason];
          if (path) return path;
        }
        return null;
      },
      /** The watchdog's own evaluation, read back for the one source contract. */
      async evaluate(contractId, options = {}) {
        const asOf = (options.now || now).toISOString();
        if (!observationCache) {
          const registry = loadSourceContracts();
          const inputs = loadSourceHealthInputs(root, registry, { externalScheduleStateDir: stateDir });
          observationCache = buildSourceHealthObservations(registry, { ...inputs, asOf });
        }
        const row = (observationCache.observations || []).find((entry) => entry.source_id === contractId);
        return row?.freshness_watchdog || null;
      },
    },
  };
}

/** Append this attempt to the signature's receipt, bounded and newest-first. */
export async function writeRepairReceipt(stateDir, attempt) {
  const dir = join(stateDir, "repair", "receipts");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${safeName(attempt.signature)}.json`);
  const prior = await readJsonFile(path);
  const attempts = [attempt, ...(Array.isArray(prior?.attempts) ? prior.attempts : [])].slice(0, REPAIR_RECEIPT_ATTEMPT_LIMIT);
  const receipt = {
    schema: REPAIR_RECEIPT_SCHEMA,
    signature: attempt.signature,
    playbook: attempt.playbook,
    latest_outcome: attempt.outcome,
    latest_observed_at: attempt.observed_at,
    attempt_count: attempts.length,
    attempts,
  };
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function timeout(ms, summary) {
  let timer = null;
  const promise = new Promise((settle) => {
    timer = setTimeout(() => settle({ outcome: "failed", summary, verification: { ok: false, detail: "the playbook exceeded its bound" } }), ms);
  });
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

/**
 * Decide and act on one leased item.
 *
 * The item contributes exactly one thing: its signature. Everything else about
 * what happens is the committed registry's, so a queue record can describe a
 * failure and can never name something to run.
 */
export async function dispatchRepairItem(item, options = {}) {
  const now = options.now || new Date();
  const observedAt = now.toISOString();
  const stateDir = options.stateDir || stateDirectory();
  const signature = typeof item?.signature === "string" ? item.signature : "";
  const record = async (result, playbook) => {
    const attempt = {
      signature: signature || "unknown",
      playbook: playbook || null,
      observed_at: observedAt,
      outcome: result.outcome,
      summary: result.summary,
      verification: result.verification || null,
    };
    if (options.receipts !== false) await writeRepairReceipt(stateDir, attempt);
    return { ...result, signature: attempt.signature, playbook: attempt.playbook, observed_at: observedAt };
  };

  if (!signature) {
    return record({ outcome: "judgment", summary: "the leased item carries no signature, so no playbook can be selected for it; the queue record is malformed rather than the condition unrepairable", verification: null }, null);
  }
  // The scope is declared by the queue and never widened here. An item claiming
  // anything else is refused rather than run under an authority nobody granted.
  if (item.repair_scope && item.repair_scope !== REPAIR_SCOPE_EXPECTED) {
    return record({ outcome: "judgment", summary: `the leased item declares repair scope ${String(item.repair_scope).slice(0, 60)}, which is not the scope this dispatcher runs under; nothing was attempted`, verification: null }, null);
  }

  const selection = selectRepairPlaybook(signature);
  if (!selection.playbook) {
    // A signature that parsed names a real class, so a person can act on it. One
    // that did not parse names nothing this rail understands, and reporting it as
    // a decision would put an unanswerable question in front of an owner on every
    // cycle for as long as the record exists.
    return record({
      outcome: selection.parsed ? "judgment" : "unkeyable",
      summary: selection.reason,
      verification: null,
    }, null);
  }
  const { playbook, parsed } = selection;
  const context = options.context || createDispatchContext({
    signature,
    monitor: parsed.monitor,
    subject: parsed.subject,
    item,
    now,
    stateDir,
  });
  // The registry's own bound, never above the dispatch ceiling, which itself
  // sits inside the cycle's ten-minute kill so an overrun is a reported
  // judgment rather than a lost receipt.
  const budget = Math.min(playbook.budget_ms, options.budgetMs || REPAIR_DISPATCH_BUDGET_MS);
  const bound = timeout(budget, `${playbook.id} exceeded its ${Math.round(budget / 1000)}s bound and was stopped before it could verify`);
  let result;
  try {
    result = await Promise.race([playbook.run(context), bound.promise]);
  } catch (error) {
    result = {
      outcome: "failed",
      summary: `${playbook.id} raised while running: ${String(error?.message || error).slice(0, 200)}`,
      verification: { ok: false, detail: "the playbook raised" },
    };
  } finally {
    bound.cancel();
  }
  return record(result, playbook.id);
}

export function exitCodeFor(outcome) {
  return Object.prototype.hasOwnProperty.call(EXIT_CODES, outcome) ? EXIT_CODES[outcome] : EXIT_CODES.failed;
}

async function main() {
  if (!process.argv.includes("--repair-item")) {
    process.stderr.write("usage: repair_dispatch.mjs --repair-item < item.json\n");
    process.exitCode = EXIT_CODES.failed;
    return;
  }
  const { item, reason } = await readItemFromStdin();
  if (!item) {
    process.stdout.write(`${reason}\n`);
    process.exitCode = EXIT_CODES.judgment;
    return;
  }
  const result = await dispatchRepairItem(item);
  // The cycle keeps the tail of this output as the sentence it reports, so the
  // summary is the last thing written and nothing follows it.
  process.stdout.write(`${result.summary}\n`);
  process.exitCode = exitCodeFor(result.outcome);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`the repair dispatcher raised before it could decide anything: ${String(error?.message || error).slice(0, 200)}\n`);
    process.exitCode = EXIT_CODES.failed;
  });
}
