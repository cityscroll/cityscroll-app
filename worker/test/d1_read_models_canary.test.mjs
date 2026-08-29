import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { resolveKeywordQuery } from "../../site/keyword_matcher.mjs";
import { searchKeywordFamilyFromD1 } from "../src/lib/search_read_model.mjs";
import { lookupOcpFromD1 } from "../src/lib/ocp_warehouse_lookup.mjs";
import {
  lookupEntityIntelligenceFromD1,
  resetEntityIntelligenceReadModelCache,
} from "../src/lib/entity_intelligence_read_model.mjs";
import { entityIntelligenceD1 } from "./helpers/entity_intelligence_d1.mjs";
import { readKeywordSearchIndexFromShards } from "../../site/keyword_search_index_shards.mjs";

const SCHEMA = readFileSync(new URL("../migrations/0025_search_and_ocp_read_models.sql", import.meta.url), "utf8");
const keyword = readKeywordSearchIndexFromShards(new URL(
  "../../worker/src/data/keyword_search_index_shards/manifest.json",
  import.meta.url,
));
const ocp = JSON.parse(readFileSync(new URL("../../site/data/ocp_awards_warehouse_lookup.json", import.meta.url), "utf8"));

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const people = keyword.families.people;
  const person = people.documents.find((row) => row.object_ref === "person:7801");
  sqlite.prepare("INSERT INTO keyword_search_families VALUES (?, ?, ?, ?, ?, ?)").run(
    "people", people.source, people.as_of, people.source_row_count, people.indexed_count,
    JSON.stringify(people.coverage),
  );
  const documentId = "people:canary";
  const text = [person.title, person.summary, person.search_text].filter(Boolean).join(" ");
  sqlite.prepare("INSERT INTO keyword_search_documents VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    documentId, "people", 0, person.object_ref, JSON.stringify(person.source_observation_refs), JSON.stringify(person), text,
  );
  sqlite.prepare("INSERT INTO keyword_search_fts VALUES (?, ?, ?)").run(documentId, "people", text);
  const row = ocp.rows.find((candidate) => candidate.request_id === "20260723031");
  sqlite.prepare("INSERT INTO ocp_awards_warehouse VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "canary", row.request_id, row.start_date, row.agency_name, row.type_of_notice_description,
    row.short_title, row.pin, row.contract_amount, row.vendor_name,
  );
  return {
    sqlite,
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let args = [];
        const wrapper = {
          bind(...values) { args = values; return wrapper; },
          async all() { return { results: statement.all(...args) }; },
          async first() { return statement.get(...args) || null; },
        };
        return wrapper;
      },
    },
  };
}

function boundedKeywordD1(rows) {
  const sqlite = new DatabaseSync(":memory:");
  const queries = [];
  sqlite.exec(SCHEMA);
  sqlite.prepare("INSERT INTO keyword_search_families VALUES (?, ?, ?, ?, ?, ?)").run(
    "awards", "fixture", "2026-08-23", rows.length, rows.length, "[]",
  );
  const documentInsert = sqlite.prepare("INSERT INTO keyword_search_documents VALUES (?, ?, ?, ?, ?, ?, ?)");
  const ftsInsert = sqlite.prepare("INSERT INTO keyword_search_fts VALUES (?, ?, ?)");
  rows.forEach((document, ordinal) => {
    const documentId = `awards:${ordinal}`;
    const searchText = [document.title, document.summary, document.search_text].filter(Boolean).join(" ");
    documentInsert.run(
      documentId, "awards", ordinal, document.object_ref,
      JSON.stringify(document.source_observation_refs || []), JSON.stringify(document), searchText,
    );
    ftsInsert.run(documentId, "awards", searchText);
  });
  return {
    sqlite,
    queries,
    DB: {
      prepare(sql) {
        queries.push(sql);
        const statement = sqlite.prepare(sql);
        let args = [];
        const wrapper = {
          bind(...values) { args = values; return wrapper; },
          async all() { return { results: statement.all(...args) }; },
          async first() { return statement.get(...args) || null; },
        };
        return wrapper;
      },
    },
  };
}

test("production-like D1 keyword canary preserves exact-token evidence", async () => {
  const { sqlite, DB } = d1();
  try {
    const result = await searchKeywordFamilyFromD1(DB, "people", resolveKeywordQuery("Christopher Marte"));
    assert.equal(result.family.indexed_count, 219);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].object_ref, "person:7801");
    assert.deepEqual(result.matches[0].match_evidence.token_offsets, [0, 2]);
    assert.ok(result.matches[0].match_evidence.character_offsets[1] > 0);
  } finally {
    sqlite.close();
  }
});

test("D1 family retrieval is ranked and hard-bounded before JSON materialization", async () => {
  const rows = [
    { object_ref: "award:best", title: "award award award", source_observation_refs: ["source:best"] },
    ...Array.from({ length: 104 }, (_, index) => ({
      object_ref: `award:${index}`,
      title: "award",
      source_observation_refs: [`source:${index}`],
    })),
  ];
  const { sqlite, queries, DB } = boundedKeywordD1(rows);
  try {
    const result = await searchKeywordFamilyFromD1(DB, "awards", resolveKeywordQuery("award"), { limit: 20_000 });
    const candidateQuery = queries.find((sql) => sql.includes("keyword_search_fts MATCH"));
    assert.match(candidateQuery, /bm25\(keyword_search_fts\)/);
    assert.match(candidateQuery, /ORDER BY bm25\(keyword_search_fts\) ASC/);
    assert.match(candidateQuery, /LIMIT \?/);
    assert.equal(result.matches.length, 100);
    assert.equal(result.matches[0].object_ref, "award:best");
    assert.equal(result.matches[0].match_evidence.matched_normalized_term, "award");
  } finally {
    sqlite.close();
  }
});

test("production-like D1 OCP canary resolves by request_id and pin", async () => {
  const { sqlite, DB } = d1();
  try {
    const byRequest = await lookupOcpFromD1(DB, { request_id: "20260723031" });
    assert.equal(byRequest.status, "ok");
    assert.equal(byRequest.join_key, "request_id");
    assert.equal(byRequest.rows[0].vendor_name, "Make it Zesty LLC");
    const byPin = await lookupOcpFromD1(DB, { pin: "81626W0043001" });
    assert.equal(byPin.status, "ok");
    assert.equal(byPin.join_key, "pin");
    assert.equal(byPin.rows[0].request_id, "20260723031");
  } finally {
    sqlite.close();
  }
});

test("production-like D1 entity-intelligence canary returns the Parks keyed dossier", async () => {
  resetEntityIntelligenceReadModelCache();
  const { sqlite, DB } = entityIntelligenceD1();
  try {
    const view = await lookupEntityIntelligenceFromD1(DB, {
      kind: "agency",
      id: "parks-and-recreation",
    });
    assert.equal(view.ok, true);
    assert.equal(view.serve, "materialization");
    assert.equal(view.root.ref, "agency:id:parks-and-recreation");
    assert.ok(view.metrics.domains_matched >= 3);
    assert.equal(view.domains.money.status, "matched");
    assert.equal(view.domains.people.status, "empty");
  } finally {
    sqlite.close();
    resetEntityIntelligenceReadModelCache();
  }
});
