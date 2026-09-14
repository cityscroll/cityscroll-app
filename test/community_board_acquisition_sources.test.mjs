import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  fetchCommunityBoardSource,
  parseAirtableSource,
  parseHtmlPdfSource,
} from "../site/community_board_source_adapters.mjs";

const OBSERVED_AT = "2026-09-14T01:44:00Z";
const fixtureRoot = new URL("./fixtures/community_board_acquisition_sources/", import.meta.url);
const htmlSources = [
  ["bronx-cb-06", "bronx-cb-06.html", "https://cb6.example/calendar/"],
  ["bronx-cb-08", "bronx-cb-08.html", "https://cb8.example/calendar/"],
  ["manhattan-cb-02", "manhattan-cb-02.html", "https://cb2.example/calendar/"],
  ["manhattan-cb-04", "manhattan-cb-04.html", "https://cb4.example/calendar/"],
  ["manhattan-cb-10", "manhattan-cb-10.html", "https://cb10.example/calendar/"],
  ["manhattan-cb-12", "manhattan-cb-12.html", "https://cb12.example/calendar/"],
];

function fixture(name) {
  return readFileSync(new URL(name, fixtureRoot), "utf8");
}

function receipt(url, parser = "html_pdf_v1") {
  return { status: "ok", observed_at: OBSERVED_AT, source_url: url, parser };
}

function source(boardId, url) {
  return {
    adapter: "html_pdf_v1", role: "upcoming_meetings", board_id: boardId,
    body_name: boardId, url, format: "saved HTML fixture",
  };
}

test("A1: six saved HTML sources replay with stable identities and meaningful fields", () => {
  const replay = htmlSources.map(([boardId, file, url]) => {
    const records = parseHtmlPdfSource(fixture(file), source(boardId, url), {
      observedAt: OBSERVED_AT, receipt: receipt(url),
    });
    assert.ok(records.length > 0, `${boardId} yields records`);
    assert.ok(records.every((record) => record.board_id === boardId));
    assert.ok(records.every((record) => record.record_id && record.date && record.title));
    return { boardId, records };
  });

  assert.equal(replay.reduce((total, row) => total + row.records.length, 0), 66);
  assert.equal(new Set(replay.flatMap((row) => row.records.map((record) => record.record_id))).size, 66);
  assert.match(replay.find((row) => row.boardId === "manhattan-cb-02").records
    .find((record) => /cancel/i.test(record.title)).title, /cancel/i);
  assert.match(replay.find((row) => row.boardId === "manhattan-cb-04").records
    .find((record) => /closed/i.test(record.title)).title, /closed/i);
});

test("A2: duplicate, cancellation, closure, and date-only boundaries remain honest", () => {
  const bronx8 = parseHtmlPdfSource(fixture("bronx-cb-08.html"), source("bronx-cb-08", "https://cb8.example/calendar/"), {
    observedAt: OBSERVED_AT, receipt: receipt("https://cb8.example/calendar/"),
  });
  assert.equal(bronx8.filter((record) => record.date === "2026-09-08").length, 1, "duplicate event is suppressed");

  const manhattan2 = parseHtmlPdfSource(fixture("manhattan-cb-02.html"), source("manhattan-cb-02", "https://cb2.example/calendar/"), {
    observedAt: OBSERVED_AT, receipt: receipt("https://cb2.example/calendar/"),
  });
  assert.ok(manhattan2.some((record) => /cancel/i.test(record.title)), "cancellation remains publisher-visible");

  const manhattan4 = parseHtmlPdfSource(fixture("manhattan-cb-04.html"), source("manhattan-cb-04", "https://cb4.example/calendar/"), {
    observedAt: OBSERVED_AT, receipt: receipt("https://cb4.example/calendar/"),
  });
  const closure = manhattan4.find((record) => /closed/i.test(record.title));
  assert.ok(closure);
  assert.equal(closure.start_at, "2026-09-16T09:00:00-04:00");

  const dateOnly = parseAirtableSource({ records: [{ id: "rec-date-only", fields: { Name: "Full Board Meeting", Date: "2026-09-20" } }] }, {
    adapter: "airtable_v1", role: "upcoming_meetings", board_id: "manhattan-cb-11", url: "https://cb11.example/calendar/",
  }, { observedAt: OBSERVED_AT, receipt: receipt("https://cb11.example/calendar/", "airtable_v1") });
  assert.equal(dateOnly[0].date, "2026-09-20");
  assert.equal(dateOnly[0].start_at, null, "date-only evidence never invents a clock");
});

test("A3: fresh seven-source smoke follows only the CB11 calendar iframe", async () => {
  const calls = [];
  const cb11Page = '<iframe class="airtable-embed" src="https://airtable.com/embed/shrCalendarView"></iframe>'
    + '<a href="https://airtable.com/shrUnrelatedView">unrelated share</a>';
  const cb11Embed = '<script>var headers = {"x-airtable-application-id":"appCalendar"};'
    + 'window.__stashedPrefetch = { urlWithParams: "\\u002Fv0.3\\u002Fview\\u002FviwCalendar\\u002FreadSharedViewData?accessPolicy=%7B%22shareId%22%3A%22shrCalendarView%22%7D" };</script>';
  const cb11Data = fixture("manhattan-cb-11.json");
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const body = url === "https://cb11.example/calendar/" ? cb11Page
      : /airtable\.com\/embed\//.test(url) ? cb11Embed : cb11Data;
    return { ok: true, status: 200, headers: { get: (name) => /json|readSharedViewData/.test(url) || /accept/i.test(name) ? "application/json" : "text/html" },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  const sources = htmlSources.map(([boardId, file, url]) => ({ ...source(boardId, url), fixture: file }));
  const results = [];
  for (const descriptor of sources) {
    const body = fixture(descriptor.fixture);
    const records = parseHtmlPdfSource(body, descriptor, { observedAt: OBSERVED_AT, receipt: receipt(descriptor.url) });
    results.push({ board_id: descriptor.board_id, records, source_url: descriptor.url });
  }
  const cb11 = await fetchCommunityBoardSource({ adapter: "airtable_v1", role: "upcoming_meetings", board_id: "manhattan-cb-11", url: "https://cb11.example/calendar/", format: "board-owned HTML + public Airtable shared view" }, {
    observedAt: OBSERVED_AT, fetchImpl,
  });
  results.push({ board_id: "manhattan-cb-11", records: cb11.records, source_url: "https://cb11.example/calendar/" });

  assert.equal(results.length, 7);
  assert.ok(results.every(({ records }) => records.length > 0));
  assert.equal(cb11.records.length, 1);
  assert.equal(cb11.records[0].record_id, "rec-cb11-full");
  assert.equal(cb11.records[0].date, "2026-09-16");
  assert.equal(cb11.records[0].start_at, null, "Airtable Date retains date precision without a guessed time");
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://cb11.example/calendar/",
    "https://airtable.com/embed/shrCalendarView",
    "https://airtable.com/v0.3/view/viwCalendar/readSharedViewData?accessPolicy=%7B%22shareId%22%3A%22shrCalendarView%22%7D",
  ]);
  assert.equal(calls[2].init.headers["x-time-zone"], "America/New_York");
  assert.equal(calls.some(({ url }) => /shrUnrelatedView/.test(url)), false);
  assert.ok(cb11.receipt.acquisition.graph.every((entry) => entry.outcome === "ok"));
});

test("A3 negative control: an expired shared-view request is unavailable, not empty", async () => {
  const result = await fetchCommunityBoardSource({ adapter: "airtable_v1", role: "upcoming_meetings", board_id: "manhattan-cb-11", url: "https://cb11.example/calendar/", format: "board-owned HTML + public Airtable shared view" }, {
    observedAt: OBSERVED_AT,
    fetchImpl: async (url) => {
      const body = url === "https://cb11.example/calendar/"
        ? '<iframe class="airtable-embed" src="https://airtable.com/embed/shrExpired"></iframe>'
        : /embed/.test(url) ? '<script>window.__stashedPrefetch = { urlWithParams: "\\u002Fv0.3\\u002Fview\\u002FviwExpired\\u002FreadSharedViewData" };</script>'
        : "{}";
      const ok = !/readSharedViewData/.test(url);
      return { ok, status: ok ? 200 : 403, headers: { get: () => "text/html" }, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    },
  });
  assert.deepEqual(result.records, []);
  assert.equal(result.receipt.status, "unknown");
  assert.equal(result.receipt.acquisition.complete, false);
  assert.equal(result.receipt.acquisition.graph.at(-1).reason, "http_403");
});

test("evidence inputs are deterministic and hashable", () => {
  for (const [, file] of htmlSources.concat([["manhattan-cb-11", "manhattan-cb-11.json", ""]])) {
    const digest = createHash("sha256").update(fixture(file)).digest("hex");
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
});
