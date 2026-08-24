import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { resolveKeywordQuery } from "../../site/keyword_matcher.mjs";
import { searchKeywordFamilyFromD1 } from "../src/lib/search_read_model.mjs";
import { lookupOcpFromD1 } from "../src/lib/ocp_warehouse_lookup.mjs";

const SCHEMA = readFileSync(new URL("../migrations/0025_search_and_ocp_read_models.sql", import.meta.url), "utf8");
const keyword = JSON.parse(readFileSync(new URL("../src/data/keyword_search_index.json", import.meta.url), "utf8"));
const ocp = JSON.parse(readFileSync(new URL("../src/data/ocp_awards_warehouse_lookup.json", import.meta.url), "utf8"));

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

test("production-like D1 keyword canary preserves exact-token evidence", async () => {
  const { sqlite, DB } = d1();
  try {
    const result = await searchKeywordFamilyFromD1(DB, "people", resolveKeywordQuery("Christopher Marte"));
    assert.equal(result.family.indexed_count, 215);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].object_ref, "person:7801");
    assert.deepEqual(result.matches[0].match_evidence.token_offsets, [0, 2]);
    assert.ok(result.matches[0].match_evidence.character_offsets[1] > 0);
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
