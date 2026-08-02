// Legistar meeting Events / EventItems / Votes / Attachments immutable
// observation dual-write (source coverage gap-close for the four Legistar streams).
//
//   cd worker && node --test test/legistar_source_records.test.mjs
//   node --test test/legistar_source_records.test.mjs   (from repo root via path)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { buildMeetingOutcomesView } from "../src/lib/meeting_outcomes.mjs";
import {
  dualWriteLegistarObservations,
  legistarEventSourceSystemId,
  legistarEventItemSourceSystemId,
  legistarVoteSourceSystemId,
  legistarAttachmentSourceSystemId,
  LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG,
  LEGISTAR_EVENTS_SOURCE_SYSTEM,
  LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM,
  LEGISTAR_VOTES_SOURCE_SYSTEM,
  LEGISTAR_ATTACHMENTS_SOURCE_SYSTEM,
} from "../src/lib/legistar_source_records.mjs";

const EVENT = {
  EventId: 22526,
  EventBodyName: "Subcommittee on Land Use",
  EventDate: "2026-07-28T00:00:00",
  EventAgendaFile: "https://nyc.legistar1.com/nyc/agenda.pdf",
  EventMinutesFile: "https://nyc.legistar1.com/nyc/minutes.pdf",
  EventInSiteURL: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22526",
};

const ITEM = {
  EventItemId: 440244,
  EventItemEventId: 22526,
  EventItemTitle: "Transit Improvement Funding",
  EventItemActionName: "Approved by Subcommittee",
  EventItemPassedFlagName: "Pass",
  EventItemRollCallFlag: 1,
  EventItemMatterId: 79193,
  EventItemMatterFile: "LU 0001-2026",
  EventItemMatterName: "Transit Improvement Funding",
  EventItemMatterStatus: "Adopted",
};

const VOTES = [
  { PersonId: 101, PersonName: "Ada Councilmember", VoteValue: "Aye" },
  { PersonId: 102, PersonName: "Ben Councilmember", VoteValue: "Aye" },
  { PersonId: 103, PersonName: "Cara Councilmember", VoteValue: "Nay" },
];

// Live Granicus field names (used for stable source-key identity).
const LIVE_VOTE_ROW = {
  VoteId: 1031408,
  VoteEventItemId: 440494,
  VotePersonId: 7801,
  VotePersonName: "Christopher Marte",
  VoteValueName: "Affirmative",
  VoteResult: 1,
};

const ATTACHMENTS = [
  {
    MatterAttachmentId: 9001,
    MatterAttachmentName: "Staff report",
    MatterAttachmentHyperlink: "https://example.com/staff.pdf",
    MatterAttachmentIsSupportingDocument: true,
  },
];

const NOTICE = {
  request_id: "20260728001",
  section_name: "Public Hearings and Meetings",
  type_of_notice_description: "Public Hearing",
  agency_name: "City Council",
  short_title: "7-28-26 Subcommittee on Land Use — Queens items",
  event_date: "2026-07-28T16:00:00.000",
  start_date: "2026-07-10",
  additional_description_1: "Borough of Queens public hearing.",
  street_address_1: "120 Broad Street",
  city: "New York",
  state: "NY",
  zip_code: "10271",
};

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      // Each bind() must return an independent statement handle so multi-row
      // batch dual-writes do not clobber one another (matches D1 semantics).
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

function mockMeetingFetch() {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname.includes("/resource/dg92-zbpx.json")) {
      return new Response(JSON.stringify([NOTICE]), { status: 200 });
    }
    if (u.pathname === "/v1/nyc/Events") {
      return new Response(JSON.stringify([EVENT]), { status: 200 });
    }
    if (u.pathname === "/v1/nyc/Events/22526/EventItems") {
      return new Response(JSON.stringify([ITEM]), { status: 200 });
    }
    if (u.pathname === "/v1/nyc/EventItems/440244/Votes") {
      return new Response(JSON.stringify(VOTES), { status: 200 });
    }
    if (u.pathname === "/v1/nyc/EventItems/440244/Attachments") {
      return new Response(JSON.stringify(ATTACHMENTS), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
}

test("Legistar source keys preserve event, item, person-vote, and attachment identity", () => {
  assert.equal(legistarEventSourceSystemId(EVENT), "event:22526");
  assert.equal(legistarEventItemSourceSystemId(ITEM), "event-item:440244");
  assert.equal(
    legistarVoteSourceSystemId({ ...VOTES[0], EventItemId: 440244 }),
    "vote:440244:101",
  );
  // Live Granicus field names must mint the same stable key family.
  assert.equal(
    legistarVoteSourceSystemId(LIVE_VOTE_ROW),
    "vote:440494:7801",
  );
  assert.equal(
    legistarAttachmentSourceSystemId({ ...ATTACHMENTS[0], EventItemId: 440244 }),
    "attachment:440244:9001",
  );
  assert.notEqual(
    legistarVoteSourceSystemId({ ...VOTES[0], EventItemId: 440244 }),
    legistarVoteSourceSystemId({ ...VOTES[1], EventItemId: 440244 }),
  );
});

test("Legistar observation capture is production-on / beta-off", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const [production, beta = ""] = wrangler.split("[env.beta.vars]");
  assert.match(production, /LEGISTAR_SOURCE_RECORD_DUAL_WRITE\s*=\s*"true"/);
  assert.match(beta, /LEGISTAR_SOURCE_RECORD_DUAL_WRITE\s*=\s*"false"/);
});

test("flag off leaves meeting view intact without observations", async () => {
  const { sqlite, DB } = database();
  const view = await buildMeetingOutcomesView({
    token: "test-token",
    fetchImpl: mockMeetingFetch(),
    now: new Date("2026-08-01T12:00:00.000Z"),
    env: { DB },
  });
  assert.equal(view.counts.matched_notices, 1);
  assert.ok(view.counts.votes >= 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 0);
  sqlite.close();
});

test("flag on writes immutable event/item/vote/attachment rows and replay does not duplicate", async () => {
  const { sqlite, DB } = database();
  const env = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const fetchImpl = mockMeetingFetch();
  const now = new Date("2026-08-01T12:00:00.000Z");

  const first = await buildMeetingOutcomesView({ token: "test-token", fetchImpl, now, env });
  assert.equal(first.counts.matched_notices, 1);
  assert.equal(first.records[0].join.matched, true);
  // Refresh path dual-write telemetry: written > 0 for the three populated streams.
  assert.ok(first.dual_write?.written > 0, `dual_write.written=${first.dual_write?.written}`);
  assert.equal(first.dual_write?.failed, false);

  const rows = sqlite.prepare(
    "SELECT source_system, source_system_id, content_hash FROM source_records ORDER BY source_system, source_system_id",
  ).all();
  const bySystem = (system) => rows.filter((r) => r.source_system === system);

  assert.equal(bySystem(LEGISTAR_EVENTS_SOURCE_SYSTEM).length, 1);
  assert.equal(bySystem(LEGISTAR_EVENTS_SOURCE_SYSTEM)[0].source_system_id, "event:22526");
  assert.equal(bySystem(LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM).length, 1);
  assert.equal(bySystem(LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM)[0].source_system_id, "event-item:440244");
  assert.equal(bySystem(LEGISTAR_VOTES_SOURCE_SYSTEM).length, 3);
  assert.ok(bySystem(LEGISTAR_VOTES_SOURCE_SYSTEM).every((r) => r.source_system_id.startsWith("vote:440244:")));
  assert.equal(bySystem(LEGISTAR_ATTACHMENTS_SOURCE_SYSTEM).length, 1);
  assert.equal(
    bySystem(LEGISTAR_ATTACHMENTS_SOURCE_SYSTEM)[0].source_system_id,
    "attachment:440244:9001",
  );
  // Named metric: non-zero source_records for events/items/votes exits empty-declared-live.
  for (const system of [
    LEGISTAR_EVENTS_SOURCE_SYSTEM,
    LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM,
    LEGISTAR_VOTES_SOURCE_SYSTEM,
  ]) {
    assert.ok(bySystem(system).length > 0, system);
  }

  const voteSnap = sqlite.prepare(
    `SELECT raw_snapshot FROM source_records
      WHERE source_system = ? ORDER BY source_system_id LIMIT 1`,
  ).get(LEGISTAR_VOTES_SOURCE_SYSTEM);
  const vote = JSON.parse(voteSnap.raw_snapshot);
  assert.equal(vote.EventItemId, 440244);
  assert.ok(vote.PersonId);

  // Public view still carries person retention on the assembled vote summary.
  const matter = first.records[0].agenda_items[0].matters[0];
  assert.ok(matter.votes[0].by_person.length >= 1);

  const second = await buildMeetingOutcomesView({ token: "test-token", fetchImpl, now, env });
  assert.equal(second.counts.matched_notices, 1);
  const replay = sqlite.prepare(
    "SELECT source_system, source_system_id, content_hash FROM source_records ORDER BY source_system, source_system_id",
  ).all();
  assert.deepEqual(replay, rows);
  sqlite.close();
});

test("observation failure remains fail-soft for meeting-outcomes consumers", async () => {
  const { sqlite, DB } = database({ observations: false });
  const env = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const view = await buildMeetingOutcomesView({
    token: "test-token",
    fetchImpl: mockMeetingFetch(),
    now: new Date("2026-08-01T12:00:00.000Z"),
    env,
  });
  assert.equal(view.counts.matched_notices, 1);
  assert.equal(view.records[0].join.matched, true);
  // No source_records table — dual-write must not throw.
  sqlite.close();
});

test("direct dual-write helper skips when bags are empty", async () => {
  const { sqlite, DB } = database();
  const env = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const result = await dualWriteLegistarObservations(env, {}, new Date().toISOString());
  assert.equal(result.written, 0);
  assert.equal(result.skipped, "empty");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 0);
  sqlite.close();
});

test("dual-write with non-empty bags always writes >0 rows when flag and schema are ready", async () => {
  const { sqlite, DB } = database();
  const env = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const result = await dualWriteLegistarObservations(
    env,
    {
      events: [EVENT],
      eventItems: [ITEM],
      votes: VOTES.map((v) => ({ ...v, EventItemId: ITEM.EventItemId })),
      attachments: ATTACHMENTS.map((a) => ({ ...a, EventItemId: ITEM.EventItemId })),
    },
    "2026-08-01T12:00:00.000Z",
  );
  assert.ok(result.written > 0, `expected written>0, got ${result.written}`);
  assert.equal(result.failed, false);
  assert.equal(result.skipped, null);
  const bySystem = Object.fromEntries(
    sqlite.prepare(
      "SELECT source_system, COUNT(*) AS n FROM source_records GROUP BY source_system",
    ).all().map((r) => [r.source_system, r.n]),
  );
  assert.equal(bySystem[LEGISTAR_EVENTS_SOURCE_SYSTEM], 1);
  assert.equal(bySystem[LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM], 1);
  assert.equal(bySystem[LEGISTAR_VOTES_SOURCE_SYSTEM], 3);
  assert.equal(bySystem[LEGISTAR_ATTACHMENTS_SOURCE_SYSTEM], 1);
  sqlite.close();
});

test("dual-write chunks large event bags without dropping rows", async () => {
  const { sqlite, DB } = database();
  const env = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  // Larger than LEGISTAR_SOURCE_RECORD_BATCH (40) so chunking is exercised.
  const events = Array.from({ length: 95 }, (_, i) => ({
    EventId: 30000 + i,
    EventBodyName: `Body ${i}`,
    EventDate: "2026-07-01T00:00:00",
  }));
  const result = await dualWriteLegistarObservations(
    env,
    { events },
    "2026-08-01T12:00:00.000Z",
  );
  assert.equal(result.written, 95);
  assert.equal(result.failed, false);
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS n FROM source_records WHERE source_system = ?",
    ).get(LEGISTAR_EVENTS_SOURCE_SYSTEM).n,
    95,
  );
  sqlite.close();
});

test("stream isolation keeps successful streams when one bag fails", async () => {
  const { sqlite } = database();
  let batchCalls = 0;
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          const args = values;
          return {
            async run() {
              statement.run(...args);
              return { success: true };
            },
          };
        },
      };
    },
    async batch(statements) {
      batchCalls += 1;
      // Fail only the second stream batch (event items) so events still land.
      if (batchCalls === 2) throw new Error("simulated-batch-fail");
      for (const statement of statements) await statement.run();
      return [];
    },
  };
  const env = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const result = await dualWriteLegistarObservations(
    env,
    {
      events: [EVENT],
      eventItems: [ITEM],
      votes: [],
      attachments: [],
    },
    "2026-08-01T12:00:00.000Z",
  );
  assert.equal(result.failed, true);
  assert.ok(result.written >= 1, "events stream should still write");
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS n FROM source_records WHERE source_system = ?",
    ).get(LEGISTAR_EVENTS_SOURCE_SYSTEM).n,
    1,
  );
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS n FROM source_records WHERE source_system = ?",
    ).get(LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM).n,
    0,
  );
  sqlite.close();
});
