import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAdminPossiblySame } from "../src/admin.mjs";
import {
  FALSE_SPLIT_EVIDENCE_VERSION,
  dispositionInput,
} from "../src/lib/false_split_evidence.mjs";

const ASSERTION_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/assertion_evidence.json", import.meta.url),
  "utf8",
));

function d1(sqlite) {
  const adapter = {
    batchCalls: 0,
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
    async batch(statements) {
      adapter.batchCalls += 1;
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return adapter;
}

function fixtureEnv() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0008_source_records.sql",
    "0009_entity_link.sql",
    "0010_false_split_disposition.sql",
    "0010_action_log.sql",
    "0021_curation_verdicts.sql",
    "0022_curation_review_command.sql",
  ]) {
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
    JSON.stringify(ASSERTION_FIXTURE.left.raw_snapshot),
    JSON.stringify({ vendor_name: "Acme Construction LLC", pin: "85026P0001001", agency_name: "Design and Construction" }),
    now,
  );
  insert.run(
    "checkbook", "contract-44", "hash-b",
    JSON.stringify({ ...ASSERTION_FIXTURE.right.raw_snapshot, source_url: ASSERTION_FIXTURE.right.source_url }),
    JSON.stringify({ vendor_name: "Acme Builders Inc", pin: "85026P0002001", contract_id: "CT-44" }),
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
    assert.deepEqual(tray.measured, {
      candidates: 1,
      disposition_events: 0,
      ordering: {
        strategy: "active_information_gain_v1",
        baseline: "existing_shared_keys_then_observed_at_order",
        labels_per_hour: {},
        labels_per_session: {},
      },
    });
    assert.equal(tray.reviewVersion, FALSE_SPLIT_EVIDENCE_VERSION);
    assert.equal(tray.items[0].left.source_record_key, "20260730001");
    assert.match(tray.items[0].left.source_url, /RequestDetail\/20260730001$/);
    assert.equal(tray.items[0].right.source_url, "https://www.checkbooknyc.com/contract-44");
    assert.equal(tray.items[0].left.observed_fields.pin, "85026P0001001");
    assert.equal(tray.items[0].right.observed_fields.contract_id, "CT-44");
    assert.equal(tray.items[0].evidence.comparison_features.pin_epin_conflict, true);
    assert.deepEqual(
      tray.items[0].evidence.assertion_interpretation.conflicts.map((entry) => entry.fact),
      ["contract_amount", "start_date"],
    );
    const [amountConflict] = tray.items[0].evidence.assertion_interpretation.conflicts;
    assert.equal(amountConflict.assertions[0].classification, "source_assertion");
    assert.equal(amountConflict.assertions[1].classification, "source_assertion");
    assert.equal(amountConflict.interpretation.classification, "cityscroll_interpretation");
    assert.equal(amountConflict.interpretation.resolution, "unresolved");

    const htmlResponse = await handleAdminPossiblySame(
      new Request("https://w/admin/possibly-same?key=secret"),
      env,
    );
    const html = await htmlResponse.text();
    assert.match(html, /Assertion vs interpretation/);
    assert.match(html, /Source assertion/);
    assert.match(html, /CityScroll interpretation/);
    assert.match(html, /Conflict · unresolved/);
    assert.match(html, /name="command_id" value="[^"]+"/);
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
        {
          command_id: `review-command-${index + 1}`,
          pair_id: pairId,
          actor: "desk-actor:fixture-1",
          review_session: "fixture-session-1",
          decision,
          note: `review ${index + 1}`,
        },
      ), env);
      assert.equal(response.status, 201);
    }

    const tray = await (await handleAdminPossiblySame(
      jsonRequest("https://w/admin/possibly-same?key=secret"), env,
    )).json();
    const eventHour = tray.items[0].dispositions[0].created_at.slice(0, 13);
    assert.deepEqual(tray.measured, {
      candidates: 1,
      disposition_events: 3,
      ordering: {
        strategy: "active_information_gain_v1",
        baseline: "existing_shared_keys_then_observed_at_order",
        labels_per_hour: { [eventHour]: 3 },
        labels_per_session: { "fixture-session-1": 3 },
      },
    });
    assert.deepEqual(tray.items[0].dispositions.map((event) => event.decision), ["same", "different", "defer"]);
    for (const event of tray.items[0].dispositions) {
      assert.equal(event.actor, "desk-actor:fixture-1");
      assert.equal(event.evidence_version, FALSE_SPLIT_EVIDENCE_VERSION);
      const evidence = JSON.parse(event.evidence_json);
      assert.equal(evidence.pair_id, pairId);
      assert.equal(evidence.left.source_record_id, "city_record:20260730001:hash-a");
      assert.equal(evidence.right.source_record_id, "checkbook:contract-44:hash-b");
    }

    const verdictRows = sqlite.prepare(
      `SELECT id, decision, target_json, evidence_refs_json, effect_json, reverses_receipt_id
         FROM curation_verdict_receipt
        ORDER BY created_at ASC, rowid ASC`,
    ).all();
    assert.deepEqual(verdictRows.map((row) => row.decision), ["ACCEPT", "REJECT", "REVIEW"]);
    assert.deepEqual(verdictRows.map((row) => row.reverses_receipt_id), [
      null,
      "review-command-1",
      "review-command-2",
    ]);
    const assertionIds = verdictRows.map((row) => JSON.parse(row.target_json).assertion_id);
    assert.equal(new Set(assertionIds).size, 1);
    assert.match(assertionIds[0], /^assertion:vendor_identity:/);
    assert.deepEqual(
      JSON.parse(verdictRows[0].evidence_refs_json).map((ref) => ref.id),
      ["city_record:20260730001:hash-a", "checkbook:contract-44:hash-b"],
    );
    assert.equal(JSON.parse(verdictRows[0].effect_json).operation, "export_gold_candidate");
    assert.equal(JSON.parse(verdictRows[2].effect_json).operation, "retain_provisional");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM curation_review_command").get().n, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM entity_link").get().n, 0);
    assert.equal(env.DB.batchCalls, 3, "each review click has one authoritative batch");

    // Product action log mirrors decisions without actors or free-text notes.
    const actionRows = sqlite.prepare(
      "SELECT id, action_type, object_type, object_id, method, method_version, metadata_json FROM action_log ORDER BY ts ASC, rowid ASC",
    ).all();
    assert.equal(actionRows.length, 3);
    assert.deepEqual(actionRows.map((row) => JSON.parse(row.metadata_json).decision), [
      "same",
      "different",
      "unresolved",
    ]);
    for (const row of actionRows) {
      assert.equal(row.action_type, "review_decision");
      assert.equal(row.object_type, "entity_pair");
      assert.equal(row.object_id, pairId);
      assert.equal(row.method, "false_split_desk");
      assert.equal(row.method_version, "v1");
      assert.equal(JSON.stringify(row).includes("desk-actor"), false);
      assert.equal(JSON.stringify(row).includes("review "), false);
    }
    assert.deepEqual(
      actionRows.map((row) => row.id),
      tray.items[0].dispositions.map((event) => event.id),
    );

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

test("curation command rolls back partial failure and retries idempotently", async () => {
  const { sqlite, env } = fixtureEnv();
  try {
    const tray = await (await handleAdminPossiblySame(
      jsonRequest("https://w/admin/possibly-same?key=secret"), env,
    )).json();
    const pairId = tray.items[0].id;
    const input = {
      command_id: "review-command-partial-retry",
      pair_id: pairId,
      actor: "desk-actor:fixture-1",
      review_session: "fixture-session-retry",
      decision: "same",
      note: "atomic retry fixture",
    };

    sqlite.exec(`CREATE TRIGGER fail_curation_receipt
      BEFORE INSERT ON curation_verdict_receipt
      BEGIN
        SELECT RAISE(ABORT, 'simulated curation receipt failure');
      END`);
    const failed = await handleAdminPossiblySame(jsonRequest(
      "https://w/admin/possibly-same?key=secret", "POST", input,
    ), env);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "curation-command-write-failed" });
    for (const table of [
      "curation_review_command",
      "false_split_disposition_event",
      "curation_verdict_receipt",
      "action_log",
    ]) {
      assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }

    sqlite.exec("DROP TRIGGER fail_curation_receipt");
    sqlite.exec(`CREATE TRIGGER fail_action_projection
      BEFORE INSERT ON action_log
      BEGIN
        SELECT RAISE(ABORT, 'simulated derivative projection failure');
      END`);
    const committed = await handleAdminPossiblySame(jsonRequest(
      "https://w/admin/possibly-same?key=secret", "POST", input,
    ), env);
    assert.equal(committed.status, 201);
    const first = await committed.json();
    assert.equal(first.command.id, input.command_id);
    assert.equal(first.command.replayed, false);
    assert.equal(first.verdict.decision, "ACCEPT");
    assert.match(first.verdict.target.assertion_id, /^assertion:vendor_identity:/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM action_log").get().n, 0);

    sqlite.exec("DROP TRIGGER fail_action_projection");
    const retried = await handleAdminPossiblySame(jsonRequest(
      "https://w/admin/possibly-same?key=secret", "POST", input,
    ), env);
    assert.equal(retried.status, 200);
    const replay = await retried.json();
    assert.equal(replay.command.replayed, true);
    assert.deepEqual(replay.event, first.event);
    assert.deepEqual(replay.verdict, first.verdict);

    for (const table of [
      "curation_review_command",
      "false_split_disposition_event",
      "curation_verdict_receipt",
      "action_log",
    ]) {
      assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
    }
    assert.equal(env.DB.batchCalls, 2, "failed attempt plus successful retry; replay does not re-commit");

    const conflict = await handleAdminPossiblySame(jsonRequest(
      "https://w/admin/possibly-same?key=secret", "POST", { ...input, decision: "different" },
    ), env);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "idempotency-key-conflict" });
    assert.equal(
      sqlite.prepare("SELECT decision FROM false_split_disposition_event").get().decision,
      "same",
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
    const tray = await (await handleAdminPossiblySame(
      jsonRequest("https://w/admin/possibly-same?key=secret"), env,
    )).json();
    const missingCommand = await handleAdminPossiblySame(jsonRequest(
      "https://w/admin/possibly-same?key=secret",
      "POST",
      { pair_id: tray.items[0].id, actor: "desk", decision: "same" },
    ), env);
    assert.equal(missingCommand.status, 400);
    assert.deepEqual(await missingCommand.json(), { error: "command-id-required" });
  } finally {
    sqlite.close();
  }
});
