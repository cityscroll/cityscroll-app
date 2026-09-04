// CBICS-05: Add Calendar and Cards to Now.
//
// This suite pins the acceptance journey against `now_calendar.mjs` (the
// Now → shared compact-month projection) and `calendar_display_state.mjs` /
// `now_calendar_switch.mjs` (the presentation switch and its route-hash
// wiring):
//
//   A1 identical eligible dated identities between Cards and Calendar
//   A2 deadlines and happening-soon events stay visibly distinct
//   A3 undated open opportunities never receive an invented cell
//   A4 domain/place/agency scope persists across the presentation switch
//   A5 the view selector is ignored by watch/subscription serialization
//   A6 direct links, history, refresh, and default no-JS Cards stay coherent
//   A7 a cancelled or rescheduled occurrence updates once, no stale duplicate

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

import { buildNowSurface } from "../site/now_surface.mjs";
import {
  buildNowCalendarView,
  nowCalendarOccurrences,
  resolveNowCalendarOccurrences,
  stableNowCalendarUid,
} from "../site/now_calendar.mjs";
import {
  ensureNowCalendarStylesheet,
  nowCalendarSwitchHTML,
  nowCalendarViewHref,
  resolveNowCalendarPresentation,
} from "../site/now_calendar_switch.mjs";
import {
  calendarViewFromRouteHash,
  routeHashWithCalendarView,
} from "../site/calendar_display_state.mjs";
import {
  routeHashFromScope,
  scopeFromRouteHash,
  watchFromScope,
} from "../site/scope_v0.mjs";

const require = createRequire(import.meta.url);
const CrolActions = require("../site/action_registry.js");

const TODAY = "2026-08-03";

// A dense fixture: three dated act-by deadlines across two domains and two
// happening-soon events, spread over the density rule's rolling 42-day
// window, with a rescheduled rules hearing and a cancelled property auction
// mixed in (A7).
function denseSources() {
  return {
    money: {
      status: "available",
      notices: [
        { request_id: "bid-open", short_title: "Bridge inspection services", agency_name: "Transportation",
          type_of_notice_description: "Solicitation", due_date: "2026-08-04T14:00:00" },
      ],
    },
    staffing: {
      status: "available",
      exams: [
        { exam_number: "7001", title: "Housing Inspector", application_start: "2026-08-01",
          application_end: "2026-08-14", official_application_url: "https://www.nyc.gov/examsforjobs" },
      ],
    },
    rules: {
      status: "available",
      rules: [
        { request_id: "rule-comment", agency: "Buildings", title: "Energy code amendments", stage: "comment-open",
          nyc_rules: { url: "https://rules.cityofnewyork.us/rule/energy-code/", comment_by_date: "2026-08-07", hearing_date: "2026-08-20" },
          events: [
            { event_type: "comment_close", valid_at: "2026-08-07", source_field: "comment_by_date", status: "scheduled" },
            // An append-only source history: the original hearing date plus the
            // rescheduled one. Both land in the same record's raw event list.
            { event_type: "public_hearing", valid_at: "2026-08-10", source_field: "hearing_date_1", status: "scheduled" },
            { event_type: "public_hearing", valid_at: "2026-08-20", source_field: "hearing_date_2", status: "scheduled" },
          ] },
      ],
    },
    property: {
      status: "available",
      properties: [
        { request_id: "auction-cancelled", short_title: "CANCELLED — City-owned parcel auction",
          agency_name: "Housing Preservation and Development", disposition_stage: "auction_or_rfp",
          commercial: { timed_events: [
            { kind: "auction", start: "2026-08-12T10:00:00", confidence: "high", date_source: "literal" },
          ] },
          property_location: { scope: "local", boroughs: ["Bronx"] } },
      ],
    },
    meetings: { status: "available", hearings: [] },
    land: { status: "available", hearings: [] },
  };
}

function buildSurface(sources, options = {}) {
  return buildNowSurface(sources, {
    today: TODAY,
    compileActionRail: CrolActions.compileActionRail,
    ...options,
  });
}

test("A1: the calendar carries the same eligible dated identities as the two Cards lanes", () => {
  const surface = buildSurface(denseSources());
  const cardsDatedUids = new Set([
    ...surface.act_by.dated.map((item) => stableNowCalendarUid(item)),
    ...surface.happening_soon.items.map((item) => stableNowCalendarUid(item)),
  ]);
  const occurrences = nowCalendarOccurrences(surface);
  const calendarUids = new Set(occurrences.map((occurrence) => occurrence.uid));
  assert.deepEqual(calendarUids, cardsDatedUids, "every calendar uid names a Cards identity and vice versa");
  assert.equal(occurrences.length, cardsDatedUids.size, "one calendar cell per retained identity, no extras");
});

test("A2: an act-by item always projects as a deadline; a happening-soon item always projects as an event", () => {
  const surface = buildSurface(denseSources());
  const occurrences = nowCalendarOccurrences(surface);
  const byUid = new Map(occurrences.map((occurrence) => [occurrence.uid, occurrence]));
  assert.equal(byUid.get("money:bid-open").kind, "deadline");
  assert.equal(byUid.get("staffing:7001").kind, "deadline");
  assert.equal(byUid.get("rules:rule-comment:comment").kind, "deadline");
  assert.equal(byUid.get("meetings:hearing-next"), undefined); // no meetings fixture here
  assert.equal(byUid.get("rules:rule-comment:public_hearing").kind, "event");
});

test("A3: undated open opportunities never enter the calendar projection", () => {
  const sources = denseSources();
  sources.money.notices.push({
    request_id: "bid-rolling", short_title: "Rolling vendor list",
    agency_name: "Citywide Administrative Services", type_of_notice_description: "Solicitation",
    rolling_deadline: true, due_date: null,
  });
  const surface = buildSurface(sources);
  assert.ok(surface.act_by.open_without_date.some((item) => item.id === "money:bid-rolling"));
  const occurrences = nowCalendarOccurrences(surface);
  assert.ok(!occurrences.some((occurrence) => occurrence.uid.includes("bid-rolling")));
  // The adapter never even reads the undated lane.
  const surfaceWithoutUndated = { ...surface, act_by: { ...surface.act_by, open_without_date: undefined } };
  assert.deepEqual(nowCalendarOccurrences(surfaceWithoutUndated), occurrences);
});

test("A7: a rescheduled hearing collapses to one occurrence at the retained (latest) date", () => {
  const surface = buildSurface(denseSources());
  const occurrences = nowCalendarOccurrences(surface);
  const hearingOccurrences = occurrences.filter((occurrence) => occurrence.uid === "rules:rule-comment:public_hearing");
  assert.equal(hearingOccurrences.length, 1, "no stale duplicate for the superseded hearing date");
  assert.equal(hearingOccurrences[0].date, "2026-08-20");
  assert.equal(hearingOccurrences[0].lifecycle, "rescheduled");
});

test("A7: a cancelled record is retained once, flagged cancelled, not silently dropped or duplicated", () => {
  const surface = buildSurface(denseSources());
  const occurrences = nowCalendarOccurrences(surface);
  const auction = occurrences.filter((occurrence) => occurrence.uid === "property:auction-cancelled:auction");
  assert.equal(auction.length, 1);
  assert.equal(auction[0].lifecycle, "cancelled");
  assert.equal(auction[0].status, "cancelled");
});

test("A7: resolveNowCalendarOccurrences prefers a later reschedule over an earlier cancellation notice", () => {
  const resolved = resolveNowCalendarOccurrences([
    { id: "property:p1:hearing:2026-08-01", time: { day: "2026-08-01", value: "2026-08-01" }, cancelled: true, title: "Cancelled notice" },
    { id: "property:p1:hearing:2026-08-20", time: { day: "2026-08-20", value: "2026-08-20" }, cancelled: false, title: "Moved hearing" },
  ]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].lifecycle, "rescheduled");
  assert.equal(resolved[0].item.time.day, "2026-08-20");
});

test("the dense fixture meets the commissioned density rule and renders a month", () => {
  const surface = buildSurface(denseSources());
  const view = buildNowCalendarView(surface, { today: TODAY });
  assert.equal(view.render, true);
  assert.equal(view.month, "2026-08");
});

test("a sparse Now surface returns an explicit non-render result, never an empty calendar", () => {
  const emptySources = Object.fromEntries(
    ["money", "staffing", "rules", "property", "meetings", "land"].map((domain) => [domain, { status: "available" }]),
  );
  const surface = buildSurface(emptySources);
  const view = buildNowCalendarView(surface, { today: TODAY });
  assert.equal(view.render, false);
  assert.ok(view.reason);
});

test("A4: domain/place/agency scope round-trips through the Now route hash independent of calview", () => {
  const semantic = "#now?lens=rules&boro=Bronx&agency=Buildings&q=comment";
  const canonicalSemantic = routeHashFromScope(scopeFromRouteHash(semantic), { surface: "now" });
  for (const view of ["list", "calendar"]) {
    const hash = routeHashWithCalendarView(semantic, view);
    const scope = scopeFromRouteHash(hash);
    assert.deepEqual(scope.facets.domains, ["rules"]);
    assert.deepEqual(scope.place.boroughs, ["Bronx"]);
    assert.deepEqual(scope.facets.agencies, ["Buildings"]);
    assert.equal(scope.topic.query, "comment");
    // Round-tripping the scope back to a route reproduces the same canonical
    // semantic hash regardless of which presentation view was requested.
    assert.equal(routeHashFromScope(scope, { surface: "now" }), canonicalSemantic);
  }
});

test("A5: calview is stripped from Now scope and never reaches a saved watch filter", () => {
  const hash = routeHashWithCalendarView("#now?lens=money&boro=Bronx", "calendar");
  const scope = scopeFromRouteHash(hash);
  assert.equal("calview" in scope.facets.values, false);
  const watch = watchFromScope(scope, { lens: "money" });
  assert.equal("calview" in watch.filter, false);
  // A hostile facet blob cannot smuggle calview into scope either.
  const hostile = scopeFromRouteHash(`#now?lens=money&facet=${encodeURIComponent(JSON.stringify({ calview: "calendar" }))}`);
  assert.equal("calview" in hostile.facets.values, false);
});

test("A6: the default (no view requested) route is List and stays byte-identical to a legacy #now link", () => {
  assert.equal(calendarViewFromRouteHash("#now"), "list");
  assert.equal(routeHashWithCalendarView("#now?boro=BX", "list"), "#now?boro=BX");
  const presentation = resolveNowCalendarPresentation({ requested: undefined, sparse: false });
  assert.equal(presentation.view, "list");
  assert.equal(presentation.fallback, false);
});

test("A6: a Calendar request against a sparse population falls back to Cards with an explanatory note, not an empty page", () => {
  const presentation = resolveNowCalendarPresentation({ requested: "calendar", sparse: true, doc: null });
  assert.equal(presentation.view, "list");
  assert.equal(presentation.reason, "sparse");
});

test("the switch always reflects what actually painted, never the bare request", () => {
  const html = nowCalendarSwitchHTML({ view: "list", currentHash: "#now?boro=BX" });
  assert.match(html, /data-now-calview="list"/);
  assert.match(html, /aria-pressed="true"[^>]*>Cards|now_calview_cards/);
  assert.match(html, /data-filter-href="#now\?boro=BX&amp;calview=calendar"/);
});

test("nowCalendarViewHref produces the same shareable route the switch itself links to", () => {
  assert.equal(nowCalendarViewHref("calendar", "#now?boro=BX"), "#now?boro=BX&calview=calendar");
  assert.equal(nowCalendarViewHref("list", "#now?boro=BX&calview=calendar"), "#now?boro=BX");
});

test("ensureNowCalendarStylesheet tolerates a missing document (no-JS / non-browser environments)", () => {
  assert.doesNotThrow(() => ensureNowCalendarStylesheet(null));
  assert.doesNotThrow(() => ensureNowCalendarStylesheet(undefined));
});

test("stableNowCalendarUid strips only a trailing ISO date segment", () => {
  assert.equal(stableNowCalendarUid({ id: "property:req:kind:2026-08-06" }), "property:req:kind");
  assert.equal(stableNowCalendarUid({ id: "money:req" }), "money:req");
  assert.equal(stableNowCalendarUid({ id: "rules:req:comment" }), "rules:req:comment");
});
