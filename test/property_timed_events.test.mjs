import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  extractPropertyTimedEvents,
  propertyEventBand,
  propertyEventState,
} from "../site/property_timed_events.mjs";
import { propertyTimedEventViews } from "../site/property_commercial.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(
  join(ROOT, "test/fixtures/property_timed_events/real_notices.json"),
  "utf8",
));

function row(id) {
  return fixture.cases.find((entry) => entry.id === id)?.row;
}

function events(id) {
  return extractPropertyTimedEvents(row(id));
}

function ofKind(id, kind) {
  return events(id).filter((event) => event.kind === kind);
}

function assertReceipt(event, sourceRow) {
  assert.ok(event.source_field in sourceRow);
  assert.ok(event.source_span);
  const source = String(sourceRow[event.source_field]);
  assert.equal(
    source.slice(event.source_span.start, event.source_span.end),
    event.source_span.text,
    `${sourceRow.request_id} keeps an exact source span`,
  );
}

test("real disposition prose yields one source-receipted hearing date", () => {
  const found = ofKind("disposition-hearing", "hearing");
  assert.equal(found.length, 1);
  assert.equal(found[0].start, "2024-11-26");
  assert.equal(found[0].confidence, "high");
  assertReceipt(found[0], row("disposition-hearing"));
});

test("real lease-auction prose separates the auction window, bid close, and result date", () => {
  const found = events("lease-auction-window");
  const window = found.find((event) => event.kind === "auction_window");
  assert.deepEqual(
    { start: window?.start, end: window?.end },
    { start: "2022-12-08T09:00:00", end: "2022-12-15T21:00:00" },
  );
  assert.equal(found.find((event) => event.kind === "bid_deadline")?.deadline, "2022-12-15T21:00:00");
  assert.equal(found.filter((event) => event.kind === "bid_deadline").length, 1);
  assert.equal(found.find((event) => event.kind === "result_award")?.deadline, "2022-12-19");
  for (const event of found) assertReceipt(event, row("lease-auction-window"));
});

test("real lease-RFP deadline variants parse only with proposal/response scope", () => {
  const numeric = ofKind("lease-rfp-numeric-deadline", "bid_deadline");
  assert.equal(numeric.length, 1);
  assert.equal(numeric[0].deadline, "2025-07-24T23:59:00");
  assertReceipt(numeric[0], row("lease-rfp-numeric-deadline"));

  const response = ofKind("lease-offer-response-deadline", "bid_deadline");
  assert.equal(response.length, 1);
  assert.equal(response[0].deadline, "2017-07-14");
  assertReceipt(response[0], row("lease-offer-response-deadline"));
});

test("worst-offender forest pattern extracts both showings and the anchored bid deadline", () => {
  const found = events("forest-showings-and-bid");
  assert.deepEqual(
    found.filter((event) => event.kind === "inspection_showing").map((event) => event.start),
    ["2023-11-20T13:00:00", "2023-11-21T09:00:00"],
  );
  assert.equal(found.find((event) => event.kind === "bid_deadline")?.deadline, "2023-12-06T16:00:00");
  assert.equal(found.some((event) => event.kind === "accommodation_deadline"), false);
  for (const event of found) assertReceipt(event, row("forest-showings-and-bid"));
});

test("hearing accommodation boilerplate is typed separately and never becomes a bid deadline", () => {
  const found = events("hearing-accommodation-relative");
  assert.equal(found.find((event) => event.kind === "hearing")?.start, "2018-06-27");
  const accommodation = found.find((event) => event.kind === "accommodation_deadline");
  assert.equal(accommodation?.deadline, "2018-06-18");
  assert.equal(accommodation?.date_source, "derived_from_relative_rule");
  assert.equal(accommodation?.relative_business_days_before, 7);
  assert.equal(found.some((event) => event.kind === "bid_deadline"), false);
  assertReceipt(accommodation, row("hearing-accommodation-relative"));
});

test("direct-sale prose gets a sale date; a result title does not invent a result publication date", () => {
  const sale = ofKind("direct-property-sale", "sale");
  assert.equal(sale.length, 1);
  assert.equal(sale[0].start, "2015-10-28");
  assertReceipt(sale[0], row("direct-property-sale"));

  const structured = ofKind("direct-property-sale-structured", "sale");
  assert.equal(structured.length, 1);
  assert.equal(structured[0].start, "2021-10-29T16:00:00");
  assert.equal(structured[0].date_source, "structured_field");
  assertReceipt(structured[0], row("direct-property-sale-structured"));

  const result = events("result-notice-without-result-date");
  assert.equal(result.some((event) => event.kind === "result_award"), false);
  assert.equal(result.find((event) => event.kind === "auction")?.start, "2014-03-25");
});

test("comment, objection, and undated hearing references remain honestly absent", () => {
  assert.deepEqual(events("honest-empty"), []);
  const testimony = events("disposition-hearing");
  assert.equal(testimony.some((event) => event.kind === "comment_deadline"), false);
  assert.equal(testimony.some((event) => event.kind === "objection_deadline"), false);
});

test("approved temporal bands are shared and past events cannot remain live", () => {
  const event = { kind: "hearing", start: "2026-08-10" };
  assert.equal(propertyEventBand(event, "2026-08-03"), "imminent");
  assert.equal(propertyEventBand({ ...event, start: "2026-10-01" }, "2026-08-03"), "approaching");
  assert.equal(propertyEventBand({ ...event, start: "2026-11-02" }, "2026-08-03"), "far");
  assert.equal(propertyEventBand({ ...event, start: "2026-07-01" }, "2026-08-03"), null);
  assert.equal(propertyEventState({ ...event, start: "2026-07-01" }, "2026-08-03"), "past");
  assert.equal(propertyEventState(event, "2026-08-03"), "upcoming");
  assert.equal(propertyEventState({ kind: "auction_window", start: "2026-08-01", end: "2026-08-10" }, "2026-08-03"), "open");
});

test("auction windows expand into positively named, temporally honest date-chip records", () => {
  const extracted = events("lease-auction-window");
  const views = propertyTimedEventViews(extracted, "2022-12-10");
  assert.deepEqual(
    views.filter((view) => view.source_kind === "auction_window").map((view) => [view.kind, view.state, view.band]),
    [["auction_start", "past", null], ["auction_end", "upcoming", "imminent"]],
  );
  assert.match(SITE_SOURCE, /function propertyTimedEventChipsHTML/);
  assert.match(SITE_SOURCE, /data-date-chip/);
  assert.match(SITE_SOURCE, /data-open-window-band/);
  assert.equal(views.find((view) => view.kind === "auction_start")?.label_key, "property_event_auction_start");
  assert.equal(views.find((view) => view.kind === "result_award")?.label_key, "property_event_result");
  assert.equal(views.find((view) => view.kind === "result_award")?.fmt, "2022-12-19T12:00:00");
});
