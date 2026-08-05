/**
 * Tax-lien cycle context: notice-inline model + property class survey.
 *
 * verify:
 *   node --test test/tax_lien_cycle_context.test.mjs test/tax_lien_sale_prediction.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

import {
  PROPERTY_CYCLE_CONTEXT_SURVEY,
  TAX_LIEN_STAGES,
  buildDispositionCycleContext,
  buildTaxLienCycleGuide,
  buildTaxLienResidentChecklist,
  buildTaxLienCycleContext,
  buildTaxLienStepper,
  daysUntil,
  deadlineState,
  decodeTaxLienBbl,
  leaveRateForStage,
  noticeParcelBbls,
  taxLienHistoricalContextLine,
} from "../site/tax_lien_cycle_context.mjs";

const summary = JSON.parse(
  readFileSync(new URL("../site/data/tax_lien_sale_summary.json", import.meta.url), "utf8"),
);
const lookup = JSON.parse(
  readFileSync(new URL("../site/data/tax_lien_sale_bbl.json", import.meta.url), "utf8"),
);
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");

const FIXTURE_BBL = "1000110012"; // listed on latest cycle (notice_10)

test("ladder order is 90→60→30→10→final", () => {
  assert.deepEqual(TAX_LIEN_STAGES, [
    "notice_90",
    "notice_60",
    "notice_30",
    "notice_10",
    "sold",
  ]);
});

test("stepper highlights the observed stage as current", () => {
  const steps = buildTaxLienStepper("notice_30");
  assert.equal(steps.length, 5);
  assert.equal(steps[0].status, "done");
  assert.equal(steps[1].status, "done");
  assert.equal(steps[2].status, "current");
  assert.equal(steps[2].id, "notice_30");
  assert.equal(steps[3].status, "todo");
  assert.equal(steps[4].status, "todo");
});

test("historical context line uses leave rate and prior-cycle attribution", () => {
  const rate = leaveRateForStage(summary, "notice_90");
  assert.ok(rate != null && rate > 0.8 && rate < 0.95);
  const line = taxLienHistoricalContextLine({
    leaveRate: rate,
    cycleCount: summary.training.cycle_count,
    stage: "notice_90",
  });
  assert.match(line, /90-day list/);
  assert.match(line, /87%/); // citywide training rounds to 87
  assert.match(line, /Based on 3 prior cycles/);
  assert.match(line, /exemption and payment-plan deadlines are the lever/);
  assert.equal(
    taxLienHistoricalContextLine({ leaveRate: null, cycleCount: 3 }),
    null,
  );
});

test("deadlineState is civic-time open / closing-soon / closed", () => {
  assert.equal(deadlineState("2099-06-02", "2026-08-03").state, "open");
  assert.equal(deadlineState("2026-08-10", "2026-08-03").state, "closing-soon");
  assert.equal(deadlineState("2025-06-02", "2026-08-03").state, "closed");
  assert.equal(daysUntil("2026-08-10", "2026-08-03"), 7);
});

test("resident checklist is action-ordered and honest when a DOF link is absent", () => {
  const checklist = buildTaxLienResidentChecklist(summary.action_channels);
  assert.deepEqual(checklist.map((step) => step.id), [
    "exemptions",
    "payment_plans",
    "official_guide",
  ]);
  assert.ok(checklist.every((step) => step.url.startsWith("https://www.nyc.gov/")));

  const withoutPaymentPlan = buildTaxLienResidentChecklist({
    ...summary.action_channels,
    payment_plan_url: null,
  });
  assert.deepEqual(withoutPaymentPlan.map((step) => step.id), [
    "exemptions",
    "official_guide",
  ]);
  assert.equal(buildTaxLienResidentChecklist(null).length, 0);
});

test("an expired cycle never exposes a live countdown", () => {
  const expiredWithFutureDates = {
    ...summary,
    latest_cycle: { ...summary.latest_cycle, status: "expired" },
    schedule: { ...summary.schedule, sale_date: "2099-06-03", action_deadline: "2099-06-02" },
  };
  const guide = buildTaxLienCycleGuide(expiredWithFutureDates, "notice_90", "2026-08-03");
  assert.equal(guide.deadline.cycle_status, "expired");
  assert.equal(guide.deadline.live, false);
});

test("buildTaxLienCycleContext scopes parcels to the notice and highlights stage", () => {
  const row = decodeTaxLienBbl(lookup, FIXTURE_BBL);
  assert.ok(row);
  assert.equal(row.stage, "notice_10");

  const ctx = buildTaxLienCycleContext({
    summary,
    lookup,
    notice: {
      request_id: "20250601001",
      property_location: {
        bbls: [FIXTURE_BBL, "9999999999"],
        addresses: [{ bbl: FIXTURE_BBL }],
      },
    },
    today: "2026-08-03",
  });
  assert.ok(ctx);
  assert.equal(ctx.class_id, "tax_lien");
  assert.equal(ctx.bbl, FIXTURE_BBL);
  assert.equal(ctx.parcels.length, 1); // unlisted BBL dropped
  assert.equal(ctx.stage, "notice_10");
  assert.equal(ctx.stepper.find((s) => s.current).id, "notice_10");
  assert.ok(ctx.historical_context);
  assert.equal(ctx.historical_context.cycle_count, 3);
  assert.match(ctx.historical_context.line, /Based on 3 prior cycles/);
  assert.equal(ctx.deadline.state, "closed"); // 2025 cycle expired
  assert.equal(ctx.deadline.live, false);
  assert.ok(ctx.action_channels.exemption_url);
  assert.ok(ctx.action_channels.payment_plan_url);
  assert.ok(ctx.action_channels.lien_sale_help_url);
  assert.deepEqual(ctx.resident_checklist.map((step) => step.id), [
    "exemptions",
    "payment_plans",
    "official_guide",
  ]);
});

test("buildTaxLienCycleContext returns null when no listed parcels", () => {
  const ctx = buildTaxLienCycleContext({
    summary,
    lookup,
    notice: { property_location: { bbls: ["1111111111"] } },
  });
  assert.equal(ctx, null);
});

test("noticeParcelBbls de-duplicates and normalizes", () => {
  assert.deepEqual(
    noticeParcelBbls({
      _property_bbl: "1000110012",
      property_location: {
        bbls: ["1000110012", "3025180036"],
        tax_lots: [{ bbl: "3025180036" }],
      },
    }),
    ["1000110012", "3025180036"],
  );
});

test("disposition cycle context reuses the shared envelope shape", () => {
  const phaseView = {
    phases: [
      { id: "hearing", short: "Hearing", matched: true },
      { id: "auction_or_rfp", short: "Auction", matched: false },
      { id: "award_or_conveyance", short: "Award", matched: false },
    ],
    current: { id: "hearing", matched: true, action_key: "disposition_phase_action_attend" },
    next: { id: "auction_or_rfp" },
    disposition_timing_estimate: {
      kind: "cohort_statistic",
      pattern_line: "A published sale date typically falls 1–6 weeks after the auction notice (34 past Property Disposition notices since 2013).",
      n: 34,
      since_year: "2013",
      public_projection: "cohort_statistic_only",
    },
  };
  const ctx = buildDispositionCycleContext(phaseView, { subject_ref: "disposition:demo" });
  assert.equal(ctx.class_id, "property_disposition");
  assert.equal(ctx.position.current_id, "hearing");
  assert.equal(ctx.position.stages.filter((s) => s.status === "current").length, 1);
  assert.match(ctx.historical_context.line, /^A published sale date/);
  assert.match(ctx.historical_context.attribution, /34 prior dispositions/);
  assert.equal(ctx.survey_status, "implemented");
});

test("class survey names every property cycle class with no dangling deferrals", () => {
  assert.ok(PROPERTY_CYCLE_CONTEXT_SURVEY.length >= 4);
  const byId = Object.fromEntries(PROPERTY_CYCLE_CONTEXT_SURVEY.map((r) => [r.class_id, r]));
  assert.equal(byId.tax_lien.status, "implemented");
  assert.equal(byId.property_disposition.status, "implemented");
  for (const row of PROPERTY_CYCLE_CONTEXT_SURVEY) {
    assert.ok(row.label && row.history);
    if (row.status === "carded") {
      assert.ok(row.card_id, `carded class ${row.class_id} must name a card_id`);
      assert.ok(row.reason);
    }
  }
});

test("property lens demotes the standalone stats destination; notice cycle context ships", () => {
  // Header no longer promotes tax-lien as a navigation destination.
  assert.doesNotMatch(
    SITE_SOURCE,
    /property-tax-lien-link"><a href="#property\?view=tax-lien"/,
  );
  // Archive deep link + panel remain for reference.
  assert.match(SITE_SOURCE, /id="tax-lien-sale-panel"/);
  assert.match(SITE_SOURCE, /data-tax-lien-archive="1"/);
  assert.match(SITE_SOURCE, /["']tax-lien["']/);
  assert.match(SITE_SOURCE, /paintTaxLienSalePanel/);
  // Notice-inline cycle context surface.
  assert.match(SITE_SOURCE, /data-tax-lien-cycle-context/);
  assert.match(SITE_SOURCE, /taxLienNoticeCycleHTML/);
  assert.match(SITE_SOURCE, /buildTaxLienCycleContext/);
  assert.match(SITE_SOURCE, /data-tax-lien-resident-checklist/);
  assert.match(SITE_SOURCE, /data-tax-lien-cycle-status="expired"/);
  assert.match(SITE_SOURCE, /tax_lien_stage_90_meaning/);
  assert.match(SITE_SOURCE, /tax_lien_stage_sold_meaning/);
  assert.match(SITE_SOURCE, /tax_lien_no_lot_tracking/);
  // Disposition generalized cycle-context marker.
  assert.match(SITE_SOURCE, /data-property-cycle-context="property_disposition"/);
  // i18n copy for inline actions + countdown.
  assert.match(i18n, /tax_lien_deadline_open/);
  assert.match(i18n, /tax_lien_archive_note_html/);
  assert.match(i18n, /tax_lien_formula_link/);
  assert.match(i18n, /Properties on the 90-day list historically left the list before sale/);
});
