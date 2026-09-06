#!/usr/bin/env node
/**
 * Build the guide-review report the existing weekly review flow consumes.
 *
 * The report is machine evidence about public guide sources. It records what a
 * check observed and which articles a person may want to read; it never writes
 * an article's review date, never edits guide prose, and never decides what
 * ships. Assignment and queue state stay with the review owner outside this
 * repository, and no key in this report could carry them.
 *
 * The report is not tracked. It is written under the ignored .artifacts tree,
 * because it describes one moment rather than the state of the site.
 *
 *   node tools/build_guide_review.mjs --check
 *   node tools/build_guide_review.mjs --report --checked-at=2026-09-05
 *   node tools/build_guide_review.mjs --section --checked-at=2026-09-05 --since=origin/main
 *   node tools/build_guide_review.mjs --rehearse --checked-at=2026-09-05 --state-dir=.artifacts/guide-review/state
 *
 * `--check` reads no clock and takes no date: it only asks whether every
 * identifier a guide article cites still resolves, which is the part of the
 * contract that can rot silently between reviews.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import {
  GUIDE_REVIEW_JOB_ID,
  buildGuideReviewReport,
  guideReviewArticleRecord,
  guideReviewDelta,
  renderGuideReviewSection,
  serializeGuideReviewReport,
  validateGuideReviewReport,
} from "../site/guide_review_source.mjs";
import { persistScheduleResult, replayOutbox } from "./external_schedule_outbox.mjs";
import { loadGuide } from "./build_guide_documents.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_MANIFEST = join(ROOT, "site/demo/demo-links.json");
const SOURCE_CONTRACTS = join(ROOT, "site/data/source_contracts.json");
const DEFAULT_OUT_DIR = join(ROOT, ".artifacts/guide-review");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const pair = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (pair) {
      flags[pair[1]] = pair[2];
      continue;
    }
    const bare = /^--([a-z-]+)$/.exec(arg);
    if (bare) {
      flags[bare[1]] = true;
      continue;
    }
    throw new Error(`unrecognized argument ${JSON.stringify(arg)}`);
  }
  return flags;
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function changedPathsSince(since) {
  const output = execFileSync("git", ["diff", "--name-only", `${since}...HEAD`], { cwd: ROOT, encoding: "utf8" });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function changedPathsFrom(flags) {
  if (flags["changed-paths-file"]) {
    return readFileSync(join(ROOT, flags["changed-paths-file"]), "utf8")
      .split("\n").map((line) => line.trim()).filter(Boolean);
  }
  if (flags.since) return changedPathsSince(flags.since);
  return [];
}

function sources() {
  return {
    articles: loadGuide().articles,
    demoManifest: readJson(DEMO_MANIFEST),
    capabilities: CAPABILITY_REGISTRY,
    sourceContracts: readJson(SOURCE_CONTRACTS),
  };
}

/**
 * The clock-free half of the contract: every demo, capability, source, and code
 * path a guide article names must still exist. A rename that silently orphans a
 * citation fails here rather than surfacing as a mystery finding weeks later.
 */
export function checkGuideReviewReferences() {
  const { articles, demoManifest, sourceContracts } = sources();
  const demoIds = new Set((demoManifest.entries || []).map((entry) => entry.id));
  const references = new Set(CAPABILITY_REGISTRY.map((row) => row.reference));
  const contractIds = new Set((sourceContracts.contracts || []).map((row) => row.id));
  const problems = [];

  for (const article of articles) {
    const record = guideReviewArticleRecord(article);
    for (const demoId of [...record.demos, ...record.historical_demos]) {
      if (!demoIds.has(demoId)) problems.push(`${record.id}: demo ${demoId} is not in the demo manifest`);
    }
    for (const demoId of record.historical_demos) {
      if (!record.demos.includes(demoId)) {
        problems.push(`${record.id}: historical demo ${demoId} is not also listed as a demo`);
      }
    }
    for (const reference of record.capabilities) {
      if (!references.has(reference)) problems.push(`${record.id}: capability ${reference} is not in the registry`);
    }
    for (const contractId of record.source_contracts) {
      if (!contractIds.has(contractId)) problems.push(`${record.id}: source ${contractId} is not a source contract`);
    }
    for (const path of record.depends_on) {
      if (!existsSync(join(ROOT, path))) problems.push(`${record.id}: depends_on path ${path} does not exist`);
    }
  }
  return problems;
}

export function buildReport(flags) {
  const checkedAt = typeof flags["checked-at"] === "string" ? flags["checked-at"] : null;
  if (!checkedAt) {
    throw new Error("--checked-at=YYYY-MM-DD is required; this tool never reads a clock");
  }
  const interval = flags["review-interval-days"];
  const { articles, demoManifest, capabilities, sourceContracts } = sources();
  const report = buildGuideReviewReport({
    articles,
    demoManifest,
    capabilities,
    sourceContracts,
    changedPaths: changedPathsFrom(flags),
    demoResults: flags["demo-results"] ? readJson(join(ROOT, flags["demo-results"])) : null,
    checkedAt,
    observedCommit: typeof flags["observed-commit"] === "string" ? flags["observed-commit"] : gitHead(),
    runKey: typeof flags["run-key"] === "string" ? flags["run-key"] : checkedAt,
    ...(interval === undefined ? {} : { reviewIntervalDays: Number.parseInt(interval, 10) }),
  });
  const errors = validateGuideReviewReport(report);
  if (errors.length) throw new Error(`guide review report is not publishable:\n  ${errors.join("\n  ")}`);
  return report;
}

function writeOut(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * Rehearse the handoff through the shared outbox with an intent of `none`, so
 * the deduplication and replay behaviour can be proved without opening,
 * commenting on, or closing anything. A second run over the same window
 * produces the same event and no new work.
 */
const NO_MUTATION_CLIENT = Object.freeze({
  listIssues: () => { throw new Error("guide review rehearsal must not reach GitHub"); },
  listComments: () => { throw new Error("guide review rehearsal must not reach GitHub"); },
  createIssue: () => { throw new Error("guide review rehearsal must not reach GitHub"); },
  createComment: () => { throw new Error("guide review rehearsal must not reach GitHub"); },
  updateIssue: () => { throw new Error("guide review rehearsal must not reach GitHub"); },
});

async function rehearse(report, stateDir) {
  const { event } = await persistScheduleResult({
    stateDir,
    jobId: GUIDE_REVIEW_JOB_ID,
    runKey: report.run_key,
    result: {
      observed_at: `${report.checked_at}T00:00:00Z`,
      status: report.findings.length ? "findings" : "clear",
      content_hash: report.content_hash,
      counts: report.counts,
    },
    issue: { mode: "none" },
  });
  // The client throws on any mutation, so a clean replay is itself the proof
  // that an intent of `none` reaches no outward surface.
  const replay = await replayOutbox({ stateDir, github: NO_MUTATION_CLIENT });
  return { event, replay };
}

async function main(argv) {
  const flags = parseArgs(argv);

  if (flags.check) {
    const problems = checkGuideReviewReferences();
    if (problems.length) {
      process.stderr.write(`Guide review references are stale:\n  ${problems.join("\n  ")}\n`);
      return 1;
    }
    process.stdout.write(`Guide review references ok (${loadGuide().articles.length} articles)\n`);
    return 0;
  }

  const report = buildReport(flags);

  if (flags.section) {
    const text = renderGuideReviewSection(report);
    if (typeof flags.out === "string") {
      process.stdout.write(`Wrote ${writeOut(join(ROOT, flags.out), text)}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  const outPath = typeof flags.out === "string"
    ? join(ROOT, flags.out)
    : join(DEFAULT_OUT_DIR, `${report.run_key}.json`);

  if (flags.rehearse) {
    const stateDir = join(ROOT, typeof flags["state-dir"] === "string"
      ? flags["state-dir"]
      : ".artifacts/guide-review/state");
    const previousPath = join(stateDir, "previous-report.json");
    const previous = existsSync(previousPath) ? readJson(previousPath) : null;
    const delta = guideReviewDelta(previous, report);
    const { event, replay } = await rehearse(report, stateDir);
    writeOut(previousPath, serializeGuideReviewReport(report));
    writeOut(outPath, serializeGuideReviewReport(report));
    process.stdout.write(
      `Guide review rehearsed: event ${event.event_id}, ${delta.new_ids.length} new, `
      + `${delta.persisting_ids.length} unchanged, ${delta.resolved_ids.length} resolved, `
      + `replay ${replay.status}\n`,
    );
    return 0;
  }

  writeOut(outPath, serializeGuideReviewReport(report));
  process.stdout.write(
    `Guide review report: ${report.findings.length} findings across ${report.articles.length} articles -> ${outPath}\n`,
  );
  return 0;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
