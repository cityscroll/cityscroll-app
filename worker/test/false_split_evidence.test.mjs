import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAdminPossiblySame } from "../src/admin.mjs";
import {
  FALSE_SPLIT_EVIDENCE_VERSION,
  dispositionInput,
} from "../src/lib/false_split_evidence.mjs";

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async all() { return { results: statement.all(...args) }; },
            async run() { return statement.run(...args); },
          };
        },
      };
    },
  };
}

function fixtureEnv() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of ["0008_source_records.sql", "0009_entity_link.sql", "0010_false_split_disposition.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const insert = sqlite.prepare(
    `INSERT INTO source_records
       (source_system, source_system_id, content_hash, raw_snapshot, normalized_snapshot, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  insert.run(
    "city_record", "20260730001", "hash-a",
    JSON.stringify({ request_id: "20260730001" }),
    JSON.stringify({ vendor_name: "Acme Construction LLC", pin: "PIN-44", agency_name: "Design and Construction" }),
    now,
  );
  insert.run(
    "checkbook", "contract-44", "hash-b",
    JSON.stringify({ source_url: "https://www.checkbooknyc.com/contract-44" }),
    JSON.stringify({ vendor_name: "Acme Builders Inc", pin: "PIN-45", contract_id: "CT-44" }),
    now,
  );
  return { sqlite, env: { ADMIN_KEY: "secret", DB: d1(sqlite) } };
}

const jsonRequest = (url, method = "GET", body) => new Request(url, {
  method,
  headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test("fixture tray measures candidates and exposes both source-linked records", async () => {
  const { sqlite, env } = fixtureEnv();
  try {
    const response = await handleAdminPossiblySame(jsonRequest("https://w/admin/possibly-same?key=secret"), env);
    assert.equal(response.status, 200);
    const tray = await response.json();
    assert.deepEqual(tray.measured, { candidates: 1, disposition_events: 0 });
    assert.equal(tray.reviewVersion, FALSE_SPLIT_EVIDENCE_VERSION);
    assert.equal(tray.items[0].left.source_record_key, "20260730001");
    assert.match(tray.items[0].left.source_url, /RequestDetail\/20260730001$/);
    assert.equal(tray.items[0].right.source_url, "https://www.checkbooknyc.com/contract-44");
    assert.equal(tray.items[0].left.observed_fields.pin, "PIN-44");
    assert.equal(tray.items[0].right.observed_fields.contract_id, "CT-44");
    assert.equal(tray.items[0].evidence.comparison_features.pin_epin_conflict, true);
  } finally {
    sqlite.close();
  }
});

test("same, different, and defer dispositions append immutable evidence events", async () => {
  const { sqlite, env } = fixtureEnv();
  try {
    const firstTray = await (await handleAdminPossiblySame(
      jsonRequest("https://w/admin/possibly-same?key=secret"), env,
    )).json();
    const pairId = firstTray.items[0].id;
    for (const [index, decision] of ["same", "different", "defer"].entries()) {
      const response = await handleAdminPossiblySame(jsonRequest(
        "https://w/admin/possibly-same?key=secret",
        "POST",
        { pair_id: pairId, actor: "desk-actor:fixture-1", decision, note: `review ${index + 1}` },
      ), env);
      assert.equal(response.status, 201);
    }

    const tray = await (await handleAdminPossiblySame(
      jsonRequest("https://w/admin/possibly-same?key=secret"), env,
    )).json();
    assert.deepEqual(tray.measured, { candidates: 1, disposition_events: 3 });
    assert.deepEqual(tray.items[0].dispositions.map((event) => event.decision), ["same", "different", "defer"]);
    for (const event of tray.items[0].dispositions) {
      assert.equal(event.actor, "desk-actor:fixture-1");
      assert.equal(event.evidence_version, FALSE_SPLIT_EVIDENCE_VERSION);
      const evidence = JSON.parse(event.evidence_json);
      assert.equal(evidence.pair_id, pairId);
      assert.equal(evidence.left.source_record_id, "city_record:20260730001:hash-a");
      assert.equal(evidence.right.source_record_id, "checkbook:contract-44:hash-b");
    }

    const eventId = tray.items[0].dispositions[0].id;
    assert.throws(
      () => sqlite.prepare("UPDATE false_split_disposition_event SET note = 'changed' WHERE id = ?").run(eventId),
      /append-only/,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM false_split_disposition_event WHERE id = ?").run(eventId),
      /append-only/,
    );
  } finally {
    sqlite.close();
  }
});

test("the evidence tray fails closed and rejects incomplete dispositions", async () => {
  const { sqlite, env } = fixtureEnv();
  try {
    assert.equal((await handleAdminPossiblySame(jsonRequest("https://w/admin/possibly-same"), env)).status, 401);
    assert.deepEqual(dispositionInput({ pair_id: "pair", actor: "desk", decision: "merge" }), { error: "invalid-decision" });
    assert.deepEqual(dispositionInput({ pair_id: "pair", decision: "same" }), { error: "actor-required" });
  } finally {
    sqlite.close();
  }
});
