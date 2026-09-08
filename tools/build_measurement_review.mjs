#!/usr/bin/env node
/**
 * Build the measurement-review report the existing weekly review flow consumes.
 *
 * The lane is the guide-review lane's twin, deliberately: same report shape, same finding
 * identity rule, same shared outbox, same refusal to schedule itself. What it watches is
 * different -- the figures the public Stats page publishes and the contracts behind them --
 * but a review desk should not have to learn a second set of conventions to read it.
 *
 *   node tools/build_measurement_review.mjs --check
 *   node tools/build_measurement_review.mjs --checked-at=2026-09-06 --observation=<path>
 *   node tools/build_measurement_review.mjs --section --checked-at=2026-09-06
 *   node tools/build_measurement_review.mjs --rehearse --checked-at=2026-09-06 --run-key=2026-W36
 *
 * `--check` reads no clock and takes no date. It asks only the questions that can be answered
 * from the tracked sources alone: whether the surface vocabulary still answers for the route
 * map, whether every source the published coverage counts is registered, and whether the
 * worked paths on the page still point at routes that exist. Those are the parts that rot
 * silently between reviews, so they are also the parts a required gate can hold.
 *
 * `--observation` supplies the two live readings a check cannot take for itself: the dated
 * aggregate reconciliation and the daily-publication finding. Without it those two checks
 * report `check_unavailable`, which is not the same claim as a measurement that went wrong.
 *
 * Reports are written under the ignored `.artifacts/` tree. They describe one moment rather
 * than the state of the site, so they are not tracked.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANALYTICS_COLLECTOR_SURFACES,
  ANALYTICS_ROUTE_SURFACES,
} from "../site/analytics_surface_taxonomy.mjs";
import {
  MEASUREMENT_REVIEW_JOB_ID,
  buildMeasurementReviewReport,
  measurementReviewDelta,
  renderMeasurementReviewSection,
  serializeMeasurementReviewReport,
  validateMeasurementReviewReport,
} from "../site/measurement_review_source.mjs";
import { persistScheduleResult, replayOutbox } from "./external_schedule_outbox.mjs";
import { primaryDocumentOutputs } from "./build_primary_documents.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = join(ROOT, ".artifacts/measurement-review");
const COLLECTOR_TAG = /<script[^>]+src="[^"]*analytics\.js\?v=/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * A path argument is repository-relative unless the caller gave an absolute one. Joining an
 * absolute path onto the repository root would silently write inside the working copy, which is
 * how a temporary directory ends up tracked.
 */
function fromRoot(path) {
  return isAbsolute(path) ? path : join(ROOT, path);
}

export function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const pair = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (pair) { flags[pair[1]] = pair[2]; continue; }
    const bare = /^--([a-z-]+)$/.exec(arg);
    if (bare) { flags[bare[1]] = true; continue; }
    throw new Error(`unrecognized argument ${JSON.stringify(arg)}`);
  }
  return flags;
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

/** The route a built document is served at, derived from where it sits in the site tree. */
export function documentRoute(sitePath) {
  const relativePath = relative(join(ROOT, "site"), sitePath).split("\\").join("/");
  if (relativePath === "index.html") return "/";
  if (relativePath.endsWith("/index.html")) return `/${relativePath.slice(0, -"/index.html".length)}`;
  return `/${relativePath}`;
}

/**
 * Every document that ships the first-party collector, tracked or generated.
 *
 * Tracked documents are read from the working tree; the primary documents are built the same
 * way the site build builds them, so a route that only exists as build output is still part of
 * this answer.
 */
export function collectorDocuments() {
  const documents = new Map();
  const tracked = execFileSync("git", ["ls-files", "site/**/*.html", "site/*.html"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean);
  for (const path of tracked) {
    const absolute = join(ROOT, path);
    if (!existsSync(absolute)) continue;
    if (!COLLECTOR_TAG.test(readFileSync(absolute, "utf8"))) continue;
    documents.set(documentRoute(absolute), { path, route: documentRoute(absolute) });
  }
  for (const [path, html] of primaryDocumentOutputs()) {
    if (!COLLECTOR_TAG.test(html)) continue;
    const route = documentRoute(path);
    documents.set(route, { path: relative(ROOT, path), route });
  }
  return [...documents.values()].sort((left, right) => (left.route < right.route ? -1 : 1));
}

/**
 * The worked paths the public Stats page teaches, read out of the document rather than
 * restated here. A second list of example URLs would be a second thing to keep true.
 */
export function statsWorkedPaths(html = readFileSync(join(ROOT, "site/stats.html"), "utf8")) {
  const section = html.slice(html.indexOf('<div class="paths"'));
  const block = section.slice(0, section.indexOf("</div>"));
  return [...block.matchAll(/<a href="([^"]+)"/g)].map((match) => ({ href: match[1] }));
}

function observation(flags) {
  if (!flags.observation) return { reconciliation: null, publication: null };
  const parsed = readJson(fromRoot(flags.observation));
  return {
    reconciliation: parsed.reconciliation || null,
    publication: parsed.publication || null,
  };
}

export function buildReport(flags) {
  const checkedAt = typeof flags["checked-at"] === "string" ? flags["checked-at"] : null;
  if (!checkedAt) throw new Error("--checked-at=YYYY-MM-DD is required; this tool never reads a clock");
  const live = observation(flags);
  const report = buildMeasurementReviewReport({
    routeSurfaces: ANALYTICS_ROUTE_SURFACES,
    collectorSurfaces: ANALYTICS_COLLECTOR_SURFACES,
    routeManifest: readJson(join(ROOT, "site/data/performance-classification-manifest.v1.json")),
    collectorDocuments: collectorDocuments(),
    sourceContracts: readJson(join(ROOT, "site/data/source_contracts.json")),
    coverageSnapshot: readJson(join(ROOT, "site/data/served_coverage_snapshot.json")),
    workedPaths: statsWorkedPaths(),
    demoManifest: readJson(join(ROOT, "site/demo/demo-links.json")),
    reconciliation: live.reconciliation,
    publication: live.publication,
    checkedAt,
    observedCommit: typeof flags["observed-commit"] === "string" ? flags["observed-commit"] : gitHead(),
    runKey: typeof flags["run-key"] === "string" ? flags["run-key"] : checkedAt,
  });
  const errors = validateMeasurementReviewReport(report);
  if (errors.length) throw new Error(`measurement review report is not publishable:\n  ${errors.join("\n  ")}`);
  return report;
}

/**
 * The clock-free half of the contract: the three checks that need no live observation. A
 * finding from any of them means a tracked contract and the thing it describes have parted
 * company, which is a build-time fact rather than a weekly one.
 */
export function checkMeasurementReviewReferences() {
  const report = buildMeasurementReviewReport({
    routeSurfaces: ANALYTICS_ROUTE_SURFACES,
    collectorSurfaces: ANALYTICS_COLLECTOR_SURFACES,
    routeManifest: readJson(join(ROOT, "site/data/performance-classification-manifest.v1.json")),
    collectorDocuments: collectorDocuments(),
    sourceContracts: readJson(join(ROOT, "site/data/source_contracts.json")),
    coverageSnapshot: readJson(join(ROOT, "site/data/served_coverage_snapshot.json")),
    workedPaths: statsWorkedPaths(),
    demoManifest: readJson(join(ROOT, "site/demo/demo-links.json")),
    checkedAt: "1970-01-01",
    observedCommit: "",
    runKey: "check",
  });
  return report.findings
    .filter((item) => ["source_participation", "route_taxonomy_drift", "example_invalid"].includes(item.kind))
    .map((item) => `${item.kind}: ${item.subject} — ${item.detail}`);
}

function writeOut(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * Rehearse the handoff through the shared outbox with an intent of `none`, so deduplication and
 * replay can be proved without opening, commenting on, or closing anything.
 */
const NO_MUTATION_CLIENT = Object.freeze({
  listIssues: () => { throw new Error("measurement review rehearsal must not reach GitHub"); },
  listComments: () => { throw new Error("measurement review rehearsal must not reach GitHub"); },
  createIssue: () => { throw new Error("measurement review rehearsal must not reach GitHub"); },
  createComment: () => { throw new Error("measurement review rehearsal must not reach GitHub"); },
  updateIssue: () => { throw new Error("measurement review rehearsal must not reach GitHub"); },
});

async function rehearse(report, stateDir) {
  const { event } = await persistScheduleResult({
    stateDir,
    jobId: MEASUREMENT_REVIEW_JOB_ID,
    runKey: report.run_key,
    result: {
      observed_at: `${report.checked_at}T00:00:00Z`,
      status: report.findings.length ? "findings" : "clear",
      content_hash: report.content_hash,
      counts: report.counts,
    },
    issue: { mode: "none" },
  });
  const replay = await replayOutbox({ stateDir, now: `${report.checked_at}T00:00:00Z`, github: NO_MUTATION_CLIENT });
  return { event, replay };
}

async function main(argv) {
  const flags = parseArgs(argv);

  if (flags.check) {
    const problems = checkMeasurementReviewReferences();
    if (problems.length) {
      process.stderr.write(`Measurement review references are stale:\n  ${problems.join("\n  ")}\n`);
      return 1;
    }
    process.stdout.write(
      `Measurement review references ok (${collectorDocuments().length} collector documents, `
      + `${ANALYTICS_ROUTE_SURFACES.length} registered surfaces)\n`,
    );
    return 0;
  }

  const report = buildReport(flags);

  if (flags.section) {
    const text = renderMeasurementReviewSection(report);
    if (typeof flags.out === "string") process.stdout.write(`Wrote ${writeOut(fromRoot(flags.out), text)}\n`);
    else process.stdout.write(text);
    return 0;
  }

  const outPath = typeof flags.out === "string"
    ? fromRoot(flags.out)
    : join(DEFAULT_OUT_DIR, `${report.run_key}.json`);

  if (flags.rehearse) {
    const stateDir = fromRoot(typeof flags["state-dir"] === "string"
      ? flags["state-dir"]
      : ".artifacts/measurement-review/state");
    const previousPath = join(stateDir, "previous-report.json");
    const previous = existsSync(previousPath) ? readJson(previousPath) : null;
    const delta = measurementReviewDelta(previous, report);
    const { event, replay } = await rehearse(report, stateDir);
    writeOut(previousPath, serializeMeasurementReviewReport(report));
    writeOut(outPath, serializeMeasurementReviewReport(report));
    process.stdout.write(
      `Measurement review rehearsed: event ${event.event_id}, ${delta.new_ids.length} new, `
      + `${delta.persisting_ids.length} unchanged, ${delta.resolved_ids.length} resolved, `
      + `replay ${replay.status}\n`,
    );
    return 0;
  }

  writeOut(outPath, serializeMeasurementReviewReport(report));
  process.stdout.write(
    `Measurement review report: ${report.findings.length} findings -> ${outPath}\n`,
  );
  return 0;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error?.message || String(error)}\n`);
      process.exitCode = 1;
    });
}
