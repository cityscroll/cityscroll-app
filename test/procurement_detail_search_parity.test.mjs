import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import { handleSearch, workerFederatedSearch } from "../worker/src/search.mjs";
import { loadManifest, modelEntry } from "../tools/d1_manifest.mjs";
import { statementsForModel } from "../tools/build_worker_d1_read_models.mjs";
import { readSourceDocument } from "../tools/build_worker_d1_read_models.mjs";

const PROCUREMENT_ID = "procurement:contract:CT107120258801626";
const IDENTIFIERS = ["CT107120258801626", "07124E0044001"];

function d1FromSqlite(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const statement = sqlite.prepare(sql);
          return {
            async all() { return { results: statement.all(...params) }; },
            async first() { return statement.get(...params) ?? null; },
          };
        },
      };
    },
  };
}

function committedReadModelDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../worker/migrations/0001_notices.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../worker/migrations/0016_notice_fts.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../worker/migrations/0025_search_and_ocp_read_models.sql", import.meta.url), "utf8"));
  const manifest = loadManifest();
  const entry = modelEntry(manifest, "keyword_search");
  const source = readSourceDocument(entry);
  sqlite.exec(statementsForModel(entry, source, { mode: "rebuild", allowRebuild: "d1-explicit-rebuild-v1" }).sql);
  return d1FromSqlite(sqlite);
}

async function servedSearch(query) {
  const env = { DB: committedReadModelDb() };
  const request = new Request(`https://api.cityscroll.test/search?q=${encodeURIComponent(query)}`);
  const response = await handleSearch(request, env, { federatedProvider: workerFederatedSearch(env) });
  assert.equal(response.status, 200, query);
  return response.json();
}

function matchingRecords(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) matchingRecords(item, output);
  } else if (value && typeof value === "object") {
    if (value.object_ref === PROCUREMENT_ID || value.procurement_id === PROCUREMENT_ID) {
      output.push(value);
    } else {
      for (const child of Object.values(value)) matchingRecords(child, output);
    }
  }
  return output;
}

function distinctMatchingObjectRefs(value) {
  return new Set(matchingRecords(value).map((record) => record.object_ref || record.procurement_id)).size;
}

test("served exact procurement identifier searches return one canonical result", async () => {
  for (const identifier of IDENTIFIERS) {
    const payload = await servedSearch(identifier);
    assert.equal(payload.results.length, 1, identifier);
    assert.equal(payload.federated.results.length, 1, identifier);
    assert.ok(payload.lanes.some((lane) => lane.cards.some((card) => card.object_ref === PROCUREMENT_ID)), identifier);
    assert.equal(distinctMatchingObjectRefs(payload), 1, identifier);
  }
});
