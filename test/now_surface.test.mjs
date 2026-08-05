import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import {
  NOW_SURFACE_SCHEMA_VERSION,
  buildNowSurface,
  countNowSurfaceItems,
} from "../site/now_surface.mjs";
import { nowDateLabel } from "../site/now_view.mjs";

const require = createRequire(import.meta.url);
const CrolActions = require("../site/action_registry.js");

const TODAY = "2026-08-03";

function fixtureSources() {
  return {
    money: {
      status: "available",
      generated_at: "2026-08-03T08:00:00Z",
      notices: [
        {
          request_id: "bid-open",
          short_title: "Bridge inspection services",
          agency_name: "Transportation",
          type_of_notice_description: "Solicitation",
          due_date: "2026-08-04T14:00:00",
          selection_method_description: "Competitive Sealed Bids",
        },
        {
          request_id: "bid-closed",
          short_title: "Expired bid",
          agency_name: "Transportation",
          type_of_notice_description: "Solicitation",
          due_date: "2026-08-02T14:00:00",
        },
        {
          request_id: "bid-rolling",
          short_title: "Rolling vendor list",
          agency_name: "Citywide Administrative Services",
          type_of_notice_description: "Solicitation",
          rolling_deadline: true,
          due_date: null,
        },
      ],
    },
    staffing: {
      status: "available",
      generated_at: "2026-08-03T08:00:00Z",
      exams: [
        {
          exam_number: "7001",
          title: "Housing Inspector",
          eligibility: "open_competitive",
          schedule_status: "scheduled",
          application_start: "2026-08-01",
          application_end: "2026-08-14",
          official_application_url: "https://www.nyc.gov/examsforjobs",
        },
        {
          exam_number: "7000",
          title: "Closed exam",
          application_start: "2026-07-01",
          application_end: "2026-08-01",
        },
      ],
    },
    rules: {
      status: "available",
      generated_at: "2026-08-03T08:00:00Z",
      rules: [
        {
          request_id: "rule-comment",
          agency: "Buildings",
          title: "Energy code amendments",
          stage: "comment-open",
          city_record: { request_id: "rule-comment", event_date: "2026-08-07" },
          nyc_rules: {
            url: "https://rules.cityofnewyork.us/rule/energy-code/",
            comment_url: "https://rules.cityofnewyork.us/rule/energy-code/",
            comment_by_date: "2026-08-07",
            hearing_date: "2026-08-07",
          },
          events: [
            { event_type: "comment_close", valid_at: "2026-08-07", source_field: "comment_by_date", status: "scheduled" },
            { event_type: "public_hearing", valid_at: "2026-08-07", source_field: "hearing_date_1", status: "scheduled" },
          ],
        },
        {
          request_id: "rule-effective",
          agency: "Sanitation",
          title: "Containerization requirements",
          stage: "adopted",
          nyc_rules: { url: "https://rules.cityofnewyork.us/rule/containerization/" },
          events: [
            { event_type: "effective", valid_at: "2026-08-12", source_field: "rule_adoption_date", status: "scheduled" },
          ],
        },
      ],
    },
    property: {
      status: "available",
      generated_at: "2026-08-03T08:00:00Z",
      properties: [
        {
          request_id: "property-actions",
          short_title: "City-owned parcel disposition",
          agency_name: "Housing Preservation and Development",
          section_name: "Property Disposition",
          disposition_stage: "auction_or_rfp",
          commercial: {
            timed_events: [
              {
                kind: "objection_deadline",
                deadline: "2026-08-06",
                confidence: "high",
                date_source: "literal",
                source_field: "additional_description_1",
                source_span: { text: "Objections must be submitted by August 6, 2026." },
              },
              {
                kind: "bid_deadline",
                deadline: "2026-08-04",
                confidence: "high",
                date_source: "derived_from_relative_rule",
                source_field: "additional_description_1",
                source_span: { text: "Bids close one business day before the sale." },
              },
              {
                kind: "auction",
                start: "2026-08-09T10:00:00",
                confidence: "high",
                date_source: "literal",
                source_field: "additional_description_1",
                source_span: { text: "The auction is August 9, 2026 at 10 a.m." },
              },
            ],
          },
          property_location: { scope: "local", boroughs: ["Bronx"] },
        },
      ],
    },
    meetings: {
      status: "available",
      generated_at: "2026-08-03T08:00:00Z",
      hearings: [
        {
          request_id: "hearing-next",
          agency: "Landmarks Preservation Commission",
          title: "Public hearing agenda",
          event_date: "2026-08-04T09:00:00",
          source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/hearing-next",
          affected_area: { scope: "local", boroughs: ["Manhattan"] },
        },
      ],
    },
    land: {
      status: "available",
      generated_at: "2026-08-03T08:00:00Z",
      hearings: [
        {
          project_id: "2026X0001",
          project_name: "Example rezoning",
          hearing_date: "2026-08-05",
          hearing_at: "2026-08-05T10:00:00",
          source: "zap-api-milestones",
          portal_url: "https://zap.planning.nyc.gov/projects/2026X0001",
          borough: "Bronx",
          provenance: { field: "dcp-reviewmeetingdate" },
        },
      ],
    },
  };
}

test("Now compiles two independently ordered lanes from existing action and time records", () => {
  const surface = buildNowSurface(fixtureSources(), {
    today: TODAY,
    compileActionRail: CrolActions.compileActionRail,
  });

  assert.equal(surface.schema_version, NOW_SURFACE_SCHEMA_VERSION);
  assert.deepEqual(
    surface.act_by.dated.map((item) => item.id),
    ["money:bid-open", "property:property-actions:objection_deadline:2026-08-06", "rules:rule-comment:comment", "staffing:7001", "property:property-actions:bid_deadline:2026-08-04"],
    "verified deadlines sort by date; derived dates follow every verified closing window",
  );
  assert.deepEqual(surface.act_by.open_without_date.map((item) => item.id), ["money:bid-rolling"]);
  assert.deepEqual(
    surface.happening_soon.items.map((item) => item.id),
    [
      "meetings:hearing-next",
      "land:2026X0001:2026-08-05",
      "rules:rule-comment:public_hearing:2026-08-07",
      "property:property-actions:auction:2026-08-09",
      "rules:rule-effective:effective:2026-08-12",
    ],
  );
});

test("closed actions never enter Act by and every item retains route, domain, source, and basis", () => {
  const surface = buildNowSurface(fixtureSources(), {
    today: TODAY,
    compileActionRail: CrolActions.compileActionRail,
  });
  const all = [
    ...surface.act_by.dated,
    ...surface.act_by.open_without_date,
    ...surface.happening_soon.items,
  ];

  assert.equal(all.some((item) => item.id.includes("closed")), false);
  for (const item of all) {
    assert.ok(item.route.startsWith("/"), item.id);
    assert.ok(item.domain, item.id);
    assert.ok(item.source?.label, item.id);
    assert.ok(item.time?.basis, item.id);
  }
  assert.equal(countNowSurfaceItems(surface), all.length);
  assert.equal(surface.counts.total, all.length);
  assert.equal(surface.counts.act_by, surface.act_by.dated.length + surface.act_by.open_without_date.length);
  assert.equal(surface.counts.happening_soon, surface.happening_soon.items.length);
});

test("an opaque future scope can filter both lanes without changing their compiler contract", () => {
  const calls = [];
  const scope = { geography: { borough: "Bronx" } };
  const surface = buildNowSurface(fixtureSources(), {
    today: TODAY,
    scope,
    compileActionRail: CrolActions.compileActionRail,
    matchesScope(item, receivedScope) {
      calls.push([item.id, receivedScope]);
      return item.place?.boroughs?.includes(receivedScope.geography.borough) || item.domain === "staffing";
    },
  });

  assert.ok(calls.length > 0);
  assert.ok(calls.every(([, received]) => received === scope));
  assert.ok([
    ...surface.act_by.dated,
    ...surface.act_by.open_without_date,
    ...surface.happening_soon.items,
  ].every((item) => item.domain === "staffing" || item.place?.boroughs?.includes("Bronx")));
});

test("unavailable source models are disclosed and do not become confident empty results", () => {
  const sources = fixtureSources();
  sources.rules = { status: "unavailable", reason: "request_failed", rules: [] };
  delete sources.land;
  const surface = buildNowSurface(sources, {
    today: TODAY,
    compileActionRail: CrolActions.compileActionRail,
  });

  assert.deepEqual(surface.coverage.unavailable_sources, ["rules", "land"]);
  assert.equal(surface.coverage.complete, false);
  assert.equal(surface.coverage.sources.rules.status, "unavailable");
  assert.equal(surface.coverage.sources.land.reason, "source_not_loaded");
  assert.equal(surface.act_by.dated.some((item) => item.domain === "rules"), false);
});

test("Now date labels describe the date and suppress a fact already named by the kind chip", () => {
  const strings = {
    now_basis_no_date: "No fixed date published",
    now_date_responses_due: "Responses due",
    now_date_comment_by: "Comment by",
    now_date_hearing: "Hearing",
    next_action_response_instructions: "Follow the response steps below",
    rule_comment_btn: "Comment",
    disposition_stage_hearing: "Hearing",
  };
  globalThis.t = (key) => strings[key] || key;

  assert.equal(nowDateLabel({ lane: "act_by", kind: "bid", time: { value: "2026-08-04" } }), "Responses due");
  assert.equal(nowDateLabel({ lane: "act_by", kind: "comment", time: { value: "2026-08-04" } }), "Comment by");
  assert.equal(nowDateLabel({ lane: "happening_soon", kind: "hearing", time: { value: "2026-08-04" } }), "");
  assert.equal(nowDateLabel({ lane: "act_by", kind: "bid", time: { value: null } }), "No fixed date published");
});

test("meeting records that are not hearings carry the Meeting event kind", () => {
  const sources = fixtureSources();
  sources.meetings.hearings.push({
    request_id: "meeting-next",
    agency: "Community Board 1",
    title: "Monthly community board meeting",
    event_date: "2026-08-06T18:00:00",
  });
  const surface = buildNowSurface(sources, { today: TODAY, compileActionRail: CrolActions.compileActionRail });
  assert.equal(surface.happening_soon.items.find((item) => item.id === "meetings:meeting-next")?.kind, "meeting");
});

test("Now is promoted as a document route while source lenses remain Browse facets", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
  const main = readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8");
  const nowApp = readFileSync(new URL("../site/app/now.mjs", import.meta.url), "utf8");
  const nowView = readFileSync(new URL("../site/now_view.mjs", import.meta.url), "utf8");
  const model = readFileSync(new URL("../site/now_surface.mjs", import.meta.url), "utf8");

  assert.match(html, /href="\/now\/"/);
  assert.match(html, /id="tab-now" class="tabpane"/);
  assert.doesNotMatch(html, /class="tabbtn"[^>]+data-tab="now"/);
  for (const lens of ["money", "people", "land", "property", "rules", "meetings"]) {
    assert.match(html, new RegExp(`data-tab="${lens}"`));
  }
  assert.doesNotMatch(html, /class="tabbtn"[^>]+data-tab="alerts"/);
  assert.match(html, /href="\/following\/"/);
  assert.doesNotMatch(html, /data-tab="map"/);
  assert.match(html, /href="\/near-you\/"/);
  assert.match(html, /href="\/browse\/"/);
  assert.match(routing, /raw === "now" \|\| raw\.startsWith\("now\?"\)/);
  assert.match(routing, /scopeFromRouteHash\("#"\+raw/);
  assert.match(routing, /showNow\(\{scope:CrolScope\.scopeHasConstraints\(scope\)\?scope:null\}\)/);
  assert.match(main, /import\("\.\/now\.mjs"\)/);
  assert.match(nowApp, /import\("\.\.\/now_view\.mjs"\)/);
  assert.doesNotMatch(nowApp, /now_surface/);
  assert.match(nowView, /workerJson\("\/rules", "rules"\)/);
  assert.match(nowView, /workerJson\("\/property-locations", "properties"\)/);
  assert.match(nowView, /workerJson\("\/hearings", "hearings"\)/);
  assert.doesNotMatch(model, /extractPropertyTimedEvents|extractPropertyReaderActions/);
});
