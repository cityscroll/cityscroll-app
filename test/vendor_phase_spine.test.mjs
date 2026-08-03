import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Pure vendor profile phase spine: award → registration → payments.
//
//   node --test test/vendor_phase_spine.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VENDOR_PROCUREMENT_PHASES,
  mapNoticeTypeToVendorPhase,
  aggregateByYear,
  aggregateByTitle,
  countDuplicateSourceLinks,
  buildVendorPhaseView,
  noticeToVendorMilestone,
} from "../site/vendor_phase_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROWS = [
  {
    request_id: "20260724018",
    type_of_notice_description: "Award",
    short_title: "Integrated Commercial Hotels Program",
    start_date: "2026-07-30",
    agency_name: "Homeless Services",
    contract_amount: 81424178,
  },
  {
    request_id: "20260616018",
    type_of_notice_description: "Award",
    short_title: "CMS Violence Prevention Mentoring Program",
    start_date: "2026-06-23",
    agency_name: "Youth and Community Development",
    contract_amount: 127555,
  },
  {
    request_id: "20260609041",
    type_of_notice_description: "Award",
    short_title: "Family Enrichment Centers 3 RFP Renewal #1",
    start_date: "2026-06-15",
    agency_name: "Administration for Children's Services",
    contract_amount: 2221484,
  },
  {
    request_id: "20251201001",
    type_of_notice_description: "Award",
    short_title: "Family Enrichment Centers 3 RFP Renewal #1",
    start_date: "2025-12-01",
    agency_name: "Administration for Children's Services",
    contract_amount: 2100000,
  },
  {
    request_id: "20250301001",
    type_of_notice_description: "Intent to Award",
    short_title: "Prevention services",
    start_date: "2025-03-01",
    agency_name: "ACS",
    contract_amount: 5000000,
  },
];

test("mapNoticeTypeToVendorPhase maps City Record types into award", () => {
  assert.equal(mapNoticeTypeToVendorPhase("Award"), "award");
  assert.equal(mapNoticeTypeToVendorPhase("Intent to Award"), "award");
  assert.equal(mapNoticeTypeToVendorPhase("Solicitation"), "award");
});

test("buildVendorPhaseView groups under award → registration → payments", () => {
  const view = buildVendorPhaseView(ROWS, {
    vendorName: "Community Mediation Services Inc.",
    stem: "COMMUNITY MEDIATION SERVICES",
  });
  assert.equal(view.schema_version, 1);
  assert.deepEqual(
    view.phases.map((p) => p.id),
    [...VENDOR_PROCUREMENT_PHASES],
  );
  const byId = Object.fromEntries(view.phases.map((p) => [p.id, p]));
  assert.equal(byId.award.event_count, 5);
  assert.equal(byId.registration.event_count, 0);
  assert.equal(byId.payments.event_count, 0);
  assert.equal(byId.registration.state, "future");
  assert.equal(byId.payments.state, "future");
});

test("buildVendorPhaseView: current is award when only notices exist", () => {
  const view = buildVendorPhaseView(ROWS, { vendorName: "CMS" });
  assert.equal(view.current.phase_id, "award");
  assert.equal(view.current.action_key, "vendor_phase_action_review_awards");
  assert.equal(view.current.award_count, 5);
  assert.equal(view.next?.phase_id, "registration");
  assert.equal(view.latest_notice_id, "20260724018");
  assert.equal(view.action_notice_id, "20260724018");
});

test("aggregateByYear collapses awards into year cycles", () => {
  const ms = ROWS.map(noticeToVendorMilestone);
  const years = aggregateByYear(ms);
  assert.equal(years.length, 2);
  assert.equal(years[0].year, "2026");
  assert.equal(years[0].count, 3);
  assert.equal(years[1].year, "2025");
  assert.equal(years[1].count, 2);
});

test("aggregateByTitle collapses identical titles", () => {
  const ms = ROWS.map(noticeToVendorMilestone);
  const titles = aggregateByTitle(ms);
  const fec = titles.find((t) => /Family Enrichment/i.test(t.title));
  assert.ok(fec);
  assert.equal(fec.count, 2);
});

test("countDuplicateSourceLinks: N Checkbook candidates → N-1 dropped", () => {
  const ms = ROWS.map(noticeToVendorMilestone).map((m) => ({ ...m, source: "checkbook" }));
  assert.equal(countDuplicateSourceLinks(ms), 4); // 5 → 4 extras
});

test("buildVendorPhaseView: one Checkbook target, not N per award", () => {
  const view = buildVendorPhaseView(ROWS, {
    vendorName: "Community Mediation Services Inc.",
  });
  assert.equal(view.default_checkbook_links, 1);
  assert.equal(view.checkbook.vendor, "Community Mediation Services Inc.");
  assert.equal(view.duplicate_link_candidates, 4);
  // Future phases display zero events (substance only for current/passed)
  const future = view.phases.filter((p) => p.state === "future");
  assert.ok(future.every((p) => p.event_count === 0));
  assert.ok(future.length >= 2);
});

test("buildVendorPhaseView: optional registration/payment joins advance current", () => {
  const view = buildVendorPhaseView(ROWS, {
    vendorName: "CMS",
    hasRegistration: true,
    hasPayments: true,
  });
  assert.equal(view.current.phase_id, "payments");
  assert.equal(view.has_registration, true);
  assert.equal(view.has_payments, true);
  const states = Object.fromEntries(view.phases.map((p) => [p.id, p.state]));
  assert.equal(states.award, "passed");
  assert.equal(states.registration, "passed");
  assert.equal(states.payments, "current");
});

test("buildVendorPhaseView: empty rows still returns three-phase shell", () => {
  const view = buildVendorPhaseView([], { vendorName: "CMS" });
  assert.equal(view.phases.length, 3);
  assert.equal(view.notice_count, 0);
  assert.equal(view.current.phase_id, "award");
});

test("index.html wires vendor phase spine module and timeline render", () => {
  const index = SITE_SOURCE;
  assert.match(index, /vendor_phase_spine\.mjs/);
  assert.match(index, /buildVendorPhaseView|vendorPhaseTimelineHTML/);
  // Flat-only rowItems dump for "On the record" must not be the sole path.
  assert.match(index, /vendorPhaseTimelineHTML|vendor-phase-timeline/);
});

test("i18n carries vendor_phase keys", () => {
  const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
  for (const key of [
    "vendor_phase_award",
    "vendor_phase_registration",
    "vendor_phase_payments",
    "vendor_phase_now_label",
    "vendor_phase_action_follow_money",
    "vendor_on_the_record",
  ]) {
    assert.match(i18n, new RegExp(`${key}:`));
  }
});
