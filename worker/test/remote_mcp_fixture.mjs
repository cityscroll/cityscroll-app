import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { executeCitedPassages } from "../../capabilities/cited_passages.mjs";
import { executeNoticeGet } from "../../capabilities/notice_get.mjs";
import { executeEntityDossier } from "../../capabilities/entity_dossier.mjs";
import { executeEntityRelationships } from "../../capabilities/entity_relationships.mjs";
import { executeNoticeSearch } from "../../capabilities/notice_search.mjs";
import { executeFederatedSearch } from "../../capabilities/federated_search.mjs";
import { workerCitedPassages } from "../src/cited_retrieval.mjs";
import { workerD1EntityDossier } from "../src/entity_dossier.mjs";
import { workerD1NoticeSearch } from "../src/lib/notices.mjs";
import { mcpCitedPassagesInput, mcpNoticeGetInput, mcpNoticeSearchInput } from "../src/mcp.mjs";
import { workerNoticeGet } from "../src/notice.mjs";
import { workerD1EntityRelationships } from "../src/public_relationship_graph.mjs";
import { workerFederatedSearch } from "../src/search.mjs";

export const CAPABILITY_TOOL_CASES = Object.freeze([
  Object.freeze({
    capabilityReference: "search.federated@1",
    name: "search_federated",
    arguments: Object.freeze({ query: "acme construction", limit: 10 }),
  }),
  Object.freeze({
    capabilityReference: "notice.search@1",
    name: "search_notices",
    arguments: Object.freeze({
      query: "acme construction",
      agency: "Department of Design and Construction",
      limit: 10,
    }),
  }),
  Object.freeze({
    capabilityReference: "notice.get@1",
    name: "get_notice",
    arguments: Object.freeze({ request_id: "20260730002" }),
  }),
  Object.freeze({
    capabilityReference: "entity.dossier.get@1",
    name: "get_entity_dossier",
    arguments: Object.freeze({ entity_id: "vendor:stem:ACME CONSTRUCTION" }),
  }),
  Object.freeze({
    capabilityReference: "entity.relationships.get@1",
    name: "get_entity_relationships",
    arguments: Object.freeze({
      entity_id: "vendor:stem:ACME CONSTRUCTION",
      depth: 2,
      fan_out: 12,
    }),
  }),
  Object.freeze({
    capabilityReference: "cited.passages.retrieve@1",
    name: "retrieve_cited_passages",
    arguments: Object.freeze({
      query: "energy conservation",
      source_family: "city_record_notice",
      limit: 5,
    }),
  }),
]);

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
}

const FIXTURE = JSON.parse(readFileSync(
  new URL("../../test/fixtures/capability_semantic_scout.json", import.meta.url),
  "utf8",
));
const NOTICE_SCHEMA = readFileSync(new URL("../migrations/0001_notices.sql", import.meta.url), "utf8");
const NOTICE_FACTS_SCHEMA = readFileSync(new URL("../migrations/0010_notice_facts.sql", import.meta.url), "utf8");
const NOTICE_FTS_SCHEMA = readFileSync(new URL("../migrations/0016_notice_fts.sql", import.meta.url), "utf8");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function semanticHash(value) {
  const stable = structuredClone(value);
  if (stable?.retrieval) delete stable.retrieval.duration_ms;
  return createHash("sha256").update(JSON.stringify(canonicalize(stable))).digest("hex");
}

function entityRows(rows) {
  return rows.map((row) => ({
    ...row,
    raw_snapshot: JSON.stringify(row.raw_snapshot || {}),
  }));
}

export function createRemoteMcpFixtureEnv() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(NOTICE_SCHEMA);
  sqlite.exec(NOTICE_FACTS_SCHEMA);
  const insert = sqlite.prepare(`INSERT INTO notices
    (request_id, section, agency, type_of_notice, category, short_title, vendor_name,
     description, contract_amount, contract_amount_valid, start_date, due_date, haystack,
     document_urls, n_documents, structured_facts, raw, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, '{}', ?, ?)`);
  for (const row of FIXTURE.cases.notice_search.source_rows) {
    insert.run(
      row.request_id,
      row.section,
      row.agency,
      row.type_of_notice,
      row.category,
      row.short_title,
      row.vendor_name,
      row.description,
      row.contract_amount,
      row.contract_amount_valid,
      row.start_date,
      row.due_date,
      row.haystack,
      JSON.stringify(row.raw || {}),
      row.ingested_at,
    );
  }
  sqlite.exec(NOTICE_FTS_SCHEMA);

  const dossierRows = entityRows(FIXTURE.cases.entity_dossier.source_rows);
  const relationshipRows = entityRows(FIXTURE.cases.entity_relationships.source_rows);
  const reads = [];
  const DB = {
    prepare(sql) {
      if (/FROM canonical_entity/.test(sql)) {
        const rows = /link_confidence_score/.test(sql) ? dossierRows : relationshipRows;
        return {
          bind() {
            return {
              async all() {
                reads.push({
                  capability_reference: /link_confidence_score/.test(sql)
                    ? "entity.dossier.get@1"
                    : "entity.relationships.get@1",
                  rows_read: rows.length,
                });
                return { results: structuredClone(rows), meta: { rows_read: rows.length } };
              },
            };
          },
        };
      }
      if (/FROM notice_attachments/.test(sql)) {
        return {
          bind() { return this; },
          async all() { return { results: [], meta: { rows_read: 0 } }; },
        };
      }
      const prepared = sqlite.prepare(sql);
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async all() {
          const results = prepared.all(...args);
          reads.push({ capability_reference: "notice.search@1", rows_read: results.length });
          return { results, meta: { rows_read: results.length } };
        },
        async first() {
          const result = prepared.get(...args) ?? null;
          reads.push({ capability_reference: "notice.get@1", rows_read: result ? 1 : 0 });
          return result;
        },
      };
      return statement;
    },
  };

  return {
    env: { DB, SUBS: new MockKV(), NL_METER: new MockKV() },
    reads,
    close() { sqlite.close(); },
  };
}

export async function directCapabilityResults(env) {
  const results = new Map();
  const argsFor = (name) => CAPABILITY_TOOL_CASES.find((toolCase) => toolCase.name === name).arguments;
  const federatedArgs = argsFor("search_federated");
  results.set("search_federated", await executeFederatedSearch(
    workerFederatedSearch(env),
    { query: federatedArgs.query, limit: federatedArgs.limit },
  ));
  const noticeSearchArgs = argsFor("search_notices");
  results.set("search_notices", await executeNoticeSearch(
    workerD1NoticeSearch(env.DB),
    mcpNoticeSearchInput(noticeSearchArgs),
  ));
  const noticeGetArgs = argsFor("get_notice");
  results.set("get_notice", await executeNoticeGet(
    workerNoticeGet(env, { nowMs: Date.parse("2026-08-04T00:00:00.000Z") }),
    mcpNoticeGetInput(noticeGetArgs),
  ));
  const dossierArgs = argsFor("get_entity_dossier");
  results.set("get_entity_dossier", await executeEntityDossier(
    workerD1EntityDossier(env.DB),
    { entityId: dossierArgs.entity_id },
  ));
  const relationshipsArgs = argsFor("get_entity_relationships");
  results.set("get_entity_relationships", await executeEntityRelationships(
    workerD1EntityRelationships(env.DB),
    {
      entityId: relationshipsArgs.entity_id,
      depth: relationshipsArgs.depth,
      fanOut: relationshipsArgs.fan_out,
    },
  ));
  const citedArgs = argsFor("retrieve_cited_passages");
  results.set("retrieve_cited_passages", await executeCitedPassages(
    workerCitedPassages(),
    mcpCitedPassagesInput(citedArgs),
  ));
  return results;
}
