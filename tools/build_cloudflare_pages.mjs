#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptRoot);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "refresh-decision-outcomes") {
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

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNode(sourceDir, tool, args = []) {
  run(process.execPath, [join(sourceDir, "tools", tool), ...args], sourceDir);
}

function runPython(sourceDir, tool, args = []) {
  run("python3", [join(sourceDir, "tools", tool), ...args], sourceDir);
}

function appendOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const args = parseArgs(process.argv.slice(2));
const sourceDir = resolve(repositoryRoot, args["source-dir"] || ".");
const siteDir = resolve(repositoryRoot, args["site-dir"] || "_site");
const refresh = Boolean(args["refresh-decision-outcomes"]);
const reviewChannel = args["review-channel"] || "";
const commitSha = args["commit-sha"] || "";

// Architecture fitness runs before any generated artifact. A production build
// must never be the first place a resident live-data dependency is discovered.
runNode(sourceDir, "no_live_external_reads.mjs", ["--check"]);
runNode(sourceDir, "build_geocoder_address_index.mjs", ["--check"]);
runNode(sourceDir, "build_bbl_mappluto_centroids.mjs", ["--check"]);

// Rebuild the shared freshness seam before the desk graph. The external
// scheduler state directory is optional in local/Pages builds; when absent the
// generated watchdog records the missing heartbeat instead of silently serving
// yesterday's committed health clock.
runNode(sourceDir, "build_source_health_observations.mjs");
runNode(sourceDir, "build_source_health_observations.mjs", ["--check"]);

if (refresh) {
  runNode(sourceDir, "build_batch_precompute_snapshots.mjs", ["--land-only"]);
  runNode(sourceDir, "build_meeting_outcomes_snapshot.mjs");
  run(process.execPath, [
    "--test",
    join(sourceDir, "test/batch_precompute_snapshots.test.mjs"),
    join(sourceDir, "test/zap_outcomes.test.mjs"),
    join(sourceDir, "test/meeting_outcomes_static.test.mjs"),
  ], sourceDir);
}

const graphTool = join(sourceDir, "tools", "data_source_graph.mjs");
if (existsSync(graphTool)) {
  const docsDir = join(sourceDir, "docs");
  runNode(sourceDir, "data_source_graph.mjs", ["--output-dir", docsDir]);
  runNode(sourceDir, "data_source_graph.mjs", ["--check", "--output-dir", docsDir]);
  appendOutput("data-source-graph-dir", docsDir);
}

const optionalBuilds = [
  ["build_shared_procurement_read_model.mjs", []],
  ["build_money_resident_snapshot.mjs", []],
  ["build_property_resident_snapshot.mjs", []],
  ["build_primary_documents.mjs", []],
  ["build_keyword_search_index.mjs", []],
  ["build_following_procurement_suggestions.mjs", []],
  ["build_district_activity.mjs", []],
  ["build_near_you_pages.mjs", []],
  ["build_following_page.mjs", []],
  ["build_data_health_page.mjs", []],
  ["build_exam_documents.mjs", []],
  ["build_agency_documents.mjs", []],
  ["build_process_conformance.mjs", []],
  ["build_agency_lifecycle_conformance.mjs", []],
  ["build_agency_constellation_documents.mjs", []],
  ["build_community_board_constellation_documents.mjs", []],
];
for (const [tool, toolArgs] of optionalBuilds) {
  if (existsSync(join(sourceDir, "tools", tool))) runNode(sourceDir, tool, toolArgs);
  if (existsSync(join(sourceDir, "tools", tool))) runNode(sourceDir, tool, ["--check"]);
}
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

if (reviewChannel) {
  runPython(sourceDir, "prepare_review_artifact.py", [
    "--site-root", siteDir,
    "--channel", reviewChannel,
    "--commit", commitSha,
  ]);
}

runPython(sourceDir, "verify_public_artifact.py", ["--site-root", siteDir]);
console.log(`Cloudflare Pages artifact ready at ${siteDir}`);
