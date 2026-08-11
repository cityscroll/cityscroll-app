/**
 * Track A (Browse / understand) HCI improvements characterization.
 * Covers notice action order, Following labeling, money award clustering,
 * phase history disclosure, Near-you list-first, and Following scope chips.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFollowingViewModel, renderFollowingBody } from "../site/following_view.mjs";
import { groupSameExcept } from "../site/same_consolidation.mjs";
import { renderNearYouBody } from "../site/near_you_view.mjs";

const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
const land = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
const property = readFileSync(new URL("../site/app/property.mjs", import.meta.url), "utf8");
const money = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const map = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
const people = readFileSync(new URL("../site/app/people.mjs", import.meta.url), "utf8");

test("notice detail mounts the action rail before summary/context chrome", () => {
  const start = routing.indexOf("box.innerHTML = `<div style=\"max-width:880px");
  assert.ok(start > 0);
  const block = routing.slice(start, start + 1800);
  const actions = block.indexOf('id="nactions"');
  const plain = block.indexOf('id="nplain"');
  const context = block.indexOf('id="ncontext"');
  assert.ok(actions >= 0 && plain > actions && context > actions);
});

test("public subscription labels use Following / Follow, not Alerts as the synonym", () => {
  assert.match(i18n, /tab_alerts:\s*"Following"/);
  assert.match(i18n, /watch_this_search:\s*"Follow this search"/);
  assert.match(i18n, /quiz_heading:\s*"Follow CityScroll"/);
  assert.match(html, /data-i18n="quiz_heading">Follow CityScroll</);
});

test("money award mode uses same-except consolidation helpers", () => {
  assert.match(money, /consolidateMoneyAwardRows/);
  assert.match(money, /groupSameExcept/);
  assert.match(money, /money-award-cluster/);
  const rows = [
    { agency_name: "Parks", short_title: "Tree pruning", vendor_name: "Acme", contract_amount: 100, pin: "P1", start_date: "2026-01-01" },
    { agency_name: "Parks", short_title: "Tree pruning", vendor_name: "Acme", contract_amount: 100, pin: "P1", start_date: "2026-02-01" },
    { agency_name: "Parks", short_title: "Tree pruning", vendor_name: "Acme", contract_amount: 100, pin: "P1", start_date: "2026-03-01" },
    { agency_name: "DOT", short_title: "Other", vendor_name: "Beta", contract_amount: 50, pin: "P2", start_date: "2026-01-01" },
  ];
  const entries = groupSameExcept(rows, {
    fields: ["agency_name", "short_title", "vendor_name", "contract_amount", "pin", "start_date"],
    except: ["start_date"],
    threshold: 3,
  });
  assert.equal(entries.filter((e) => e.kind === "same-except-group").length, 1);
  assert.equal(entries.find((e) => e.kind === "same-except-group").count, 3);
});

test("land and property phase spines disclose earlier stages under history", () => {
  assert.match(land, /lc-phase-history land-phase-history/);
  assert.match(land, /lifecycle_phase_show_history/);
  assert.match(property, /disposition-phase-history/);
  assert.match(property, /lifecycle_phase_show_history/);
});

test("staffing career browser exposes format as the primary rail with More filters", () => {
  const section = html.slice(html.indexOf('class="career-browser"'), html.indexOf('id="staffing-ledger"'));
  assert.match(section, /id="staffing-more-filters"/);
  assert.match(section, /id="career-format-facets"/);
  assert.ok(section.indexOf("career-toolbar") < section.indexOf("career-format-facets"));
  assert.match(section, /id="staffing-active-filters"/);
  assert.match(people, /updateStaffingMoreFiltersState/);
});

test("Following handoff renders scope chips and count before the email field", () => {
  const view = buildFollowingViewModel({
    lens: "money",
    filter: { keywords: ["housing"], agency: "Parks", borough: "Brooklyn" },
    matchCount: 12,
    previewItems: [{ id: "1", title: "Sample", url: "/notices/1" }],
    requested: true,
  });
  const body = renderFollowingBody(view);
  const scope = body.indexOf("data-following-scope-panel");
  const chips = body.indexOf("following-scope-chips");
  const email = body.indexOf('name="email"');
  assert.ok(scope >= 0 && chips > scope && email > chips);
  assert.match(body, /data-scope-axis="topic"/);
  assert.match(body, /housing/);
  assert.match(body, /Parks/);
  assert.match(body, /Brooklyn/);
  assert.match(body, /12 matching records/);
});

test("Near-you body leads with records and offers a mobile surface switch", () => {
  const body = renderNearYouBody({
    lens: "meetings",
    lensLabel: "Meetings",
    level: "borough",
    hasPlace: false,
    mapped: true,
    basis: "",
    basisLabel: "",
    viewBox: "0 0 100 100",
    browseHref: "/browse/meetings/",
    watchHref: "/following/",
    shareHref: "https://cityscroll.org/near-you",
    canonicalBase: "https://cityscroll.org/near-you",
    siteBase: "",
    scopeSummary: [{ axis: "topic", label: "Meetings" }],
    features: [],
    max: 0,
    parent: null,
    bags: {
      citywide: { kind: "citywide", label: "Citywide", count: 0, records: [], href: "#" },
      virtual: { kind: "virtual", label: "Virtual", count: 0, records: [], href: "#" },
      unlocated: { kind: "unlocated", label: "Unlocated", count: 0, records: [], href: "#" },
    },
    scope: {
      place: { boroughs: [], community_districts: [], council_districts: [], neighborhood: "" },
      facets: { agencies: [], values: {} },
    },
    results: { count: 3, records: [] },
    activity: { boundary_vintage: "test" },
  });
  assert.match(body, /data-near-surface-switch/);
  assert.match(body, /data-near-surface-panel="list"/);
  assert.match(body, /data-near-surface-panel="map"/);
  const list = body.indexOf('data-near-surface-panel="list"');
  const mapPanel = body.indexOf('data-near-surface-panel="map"');
  assert.ok(list >= 0 && mapPanel > list, "list panel precedes map for mobile-first order");
  assert.match(map, /wireSurfaceSwitch/);
});
