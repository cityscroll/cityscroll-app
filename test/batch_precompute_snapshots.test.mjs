import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Wave-2 batch-precompute pure builders + property list slim view.
// Run: node --test test/batch_precompute_snapshots.test.mjs worker/test/property.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildDataPageSnapshot,
  buildLandDefaultSnapshot,
  buildMoneyAgenciesSnapshot,
  buildMoneyDefaultOpenSnapshot,
  buildStaffingHiresSnapshot,
  filterStillOpenNotices,
  isDefaultLandSearch,
  isDefaultMoneySearch,
  normalizeDataPageRows,
  yearAgoISO,
} from "../tools/lib/batch_precompute_snapshots.mjs";
import {
  PROPERTY_LIST_DROP_FIELDS,
  slimPropertyListView,
} from "../worker/src/lib/property_list.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "batch-precompute");

test("yearAgoISO is a UTC calendar date 365 days before now", () => {
  assert.equal(yearAgoISO(new Date("2026-08-01T15:00:00Z")), "2025-08-01");
});

test("normalizeDataPageRows coerces counts and trims volume months", () => {
  assert.deepEqual(
    normalizeDataPageRows("sections", [{ section_name: "Procurement", n: "12" }, { section_name: "", n: 1 }]),
    [{ section_name: "Procurement", n: 12 }],
  );
  assert.deepEqual(
    normalizeDataPageRows("volume", [{ m: "2026-01-01T00:00:00.000", n: "9" }]),
    [{ m: "2026-01", n: 9 }],
  );
});

test("buildDataPageSnapshot stamps schema and chart keys from raw SODA rows", () => {
  const raw = JSON.parse(readFileSync(join(FIXTURE, "data_page_charts_raw.json"), "utf8"));
  const snap = buildDataPageSnapshot(raw, { now: new Date("2026-08-01T12:00:00Z") });
  assert.equal(snap.schema_version, 1);
  assert.equal(snap.delivery_tier, "inline-at-build");
  assert.equal(snap.year_ago, "2025-08-01");
  assert.ok(snap.charts.sections.length >= 1);
  assert.ok(snap.charts.sections[0].section_name);
  assert.equal(typeof snap.charts.sections[0].n, "number");
  assert.ok(snap.query.sections.$select.includes("section_name"));
});

test("buildLandDefaultSnapshot keeps project_id order and caps count", () => {
  const projects = JSON.parse(readFileSync(join(FIXTURE, "land_default_projects.json"), "utf8"));
  const snap = buildLandDefaultSnapshot(projects, { now: new Date("2026-08-01T12:00:00Z") });
  assert.equal(snap.delivery_tier, "inline-at-build");
  assert.equal(snap.count, projects.length);
  assert.equal(snap.projects[0].project_id, projects[0].project_id);
  assert.match(snap.query.$where, /ULURP/);
});

test("isDefaultLandSearch is only the unfiltered Active ULURP tab", () => {
  assert.equal(isDefaultLandSearch({ status: "active" }), true);
  assert.equal(isDefaultLandSearch({ status: "all" }), false);
  assert.equal(isDefaultLandSearch({ status: "active", boro: "Brooklyn" }), false);
  assert.equal(isDefaultLandSearch({ status: "active", kw: "Gowanus" }), false);
  assert.equal(isDefaultLandSearch({ status: "active", located: true }), false);
  assert.equal(isDefaultLandSearch({ status: "active", communityDistrict: "K02" }), false);
  assert.equal(isDefaultLandSearch({ status: "active", councilDistrict: "36" }), false);
});

test("slimPropertyListView drops body dumps and keeps list fields", () => {
  const view = slimPropertyListView({
    schema_version: 1,
    generated_at: "2026-08-01T00:00:00Z",
    properties: [
      {
        request_id: "p1",
        short_title: "Sale",
        additional_description_1: "Block 1 Lot 2",
        additional_description_2: "long body",
        other_info_1: "print",
        printout_1: "dump",
        property_location: { scope: "local" },
        commercial: {
          glance: { item: "Property" },
          timed_events: [{
            kind: "hearing",
            start: "2026-08-10T10:00:00",
            source_field: "additional_description_1",
            source_span: { start: 0, end: 5, text: "Block" },
          }],
        },
      },
    ],
  });
  assert.equal(view.view, "list");
  assert.equal(view.properties[0].additional_description_1, "Block 1 Lot 2");
  assert.equal(view.properties[0].property_location.scope, "local");
  assert.deepEqual(view.properties[0].commercial.timed_events, [{
    kind: "hearing",
    start: "2026-08-10T10:00:00",
    source_field: "additional_description_1",
    source_span: { start: 0, end: 5, text: "Block" },
  }]);
  for (const key of PROPERTY_LIST_DROP_FIELDS) {
    assert.equal(view.properties[0][key], undefined, key);
  }
});

test("committed data page and land default snapshots exist and parse", () => {
  const dataPage = JSON.parse(readFileSync(join(ROOT, "site/data/data_page_charts.json"), "utf8"));
  const land = JSON.parse(readFileSync(join(ROOT, "site/data/land_default_ulurp.json"), "utf8"));
  assert.ok(dataPage.charts.sections.length >= 1);
  assert.ok(land.projects.length >= 1);
  assert.ok(land.projects[0].project_id);
});

test("buildMoneyDefaultOpenSnapshot keeps notice order and due_date floor", () => {
  const rows = JSON.parse(readFileSync(join(FIXTURE, "money_default_open_raw.json"), "utf8"));
  const snap = buildMoneyDefaultOpenSnapshot(rows, { now: new Date("2026-08-03T12:00:00Z") });
  assert.equal(snap.delivery_tier, "inline-at-build");
  assert.equal(snap.open_as_of, "2026-08-03");
  assert.equal(snap.count, rows.length);
  assert.equal(snap.notices[0].request_id, rows[0].request_id);
  assert.match(snap.query.$where, /Solicitation/);
  assert.match(snap.query.$where, /due_date/);
});

test("isDefaultMoneySearch is only the unfiltered open-RFP tab", () => {
  assert.equal(isDefaultMoneySearch({ mode: "open" }), true);
  assert.equal(isDefaultMoneySearch({ mode: "open", sort: "deadline" }), true);
  assert.equal(isDefaultMoneySearch({ mode: "award" }), false);
  assert.equal(isDefaultMoneySearch({ mode: "open", agency: "Parks" }), false);
  assert.equal(isDefaultMoneySearch({ mode: "open", kw: "pest" }), false);
  assert.equal(isDefaultMoneySearch({ mode: "open", methodSel: "Competitive Sealed Bid" }), false);
  assert.equal(isDefaultMoneySearch({ mode: "open", closingWeek: true }), false);
  assert.equal(isDefaultMoneySearch({ mode: "open", sort: "amount" }), false);
  assert.equal(isDefaultMoneySearch({ mode: "open", nlResolved: { category: "Services" } }), false);
});

test("filterStillOpenNotices drops past-due snapshot rows", () => {
  const rows = [
    { request_id: "a", due_date: "2026-08-01T12:00:00.000" },
    { request_id: "b", due_date: "2026-08-10T12:00:00.000" },
  ];
  const open = filterStillOpenNotices(rows, new Date("2026-08-03T12:00:00Z"));
  assert.deepEqual(open.map((r) => r.request_id), ["b"]);
});

test("buildMoneyAgenciesSnapshot unique-sorts agency names", () => {
  const rows = JSON.parse(readFileSync(join(FIXTURE, "money_procurement_agencies_raw.json"), "utf8"));
  const snap = buildMoneyAgenciesSnapshot(rows, { now: new Date("2026-08-03T12:00:00Z") });
  assert.equal(snap.delivery_tier, "inline-at-build");
  assert.ok(snap.agencies.length >= 1);
  assert.equal(snap.count, snap.agencies.length);
  const sorted = [...snap.agencies].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(snap.agencies, sorted);
});

test("buildStaffingHiresSnapshot caps APPOINTED rows", () => {
  const rows = JSON.parse(readFileSync(join(FIXTURE, "staffing_default_hires_raw.json"), "utf8"));
  const snap = buildStaffingHiresSnapshot(rows, { now: new Date("2026-08-03T12:00:00Z") });
  assert.equal(snap.delivery_tier, "inline-at-build");
  assert.equal(snap.count, rows.length);
  assert.equal(snap.notices[0].short_title, "APPOINTED");
  assert.match(snap.query.$where, /Changes in Personnel/);
});

test("committed money and staffing default snapshots exist and parse", () => {
  const money = JSON.parse(readFileSync(join(ROOT, "site/data/money_default_open.json"), "utf8"));
  const agencies = JSON.parse(readFileSync(join(ROOT, "site/data/money_procurement_agencies.json"), "utf8"));
  const hires = JSON.parse(readFileSync(join(ROOT, "site/data/staffing_default_hires.json"), "utf8"));
  assert.ok(money.notices.length >= 1);
  assert.ok(money.notices[0].request_id);
  assert.ok(money.notices[0].due_date);
  assert.ok(agencies.agencies.length >= 1);
  assert.ok(hires.notices.length >= 1);
  assert.equal(hires.notices[0].short_title, "APPOINTED");
});

test("data.html forwards to public successor paths", () => {
  const src = readFileSync(join(ROOT, "site/data.html"), "utf8");
  assert.match(src, /data has moved/i);
  assert.match(src, /location\.replace/);
  assert.match(src, /about\.html#data/);
  assert.match(src, /api\.html/);
});

test("index.html uses land default snapshot on Active ULURP first paint", () => {
  const src = SITE_SOURCE;
  assert.match(src, /data\/land_default_ulurp\.json/);
  assert.match(src, /loadLandDefaultSnapshot/);
  assert.match(src, /isDefaultLandSearchState/);
});

test("index modules use money and staffing default snapshots on first paint", () => {
  const src = SITE_SOURCE;
  assert.match(src, /data\/money_default_open\.json/);
  assert.match(src, /loadMoneyDefaultSnapshot/);
  assert.match(src, /isDefaultMoneySearchState/);
  assert.match(src, /data\/money_procurement_agencies\.json/);
  assert.match(src, /data\/staffing_default_hires\.json/);
  assert.match(src, /loadStaffingHiresSnapshot/);
});
