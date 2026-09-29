#!/usr/bin/env node
/**
 * Read-only release read-back for the fixed six-case connected-history dossier.
 *
 *   node tools/check_connected_history_release.mjs                # production read, print only
 *   node tools/check_connected_history_release.mjs --write        # append the read-back to the retained record
 *   node tools/check_connected_history_release.mjs --base-url http://127.0.0.1:8000 --no-browser --no-schedule
 *
 * The runner refuses when the served Pages revision does not contain the
 * release delivery commit. It fetches every served materialization in the same
 * run, measures the six rendered Search journeys in Chromium through the
 * existing journey instrument, and classifies the next scheduled publication
 * cycle from GitHub's public run and pull-request records. It never writes a
 * served or source artifact; `--write` only appends to the retained read-back.
 * Evidence class and acceptance are derived from the observed facts.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCEPTANCE_RULE,
  CAPABILITIES,
  DOSSIER_FAMILIES,
  PRODUCTION_HOSTS,
  RELEASE_DELIVERY,
  RELEASE_READBACK_SCHEMA,
  SCHEDULED_PUBLICATION_WORKFLOWS,
  SERVED_DATA,
  auditAdmittedFalsePositives,
  deriveAcceptance,
  evaluateCapability,
  scheduledCycleStatus,
} from "./lib/connected_history_release.mjs";
import { resolveRepositoryRevision } from "./repository_revision.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RETAINED_PATH = "docs/evidence/connected-history-release/release-readback.json";
const REPOSITORY = "cityscroll/cityscroll-app";
const PARCEL_POPULATION_RECEIPT = "warehouse/receipts/proof/site_lifecycle_population_latest.json";
const HISTORY_BYTES = Object.freeze(["cohort", "documents", "relations", "roles", "time", "coverage"]);

/** Repository inputs whose bytes the retained read-back describes. */
export const MEASURED_INPUTS = Object.freeze([
  "site/connected_history_journeys.mjs",
  "site/data/connected_history_coverage.json",
  "site/data/connected_history_documents.json",
  "site/data/connected_history_evaluation_cohort.json",
  "site/data/connected_history_relations.json",
  "site/data/connected_history_roles.json",
  "site/data/connected_history_time.json",
  "site/data/site_lifecycle/manifest.json",
  "site/site_lifecycle_reader.mjs",
  "tools/capture_documented_history_journeys.py",
  "tools/check_connected_history_release.mjs",
  "tools/lib/connected_history_release.mjs",
  PARCEL_POPULATION_RECEIPT,
]);

export class ReleaseRefusal extends Error {}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function isAncestor(ancestor, descendant) {
  if (ancestor === descendant) return true;
  return git(["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

function requireCommit(sha, label) {
  if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new ReleaseRefusal(`${label} is not a 40-hex commit: ${sha}`);
  if (git(["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
    throw new ReleaseRefusal(`${label} ${sha} is not in local history; fetch origin before the read-back`);
  }
  return sha;
}

function parseArgs(argv) {
  const args = { base: "https://cityscroll.org", browser: true, schedule: true, write: false, screenshotDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-url") args.base = argv[++index];
    else if (value === "--no-browser") args.browser = false;
    else if (value === "--no-schedule") args.schedule = false;
    else if (value === "--write") args.write = true;
    else if (value === "--screenshot-dir") args.screenshotDir = argv[++index];
    else throw new ReleaseRefusal(`unknown argument ${value}`);
  }
  args.base = String(args.base).replace(/\/+$/, "");
  return args;
}

async function fetchServed(base, path) {
  const url = `${base}${path}`;
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "cityscroll-history-release-readback/1" } });
  } catch (error) {
    return { receipt: { url: path, http_status: null, sha256: null, generated_at: null, error: `unreachable: ${error.message}` }, payload: null };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  let payload = null;
  let error = null;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not a JSON object");
  } catch (parseError) {
    // Pages answers an absent path with a 200 HTML document; parse, not status, decides.
    payload = null;
    error = `not a served JSON materialization (${parseError.message})`;
  }
  if (response.status !== 200) {
    payload = null;
    error = `HTTP ${response.status}`;
  }
  return {
    receipt: {
      url: path,
      http_status: response.status,
      sha256: payload ? sha256(bytes) : null,
      generated_at: payload?.generated_at ?? null,
      error,
    },
    payload,
  };
}

async function servedManifest(base) {
  const { payload, receipt } = await fetchServed(base, "/artifact-manifest.json");
  if (!payload || !/^[a-f0-9]{40}$/.test(payload.source_commit_sha || "")) {
    throw new ReleaseRefusal(`served artifact manifest has no source revision (${receipt.error || "missing source_commit_sha"})`);
  }
  return { source_commit_sha: payload.source_commit_sha, deployment_at: payload.deployment_at || payload.generated_at || null };
}

function readRetained() {
  const path = join(ROOT, RETAINED_PATH);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function runJourneys(screenshotDir) {
  const scratch = mkdtempSync(join(tmpdir(), "history-release-journeys-"));
  const env = { ...process.env, TMPDIR: scratch };
  delete env.FM_TASK_SCRATCH;
  const argv = ["tools/capture_documented_history_journeys.py", "--production", "--landed-commit", RELEASE_DELIVERY.landed_commit];
  if (screenshotDir) argv.push("--screenshot-dir", screenshotDir);
  try {
    const run = spawnSync(process.env.CITYSCROLL_BROWSER_PYTHON || "python3", argv, {
      cwd: ROOT,
      encoding: "utf8",
      env,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (run.status !== 0) {
      const tail = `${run.stderr || ""}`.trim().split("\n").slice(-1)[0] || `exit ${run.status}`;
      return { error: tail.replace(/\/(?:Users|private|var|tmp)\/\S+/g, "<local>") };
    }
    const receipt = JSON.parse(run.stdout);
    const failure = receipt.failure_control;
    return {
      browser: receipt.browser,
      failure_control: failure
        ? {
            case: failure.case,
            family_id: failure.family_id,
            route: failure.route,
            assertion: failure.assertion,
            render_sha256: failure.render_sha256,
            induced_failure: failure.induced_failure,
            observed_state: failure.observed_state,
            recovery: failure.recovery,
          }
        : null,
      observed_at: receipt.observed_at,
      served_revision: receipt.served_revision,
      served_revision_after: receipt.served_revision_after,
      captures: receipt.captures.map((capture) => ({
        case: capture.case,
        family_id: capture.family_id,
        route: capture.route,
        viewport: capture.viewport,
        interaction: capture.interaction,
        assertion: capture.assertion,
        render_sha256: capture.render_sha256,
        capture_sha256: capture.capture_sha256 || null,
        runtime: capture.runtime,
      })),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ghJson(args) {
  const run = spawnSync("gh", [...args, "-R", REPOSITORY], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(run.stderr || "").trim().split("\n")[0]}`);
  return JSON.parse(run.stdout);
}

function observeScheduledRuns(releaseDeployedAt, servedRevision) {
  return SCHEDULED_PUBLICATION_WORKFLOWS.map((entry) => {
    const runs = ghJson(["run", "list", "--workflow", entry.workflow, "--event", "schedule", "--limit", "20", "--json", "databaseId,event,createdAt,conclusion"])
      .filter((run) => run.createdAt > releaseDeployedAt);
    return {
      workflow: entry.workflow,
      runs: runs.map((run) => {
        const branch = entry.branch(run.createdAt);
        const pulls = ghJson(["pr", "list", "--state", "all", "--head", branch, "--limit", "10", "--json", "number,mergedAt,mergeCommit"]);
        const merged = pulls
          .filter((pull) => pull.mergedAt && pull.mergedAt > run.createdAt)
          .sort((left, right) => left.mergedAt.localeCompare(right.mergedAt))[0];
        const mergeCommit = merged?.mergeCommit?.oid || null;
        let served = null;
        if (mergeCommit && git(["cat-file", "-e", `${mergeCommit}^{commit}`]).status === 0) {
          served = isAncestor(mergeCommit, servedRevision);
        }
        return {
          run_id: run.databaseId,
          event: run.event,
          created_at: run.createdAt,
          conclusion: run.conclusion,
          pull_request: merged?.number ?? null,
          merge_commit: mergeCommit,
          served_contains_merge: served,
        };
      }),
    };
  });
}

export async function readBack(args) {
  const observedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = new URL(args.base).hostname.toLowerCase();
  const production = PRODUCTION_HOSTS.includes(host);
  requireCommit(RELEASE_DELIVERY.landed_commit, "release delivery commit");
  if (git(["merge-base", "--is-ancestor", RELEASE_DELIVERY.landed_commit, "origin/main"]).status !== 0) {
    throw new ReleaseRefusal(`release delivery ${RELEASE_DELIVERY.landed_commit} is not on the default branch`);
  }
  const manifest = await servedManifest(args.base);
  const servedRevision = requireCommit(manifest.source_commit_sha, "served revision");
  if (!isAncestor(RELEASE_DELIVERY.landed_commit, servedRevision)) {
    throw new ReleaseRefusal(
      `served revision ${servedRevision} does not contain release delivery ${RELEASE_DELIVERY.landed_commit} (#${RELEASE_DELIVERY.pull_request}); wait for the Pages deploy`,
    );
  }

  const artifacts = {};
  const data = {};
  for (const [key, path] of Object.entries(SERVED_DATA)) {
    const { payload, receipt } = await fetchServed(args.base, path);
    artifacts[key] = payload;
    data[key] = receipt;
  }
  artifacts.parcel_shards = [];
  for (const shard of artifacts.parcel_manifest?.shards || []) {
    const { payload, receipt } = await fetchServed(args.base, `/data/site_lifecycle/${shard}`);
    if (payload) artifacts.parcel_shards.push(payload);
    data[`parcel_shard_${shard}`] = receipt;
  }
  const populationBytes = readFileSync(join(ROOT, PARCEL_POPULATION_RECEIPT));
  artifacts.parcel_population = JSON.parse(populationBytes.toString("utf8"));
  data.parcel_population = {
    url: PARCEL_POPULATION_RECEIPT,
    http_status: null,
    sha256: sha256(populationBytes),
    generated_at: artifacts.parcel_population.generated_at ?? null,
    error: null,
  };
  data.parcel_shards = {
    url: "/data/site_lifecycle/<declared shards>",
    http_status: null,
    sha256: artifacts.parcel_shards.length ? sha256(Buffer.from(artifacts.parcel_shards.map((shard) => JSON.stringify(shard)).join("\n"))) : null,
    generated_at: null,
    error: null,
  };

  artifacts.journeys = args.browser && production ? runJourneys(args.screenshotDir) : null;
  if (artifacts.journeys?.error) {
    data.journeys = { url: "/search/", http_status: null, sha256: null, generated_at: null, error: artifacts.journeys.error };
    artifacts.journeys = null;
  } else if (artifacts.journeys) {
    if (artifacts.journeys.served_revision !== servedRevision || artifacts.journeys.served_revision_after !== servedRevision) {
      throw new ReleaseRefusal("served revision changed during the read-back; rerun");
    }
    data.journeys = {
      url: "/search/",
      http_status: 200,
      sha256: sha256(Buffer.from(JSON.stringify(artifacts.journeys.captures))),
      generated_at: artifacts.journeys.observed_at,
      error: null,
    };
  }
  const after = await servedManifest(args.base);
  if (after.source_commit_sha !== servedRevision) throw new ReleaseRefusal("served revision changed during the read-back; rerun");

  const evidenceClass = production ? "deployed_production_read_back" : "local_origin_rehearsal";
  const codeRevision = resolveRepositoryRevision(ROOT);
  const context = { data, served_revision: servedRevision, code_revision: codeRevision, evidence_class: evidenceClass };
  const capabilities = CAPABILITIES.map((definition) => evaluateCapability(definition, artifacts, context));

  const retained = readRetained();
  const baseline = retained?.readbacks?.[0] || null;
  const releaseDeployedAt = baseline?.served?.deployment_at || manifest.deployment_at;
  let observations = null;
  let scheduleError = null;
  if (args.schedule && production) {
    try {
      observations = observeScheduledRuns(releaseDeployedAt, servedRevision);
    } catch (error) {
      scheduleError = error.message;
    }
  }
  const unchanged = baseline
    ? HISTORY_BYTES.every((key) => data[key]?.sha256 && data[key].sha256 === baseline.data?.[key]?.sha256)
    : null;
  const journeysPassed = capabilities.find((record) => record.id === "search-history-discovery")?.observed?.result?.families_passed || [];
  const cycleReceiptPath = SCHEDULED_PUBLICATION_WORKFLOWS.find((entry) => entry.served_receipt)?.served_receipt;
  let servedCycleReceipt = null;
  if (cycleReceiptPath) {
    const { payload, receipt } = await fetchServed(args.base, cycleReceiptPath);
    servedCycleReceipt = payload
      ? {
          url: cycleReceiptPath,
          sha256: receipt.sha256,
          run_id: payload.run?.run_id ?? null,
          github_run_id: payload.run?.github_run_id ?? null,
          trigger: payload.run?.trigger ?? null,
          outcome: payload.run?.outcome ?? null,
          started_at: payload.run?.started_at ?? null,
          finished_at: payload.run?.finished_at ?? null,
          served_revision: payload.run?.served?.revision ?? null,
        }
      : { url: cycleReceiptPath, sha256: null, error: receipt.error };
  }
  const scheduledCycle = scheduledCycleStatus({
    release_deployed_at: releaseDeployedAt,
    observed_at: observedAt,
    observations,
    journeys_passed_after_cycle: journeysPassed,
    unchanged_history_bytes: unchanged,
    served_cycle_receipt: servedCycleReceipt,
  });
  if (scheduleError) scheduledCycle.query_error = scheduleError;

  const readback = {
    observed_at: observedAt,
    origin: args.base,
    evidence_class: evidenceClass,
    delivery: {
      ...RELEASE_DELIVERY,
      served_contains_delivery: true,
      ancestry_check: `git merge-base --is-ancestor ${RELEASE_DELIVERY.landed_commit} ${servedRevision}`,
    },
    served: { revision: servedRevision, deployment_at: manifest.deployment_at },
    code_revision: codeRevision,
    data,
    journeys: artifacts.journeys,
    capabilities,
    false_positive_audit: auditAdmittedFalsePositives(artifacts),
    scheduled_cycle: scheduledCycle,
  };
  readback.acceptance_rule = ACCEPTANCE_RULE;
  readback.acceptance = deriveAcceptance(readback);
  return readback;
}

export function retainReadback(readback) {
  if (readback.evidence_class !== "deployed_production_read_back") {
    throw new ReleaseRefusal("only a deployed production read-back is retained");
  }
  const existing = readRetained();
  const inputs = MEASURED_INPUTS.map((path) => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) }));
  const document = {
    schema: RELEASE_READBACK_SCHEMA,
    runner: "node tools/check_connected_history_release.mjs --write",
    verifier: "node --test test/connected_history_release.test.mjs",
    dossier_families: [...DOSSIER_FAMILIES],
    image_binaries_committed: false,
    policy: "Read-backs are appended, never rewritten, so original failures stay visible. Acceptance is re-derived from each read-back's facts.",
    measurement_provenance: { revision: readback.code_revision, inputs },
    readbacks: [...(existing?.readbacks || []), readback],
  };
  writeFileSync(join(ROOT, RETAINED_PATH), `${JSON.stringify(document, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readback = await readBack(args);
  if (args.write) retainReadback(readback);
  process.stdout.write(`${JSON.stringify(readback, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof ReleaseRefusal ? "refused" : "error"}: ${error.message}\n`);
    process.exit(error instanceof ReleaseRefusal ? 2 : 1);
  });
}
