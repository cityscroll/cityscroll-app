// Give Now cards and calendar previews enough context to decide.
//
// Public alias: c5be5f81ff33d
//
// Now calendar previews and card renderers used to expose little beyond
// title/date, with the card title navigating away. After this change both
// projections share source-honest overview facts (agency, summary, identity,
// due-date precision), cards use primary inspect after enhancement, and the
// calendar preview loads the same detail through the existing loader contract.
//
//   A1 frozen Copilot notice 20260811024 gains decision context beyond
//      title/date, with equivalent static and enhanced facts and primary
//      inspection after enhancement
//   A2 date-only / timezone-free inputs stay honest; missing optional
//      summaries create no empty section; Apply/Register stay separate
//   A3 positive and negative fixtures distinguish the prior thin preview /
//      title-navigates outcome from the intended informative projection
//   A4 sulfuric-acid 20260811028 and Risk Management 20260729003 as frozen
//      examples, plus missing-summary and detail-failure variants; journey
//      evidence recorded without gating on live feed membership
//
//   node --test test/now_inspection_projection.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

import { buildNowSurface } from "../site/now_surface.mjs";
import {
  buildNowCalendarView,
  nowCalendarOccurrences,
  stableNowCalendarUid,
} from "../site/now_calendar.mjs";
import {
  BROWSE_INSPECTION_LEGACY_BASELINE,
  BROWSE_INSPECTION_SURFACES,
} from "../site/browse_inspection_contract.mjs";
import {
  bindCompactMonthCalendar,
  renderCompactMonth,
} from "../site/compact_calendar.mjs";
import {
  CALENDAR_EVENT_PREVIEW_DIALOG_ID,
  calendarEventPreviewFacts,
  renderCalendarEventPreviewBody,
} from "../site/calendar_event_preview.mjs";
import {
  NOW_CARD_FULL_RECORD_CLASS,
  NOW_CARD_INSPECT_ATTRIBUTE,
  NOW_CARD_READY_ATTRIBUTE,
  NOW_CARD_TITLE_LINK_CLASS,
  bindNowCardInspection,
  composeNowOverviewSummary,
  createNowCalendarDetailLoader,
  nowInspectionDetailPayload,
  projectNowInspection,
  renderNowCardTitleClusterHTML,
  renderNowInspectionOverviewHTML,
} from "../site/now_inspection_projection.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const require = createRequire(import.meta.url);
const CrolActions = require("../site/action_registry.js");

const TODAY = "2026-08-20";
const ROOT = process.cwd();
const EVIDENCE_PATH = join("docs", "evidence", "now-inspection-projection", "acceptance-manifest.json");

const FROZEN = Object.freeze({
  copilot: "20260811024",
  sulfuric: "20260811028",
  risk: "20260729003",
});

function moneyNotice(requestId, overrides = {}) {
  const defaults = {
    "20260811024": {
      short_title: "Microsoft 365 Copilot Pre-Rollout Security Readiness Assessment",
      agency_name: "Teachers' Retirement System",
      type_of_notice_description: "Solicitation",
      category_description: "Goods and Services",
      selection_method_description: "Request for Quote",
      pin: "2130",
      due_date: "2026-09-15T17:00:00.000",
      start_date: "2026-08-19T00:00:00.000",
    },
    "20260811028": {
      short_title: "82626B0052-BWS - CRO-661: Delivery of Sulfuric Acid - 78 and 93 percent",
      agency_name: "Environmental Protection",
      type_of_notice_description: "Solicitation",
      category_description: "Services (other than human services)",
      selection_method_description: "Competitive Sealed Bids",
      pin: "82626B0052",
      due_date: "2026-09-16T10:00:00.000",
      start_date: "2026-08-17T00:00:00.000",
    },
    "20260729003": {
      short_title: "Bid Extension: RFP 521165 - Risk Management Consulting Services",
      agency_name: "Housing Authority",
      type_of_notice_description: "Solicitation",
      category_description: "Services (other than human services)",
      selection_method_description: "Request for Proposals",
      pin: "521165",
      due_date: "2026-09-17T14:00:00.000",
      start_date: "2026-08-11T00:00:00.000",
    },
  };
  return {
    request_id: requestId,
    ...(defaults[requestId] || {
      short_title: `Fixture ${requestId}`,
      agency_name: "Fixture Agency",
      type_of_notice_description: "Solicitation",
      category_description: "Goods and Services",
      selection_method_description: "Competitive Sealed Bids",
      pin: "PIN-1",
      due_date: "2026-09-10T12:00:00.000",
      start_date: "2026-08-20T00:00:00.000",
    }),
    ...overrides,
  };
}

function emptyDomain(shape) {
  return { status: "available", [shape]: [] };
}

function fixtureSources(extraNotices = []) {
  return {
    money: {
      status: "available",
      notices: [
        moneyNotice(FROZEN.copilot),
        moneyNotice(FROZEN.sulfuric),
        moneyNotice(FROZEN.risk),
        ...extraNotices,
      ],
    },
    staffing: emptyDomain("exams"),
    rules: emptyDomain("rules"),
    property: emptyDomain("properties"),
    meetings: emptyDomain("hearings"),
    land: emptyDomain("hearings"),
    consultations: emptyDomain("consultations"),
  };
}

function buildSurface(extraNotices = []) {
  return buildNowSurface(fixtureSources(extraNotices), {
    today: TODAY,
    compileActionRail: CrolActions.compileActionRail,
  });
}

function itemFor(surface, requestId) {
  return [...surface.act_by.dated, ...surface.act_by.open_without_date]
    .find((item) => item.request_id === requestId || item.id === `money:${requestId}`);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---------- A1 / A3: projection facts ---------- */

test("A1: frozen Copilot notice gains agency, summary, and identity beyond title/date", () => {
  const surface = buildSurface();
  const item = itemFor(surface, FROZEN.copilot);
  assert.ok(item, "Copilot notice must remain a fixture, not a live-feed gate");
  const projection = projectNowInspection(item);
  assert.equal(projection.agency, "Teachers' Retirement System");
  assert.match(projection.summary, /Solicitation/);
  assert.match(projection.summary, /Goods and Services/);
  assert.match(projection.summary, /Request for Quote/);
  assert.equal(projection.identity.request_id, FROZEN.copilot);
  assert.equal(projection.identity.pin, "2130");
  assert.equal(projection.due.precision, "day");
  assert.equal(projection.route, `/notices/${FROZEN.copilot}`);

  const overview = renderNowInspectionOverviewHTML(projection);
  assert.match(overview, /Teachers' Retirement System/);
  assert.match(overview, /Request for Quote/);
  assert.match(overview, /Notice/);
  assert.match(overview, new RegExp(FROZEN.copilot));
  assert.doesNotMatch(overview, /<dd>\s*<\/dd>/);
});

test("A3: prior thin title/date-only outcome is rejected by the informative projection", () => {
  const thin = {
    id: "money:thin",
    title: "Thin title only",
    route: "/notices/thin",
    time: { value: "2026-09-15", day: "2026-09-15", precision: "day" },
  };
  const projection = projectNowInspection(thin);
  assert.equal(projection.agency, null);
  assert.equal(projection.summary, null);
  assert.equal(projection.identity, null);
  assert.equal(renderNowInspectionOverviewHTML(projection), "");
  assert.equal(nowInspectionDetailPayload(thin), null);
  assert.notEqual(composeNowOverviewSummary({
    notice_type: "Solicitation",
    category: "Goods and Services",
  }), null);
});

/* ---------- A4: frozen companions + missing summary ---------- */

test("A4: sulfuric-acid and Risk Management fixtures project distinguishing context", () => {
  const surface = buildSurface();
  const sulfuric = projectNowInspection(itemFor(surface, FROZEN.sulfuric));
  const risk = projectNowInspection(itemFor(surface, FROZEN.risk));
  assert.equal(sulfuric.agency, "Environmental Protection");
  assert.match(sulfuric.summary, /Competitive Sealed Bids/);
  assert.equal(sulfuric.identity.pin, "82626B0052");
  assert.equal(risk.agency, "Housing Authority");
  assert.match(risk.summary, /Request for Proposals/);
  assert.equal(risk.identity.request_id, FROZEN.risk);
});

test("A2: missing optional summary creates no empty section; date-only stays honest", () => {
  const projection = projectNowInspection({
    id: "money:20260811999",
    title: "No optional summary fields",
    agency: "Parks",
    route: "/notices/20260811999",
    notice_type: null,
    category: null,
    selection_method: null,
    pin: null,
    summary: null,
    time: { value: "2026-09-12", day: "2026-09-12", precision: "day" },
  });
  assert.equal(projection.summary, null);
  assert.equal(projection.due.precision, "day");
  const overview = renderNowInspectionOverviewHTML(projection);
  assert.match(overview, /Parks/);
  assert.doesNotMatch(overview, />Summary</);
  assert.doesNotMatch(overview, /America\/New_York/);
  assert.doesNotMatch(overview, /\d{1,2}:\d{2}/);
});

/* ---------- Cards: static/enhanced equivalence + primary inspect ---------- */

test("A1: static and enhanced card facts match; title inspects after enhancement", async () => {
  const surface = buildSurface();
  const item = itemFor(surface, FROZEN.copilot);
  const projection = projectNowInspection(item);
  const staticOverview = renderNowInspectionOverviewHTML(projection);
  const title = renderNowCardTitleClusterHTML(projection);
  assert.match(title, new RegExp(`class="${NOW_CARD_TITLE_LINK_CLASS}"`));
  assert.match(title, new RegExp(`${NOW_CARD_INSPECT_ATTRIBUTE}="${projection.id}"`));
  assert.match(title, /href="\/notices\/20260811024"/);

  const { container } = mountDocument(
    `<article class="now-card">${title}${staticOverview}` +
    `<div class="now-card-detail" data-now-detail hidden>` +
    `<button type="button" data-now-inspect-dismiss>Close details</button>` +
    `<a class="${NOW_CARD_FULL_RECORD_CLASS}" href="${projection.route}">Open full record</a>` +
    `</div></article>`,
  );
  const controller = bindNowCardInspection(container);
  assert.equal(container.getAttribute(NOW_CARD_READY_ATTRIBUTE), "");

  const button = container.querySelector(`[${NOW_CARD_INSPECT_ATTRIBUTE}]`);
  const detail = container.querySelector("[data-now-detail]");
  assert.equal(detail.hidden, true);
  click(button);
  assert.equal(detail.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.match(container.textContent, /Teachers' Retirement System/);
  assert.equal(
    container.querySelector(`.${NOW_CARD_FULL_RECORD_CLASS}`).getAttribute("href"),
    `/notices/${FROZEN.copilot}`,
  );

  click(container.querySelector("[data-now-inspect-dismiss]"));
  assert.equal(detail.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  click(button);
  keydown(container, "Escape");
  assert.equal(detail.hidden, true);
  controller?.destroy?.();
  assert.equal(staticOverview, renderNowInspectionOverviewHTML(projection));
});

test("A2: domain action links keep their destination separate from full-record navigation", () => {
  const surface = buildSurface();
  // Staffing is empty in this fixture set; synthesize a handoff-shaped item.
  const handoffItem = {
    id: "staffing:7001",
    title: "Example exam",
    agency: "Department of Citywide Administrative Services",
    exam_number: "7001",
    route: "/exams/7001/",
    notice_type: "Exam application",
    action: {
      type: "official_application",
      delivery: "official_handoff",
      destination: "https://www.nyc.gov/examsforjobs",
      label_key: "career_apply_oasys_browse",
      label: "Browse OASys exams",
    },
    time: { value: "2026-09-01", day: "2026-09-01", precision: "day" },
  };
  const projection = projectNowInspection(handoffItem);
  assert.equal(projection.route, "/exams/7001/");
  assert.notEqual(handoffItem.action.destination, projection.route);
  assert.match(renderNowCardTitleClusterHTML(projection), /href="\/exams\/7001\/"/);
});

/* ---------- Calendar preview + loadDetail ---------- */

test("A1: Now calendar occurrence and preview body carry agency for Copilot notice", () => {
  const surface = buildSurface();
  const item = itemFor(surface, FROZEN.copilot);
  const uid = stableNowCalendarUid(item);
  const occurrence = nowCalendarOccurrences(surface).find((row) => row.uid === uid);
  assert.ok(occurrence);
  assert.equal(occurrence.agency, "Teachers' Retirement System");
  assert.match(occurrence.summary, /Request for Quote/);

  const view = buildNowCalendarView(surface, { today: TODAY });
  assert.equal(view.render, true);
  const entry = view.weeks
    .flatMap((week) => week)
    .flatMap((day) => [...(day.visible_occurrences || []), ...(day.overflow_occurrences || [])])
    .find((row) => row.uid === uid);
  assert.ok(entry);
  const facts = calendarEventPreviewFacts(entry);
  assert.equal(facts.agency, "Teachers' Retirement System");
  assert.equal(facts.precision, "date");
  const body = renderCalendarEventPreviewBody(facts);
  assert.match(body, /Agency/);
  assert.match(body, /Teachers' Retirement System/);
  assert.doesNotMatch(body, /5:00|17:00/);
});

test("A4: loadDetail supplies shared summary; failure keeps coherent facts and record link", async () => {
  const surface = buildSurface();
  const view = buildNowCalendarView(surface, { today: TODAY });
  const html = renderCompactMonth(view);
  const { container, dialog } = (() => {
    const mounted = mountDocument(html);
    const loadDetail = createNowCalendarDetailLoader(surface, { stableUid: stableNowCalendarUid });
    bindCompactMonthCalendar(mounted.container, { loadDetail });
    return {
      container: mounted.container,
      dialog: mounted.doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID),
    };
  })();

  const item = itemFor(surface, FROZEN.copilot);
  const uid = stableNowCalendarUid(item);
  const button = [...container.querySelectorAll("[data-calendar-event-preview-uid]")]
    .find((node) => node.getAttribute("data-calendar-event-preview-uid") === uid);
  assert.ok(button);
  click(button);
  await tick();
  assert.match(dialog.textContent, /Teachers' Retirement System/);
  assert.match(dialog.textContent, /Request for Quote/);
  assert.match(dialog.textContent, new RegExp(FROZEN.copilot));
  assert.equal(
    dialog.querySelector("[data-calendar-event-preview-open]").getAttribute("href"),
    `https://cityscroll.org/notices/${FROZEN.copilot}`,
  );

  // Failed-detail variant: a loader that rejects keeps the initial facts.
  const failing = mountDocument(html);
  bindCompactMonthCalendar(failing.container, {
    loadDetail: () => Promise.reject(new Error("detail unavailable")),
  });
  const failDialog = failing.doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID);
  const failButton = [...failing.container.querySelectorAll("[data-calendar-event-preview-uid]")]
    .find((node) => node.getAttribute("data-calendar-event-preview-uid") === uid);
  click(failButton);
  await tick();
  assert.match(failDialog.textContent, /Further detail did not load/);
  assert.match(failDialog.textContent, /Teachers' Retirement System/);
  assert.equal(
    failDialog.querySelector("[data-calendar-event-preview-open]").getAttribute("href"),
    `https://cityscroll.org/notices/${FROZEN.copilot}`,
  );
});

/* ---------- Contract migration ---------- */

test("A1: now-cards leaves the legacy title-navigates baseline once primary inspect ships", () => {
  const surface = BROWSE_INSPECTION_SURFACES.find((row) => row.surface_id === "now-cards");
  assert.ok(surface);
  assert.equal(surface.classification, "conforming");
  assert.equal(surface.baseline_id, null);
  assert.equal(surface.journey_owner, "test/now_inspection_projection.test.mjs");
  assert.equal(
    BROWSE_INSPECTION_LEGACY_BASELINE.some((entry) => entry.id === "now-card-title-navigates"),
    false,
  );
  const source = readFileSync(new URL("../site/now_view.mjs", import.meta.url), "utf8");
  assert.match(source, /renderNowCardHTML/);
  assert.doesNotMatch(source, /\bnowCardHTML\b/);
});

/* ---------- A4 evidence packet ---------- */

test("A4: acceptance manifest records the journey with revision, route, viewport, and fixture vintage", () => {
  assert.equal(existsSync(join(ROOT, EVIDENCE_PATH)), true);
  const manifest = JSON.parse(readFileSync(join(ROOT, EVIDENCE_PATH), "utf8"));
  assert.equal(manifest.schema, "cityscroll.now_inspection_projection_acceptance.v1");
  assert.equal(manifest.record, "cityscroll-engineering/c5be5f81ff33d");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/i);
  assert.equal(manifest.route, "/now/");
  assert.deepEqual(manifest.viewport, [1440, 900]);
  assert.equal(manifest.fixture_vintage, TODAY);
  assert.deepEqual(manifest.journey.sequence, [
    "set_scope_or_view",
    "inspect",
    "dismiss",
    "open_full_record",
    "return_with_back",
    "continue",
  ]);
  assert.ok(manifest.journey.variants.includes("failed_detail"));
  assert.ok(manifest.journey.variants.includes("missing_summary"));
  assert.equal(manifest.frozen_examples.copilot, FROZEN.copilot);
  assert.equal(manifest.frozen_examples.sulfuric_acid, FROZEN.sulfuric);
  assert.equal(manifest.frozen_examples.risk_management, FROZEN.risk);
  assert.ok(manifest.assertions.some((row) => row.id === "copilot-decision-context"));
  assert.ok(manifest.assertions.some((row) => row.id === "failed-detail-keeps-record-link"));
  const digest = createHash("sha256").update(JSON.stringify(manifest.assertions) + "\n").digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});
