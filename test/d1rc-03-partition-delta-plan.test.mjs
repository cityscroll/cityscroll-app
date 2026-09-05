import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadManifest } from "../tools/d1_manifest.mjs";
import {
  DeltaPlanError,
  PLAN_SCHEMA,
  SNAPSHOT_SCHEMA,
  WHOLE_MODEL_PARTITION,
  planDelta,
  snapshotFor,
  watermarkInstants,
  watermarkRegressed,
} from "../tools/d1_delta_plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "tools", "d1_delta_plan.mjs");
const manifest = loadManifest();
const clone = (value) => structuredClone(value);

function fixtureSources() {
  return {
    keyword_search: {
      families: {
        alpha: {
          source: "alpha-src", as_of: "2026-09-01T00:00:00Z", source_row_count: 2, indexed_count: 2,
          coverage: [{ matched: 2 }],
          documents: [
            { title: "Alpha one", summary: "first", object_ref: "notice:a1", source_observation_refs: ["obs:1"] },
            { title: "Alpha two", search_text: "second" },
          ],
        },
        beta: {
          source: "beta-src", as_of: "1200|2026-09-01T00:00:00Z|2026-09-02T00:00:00Z", source_row_count: 1, indexed_count: 1,
          coverage: [], documents: [{ title: "Beta one", object_ref: "notice:b1" }],
        },
      },
    },
    ocp_awards: {
      materialized_at: "2026-09-01T00:00:00Z",
      rows: [
        { request_id: "r1", pin: "p1", start_date: "2026-01-01", agency_name: "DOT", vendor_name: "Vendor A", contract_amount: 10 },
        { request_id: "r2", pin: "p2", start_date: "2026-01-02", agency_name: "DEP", vendor_name: "Vendor B", contract_amount: 20 },
        { request_id: "r3", pin: "p3", start_date: "2026-01-03", agency_name: "DEP", vendor_name: "Vendor C", contract_amount: 30 },
      ],
    },
    entity_intelligence: {
      schema_version: 1, generated_at: "2026-09-01T00:00:00Z", observation_count: 3, entity_count: 2, multi_domain_count: 1,
      by_ref: {
        "vendor:a": { root: { kind: "vendor", display_name: "Vendor A" }, links: [
          { type: "decides_land_project", from: "meeting:m1", to: "project:p1" },
        ], domains: {} },
        "agency:dep": { root: { kind: "agency", display_name: "DEP" }, links: [], domains: {} },
      },
      by_subject_ref: {
        "notice:a1": [{ entity_ref: "vendor:a", relation: "awarded_to", confidence: "high" }],
        "notice:b1": [{ entity_ref: "agency:dep", relation: "issued_by", confidence: "exact" }],
      },
    },
  };
}

function countsByPartition(plan, modelId) {
  const model = plan.models.find((entry) => entry.model_id === modelId);
  return Object.fromEntries(model.partitions.map((item) => [item.partition, { status: item.status, ...item.counts }]));
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  return value;
}

test("every model has a partition key, a watermark, and keyed records per declared table", () => {
  const snapshot = snapshotFor(manifest, fixtureSources());
  assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
  assert.deepEqual(Object.keys(snapshot.models), ["entity_intelligence", "keyword_search", "ocp_awards"]);
  assert.deepEqual(Object.keys(snapshot.models.keyword_search.partitions), ["alpha", "beta"]);
  assert.deepEqual(Object.keys(snapshot.models.ocp_awards.partitions), [WHOLE_MODEL_PARTITION]);
  for (const entry of manifest.models) {
    const model = snapshot.models[entry.model_id];
    const tables = new Set();
    for (const bucket of Object.values(model.partitions)) {
      assert.ok(watermarkInstants(bucket.watermark), `${entry.model_id} partition watermark parses`);
      for (const key of Object.keys(bucket.rows)) tables.add(key.split("|")[0]);
    }
    assert.deepEqual([...tables].sort(), entry.tables.map((table) => table.name).sort(), `${entry.model_id} covers every declared table`);
  }
  assert.equal(Object.keys(snapshot.models.keyword_search.partitions.alpha.rows).length, 1 + 2 * 2);
  assert.equal(Object.keys(snapshot.models.ocp_awards.partitions[WHOLE_MODEL_PARTITION].rows).length, 3);
});

test("an unchanged source yields zero operations in every partition", () => {
  const snapshot = snapshotFor(manifest, fixtureSources());
  const plan = planDelta({ prior: snapshot, current: clone(snapshot) });
  assert.equal(plan.schema, PLAN_SCHEMA);
  assert.equal(plan.operation, "delta");
  for (const model of plan.models) {
    assert.equal(model.truncate, false);
    assert.equal(model.totals.total_ops, 0, `${model.model_id} has no operations`);
    assert.ok(model.partitions.every((item) => item.status === "unchanged"));
  }
});

test("golden: one changed source partition yields a bounded delta and unrelated partitions stay untouched", () => {
  const prior = snapshotFor(manifest, fixtureSources());
  const sources = fixtureSources();
  sources.keyword_search.families.beta.as_of = "1201|2026-09-01T00:00:00Z|2026-09-03T00:00:00Z";
  sources.keyword_search.families.beta.indexed_count = 2;
  sources.keyword_search.families.beta.documents.push({ title: "Beta two", object_ref: "notice:b2" });
  const plan = planDelta({ prior, current: snapshotFor(manifest, sources) });
  assert.deepEqual(countsByPartition(plan, "keyword_search"), {
    alpha: { status: "unchanged", insert: 0, update: 0, delete: 0, unchanged: 5, total_ops: 0 },
    beta: { status: "changed", insert: 2, update: 1, delete: 0, unchanged: 2, total_ops: 3 },
  });
  const beta = plan.models.find((model) => model.model_id === "keyword_search").partitions.find((item) => item.partition === "beta");
  assert.deepEqual(beta.ops.insert, [
    { table: "keyword_search_documents", key: "beta:notice:b2", key_values: ["beta:notice:b2"] },
    { table: "keyword_search_fts", key: "beta:notice:b2", key_values: ["beta:notice:b2"] },
  ]);
  assert.deepEqual(beta.ops.update, [{ table: "keyword_search_families", key: "beta", key_values: ["beta"] }]);
  assert.deepEqual(countsByPartition(plan, "ocp_awards"), {
    [WHOLE_MODEL_PARTITION]: { status: "unchanged", insert: 0, update: 0, delete: 0, unchanged: 3, total_ops: 0 },
  });
  assert.deepEqual(countsByPartition(plan, "entity_intelligence"), {
    [WHOLE_MODEL_PARTITION]: { status: "unchanged", insert: 0, update: 0, delete: 0, unchanged: 6, total_ops: 0 },
  });
});

test("deletions are explicit: dropped rows and dropped partitions become delete operations", () => {
  const prior = snapshotFor(manifest, fixtureSources());
  const sources = fixtureSources();
  sources.ocp_awards.materialized_at = "2026-09-02T00:00:00Z";
  sources.ocp_awards.rows.pop();
  delete sources.keyword_search.families.alpha;
  const plan = planDelta({ prior, current: snapshotFor(manifest, sources) });
  assert.deepEqual(countsByPartition(plan, "ocp_awards")[WHOLE_MODEL_PARTITION],
    { status: "changed", insert: 0, update: 0, delete: 1, unchanged: 2, total_ops: 1 });
  const ocp = plan.models.find((model) => model.model_id === "ocp_awards").partitions[0];
  assert.deepEqual(ocp.ops.delete, [{ table: "ocp_awards_warehouse", key: "r3|p3|2026-01-03", key_values: ["r3|p3|2026-01-03"] }]);
  assert.deepEqual(countsByPartition(plan, "keyword_search"), {
    alpha: { status: "removed", insert: 0, update: 0, delete: 5, unchanged: 0, total_ops: 5 },
    beta: { status: "unchanged", insert: 0, update: 0, delete: 0, unchanged: 3, total_ops: 0 },
  });
});

test("the same source produces the same plan regardless of input ordering", () => {
  const prior = snapshotFor(manifest, fixtureSources());
  const changed = fixtureSources();
  changed.ocp_awards.materialized_at = "2026-09-05T00:00:00Z";
  changed.ocp_awards.rows[1].contract_amount = 25;
  const straight = planDelta({ prior, current: snapshotFor(manifest, changed) });
  const shuffledSources = reverseKeys(changed);
  const shuffledManifest = reverseKeys(clone(manifest));
  shuffledManifest.models.reverse();
  const shuffled = planDelta({ prior: reverseKeys(clone(prior)), current: snapshotFor(shuffledManifest, shuffledSources) });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(straight));
  assert.equal(countsByPartition(straight, "ocp_awards")[WHOLE_MODEL_PARTITION].update, 1);
});

test("a missing or regressed watermark refuses the plan instead of publishing partial data", () => {
  const prior = snapshotFor(manifest, fixtureSources());
  const missingSnapshot = snapshotFor(manifest, fixtureSources());
  missingSnapshot.models.keyword_search.partitions.alpha.watermark = "12783|not-a-date";
  assert.throws(() => planDelta({ prior, current: missingSnapshot }), (error) => (
    error instanceof DeltaPlanError && error.code === "watermark_missing" && error.context.partition === "alpha"));
  const regressed = fixtureSources();
  regressed.keyword_search.families.beta.as_of = "1200|2026-08-31T00:00:00Z|2026-09-02T00:00:00Z";
  assert.throws(() => planDelta({ prior, current: snapshotFor(manifest, regressed) }), (error) => (
    error instanceof DeltaPlanError && error.code === "watermark_regressed" && error.context.partition === "beta"));
  assert.equal(watermarkRegressed(watermarkInstants("2026-09-01T00:00:00Z"), watermarkInstants("2026-09-01T00:00:00Z")), false);
  assert.equal(watermarkRegressed(watermarkInstants("1|2026-09-01T00:00:00Z|2026-09-02T00:00:00Z"), watermarkInstants("2|2026-09-01T00:00:00Z")), true);
});

test("a rebuild is an explicit, separately named operation with a reason", () => {
  const current = snapshotFor(manifest, fixtureSources());
  assert.throws(() => planDelta({ prior: null, current }), (error) => error.code === "no_prior_snapshot");
  const otherManifest = clone(manifest);
  otherManifest.models[0].model_version += 1;
  assert.throws(() => planDelta({ prior: snapshotFor(otherManifest, fixtureSources()), current }), (error) => error.code === "manifest_changed");
  assert.throws(() => planDelta({ prior: null, current, rebuild: "  " }), (error) => error.code === "rebuild_reason");
  const rebuild = planDelta({ prior: null, current, rebuild: "first publication after d1-03" });
  assert.equal(rebuild.operation, "rebuild");
  assert.equal(rebuild.reason, "first publication after d1-03");
  for (const model of rebuild.models) {
    assert.equal(model.truncate, true);
    assert.ok(model.partitions.every((item) => item.status === "rebuild" && item.counts.insert > 0 && item.counts.delete === 0));
  }
});

test("the CLI snapshots the live read models and plans a zero-operation delta against itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1rc-03-"));
  try {
    const snapshotPath = join(dir, "snapshot.json");
    let result = spawnSync(process.execPath, [TOOL, "snapshot", "--out", snapshotPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
    assert.ok(Object.keys(snapshot.models.keyword_search.partitions).length > 1, "live keyword search has more than one partition");

    const planPath = join(dir, "plan.json");
    result = spawnSync(process.execPath, [TOOL, "plan", "--prior", snapshotPath, "--current", snapshotPath, "--out", planPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(plan.operation, "delta");
    assert.ok(plan.models.every((model) => model.totals.total_ops === 0));

    result = spawnSync(process.execPath, [TOOL, "plan", "--current", snapshotPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 2, "plan without a prior or a rebuild reason is a usage error");

    const rebuildPath = join(dir, "rebuild.json");
    result = spawnSync(process.execPath, [TOOL, "plan", "--prior", join(dir, "absent.json"), "--current", snapshotPath, "--rebuild", "first publication", "--out", rebuildPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const rebuild = JSON.parse(readFileSync(rebuildPath, "utf8"));
    assert.equal(rebuild.operation, "rebuild");
    assert.equal(rebuild.reason, "first publication");

    result = spawnSync(process.execPath, [TOOL, "plan", "--prior", join(dir, "absent.json"), "--current", snapshotPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 1, "a missing prior without a rebuild reason is refused");
    assert.match(result.stderr, /refused \(no_prior_snapshot\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graph deltas follow published labels, dates, agency names, and last-link-wins payloads", () => {
  const sources = fixtureSources();
  const doc = sources.entity_intelligence;
  doc.by_ref["vendor:a"].domains.meetings = { objects: [{
    subject_ref: "meeting:m1", root_ref: "agency:dep", label: "Original meeting", when: "2026-09-01",
  }] };
  doc.by_ref["agency:dep"].links = [{ ...doc.by_ref["vendor:a"].links[0], confidence: "exact" }];
  const prior = snapshotFor(manifest, sources);
  const graphUpdates = (changed) => planDelta({ prior, current: snapshotFor(manifest, changed) })
    .models.find((model) => model.model_id === "entity_intelligence").partitions[0].ops.update
    .filter((row) => row.table === "entity_intelligence_graph_links");
  for (const mutate of [
    (value) => { value.by_ref["vendor:a"].domains.meetings.objects[0].label = "Renamed meeting"; },
    (value) => { value.by_ref["vendor:a"].domains.meetings.objects[0].when = "2026-09-02"; },
    (value) => { value.by_ref["agency:dep"].root.display_name = "Department of Environmental Protection"; },
    (value) => { value.by_ref["agency:dep"].links[0].confidence = "derived"; },
  ]) {
    const changed = clone(sources);
    mutate(changed.entity_intelligence);
    assert.deepEqual(graphUpdates(changed), [{
      table: "entity_intelligence_graph_links", key: "project:p1|meeting:m1|decides_land_project",
      key_values: ["project:p1", "meeting:m1", "decides_land_project"],
    }]);
  }
  const changed = clone(sources);
  changed.entity_intelligence.by_ref["vendor:a"].links[0].confidence = "ignored earlier duplicate";
  assert.deepEqual(graphUpdates(changed), []);
});

test("rebuilds enforce watermarks for first publication and existing partitions", () => {
  const prior = snapshotFor(manifest, fixtureSources());
  for (const watermark of [null, "not-a-date", "2026-08-01T00:00:00Z"]) {
    const current = clone(prior);
    current.models.ocp_awards.partitions[WHOLE_MODEL_PARTITION].watermark = watermark;
    assert.throws(() => planDelta({ prior, current, rebuild: "refresh publication" }),
      (error) => error.code === (watermark?.startsWith("2026") ? "watermark_regressed" : "watermark_missing"));
    if (!watermark?.startsWith("2026")) {
      assert.throws(() => planDelta({ prior: null, current, rebuild: "first publication" }),
        (error) => error.code === "watermark_missing");
    }
  }
  const invalidPrior = clone(prior);
  invalidPrior.models.ocp_awards.partitions[WHOLE_MODEL_PARTITION].watermark = null;
  assert.throws(() => planDelta({ prior: invalidPrior, current: prior, rebuild: "refresh publication" }),
    (error) => error.code === "watermark_missing" && error.context.role === "prior");
});

test("empty OCP partitions retain watermarks without inventing published rows", () => {
  const sources = fixtureSources();
  const prior = snapshotFor(manifest, sources);
  sources.ocp_awards.rows = [];
  const current = snapshotFor(manifest, sources);
  assert.deepEqual(current.models.ocp_awards.partitions[WHOLE_MODEL_PARTITION], {
    watermark: sources.ocp_awards.materialized_at, rows: {},
  });
  const model = (plan) => plan.models.find((entry) => entry.model_id === "ocp_awards");
  assert.deepEqual(model(planDelta({ prior, current })).partitions[0].counts,
    { insert: 0, update: 0, delete: 3, unchanged: 0, total_ops: 3 });
  assert.equal(model(planDelta({ prior: null, current, rebuild: "empty publication" })).partitions[0].counts.total_ops, 0);
  assert.equal(model(planDelta({ prior: current, current })).totals.total_ops, 0);
});

test("row totals and partition totals use separate units", () => {
  const current = snapshotFor(manifest, fixtureSources());
  const plan = planDelta({ prior: current, current });
  const ocp = plan.models.find((model) => model.model_id === "ocp_awards");
  assert.deepEqual(ocp.totals, {
    insert: 0, update: 0, delete: 0, unchanged: 3, total_ops: 0,
    unchanged_partitions: 1, changed_partitions: 0, added_partitions: 0, removed_partitions: 0,
  });
});

test("entity metadata deltas include derived project coverage and ontology inventory", () => {
  const sources = fixtureSources();
  sources.entity_intelligence.by_ref["agency:dep"].links.push({
    type: "decides_land_project", from: "meeting:m2", to: "project:p2",
  });
  const prior = snapshotFor(manifest, sources);
  for (const mutate of [
    (doc) => { doc.by_ref["agency:dep"].links[0].to = "project:p1"; },
    (doc) => { doc.by_ref["agency:dep"].root.kind = "organization"; },
    (doc) => { doc.by_ref["agency:dep"].links[0].type = "related_to"; },
    (doc) => { doc.by_ref["agency:dep"].domains.meetings = { objects: [{ link_type: "issued_by" }] }; },
  ]) {
    const changed = clone(sources);
    mutate(changed.entity_intelligence);
    const plan = planDelta({ prior, current: snapshotFor(manifest, changed) });
    const updates = plan.models.find((model) => model.model_id === "entity_intelligence").partitions[0].ops.update;
    assert.ok(updates.some((row) => row.table === "entity_intelligence_meta" && row.key === "current"));
  }
});

test("SQL builder publishes nonempty entities and their complete metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1rc-03-sql-"));
  try {
    const result = spawnSync(process.execPath, [join(ROOT, "tools/build_worker_d1_read_models.mjs"), "--output-dir", dir],
      { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.ok(receipt.entity_count > 0);
    const sql = readFileSync(receipt.entity_sql, "utf8");
    const entity = JSON.parse(readFileSync(join(ROOT, "worker/src/data/entity_intelligence_lookup.json"), "utf8"));
    const [ref, dossier] = Object.entries(entity.by_ref).find(([, value]) => value.root?.display_name);
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    assert.ok(sql.includes(`VALUES (${quote(ref)}, ${quote(dossier.root.kind)}, ${quote(dossier.root.display_name)},`));
    const summaryLiteral = sql.split("\n").find((line) => line.startsWith("INSERT INTO entity_intelligence_meta "))
      .match(/, '((?:[^']|'')*)'\);$/)[1];
    const summary = JSON.parse(summaryLiteral.replaceAll("''", "'"));
    const projects = new Set(Object.values(entity.by_ref).flatMap((value) => value.links || [])
      .filter((link) => link.type === "decides_land_project" && String(link.to || "").startsWith("project:"))
      .map((link) => link.to));
    assert.equal(summary.project_connection_coverage.meetings.linked, projects.size);
    assert.equal(summary.ontology_inventory.as_of, entity.generated_at);
    assert.ok(summary.ontology_inventory.entity_types.includes(dossier.root.kind));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
