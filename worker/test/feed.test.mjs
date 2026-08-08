import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeedQuery, feedItems, atomFeed, jsonFeed, icsFeed } from "../src/lib/feed.mjs";

const CR_ROW = {
  request_id: "20260630012", start_date: "2026-06-30T00:00:00", agency_name: "Buildings",
  short_title: "Proposed rule: scaffold <b>certification</b> & fees", due_date: "2026-07-18T00:00:00",
};
const EV_ROW = {
  request_id: "20260629001", start_date: "2026-06-29T00:00:00", agency_name: "Brooklyn CB6",
  short_title: "Public hearing — FY27 capital priorities", event_date: "2026-07-14T18:30:00",
  street_address_1: "250 Baltic Street, Brooklyn",
};
const ZAP_ROW = {
  project_id: "P2026K0123", project_name: "Gowanus Rezoning Phase 2", borough: "Brooklyn",
  public_status: "In Public Review", current_milestone_date: "2026-06-20T00:00:00", primary_applicant: "HPD",
};

test("parseFeedQuery: lens + q/agency/min extracted, keywords capped at 4", () => {
  const sp = new URLSearchParams("lens=rules&q=one two three four five&agency=Buildings&min=250000");
  const { lens, filter } = parseFeedQuery(sp);
  assert.equal(lens, "rules");
  assert.deepEqual(filter.keywords, ["one", "two", "three", "four"]);
  assert.equal(filter.agency, "Buildings");
  assert.equal(filter.minAmount, 250000);
});

test("feedItems: City Record rows → CityScroll permalinks, titles cleaned, dates carried", () => {
  const items = feedItems("rules", [CR_ROW]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "20260630012");
  assert.equal(items[0].url, "https://cityscroll.org/notices/20260630012");
  assert.ok(!items[0].title.includes("<b>"), "html stripped from title");
  assert.equal(items[0].date, "2026-06-30T00:00:00");
  assert.match(items[0].summary, /Buildings/);
  assert.match(items[0].summary, /due 2026-07-18/);
});

test("feedItems: ZAP rows → ZAP project links", () => {
  const items = feedItems("rezone", [ZAP_ROW]);
  assert.equal(items[0].id, "P2026K0123");
  assert.match(items[0].url, /zap\.planning\.nyc\.gov\/projects\/P2026K0123/);
  assert.equal(items[0].title, "Gowanus Rezoning Phase 2");
  assert.match(items[0].summary, /Brooklyn/);
});

test("feedItems: obligation/mandate rows → agency constellation links", () => {
  const items = feedItems("obligation", [{
    alert_id: "obligation:x-001:2026-09-01",
    obligation_id: "x-001",
    agency_id: "parks-and-recreation",
    agency_name: "Parks and Recreation",
    duty_text: "Publish an annual report.",
    deliverable_type: "report",
    deadline_date: "2026-09-01",
    recurrence: "annual",
    citation: "§1",
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "obligation:x-001:2026-09-01");
  assert.match(items[0].url, /\/agencies\/parks-and-recreation\//);
  assert.match(items[0].title, /annual report/);
  assert.match(items[0].summary, /statutory deadline 2026-09-01/i);
  assert.doesNotMatch(items[0].summary, /non-compliance|violat/i);
});

test("feedItems: identifier fallbacks replace placeholder titles", () => {
  assert.equal(feedItems("rezone", [{ project_id: "P1985Q9999" }])[0].title, "Project P1985Q9999");
  assert.equal(feedItems("rules", [{ request_id: "20260805001", short_title: "(untitled)" }])[0].title, "Notice 20260805001");
});

test("atomFeed: well-formed, escaped, one entry per item", () => {
  const xml = atomFeed({
    title: 'CityScroll — rules & notices — about "scaffold"',
    selfUrl: "https://w.example/feed.xml?lens=rules&q=scaffold",
    siteUrl: "https://cityscroll.org/",
    updated: "2026-07-01T13:00:00Z",
    items: feedItems("rules", [CR_ROW]),
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /&amp;q=scaffold/, "self link query escaped");
  assert.match(xml, /<entry>/);
  assert.match(xml, /href="https:\/\/cityscroll\.org\/notices\/20260630012"/);
  assert.ok(!/<b>/.test(xml), "no raw html leaks");
  assert.match(xml, /scaffold certification &amp; fees/, "title text escaped");
});

test("jsonFeed: valid JSON Feed 1.1 with items", () => {
  const s = jsonFeed({
    title: "CityScroll — rules", selfUrl: "https://w.example/feed.json?lens=rules",
    siteUrl: "https://cityscroll.org/", items: feedItems("rules", [CR_ROW]),
  });
  const j = JSON.parse(s);
  assert.equal(j.version, "https://jsonfeed.org/version/1.1");
  assert.equal(j.items.length, 1);
  assert.equal(j.items[0].id, "20260630012");
  assert.match(j.items[0].url, /\/notices\/20260630012/);
});

test("icsFeed: canonical flip preserves existing UID namespace to avoid duplicate calendars", () => {
  const ics = icsFeed({ title: "CityScroll — meetings", items: feedItems("meetings", [EV_ROW, { request_id: "x1", short_title: "no dates" }]) });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /X-WR-CALNAME:CityScroll — meetings/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /UID:20260629001@crol-list/);
  assert.match(ics, /DTSTART:20260714T183000/);
  assert.match(ics, /SUMMARY:Public hearing — FY27 capital priorities/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test("icsFeed: an RFP due date works as the event when no event_date exists", () => {
  const ics = icsFeed({ title: "t", items: feedItems("rfp", [CR_ROW]) });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /DTSTART:20260718T000000/);
});
