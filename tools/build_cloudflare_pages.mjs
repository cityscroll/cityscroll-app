#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { mergeResidentSnapshotRefreshEvidence } from "./lib/resident_snapshot_refresh_receipt.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptRoot);
let timingReceiptPath = null;
let timingStartedAt = 0;
const timingStages = [];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "refresh-decision-outcomes" || key === "refresh-resident-snapshots") {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function writeTimingReceipt(result = "running") {
  if (!timingReceiptPath) return;
  mkdirSync(dirname(timingReceiptPath), { recursive: true });
  writeFileSync(timingReceiptPath, `${JSON.stringify({
    schema: "cityscroll.pages_build_timing.v1",
    result,
    elapsed_ms: Math.round(performance.now() - timingStartedAt),
    stages: timingStages,
  }, null, 2)}\n`);
}

function run(command, args, cwd, stage = command) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const startedAt = performance.now();
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  timingStages.push({
    stage,
    command,
    duration_ms: Math.round(performance.now() - startedAt),
    result: result.error ? "environment-error" : result.status === 0 ? "pass" : "fail",
  });
  writeTimingReceipt(result.error || result.status !== 0 ? "fail" : "running");
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNode(sourceDir, tool, args = []) {
  run(process.execPath, [join(sourceDir, "tools", tool), ...args], sourceDir, tool);
}

function runPython(sourceDir, tool, args = []) {
  run("python3", [join(sourceDir, "tools", tool), ...args], sourceDir, tool);
}

function appendOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const args = parseArgs(process.argv.slice(2));
const sourceDir = resolve(repositoryRoot, args["source-dir"] || ".");
const siteDir = resolve(repositoryRoot, args["site-dir"] || "_site");
const refresh = Boolean(args["refresh-decision-outcomes"]);
const refreshResidentSnapshots = Boolean(args["refresh-resident-snapshots"]);
const commitSha = args["commit-sha"] || "";
let residentSnapshotRefreshEvidence = null;
let firstClassFreshnessReport = null;
timingReceiptPath = args["timing-receipt"]
  ? resolve(sourceDir, args["timing-receipt"])
  : (process.env.CITYSCROLL_BUILD_TIMING_RECEIPT ? resolve(sourceDir, process.env.CITYSCROLL_BUILD_TIMING_RECEIPT) : null);
timingStartedAt = performance.now();
writeTimingReceipt();

// Architecture fitness runs before any generated artifact. A production build
// must never be the first place a resident live-data dependency is discovered.
runNode(sourceDir, "no_live_external_reads.mjs", ["--check"]);
runNode(sourceDir, "build_geocoder_address_index.mjs", ["--check"]);
runNode(sourceDir, "build_bbl_mappluto_centroids.mjs", ["--check"]);
runNode(sourceDir, "build_land_project_map_points.mjs", ["--check"]);
runNode(sourceDir, "build_land_authority_summary.mjs", ["--check"]);

// The source-contract registry is also the canonical inventory for first-class
// resident artifacts. Emit the cadence/dependency plan from it on every build
// so workflows never acquire a separate handwritten refresh list.
const firstClassPlanPath = join(sourceDir, ".artifacts", "first-class-refresh-plan.json");
const firstClassRefreshReceiptPath = join(sourceDir, ".artifacts", "first-class-refresh-receipt.json");
const firstClassReportPath = join(sourceDir, "site", "data", "first_class_freshness_report.json");
runNode(sourceDir, "first_class_refresh.mjs", [
  "--check-registry",
  "--write-plan",
  "--plan-out", firstClassPlanPath,
]);
runNode(sourceDir, "build_product_updates.mjs", ["--check"]);

if (refresh) {
  runNode(sourceDir, "build_batch_precompute_snapshots.mjs", ["--land-only"]);
  runNode(sourceDir, "build_meeting_outcomes_snapshot.mjs");
  run(process.execPath, [
    "--test",
    join(sourceDir, "test/batch_precompute_snapshots.test.mjs"),
    join(sourceDir, "test/zap_outcomes.test.mjs"),
    join(sourceDir, "test/meeting_outcomes_static.test.mjs"),
  ], sourceDir, "refresh-decision-outcome-tests");
}

// Refresh the Contracts (Money) resident snapshot from its live acquisition
// before the derived-JSON boundary rebuilds every declared downstream
// artifact from it. A failed acquisition exits the process here (see run()),
// well before any deployment step, and the freshness guard rejects a snapshot
// whose vintage did not actually advance so a broken acquisition can never
// pass as a refresh.
if (refreshResidentSnapshots) {
  runNode(sourceDir, "build_batch_precompute_snapshots.mjs", ["--money-only"]);
  const moneySnapshotPath = join(sourceDir, "site", "data", "money_default_open.json");
  const freshnessEvidencePath = join(sourceDir, ".artifacts", "contracts-snapshot-freshness.json");
  runNode(sourceDir, "check_money_snapshot_freshness.mjs", [
    "--snapshot", moneySnapshotPath,
    "--evidence-out", freshnessEvidencePath,
  ]);
  residentSnapshotRefreshEvidence = JSON.parse(readFileSync(freshnessEvidencePath, "utf8"));
  // Run every other due acquisition and owning builder in registry order. A
  // failed publisher is recorded and isolated here; the hard-age guard below
  // decides whether its last-known-good artifact is still safe to deploy.
  runNode(sourceDir, "first_class_refresh.mjs", [
    "--run-due",
    "--receipt-out", firstClassRefreshReceiptPath,
  ]);
}

// Rebuild the shared freshness seam after acquisition so source-health and
// first-class artifact reports describe the same release attempt.
runNode(sourceDir, "build_source_health_observations.mjs");
runNode(sourceDir, "build_source_health_observations.mjs", ["--check"]);
runNode(sourceDir, "build_source_health_public_projection.mjs");
runNode(sourceDir, "build_source_health_public_projection.mjs", ["--check"]);

const graphTool = join(sourceDir, "tools", "data_source_graph.mjs");
if (existsSync(graphTool)) {
  const docsDir = join(sourceDir, "docs");
  runNode(sourceDir, "data_source_graph.mjs", ["--output-dir", docsDir]);
  runNode(sourceDir, "data_source_graph.mjs", ["--check", "--output-dir", docsDir]);
  appendOutput("data-source-graph-dir", docsDir);
  const cycleReceipt = join(sourceDir, ".artifacts", "desk-health-publication-cycle.json");
  runNode(sourceDir, "desk_health_publication_cycle.mjs", [
    "--from-graph", join(docsDir, "data-source-graph.json"),
    "--write", cycleReceipt,
    "--run-id", process.env.GITHUB_RUN_ID || commitSha || "local-build",
    "--result", "succeeded",
  ]);
  appendOutput("desk-health-publication-cycle", cycleReceipt);
}

const derivedArgs = ["--source-dir", sourceDir];
if (timingReceiptPath) derivedArgs.push("--timing-receipt", `${timingReceiptPath}.derived.json`);
runNode(sourceDir, "derived_json_build_boundary.mjs", derivedArgs);
const freshnessReportArgs = [
  "--write-report",
  "--report-out", firstClassReportPath,
  "--deployment-identity", commitSha || process.env.GITHUB_SHA || "local-build",
];
if (existsSync(firstClassRefreshReceiptPath)) {
  freshnessReportArgs.push("--receipt", firstClassRefreshReceiptPath);
}
if (refreshResidentSnapshots) freshnessReportArgs.push("--check-production");
runNode(sourceDir, "first_class_refresh.mjs", freshnessReportArgs);
firstClassFreshnessReport = JSON.parse(readFileSync(firstClassReportPath, "utf8"));
// The derived boundary builds the page from the previous report; rebuild it
// once more from this release's report before copying the public tree.
runNode(sourceDir, "build_data_health_page.mjs");
// Measure the published payload here, where the refresh boundary has just
// finished regenerating it. The same guard runs again over the built payload
// below; running it against the source first means a refreshed data artifact
// that outgrew the Pages per-file limit fails on the artifact that grew,
// before the rest of the build, instead of at the end of it.
runNode(sourceDir, "check_pages_bundle_sizes.mjs", ["--source-dir", sourceDir]);
if (existsSync(join(sourceDir, "tools", "build_url_migration_map.mjs"))) {
  runNode(sourceDir, "build_url_migration_map.mjs", ["--check"]);
}

const standards = [
  ["python", "test/standards/civic_token_contract.py", []],
  ["node", "tools/build_land_upcoming_hearings.mjs", ["--check"]],
  ["node", "warehouse/scripts/dcas_vehicle_auctions.mjs", ["--check"]],
  ["node", "tools/check_public_payload_integrity.mjs", []],
  ["node", "tools/check_procurement_index_coherence.mjs", []],
];
for (const [kind, path, toolArgs] of standards) {
  const absolutePath = join(sourceDir, path);
  if (!existsSync(absolutePath)) continue;
  if (kind === "python") run("python3", [absolutePath, ...toolArgs], sourceDir);
  else run(process.execPath, [absolutePath, ...toolArgs], sourceDir);
}

runNode(sourceDir, "build_public_site.mjs", ["--source-dir", sourceDir, "--site-dir", siteDir]);
if (residentSnapshotRefreshEvidence || firstClassFreshnessReport) {
  // Record the resident-snapshot refresh in the existing generation-output
  // receipt (already a required release-surface stage) rather than a parallel
  // receipt: build_public_site.mjs just (re)wrote it for this same build.
  const generationReceiptPath = join(sourceDir, ".artifacts", "generation-output-receipt.json");
  if (existsSync(generationReceiptPath)) {
    const generationReceipt = JSON.parse(readFileSync(generationReceiptPath, "utf8"));
    const evidence = {
      ...(residentSnapshotRefreshEvidence ? { contracts: residentSnapshotRefreshEvidence } : {}),
      ...(firstClassFreshnessReport ? { first_class: firstClassFreshnessReport } : {}),
    };
    const merged = mergeResidentSnapshotRefreshEvidence(generationReceipt, evidence);
    writeFileSync(generationReceiptPath, `${JSON.stringify(merged, null, 2)}\n`);
  }
}
runNode(sourceDir, "check_client_module_assets.mjs", ["--site-dir", siteDir]);
runNode(sourceDir, "check_pages_bundle_sizes.mjs", ["--site-dir", siteDir]);
const releaseId = /^[a-f0-9]{40}$/.test(commitSha)
  ? commitSha
  : (process.env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA) ? process.env.GITHUB_SHA : "");
if (releaseId) {
  writeFileSync(join(siteDir, "data", "performance-release.json"), `${JSON.stringify({
    schema: "cityscroll.performance.release.v1",
    release_id: releaseId,
  }, null, 2)}\n`);
}
runPython(sourceDir, "stamp_i18n_assets.py", ["--site-root", siteDir, "--stamp"]);
runPython(sourceDir, "../test/standards/i18n_refs.py", ["--root", siteDir, "--built"]);

runPython(sourceDir, "verify_public_artifact.py", ["--site-root", siteDir]);
writeTimingReceipt("pass");
console.log(`Cloudflare Pages artifact ready at ${siteDir}`);
