import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  runRebuildSequence,
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

test("a failing rebuild step still reaches the summary and pull-request steps, and the run stays visibly red", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const steps = workflow.split(/^ {6}- name:/m).slice(1).map((body) => `- name:${body}`);
  const named = (title) => {
    const step = steps.find((body) => body.startsWith(`- name: ${title}`));
    assert.ok(step, `workflow has no step named "${title}"`);
    return step;
  };
  const rebuild = named("Rebuild the committed read models the refreshed datasets feed");
  assert.match(rebuild, /id:\s*rebuild/);
  assert.match(rebuild, /continue-on-error:\s*true/, "a failed rebuild step must not fail the job or skip the steps after it");
  // continue-on-error on the rebuild step is what keeps these steps running
  // with their ordinary default (success()) condition — an always() override
  // here would also run them against a genuinely broken checkout if an
  // earlier, non-continue-on-error step had failed, which these must not do.
  for (const title of ["Write the combined first-class refresh run receipt", "Summarise what refreshed", "Open a pull request with the refreshed datasets"]) {
    assert.doesNotMatch(named(title), /^\s*if:/m, `"${title}" must run under the default success() condition, not always()`);
  }
  const failClosed = named("Fail the run if the rebuild reported a problem");
  assert.match(failClosed, /if:\s*always\(\)/, "the final visibility check must run even if a later step also failed");
  assert.match(failClosed, /steps\.rebuild\.outcome/, "the final step must check the rebuild step's own outcome");
  const summariseAt = workflow.indexOf("Summarise what refreshed");
  const openPrAt = workflow.indexOf("Open a pull request with the refreshed datasets");
  const failAt = workflow.indexOf("Fail the run if the rebuild reported a problem");
  assert.ok(summariseAt > 0 && openPrAt > summariseAt && failAt > openPrAt, "publication must happen before the run is failed for visibility");
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
    "docs/evidence/ebcg-er-accuracy/receipt.json",
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
  assert.equal(meetingPublicationFindings(previous, attempt)[0].cause_class, "publisher_change");
  attempt.receipts[0].state = "checked-empty";
  attempt.receipts[0].state_reason = "no_explicit_records";
  attempt.receipts[0].observed_receipt = { fetch_status: "200", status: "ok", reason: null };
  attempt.receipts[0].acquisition_invariants = {
    presence: { ok: true, status: "ok", fetch_status: "200", reason: null },
    population: { ok: false, extractable_count: 0, expected_kind: "event" },
    ok: false,
  };
  assert.equal(meetingPublicationFindings(previous, attempt)[0].cause_class, "parser_regression");
  assert.match(meetingPublicationFindings(previous, attempt)[0].cause, /population invariant failed/);
  attempt.receipts[0].acquisition_invariants = null;
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


test("refresh checkout supplies the same complete history as CI to the test families", () => {
  for (const file of [WORKFLOW, path.join(REPO_ROOT, ".github/workflows/ci.yml")]) {
    const steps = readFileSync(file, "utf8").split(/^ {6}- /m);
    const checkout = steps.find((step) => step.startsWith("uses: actions/checkout@"));
    assert.ok(checkout);
    assert.match(checkout, /^          fetch-depth: 0$/m);
  }
});

// A minimal rebuild-step fixture: a small tool that writes a marker file for
// its own id, unless the caller named it in FORCE_FAIL, in which case it exits
// non-zero and writes nothing. dirtyPaths() stands down outside a git working
// tree, so a plain scratch directory is enough — no repository fixture needed.
function isolationFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "first-class-rebuild-isolation-"));
  const tool = path.join(root, "tool.mjs");
  writeFileSync(
    tool,
    [
      'import { writeFileSync } from "node:fs";',
      "const id = process.argv[2];",
      'const forced = (process.env.FORCE_FAIL || "").split(",").filter(Boolean);',
      "if (forced.includes(id)) { console.error(`forced failure: ${id}`); process.exit(1); }",
      'writeFileSync(`${id}.marker`, "built\\n");',
    ].join("\n"),
  );
  const registry = {
    schema: "cityscroll.committed_read_model_rebuild.v1",
    published_paths: [{ path: "site", reason: "test fixture" }],
    not_rebuilt: [],
    rebuild_sequence: [
      { id: "root", command: ["tool.mjs", "root"], after: [] },
      { id: "leaf-a", command: ["tool.mjs", "leaf-a"], after: ["root"] },
      { id: "leaf-b", command: ["tool.mjs", "leaf-b"], after: ["root"] },
      { id: "dependent", command: ["tool.mjs", "dependent"], after: ["leaf-a"] },
    ],
  };
  return { root, registry, marker: (id) => path.join(root, `${id}.marker`) };
}

test("one failed rebuild step is isolated: independent steps still run, only its own dependents are skipped", () => {
  const fixture = isolationFixture();
  try {
    const { results, stranded } = runRebuildSequence(fixture.registry, fixture.root, {
      ...process.env,
      FORCE_FAIL: "leaf-a",
    });
    assert.deepEqual(stranded, []);
    const byId = Object.fromEntries(results.map((row) => [row.id, row]));
    assert.equal(byId.root.status, "succeeded");
    assert.ok(existsSync(fixture.marker("root")));
    assert.equal(byId["leaf-a"].status, "failed");
    assert.ok(!existsSync(fixture.marker("leaf-a")), "the failed step must not have written its output");
    // leaf-b shares no dependency with leaf-a and must still have run: this is
    // "the datasets that refreshed successfully" from a sibling failure.
    assert.equal(byId["leaf-b"].status, "succeeded");
    assert.ok(existsSync(fixture.marker("leaf-b")));
    // Only the step that actually depends on the failed one is blocked.
    assert.equal(byId.dependent.status, "skipped");
    assert.equal(byId.dependent.blocked_by, "leaf-a");
    assert.ok(!existsSync(fixture.marker("dependent")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("when every rebuild step fails, nothing is rebuilt and the run reports it rather than publishing partial data", () => {
  const fixture = isolationFixture();
  try {
    const { results } = runRebuildSequence(fixture.registry, fixture.root, {
      ...process.env,
      // Failing the root is enough to cascade a skip through every dependent,
      // which is the shape a real total failure takes: nothing downstream of
      // the first stage can run either.
      FORCE_FAIL: "root",
    });
    assert.deepEqual(
      results.map((row) => row.status),
      ["failed", "skipped", "skipped", "skipped"],
    );
    assert.ok(results.every((row) => !existsSync(fixture.marker(row.id))));
    const byId = Object.fromEntries(results.map((row) => [row.id, row]));
    assert.equal(byId["leaf-a"].blocked_by, "root");
    assert.equal(byId["leaf-b"].blocked_by, "root");
    // Transitively blocked: dependent's immediate predecessor is leaf-a, which
    // itself never ran, so it reports the dependency that actually stopped it.
    assert.equal(byId.dependent.blocked_by, "leaf-a");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("accuracy evidence follows the rebuilt census and is covered for publication", () => {
  const registry = readRegistry(REPO_ROOT);
  const census = registry.rebuild_sequence.findIndex((step) => step.id === "cross-spine-census");
  const accuracy = registry.rebuild_sequence.findIndex((step) => step.command[0] === "tools/build_constellation_er_accuracy_receipt.mjs");
  assert.ok(census >= 0 && accuracy > census);
  assert.ok(registry.rebuild_sequence[accuracy].after.includes("cross-spine-census"));
  assert.ok(coveredByPublishedPaths("docs/evidence/ebcg-er-accuracy/receipt.json", publishedPaths(registry)));
});

test("refresh restamps land map-point receipts and assistant-setup digests after site rebuild", () => {
  const registry = readRegistry(REPO_ROOT);
  const mapPoints = registry.rebuild_sequence.find((step) => step.id === "land-project-map-points");
  assert.ok(mapPoints, "land-project-map-points must restamp the receipt the Shared browser site artifact checks");
  assert.deepEqual(mapPoints.command, ["tools/build_land_project_map_points.mjs"]);
  assert.ok(mapPoints.after.includes("derived-json-build-boundary"));

  const assistant = registry.rebuild_sequence.find((step) => step.id === "assistant-setup-capture");
  assert.ok(assistant, "assistant-setup-capture must restamp digests capability_discovery verifies");
  assert.deepEqual(assistant.command, ["tools/capture_assistant_setup_evidence.py"]);
  assert.equal(assistant.runtime, "python3");
  assert.ok(assistant.after.includes("capture-site"));
});
