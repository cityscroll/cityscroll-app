import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ROOT,
  coveredByPublishedPaths,
  publishedPaths,
  readRegistry,
  registryBuilders,
  registryDrift,
  describeDrift,
  unpublishedRebuildOutputs,
  workflowGateBuilders,
  verificationCommands,
} from "../ops/first-class-refresh/rebuild-committed-read-models.mjs";
import { meetingPublicationFindings, missingAttachmentProof, unboundRollCalls } from "../ops/first-class-refresh/guard-publication.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(REPO_ROOT, ".github/workflows/first-class-refresh.yml");
const WAREHOUSE_SCRIPT = path.join(REPO_ROOT, "ops/first-class-refresh/run-warehouse-refresh.sh");
const PR_SCRIPT = path.join(REPO_ROOT, "tools/open_first_class_refresh_pr.sh");
const DERIVED_MANIFEST = path.join(REPO_ROOT, "warehouse/derived_json_build_manifest.json");

test("the rebuild registry resolves against the repository it ships in", () => {
  assert.equal(ROOT, REPO_ROOT);
  const registry = readRegistry(REPO_ROOT);
  assert.equal(registry.gate_workflow, ".github/workflows/ci.yml");
  assert.equal(registry.gate_family, "static-standards");
  for (const step of registry.rebuild_sequence) {
    assert.ok(step.id, "every rebuild step needs an id");
    assert.ok(step.command?.length, `rebuild step ${step.id} needs a command`);
    assert.ok(existsSync(path.join(REPO_ROOT, step.command[0])), `missing tool for ${step.id}`);
    assert.ok(step.covers?.length, `rebuild step ${step.id} must say which gates it covers`);
  }
  for (const entry of registry.not_rebuilt) {
    assert.ok(existsSync(path.join(REPO_ROOT, entry.builder)), `missing builder ${entry.builder}`);
    assert.ok(entry.disposition, `${entry.builder} needs a disposition`);
    assert.ok(entry.reason && entry.reason.length > 20, `${entry.builder} needs a stated reason`);
  }
});

test("the workflow reader finds the check-mode gates it is pointed at", () => {
  const gates = workflowGateBuilders(REPO_ROOT);
  assert.ok(gates.length >= 14, `expected the static-standards family to declare many gates, saw ${gates.length}`);
  assert.ok(gates.includes("tools/build_keyword_search_index.mjs"));
  assert.ok(gates.includes("tools/build_agency_constellation_documents.mjs"));
  // Gates that belong to other unit families must not leak into the comparison.
  assert.ok(!gates.includes("tools/build_geocoder_address_index.mjs"));
  assert.ok(!gates.includes("tools/no_live_external_reads.mjs"));
});

test("every committed-freshness gate is accounted for by the refresh", () => {
  // This is the drift guard. A new "Committed … freshness" step in the
  // static-standards family fails here until the refresh either rebuilds its
  // read model or records why it cannot.
  const drift = registryDrift(REPO_ROOT);
  assert.deepEqual(describeDrift(drift), []);
});

test("no builder is accounted for twice", () => {
  const builders = registryBuilders(readRegistry(REPO_ROOT));
  assert.equal(new Set(builders).size, builders.length);
});

test("the derived JSON boundary really does build the gates it is credited with", () => {
  const registry = readRegistry(REPO_ROOT);
  const boundary = registry.rebuild_sequence.find((step) => step.id === "derived-json-build-boundary");
  assert.ok(boundary, "the boundary step is the refresh's ordered rebuild for derived JSON");
  const manifest = JSON.parse(readFileSync(DERIVED_MANIFEST, "utf8"));
  const generators = new Set(manifest.generated_families.map((family) => family.generator));
  for (const builder of boundary.covers) {
    assert.ok(generators.has(builder), `${builder} is credited to the boundary but is not a declared family`);
  }
});

test("both halves of the refresh run the rebuild", () => {
  // The hosted workflow refreshes everything a runner can reach; the
  // warehouse-held script refreshes the rest. Neither may commit inputs without
  // their read models.
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /rebuild-committed-read-models\.mjs/);
  const rebuildAt = workflow.indexOf("rebuild-committed-read-models.mjs");
  const publishAt = workflow.indexOf("open_first_class_refresh_pr.sh");
  assert.ok(rebuildAt > 0 && publishAt > rebuildAt, "the rebuild must run before the pull request is opened");

  const warehouse = readFileSync(WAREHOUSE_SCRIPT, "utf8");
  assert.match(warehouse, /rebuild-committed-read-models\.mjs/);
  const warehouseRebuildAt = warehouse.indexOf("rebuild-committed-read-models.mjs");
  const warehouseCommitAt = warehouse.indexOf("git commit");
  assert.ok(
    warehouseRebuildAt > 0 && warehouseCommitAt > warehouseRebuildAt,
    "the warehouse-held refresh must rebuild before it commits",
  );
});

test("the paths the refresh publishes are declared once and exist", () => {
  const registry = readRegistry(REPO_ROOT);
  const paths = publishedPaths(registry);
  assert.ok(paths.length, "the refresh must declare which paths it commits");
  assert.equal(new Set(paths).size, paths.length, "each published path is declared once");
  for (const entry of registry.published_paths) {
    assert.ok(existsSync(path.join(REPO_ROOT, entry.path)), `published path ${entry.path} is not in the repository`);
    assert.ok(entry.reason && entry.reason.length > 20, `published path ${entry.path} needs a stated reason`);
  }
});

test("every rebuild step writes inside a path the refresh commits", () => {
  // The second half of the drift guard. Running a builder is not publishing it:
  // a read model rebuilt outside the commit's pathspecs is regenerated and then
  // discarded, and the gate that re-derives it in check mode fails on the
  // refresh's own pull request. These are the committed documents the rebuild
  // sequence is known to write outside site/ and worker/.
  const paths = publishedPaths(readRegistry(REPO_ROOT));
  for (const written of [
    "docs/evidence/served-coverage/census.json",
    "docs/evidence/geography-subjects/located-in-audit.json",
    "docs/gap-taxonomy.md",
    "site/data/served_coverage_snapshot.json",
    "worker/src/data/keyword_search_index_shards/manifest.json",
    "warehouse/receipts/proof/community_board_payroll_identity_latest.json",
  ]) {
    assert.ok(coveredByPublishedPaths(written, paths), `${written} is rebuilt but never committed`);
  }
});

test("the publish guard reports only what the rebuild itself wrote", () => {
  const paths = ["site", "worker"];
  const before = ["site/data/dataset.json"];
  const after = ["site/data/dataset.json", "site/data/derived.json", "docs/evidence/census.json"];
  assert.deepEqual(unpublishedRebuildOutputs(before, after, paths), ["docs/evidence/census.json"]);
  // A checkout the guard cannot read is not a failure to publish.
  assert.deepEqual(unpublishedRebuildOutputs(null, after, paths), []);
  // A path that merely shares a prefix with a published one is not covered.
  assert.equal(coveredByPublishedPaths("sitemap.xml", paths), false);
});

test("both commit scripts stage the registry's list rather than their own", () => {
  // Two hand-kept copies of the path list is how a rebuilt read model got
  // dropped between the builder that wrote it and the commit that published it.
  for (const script of [PR_SCRIPT, WAREHOUSE_SCRIPT]) {
    const text = readFileSync(script, "utf8");
    assert.match(text, /rebuild-committed-read-models\.mjs[^\n]*--published-paths/, `${script} must read the declared paths`);
    assert.doesNotMatch(text, /^\s*(commit_)?paths=\((?!\)).*$/m, `${script} must not restate the path list`);
  }
});

test("every site and Worker CI freshness test runs before refresh publication, including newly added gates", () => {
  const registry = readRegistry(REPO_ROOT);
  const workflow = readFileSync(path.join(REPO_ROOT, registry.gate_workflow), "utf8");
  assert.match(workflow, /run: node --test test\/\*\.test\.mjs/);
  assert.match(workflow, /run: node --test\s+working-directory: worker/);
  const commands = verificationCommands(registry);
  assert.deepEqual(commands.map((command) => command.family).sort(), ["site-node", "worker"]);
  const site = commands.find((command) => command.family === "site-node");
  // The expansion reads the directory at execution time, not a frozen list of
  // today's failing tests. Future in-process freshness assertions run too.
  for (const file of readdirSync(path.join(REPO_ROOT, "test")).filter((file) => file.endsWith(".test.mjs"))) {
    assert.ok(site.args.includes(`test/${file}`), `${file} has no registry verification entry`);
  }
  const worker = commands.find((command) => command.family === "worker");
  assert.equal(worker.cwd, path.join(REPO_ROOT, "worker"));
  assert.deepEqual(worker.args, ["--test"]);
  const runner = readFileSync(path.join(REPO_ROOT, "ops/first-class-refresh/rebuild-committed-read-models.mjs"), "utf8");
  assert.match(runner, /verifyFreshnessTests\(registry, ROOT, env\)/);
  assert.doesNotMatch(readFileSync(WORKFLOW, "utf8"), /--rebuild-only/);
});

test("the rebuild's dependency order includes all required predecessors", () => {
  const complete = new Set();
  for (const step of readRegistry(REPO_ROOT).rebuild_sequence) {
    for (const dependency of step.after || []) assert.ok(complete.has(dependency), `${step.id} precedes ${dependency}`);
    complete.add(step.id);
  }
});

test("publication retains a previously covered board after HTTP failure or unexplained empty extraction", () => {
  const previous = { by_board: { "manhattan-cb-10": [{}] }, rows: [{}] };
  const attempt = { by_board: {}, rows: [], receipts: [{ board_id: "manhattan-cb-10", role: "upcoming_meetings", state: "unavailable", state_reason: "http_error", observed_receipt: { fetch_status: "403" } }] };
  assert.equal(meetingPublicationFindings(previous, attempt)[0].http_status, "403");
  attempt.receipts[0].state = "checked-empty";
  assert.match(meetingPublicationFindings(previous, attempt)[0].cause, /not established/);
  assert.deepEqual(meetingPublicationFindings(previous, previous), []);
});

test("attachment evidence cannot disappear behind a successful Rules refresh", () => {
  const previous = { rows: [{ request_id: "rule-1", rule_evidence_densify: { method: "city_record_getfile_pdf_v1" }, rule_evidence: { citation_keys: ["fixture:1"] } }] };
  assert.deepEqual(missingAttachmentProof(previous, { rows: [{ request_id: "rule-1" }] }), ["rule-1"]);
  assert.deepEqual(missingAttachmentProof(previous, previous), []);
  // A record that actually left the source population is not manufactured.
  assert.deepEqual(missingAttachmentProof(previous, { rows: [] }), []);
});


test("new named roll calls must belong to their exact event and agenda item", () => {
  const action = { agenda_item_id: "item-1", votes: { person_count: 9, event_id: null, event_item_id: null } };
  const snapshot = { by_notice: { notice: { event: { event_id: "event-1" }, matters: [{ matter_id: "matter-1", item_actions: [action] }] } } };
  assert.equal(unboundRollCalls(snapshot).length, 1);
  action.votes.event_id = "event-1";
  action.votes.event_item_id = "item-1";
  assert.deepEqual(unboundRollCalls(snapshot), []);
  action.votes.event_item_id = "different-item";
  assert.equal(unboundRollCalls(snapshot).length, 1);
});


test("the Data health freshness report is publishable with its dependent page", () => {
  const report = "site/data/first_class_freshness_report.json";
  assert.ok(coveredByPublishedPaths(report, publishedPaths(readRegistry(REPO_ROOT))));
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "-q", report], { cwd: REPO_ROOT });
  assert.equal(ignored.status, 1, "the report must travel with the committed page that reads it");
});
