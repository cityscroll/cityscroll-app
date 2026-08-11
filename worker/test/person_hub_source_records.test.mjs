// Person-hub constellation dual-write (Council Members / eLobbyist / CFB).
//
//   cd worker && node --test test/person_hub_source_records.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  dualWritePersonHubObservations,
  councilMemberSourceSystemId,
  elobbyistSourceSystemId,
  cfbContributionSourceSystemId,
  PERSON_HUB_SOURCE_RECORD_DUAL_WRITE_FLAG,
  NYC_COUNCIL_MEMBERS_SOURCE_SYSTEM,
  CITY_CLERK_ELOBBYIST_SOURCE_SYSTEM,
  CFB_CAMPAIGN_CONTRIBUTIONS_SOURCE_SYSTEM,
} from "../src/lib/person_hub_source_records.mjs";

const COUNCIL = {
  name: "Christopher Marte",
  council_member_id: "7801",
  term_start: "2026-01-01T00:00:00.000",
  term_end: "2029-12-31T00:00:00.000",
  district: "1",
  office_id: "5827",
};

const LOBBY = {
  client_name: "Consolidated Edison Company of New York, Inc.",
  lobbyist_name: "CMW Strategies LLC",
  lobbyist_targets: "NYC Council Members Julie Menin - District No. 5",
  report_year: "2026",
  registration_id: "649737",
};

const CFB = {
  name: "Ye, Ling",
  recipid: "2937",
  recipname: "Ye, Ling",
  amnt: "276.95",
  election: "2025",
  officecd: "5",
};

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = db.prepare(sql);
          const args = values;
          return {
            bind(...next) { return d1FromSqlite(db).prepare(sql).bind(...next); },
            async run() { statement.run(...args); return { success: true }; },
            async all() { return { results: statement.all(...args) }; },
            async first() { return statement.get(...args) ?? null; },
          };
        },
        async run() { db.prepare(sql).run(); return { success: true }; },
        async all() { return { results: db.prepare(sql).all() }; },
        async first() { return db.prepare(sql).get() ?? null; },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
}

function database({ observations = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (observations) {
    sqlite.exec(readFileSync(new URL("../migrations/0008_source_records.sql", import.meta.url), "utf8"));
  }
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

test("person-hub source keys preserve council, lobby, and CFB identity", () => {
  assert.equal(
    councilMemberSourceSystemId(COUNCIL),
    "council-member:7801:2026-01-01",
  );
  assert.match(elobbyistSourceSystemId(LOBBY), /^lobby-reg:649737:/);
  assert.match(cfbContributionSourceSystemId(CFB), /^cfb-contrib:2937:/);
  // Distinct target text must not collide under one registration.
  const other = {
    ...LOBBY,
    lobbyist_targets: "NYC Council Members Gale Brewer - District No. 6",
  };
  assert.notEqual(elobbyistSourceSystemId(LOBBY), elobbyistSourceSystemId(other));
});

test("flag off writes nothing", async () => {
  const { sqlite, DB } = database();
  const result = await dualWritePersonHubObservations(
    { DB },
    { councilMembers: [COUNCIL], elobbyist: [LOBBY], cfbContributions: [CFB] },
  );
  assert.equal(result.skipped, "flag-off");
  assert.equal(result.written, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 0);
});

test("dual-write retains three isolated streams when flag is on", async () => {
  const { sqlite, DB } = database();
  const env = { DB, [PERSON_HUB_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const result = await dualWritePersonHubObservations(env, {
    councilMembers: [COUNCIL],
    elobbyist: [LOBBY],
    cfbContributions: [CFB],
  }, "2026-08-11T20:00:00.000Z");
  assert.equal(result.written, 3);
  assert.equal(result.failed, false);
  const rows = sqlite.prepare(
    "SELECT source_system, source_system_id FROM source_records ORDER BY source_system",
  ).all();
  assert.equal(rows.length, 3);
  const systems = rows.map((r) => r.source_system).sort();
  assert.deepEqual(systems, [
    CFB_CAMPAIGN_CONTRIBUTIONS_SOURCE_SYSTEM,
    CITY_CLERK_ELOBBYIST_SOURCE_SYSTEM,
    NYC_COUNCIL_MEMBERS_SOURCE_SYSTEM,
  ].sort());
  // INSERT OR IGNORE is idempotent.
  const again = await dualWritePersonHubObservations(env, {
    councilMembers: [COUNCIL],
    elobbyist: [LOBBY],
    cfbContributions: [CFB],
  }, "2026-08-11T20:00:00.000Z");
  assert.equal(again.written, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 3);
});

test("empty bags skip without failing", async () => {
  const { DB } = database();
  const env = { DB, [PERSON_HUB_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const result = await dualWritePersonHubObservations(env, {});
  assert.equal(result.written, 0);
  assert.equal(result.skipped, "empty");
  assert.equal(result.failed, false);
});

test("wrangler production enables person-hub dual-write; beta stays off", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const [production, beta = ""] = wrangler.split("[env.beta.vars]");
  assert.match(production, /PERSON_HUB_SOURCE_RECORD_DUAL_WRITE\s*=\s*"true"/);
  assert.match(beta, /PERSON_HUB_SOURCE_RECORD_DUAL_WRITE\s*=\s*"false"/);
});
