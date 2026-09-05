import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUILD_MODES, statementsForModel } from "../tools/build_worker_d1_read_models.mjs";
import { planDelta, snapshotFor } from "../tools/d1_delta_plan.mjs";
import { loadManifest, modelEntry, manifestFingerprint, validateManifest } from "../tools/d1_manifest.mjs";
import { AmbiguousKeyError, TABLE_COLUMNS, naturalKeyParts, tableRows } from "../tools/d1_stable_keys.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = [
  "worker/migrations/0025_search_and_ocp_read_models.sql",
  "worker/migrations/0026_entity_intelligence_read_model.sql",
];
const manifest = loadManifest();
const clone = (value) => structuredClone(value);

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}

function fixtureSources() {
  return {
    keyword_search: {
      families: {
        alpha: {
          source: "alpha-src", as_of: "2026-09-01T00:00:00Z", source_row_count: 2, indexed_count: 2, coverage: [],
          documents: [
            { title: "Alpha one", summary: "first", object_ref: "notice:a1", source_observation_refs: ["obs:1"] },
            { title: "Alpha two", search_text: "second" },
          ],
        },
        beta: {
          source: "beta-src", as_of: "2026-09-01T00:00:00Z", source_row_count: 1, indexed_count: 1, coverage: [],
          documents: [{ title: "Beta one", object_ref: "notice:b1" }],
        },
      },
    },
    ocp_awards: {
      materialized_at: "2026-09-01T00:00:00Z",
      rows: [
        { request_id: "r1", pin: "p1", start_date: "2026-01-01", agency_name: "DOT", vendor_name: "Vendor A", contract_amount: 10 },
        { request_id: "r2", pin: "p2", start_date: "2026-01-02", agency_name: "DEP", vendor_name: "Vendor B", contract_amount: 20 },
        { request_id: "r3", pin: "", start_date: "2026-01-03", agency_name: "DEP", vendor_name: "Vendor C", contract_amount: 30 },
      ],
    },
    entity_intelligence: {
      schema_version: 1, generated_at: "2026-09-01T00:00:00Z", observation_count: 3, entity_count: 2, multi_domain_count: 1,
      by_ref: {
        "vendor:a": { root: { kind: "vendor", display_name: "Vendor A" }, links: [{ type: "decides_land_project", from: "meeting:m1", to: "project:p1" }], domains: {} },
        "agency:dep": { root: { kind: "agency", display_name: "DEP" }, links: [], domains: {} },
      },
      by_subject_ref: {
        "notice:a1": [{ entity_ref: "vendor:a", relation: "awarded_to", confidence: "high" }],
      },
    },
  };
}

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) db.exec(readFileSync(join(ROOT, migration), "utf8"));
  return db;
}

function applyAll(db, sources, options) {
  for (const entry of manifest.models) db.exec(statementsForModel(entry, sources[entry.model_id], options).sql);
}

/** Every row of every published table, ordered by key, so two states can be compared exactly. */
function dump(db) {
  const state = {};
  for (const entry of manifest.models) {
    for (const table of entry.tables) {
      const order = table.key_columns.join(", ");
      state[table.name] = db.prepare(`SELECT ${TABLE_COLUMNS[table.name].join(", ")} FROM ${table.name} ORDER BY ${order}`).all();
    }
  }
  return state;
}

function ftsHits(db, term) {
  return db.prepare("SELECT document_id FROM keyword_search_fts WHERE keyword_search_fts MATCH ? ORDER BY document_id").all(term).map((row) => row.document_id);
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  return value;
}

test("the manifest names an identity for every table and the validator enforces it", () => {
  for (const entry of manifest.models) {
    assert.equal(entry.deletes, "delete", `${entry.model_id} declares its delete behaviour`);
    for (const table of entry.tables) {
      assert.ok(table.identity, `${entry.model_id}.${table.name} declares an identity`);
      assert.ok(["natural", "companion"].includes(table.identity.strategy));
      if (table.identity.strategy === "companion") {
        const target = entry.tables.find((candidate) => candidate.name === table.identity.of);
        assert.deepEqual(table.key_columns, target.key_columns);
      }
    }
  }
  const bad = clone(manifest);
  delete bad.models[0].tables[0].identity;
  assert.throws(() => validateManifest(bad), /tables\[0\]\.identity must be an object/);
  const badStrategy = clone(manifest);
  badStrategy.models[0].tables[0].identity = { strategy: "row_order" };
  assert.throws(() => validateManifest(badStrategy), /identity\.strategy must be one of/);
  const badCompanion = clone(manifest);
  const fts = badCompanion.models.find((model) => model.model_id === "keyword_search").tables.find((table) => table.name === "keyword_search_fts");
  fts.identity = { strategy: "companion", of: "keyword_search_families" };
  assert.throws(() => validateManifest(badCompanion), /must match the key columns of keyword_search_families/);
  const badDuplicates = clone(manifest);
  badDuplicates.models[0].tables[0].identity.duplicates = "collapse_identical";
  assert.throws(() => validateManifest(badDuplicates), /identity\.duplicates must be one of reject/);
  const badDeletes = clone(manifest);
  badDeletes.models[0].deletes = "ignore";
  assert.throws(() => validateManifest(badDeletes), /deletes must be one of/);
  const withoutIdentity = clone(manifest);
  withoutIdentity.models[0].tables[0].identity = { strategy: "natural", source_fields: ["family_id"] };
  assert.notEqual(manifestFingerprint(withoutIdentity), manifestFingerprint(manifest), "identity is part of the publication contract");
});

test("keys come from source identity, never from position", () => {
  const sources = fixtureSources();
  const keyword = tableRows(modelEntry(manifest, "keyword_search"), sources.keyword_search).rows;
  const documentKeys = keyword.filter((row) => row.table === "keyword_search_documents").map((row) => row.key);
  assert.ok(documentKeys.includes("alpha:notice:a1"));
  assert.ok(documentKeys.some((key) => key.startsWith("alpha:h:")), "a document without object_ref gets a content-hash identity");
  assert.ok(!documentKeys.some((key) => /:\d+$/.test(key)), "no ordinal-derived ids remain");
  const fts = keyword.filter((row) => row.table === "keyword_search_fts").map((row) => row.key);
  assert.deepEqual(fts, documentKeys, "the FTS companion shares the document identity");

  const shuffled = clone(sources.keyword_search);
  shuffled.families.alpha.documents.reverse();
  const shuffledKeys = tableRows(modelEntry(manifest, "keyword_search"), shuffled).rows
    .filter((row) => row.table === "keyword_search_documents").map((row) => row.key);
  assert.deepEqual(shuffledKeys, documentKeys, "reordering source documents does not change identities");

  const ocp = tableRows(modelEntry(manifest, "ocp_awards"), sources.ocp_awards).rows.map((row) => row.key);
  assert.deepEqual(ocp.filter((key) => !key.startsWith("h:")), ["r1|p1|2026-01-01", "r2|p2|2026-01-02"]);
  assert.equal(ocp.filter((key) => key.startsWith("h:")).length, 1, "a row missing a key field falls back to its content hash");
  const identity = modelEntry(manifest, "ocp_awards").tables[0].identity;
  assert.equal(naturalKeyParts(identity, sources.ocp_awards.rows[0]).source, "natural");
  assert.equal(naturalKeyParts(identity, sources.ocp_awards.rows[2]).source, "content_hash");
});

test("ambiguous duplicates are rejected before SQL exists and identical duplicates collapse", () => {
  const sources = fixtureSources();
  sources.ocp_awards.rows.push(clone(sources.ocp_awards.rows[0]));
  const collapsed = tableRows(modelEntry(manifest, "ocp_awards"), sources.ocp_awards);
  assert.equal(collapsed.collapsed, 1);
  assert.equal(collapsed.rows.length, 3);

  const ambiguous = fixtureSources();
  ambiguous.ocp_awards.rows.push({ ...ambiguous.ocp_awards.rows[0], vendor_name: "Vendor Z" });
  assert.throws(() => tableRows(modelEntry(manifest, "ocp_awards"), ambiguous.ocp_awards), (error) => (
    error instanceof AmbiguousKeyError && error.table === "ocp_awards_warehouse" && error.key === "r1|p1|2026-01-01"));
  assert.throws(() => statementsForModel(modelEntry(manifest, "ocp_awards"), ambiguous.ocp_awards, { mode: "upsert" }), AmbiguousKeyError);
  assert.throws(() => statementsForModel(modelEntry(manifest, "ocp_awards"), ambiguous.ocp_awards, { mode: "rebuild" }), AmbiguousKeyError);
});

test("the rebuild path is still the explicit full reset and both modes publish the same rows", { skip: !DatabaseSync && "node:sqlite unavailable" }, () => {
  assert.deepEqual([...BUILD_MODES], ["rebuild", "upsert"]);
  const sources = fixtureSources();
  const rebuild = statementsForModel(modelEntry(manifest, "ocp_awards"), sources.ocp_awards, { mode: "rebuild" }).sql;
  assert.ok(rebuild.startsWith("DELETE FROM ocp_awards_warehouse;"));
  assert.ok(!rebuild.includes("ON CONFLICT"));
  const keyword = statementsForModel(modelEntry(manifest, "keyword_search"), sources.keyword_search, { mode: "rebuild" }).sql.split("\n");
  assert.deepEqual(keyword.slice(0, 3), ["DELETE FROM keyword_search_fts;", "DELETE FROM keyword_search_documents;", "DELETE FROM keyword_search_families;"]);

  const viaRebuild = openDatabase();
  applyAll(viaRebuild, sources, { mode: "rebuild" });
  const viaUpsert = openDatabase();
  applyAll(viaUpsert, sources, { mode: "upsert" });
  assert.deepEqual(dump(viaUpsert), dump(viaRebuild));
});

test("applying the same upsert twice leaves rows, indexes, and FTS rows unchanged", { skip: !DatabaseSync && "node:sqlite unavailable" }, () => {
  const sources = fixtureSources();
  const db = openDatabase();
  applyAll(db, sources, { mode: "upsert" });
  const once = dump(db);
  const hitsOnce = ftsHits(db, "alpha");
  applyAll(db, sources, { mode: "upsert" });
  assert.deepEqual(dump(db), once);
  assert.deepEqual(ftsHits(db, "alpha"), hitsOnce);
  assert.equal(db.prepare("SELECT count(*) AS n FROM keyword_search_fts").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM ocp_awards_warehouse").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM entity_intelligence_entities").get().n, 2);
});

test("a changed source record updates one logical row instead of appending a duplicate", { skip: !DatabaseSync && "node:sqlite unavailable" }, () => {
  const sources = fixtureSources();
  const db = openDatabase();
  applyAll(db, sources, { mode: "upsert" });
  const changed = clone(sources);
  changed.ocp_awards.rows[1].contract_amount = 25;
  changed.keyword_search.families.alpha.documents[0].title = "Alpha one revised";
  changed.entity_intelligence.by_ref["agency:dep"].root.display_name = "Dept of Environmental Protection";
  applyAll(db, changed, { mode: "upsert" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM ocp_awards_warehouse").get().n, 3);
  assert.equal(db.prepare("SELECT contract_amount FROM ocp_awards_warehouse WHERE row_key = ?").get("r2|p2|2026-01-02").contract_amount, "25");
  assert.equal(db.prepare("SELECT count(*) AS n FROM keyword_search_documents").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM keyword_search_fts WHERE document_id = ?").get("alpha:notice:a1").n, 1);
  assert.deepEqual(ftsHits(db, "revised"), ["alpha:notice:a1"]);
  assert.equal(db.prepare("SELECT display_name FROM entity_intelligence_entities WHERE entity_ref = ?").get("agency:dep").display_name, "Dept of Environmental Protection");
});

test("a removed source record is deleted through the delta plan, companions included", { skip: !DatabaseSync && "node:sqlite unavailable" }, () => {
  const sources = fixtureSources();
  const db = openDatabase();
  applyAll(db, sources, { mode: "upsert" });
  const prior = snapshotFor(manifest, sources);
  const trimmed = clone(sources);
  trimmed.ocp_awards.materialized_at = "2026-09-02T00:00:00Z";
  trimmed.ocp_awards.rows.pop();
  trimmed.keyword_search.families.alpha.as_of = "2026-09-02T00:00:00Z";
  trimmed.keyword_search.families.alpha.documents.pop();
  const plan = planDelta({ prior, current: snapshotFor(manifest, trimmed) });
  for (const entry of manifest.models) {
    const deletes = plan.models.find((model) => model.model_id === entry.model_id).partitions;
    const { sql } = statementsForModel(entry, trimmed[entry.model_id], { mode: "upsert", deletes });
    if (entry.model_id === "keyword_search") {
      assert.match(sql, /^DELETE FROM keyword_search_fts WHERE rowid = \(SELECT rowid FROM keyword_search_documents WHERE document_id = 'alpha:h:[0-9a-f]+'\);$/m);
      assert.match(sql, /^DELETE FROM keyword_search_documents WHERE document_id = 'alpha:h:[0-9a-f]+';$/m);
    }
    db.exec(sql);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM ocp_awards_warehouse").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM keyword_search_documents").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM keyword_search_fts").get().n, 2);
  assert.deepEqual(ftsHits(db, "second"), []);
  const replay = planDelta({ prior: snapshotFor(manifest, trimmed), current: snapshotFor(manifest, trimmed) });
  assert.ok(replay.models.every((model) => model.totals.total_ops === 0), "the second receipt reports zero semantic changes");
});

test("published rows do not depend on source key order", () => {
  const sources = fixtureSources();
  const straight = statementsForModel(modelEntry(manifest, "entity_intelligence"), sources.entity_intelligence, { mode: "upsert" }).sql;
  const reordered = statementsForModel(modelEntry(manifest, "entity_intelligence"), reverseKeys(clone(sources.entity_intelligence)), { mode: "upsert" }).sql;
  assert.equal(reordered, straight);
});


test("graph duplicates collapse only when their published payloads agree", () => {
  const source = fixtureSources().entity_intelligence;
  const entry = modelEntry(manifest, "entity_intelligence");
  source.by_ref["agency:dep"].links = [clone(source.by_ref["vendor:a"].links[0])];
  assert.equal(tableRows(entry, source).collapsed, 1);
  for (const field of ["confidence", "provenance"]) {
    const changed = clone(source);
    changed.by_ref["agency:dep"].links[0][field] = field === "confidence" ? "derived" : { observed_at: "2026-09-02" };
    for (const mode of BUILD_MODES) {
      assert.throws(() => statementsForModel(entry, changed, { mode }), (error) => (
        error instanceof AmbiguousKeyError && error.table === "entity_intelligence_graph_links"));
    }
  }
});

test("FTS replacement uses indexed document lookups and preserves rowids across churn", { skip: !DatabaseSync && "node:sqlite unavailable" }, () => {
  const entry = modelEntry(manifest, "keyword_search");
  const sources = fixtureSources();
  const db = openDatabase();
  db.exec(statementsForModel(entry, sources.keyword_search).sql);
  const changed = clone(sources);
  changed.keyword_search.families.alpha.documents.shift();
  changed.keyword_search.families.beta.documents.push({ object_ref: "notice:b2", title: "Replacement" });
  const plan = planDelta({ prior: snapshotFor(manifest, sources), current: snapshotFor(manifest, changed) });
  const deletes = plan.models.find((model) => model.model_id === "keyword_search").partitions;
  const sql = statementsForModel(entry, changed.keyword_search, { mode: "upsert", deletes }).sql;
  for (const statement of sql.split("\n").filter((line) => line.startsWith("DELETE FROM keyword_search_fts WHERE"))) {
    const details = db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all().map((row) => row.detail);
    assert.ok(details.some((detail) => /SEARCH keyword_search_documents USING COVERING INDEX/.test(detail)), details.join("\n"));
    assert.ok(details.some((detail) => /keyword_search_fts VIRTUAL TABLE INDEX .*:=/.test(detail)), details.join("\n"));
  }
  db.exec(sql);
  const rowids = () => db.prepare("SELECT rowid, document_id FROM keyword_search_fts ORDER BY rowid").all();
  const once = rowids();
  assert.deepEqual(once, db.prepare("SELECT rowid, document_id FROM keyword_search_documents ORDER BY rowid").all());
  db.exec(sql);
  assert.deepEqual(rowids(), once);
  assert.deepEqual(ftsHits(db, "first"), []);
  assert.deepEqual(ftsHits(db, "replacement"), ["beta:notice:b2"]);
  db.close();
});
