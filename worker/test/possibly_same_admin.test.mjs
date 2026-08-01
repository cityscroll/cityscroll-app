import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAdminPossiblySame, renderPossiblySamePage } from "../src/admin.mjs";
import { toReviewItem, toReviewItems } from "../../entity_resolution/review/index.mjs";
import { readPossiblySamePairs, reviewPairsFromDualWriteRows } from "../src/lib/possibly_same.mjs";

const req = (url, headers = {}) => new Request(url, { headers });

test("possibly-same shaping is non-assertive and preserves provenance", () => {
  const item = toReviewItem(
    { id: "pair-1", left: { id: "a1", vendor_name: "Acme LLC", source: "city_record" }, right: { id: "b2", vendor_name: "Acme Services Inc", source: "checkbook" } },
    { confidence: 0.72, method: "token_v0", evidence: { shared_token: "ACME" } },
  );
  assert.equal(item.decision, "review");
  assert.equal(item.label, "Possibly same vendor");
  assert.equal(item.review_status, "pending");
  assert.equal(item.left.source, "city_record");
  assert.equal(item.right.source, "checkbook");
  assert.deepEqual(item.evidence, { shared_token: "ACME" });
});

function liveDb(rows) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      queries.push(sql);
      return {
        bind() { return this; },
        async all() { return { results: rows }; },
      };
    },
  };
}

const liveRows = [
  {
    source_system: "city_record",
    source_system_id: "notice-1",
    content_hash: "hash-1",
    raw_snapshot: "{}",
    normalized_snapshot: JSON.stringify({ vendor_name: "Acme Construction LLC" }),
    ingested_at: "2026-07-30T12:00:00.000Z",
    canonical_entity_id: "vendor:acme-construction",
  },
  {
    source_system: "city_record",
    source_system_id: "notice-2",
    content_hash: "hash-2",
    raw_snapshot: "{}",
    normalized_snapshot: JSON.stringify({ vendor_name: "Acme Builders Inc" }),
    ingested_at: "2026-07-29T12:00:00.000Z",
    canonical_entity_id: "vendor:acme-builders",
  },
];

test("live dual-write rows produce unresolved token-block candidates", () => {
  const pairs = reviewPairsFromDualWriteRows(liveRows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].method, "token_v0");
  assert.deepEqual(pairs[0].evidence.shared_keys, ["tok:ACME"]);
  assert.equal(pairs[0].left.source_record_id, "city_record:notice-1:hash-1");
});

test("records already linked to the same canonical entity are not review leads", () => {
  const linkedRows = liveRows.map((row) => ({ ...row, canonical_entity_id: "vendor:acme" }));
  assert.deepEqual(reviewPairsFromDualWriteRows(linkedRows), []);
});

test("content revisions of one native record are not compared with each other", () => {
  const revisions = [
    liveRows[0],
    { ...liveRows[0], content_hash: "hash-older", ingested_at: "2026-07-28T12:00:00.000Z" },
  ];
  assert.deepEqual(reviewPairsFromDualWriteRows(revisions), []);
});

test("live reader runs against the migrated SQLite schema", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0008_source_records.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0009_entity_link.sql", import.meta.url), "utf8"));
  const insert = sqlite.prepare(
    `INSERT INTO source_records
       (source_system, source_system_id, content_hash, raw_snapshot, normalized_snapshot, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  insert.run("city_record", "a", "ha", "{}", JSON.stringify({ vendor_name: "Acme Construction LLC" }), now);
  insert.run("city_record", "b", "hb", "{}", JSON.stringify({ vendor_name: "Acme Builders Inc" }), now);
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return { async all() { return { results: statement.all(...args) }; } };
        },
      };
    },
  };

  try {
    assert.equal((await readPossiblySamePairs(DB)).length, 1);
  } finally {
    sqlite.close();
  }
});

test("admin route fails closed and renders live pairs without writing", async () => {
  const DB = liveDb(liveRows);
  const env = { ADMIN_KEY: "secret", DB };

  assert.equal((await handleAdminPossiblySame(req("https://w/admin/possibly-same"), env)).status, 401);
  const response = await handleAdminPossiblySame(req("https://w/admin/possibly-same?key=secret"), env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Possibly same vendors/);
  assert.match(html, /Acme Construction LLC/);
  assert.match(html, /shared token: ACME/i);
  assert.match(html, /not a finding/);
  assert.doesNotMatch(html, /merge/i);
  assert.equal(DB.queries.length, 2);
  assert.match(DB.queries[0], /^\s*SELECT/i);
  assert.doesNotMatch(DB.queries[0], /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.match(DB.queries[1], /^\s*SELECT/i);
});

test("admin route supports a read-only JSON representation", async () => {
  const env = { ADMIN_KEY: "secret", DB: liveDb(liveRows) };
  const response = await handleAdminPossiblySame(req("https://w/admin/possibly-same?key=secret", { accept: "application/json" }), env);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.items[0].decision, "review");
  assert.equal(body.source, "live_dual_write");
});

test("empty dual-write is a successful empty desk", async () => {
  const response = await handleAdminPossiblySame(
    req("https://w/admin/possibly-same?key=secret", { accept: "application/json" }),
    { ADMIN_KEY: "secret", DB: liveDb([]) },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 0);
});

test("hand-configured pair JSON is not a substitute for live observations", async () => {
  const response = await handleAdminPossiblySame(
    req("https://w/admin/possibly-same?key=secret", { accept: "application/json" }),
    {
      ADMIN_KEY: "secret",
      DB: liveDb([]),
      ER_REVIEW_PAIRS: JSON.stringify([{ left: { name: "One" }, right: { name: "Two" } }]),
    },
  );
  assert.equal((await response.json()).count, 0);
});

test("empty desk view is explicit", () => {
  assert.match(renderPossiblySamePage([]), /No candidate pairs are currently surfaced from recent dual-write observations/);
});
