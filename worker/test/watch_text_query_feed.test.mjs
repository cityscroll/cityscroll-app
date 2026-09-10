import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handleFeed } from "../src/feed.mjs";
import { atomFeed, feedItems, icsFeed, jsonFeed, parseFeedQuery } from "../src/lib/feed.mjs";
import { evaluateMoneyTextQueryWatch, TEXT_QUERY_EVAL_STATUS } from "../src/lib/watch_text_query_procurement.mjs";
import { prepareWatchFilter } from "../src/lib/filter.mjs";
import { calendarFeedUrlForScope, standingFeedUrlsFromWatch, subscriptionParamsFromWatch } from "../../site/scope_v0.mjs";
import { digestDecision } from "../src/lib/digest.mjs";

const CLOCK = "2026-09-09";
const titleSnapshot = JSON.parse(readFileSync(
  new URL("../../test/fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url),
  "utf8",
));
const titledRows = titleSnapshot.rows.filter((row) => row.short_title);
const awardRows = titledRows.filter((row) => row.type_of_notice_description === "Award");

const term = (value) => ({ kind: "term", value });
const expr = (all, none = []) => ({ version: 1, all, none });
const E3 = expr([[term("software"), term("consulting")]], [term("maintenance")]);
const E3_IDS = ["20260709018", "20260713010", "20260713024", "20260713036"];

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            all() { return { results: statement.all(...params) }; },
            first() { return statement.get(...params) || null; },
          };
        },
      };
    },
  };
}

function makeNoticeDb(rows) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      request_id TEXT PRIMARY KEY,
      section TEXT,
      agency TEXT,
      type_of_notice TEXT,
      category TEXT,
      short_title TEXT,
      description TEXT,
      vendor_name TEXT,
      pin TEXT,
      contract_amount REAL,
      contract_amount_valid INTEGER,
      start_date TEXT,
      due_date TEXT,
      haystack TEXT
    );
    CREATE TABLE IF NOT EXISTS ingest_state (k TEXT PRIMARY KEY, v TEXT);
  `);
  const insert = sqlite.prepare(`
    INSERT INTO notices (
      request_id, agency, type_of_notice, category, short_title, description,
      vendor_name, pin, contract_amount, contract_amount_valid, start_date, haystack
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  sqlite.exec("BEGIN");
  for (const row of rows) {
    const title = row.short_title || "";
    const description = row.additional_description_1 || row.description || "";
    insert.run(
      row.request_id,
      row.agency_name || row.agency || null,
      row.type_of_notice_description || row.type_of_notice || null,
      row.category_description || row.category || null,
      title,
      description,
      row.vendor_name || null,
      row.pin || null,
      row.contract_amount == null ? null : Number(row.contract_amount),
      1,
      String(row.start_date || "").slice(0, 10),
      `${title} ${description}`.toLowerCase(),
    );
  }
  sqlite.exec("COMMIT");
  return { sqlite, DB: d1(sqlite) };
}

function e3Watch() {
  const prepared = prepareWatchFilter("money", {
    keywords: [],
    noticeType: "award",
    text_query: E3,
  });
  assert.equal(prepared.ok, true);
  return { lens: prepared.lens, filter: prepared.filter };
}

function atomIds(xml) {
  return [...xml.matchAll(/href="https:\/\/cityscroll.org\/notices\/([^"]+)"/g)].map((match) => match[1]).sort();
}

function jsonIds(body) {
  return JSON.parse(body).items.map((item) => item.id).sort();
}

async function withNoPublisher(fn) {
  const original = globalThis.fetch;
  const soda = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("data.cityofnewyork.us") || target.includes("resource/")) {
      soda.push(target);
      throw new Error(`publisher fetch is not allowed on resident feed reads: ${target}`);
    }
    return { ok: true, json: async () => [] };
  };
  try {
    return await fn(soda);
  } finally {
    globalThis.fetch = original;
  }
}

test("A2: Atom and JSON Feed contain exactly the E3 identities and escaped titles on the frozen projection", async () => {
  const { DB } = makeNoticeDb(awardRows);
  const watch = e3Watch();
  const evaluation = await evaluateMoneyTextQueryWatch({
    db: DB, sub: watch, todayISO: CLOCK, clock: CLOCK, snapshot: { rows: [] },
  });
  assert.equal(evaluation.status, TEXT_QUERY_EVAL_STATUS.complete);
  assert.deepEqual(
    evaluation.rows.map((row) => row.request_id).sort(),
    E3_IDS,
  );

  const items = feedItems("award", evaluation.rows);
  assert.deepEqual(items.map((item) => item.id).sort(), E3_IDS);
  for (const item of items) {
    assert.match(item.url, /^https:\/\/cityscroll.org\/notices\/20/);
    assert.ok(item.summary, "match evidence rides the feed summary");
  }

  const xml = atomFeed({
    title: "CityScroll — precise watch",
    selfUrl: "https://api.cityscroll.org/feed.xml?lens=money",
    siteUrl: "https://cityscroll.org/",
    updated: "2026-09-09T13:00:00Z",
    items,
  });
  assert.deepEqual(atomIds(xml), E3_IDS);
  assert.equal((xml.match(/<entry>/g) || []).length, 4);
  assert.ok(!/<b>/.test(xml));

  const json = jsonFeed({
    title: "CityScroll — precise watch",
    selfUrl: "https://api.cityscroll.org/feed.json?lens=money",
    siteUrl: "https://cityscroll.org/",
    items,
  });
  assert.deepEqual(jsonIds(json), E3_IDS);
  for (const item of JSON.parse(json).items) {
    assert.match(item.url, /\/notices\/20/);
  }

  const feeds = standingFeedUrlsFromWatch(watch);
  await withNoPublisher(async (soda) => {
    const atomRes = await handleFeed(new Request(feeds.atom), { DB }, {});
    const jsonRes = await handleFeed(new Request(feeds.json), { DB }, {});
    assert.equal(atomRes.status, 200);
    assert.equal(jsonRes.status, 200);
    assert.deepEqual(atomIds(await atomRes.text()), E3_IDS);
    assert.deepEqual(jsonIds(await jsonRes.text()), E3_IDS);
    assert.deepEqual(soda, []);
  });
});

test("A2: titles with markup and ampersands are escaped; item URLs stay stable", () => {
  const items = feedItems("award", [{
    request_id: "20260713010",
    start_date: "2026-07-13T00:00:00",
    agency_name: "Parks & Recreation",
    short_title: 'Software "upgrade" <b>kit</b> & tools',
    text_query_evidence: {
      match: true,
      groups: [{ field: "title", hit: "Software", passage: "Software \"upgrade\" kit" }],
      exclusion: null,
    },
  }]);
  const xml = atomFeed({
    title: 'CityScroll — rules & notices — about "software"',
    selfUrl: "https://api.cityscroll.org/feed.xml?lens=money&filter=%7B%7D",
    siteUrl: "https://cityscroll.org/",
    updated: "2026-09-09T13:00:00Z",
    items,
  });
  assert.match(xml, /Software &quot;upgrade&quot; kit &amp; tools/);
  assert.match(xml, /href="https:\/\/cityscroll.org\/notices\/20260713010"/);
  assert.ok(!/<b>/.test(xml));
  assert.equal(items[0].url, "https://cityscroll.org/notices/20260713010");
});

test("A2: legacy q feed URLs still parse as keyword watches", () => {
  const parsed = parseFeedQuery(new URLSearchParams("lens=money&q=software%20consulting&agency=Parks&min=100000"));
  assert.equal(parsed.modern, undefined);
  assert.deepEqual(parsed.filter.keywords, ["software", "consulting"]);
  assert.equal(parsed.filter.agency, "Parks");
  assert.equal(parsed.filter.minAmount, 100000);
  assert.equal("text_query" in parsed.filter, false);
});

test("A3: malformed, unsupported, and calendar-incompatible expressions are refused", async () => {
  const watch = e3Watch();
  const params = subscriptionParamsFromWatch(watch);
  const ics = new URL("https://api.cityscroll.org/feed.ics");
  ics.search = params.toString();
  const icsRes = await handleFeed(new Request(ics), {}, {});
  assert.equal(icsRes.status, 400);
  assert.match(await icsRes.text(), /cannot be replayed: text_query/);
  assert.equal(calendarFeedUrlForScope(watch), null);

  const badJson = await handleFeed(new Request("https://api.cityscroll.org/feed.xml?lens=money&filter=%7B"), {}, {});
  assert.equal(badJson.status, 400);
  assert.match(await badJson.text(), /invalid modern feed filter/);

  const version = new URL("https://api.cityscroll.org/feed.xml");
  version.searchParams.set("lens", "money");
  version.searchParams.set("filter", JSON.stringify({ keywords: [], text_query: { version: 2, all: [[term("software")]] } }));
  const versionRes = await handleFeed(new Request(version), {}, {});
  assert.equal(versionRes.status, 400);
  assert.match(await versionRes.text(), /cannot be admitted/);

  const meetings = new URL("https://api.cityscroll.org/feed.xml");
  meetings.searchParams.set("lens", "meetings");
  meetings.searchParams.set("filter", JSON.stringify({ keywords: [], text_query: E3 }));
  const meetingsRes = await handleFeed(new Request(meetings), {}, {});
  assert.equal(meetingsRes.status, 400);
});

test("A5: a previously delivered match may remain in the feed without being re-emailed", async () => {
  const { DB } = makeNoticeDb(awardRows);
  const watch = e3Watch();
  const evaluation = await evaluateMoneyTextQueryWatch({
    db: DB, sub: watch, todayISO: CLOCK, clock: CLOCK, snapshot: { rows: [] },
  });
  const matching = evaluation.rows.map((row) => row.request_id).sort();
  assert.deepEqual(matching, E3_IDS);
  const delivered = matching[0];
  const unseen = matching.filter((id) => id !== delivered);
  const items = feedItems("award", evaluation.rows);
  assert.ok(items.some((item) => item.id === delivered), "canonical membership still includes the delivered row");
  assert.deepEqual(unseen, ["20260713010", "20260713024", "20260713036"]);

  assert.equal(digestDecision({
    freshCount: unseen.length, freq: "daily", lastSentDate: CLOCK, today: CLOCK,
  }).action, "match");
  assert.equal(digestDecision({
    freshCount: 0, freq: "daily", lastSentDate: CLOCK, today: CLOCK,
  }).action, "none");
  assert.equal(digestDecision({
    freshCount: unseen.length, freq: "daily", lastSentDate: CLOCK, today: CLOCK,
  }).action, "match");
  const paused = { ...watch, paused: true };
  assert.equal(paused.paused, true, "pause is a delivery rule, not a membership rule");
  assert.ok(items.some((item) => item.id === delivered));

  const ics = icsFeed({ title: "t", items });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 0, "award rows without civic event dates are not calendar events");
});

test("A5: calendar-event eligibility stays separate from feed membership", () => {
  const meeting = feedItems("meetings", [{
    meeting_id: "meeting:example",
    title: "Public hearing",
    event_date: "2026-09-15T18:00:00-04:00",
    start_date: "2026-09-01",
    board_name: "Manhattan Community Board 2",
  }]);
  const ics = icsFeed({ title: "meetings", items: meeting });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  const awards = feedItems("award", [{
    request_id: "20260713010",
    short_title: "Software award",
    start_date: "2026-07-13",
  }]);
  assert.equal(awards.length, 1);
  assert.equal((icsFeed({ title: "awards", items: awards }).match(/BEGIN:VEVENT/g) || []).length, 0);
});
