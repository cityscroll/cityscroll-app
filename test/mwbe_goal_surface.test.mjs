// Characterization: M/WBE goal chips + award sub-outreach surface view models.
// Consumes solicitation procurement_method (PR 450) and award_prime_goal (PR 452).

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MWBE_GOAL_SURFACE_SCHEMA,
  SOLICITATION_CHIP_KIND,
  buildSolicitationListChips,
  buildSolicitationMwbeView,
  buildSubOutreachView,
  resolveProcurementMethod,
  shouldShowSubOutreach,
  solicitationMethodChips,
} from "../site/mwbe_goal_surface.mjs";
import { buildAwardPrimeGoal } from "../worker/src/lib/award_prime_goal.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const solFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/solicitation_procurement_method/real_notices.json", import.meta.url),
  ),
);

const AWARD_NOTICE = {
  request_id: "20231222103",
  agency_name: "Design and Construction",
  type_of_notice_description: "Award",
  section_name: "Procurement",
  short_title: "Construction Management Services",
  pin: "07123E0076001",
  vendor_name: "HNTB CORPORATION",
  contract_amount: "4020000",
  category_description: "Construction/Construction Services",
  start_date: "2023-12-22",
};

test("list chips: §6-129 with goal % on real solicitation 20260720022", () => {
  const row = solFixture.cases.find((c) => c.request_id === "20260720022").row;
  const chips = buildSolicitationListChips(row);
  assert.ok(chips.some((c) => c.kind === SOLICITATION_CHIP_KIND.SECTION_6_129_GOAL));
  const goal = chips.find((c) => c.kind === SOLICITATION_CHIP_KIND.SECTION_6_129_GOAL);
  assert.equal(goal.goal_percent, 30);
  assert.equal(goal.i18n_key, "mwbe_chip_goal_percent");
  // Non-default floor is list-eligible; default is not.
  assert.ok(chips.some((c) => c.kind === SOLICITATION_CHIP_KIND.RESPONSE_FLOOR));
  assert.equal(
    chips.find((c) => c.kind === SOLICITATION_CHIP_KIND.RESPONSE_FLOOR).days,
    27,
  );
});

test("list chips: NCSP method from real small-purchase solicitations", () => {
  const row = solFixture.cases.find((c) => c.request_id === "20251118032").row;
  const chips = buildSolicitationListChips(row);
  assert.ok(chips.some((c) => c.kind === SOLICITATION_CHIP_KIND.NCSP));
  // Default 20-day floor stays off the list.
  assert.equal(
    chips.some((c) => c.kind === SOLICITATION_CHIP_KIND.RESPONSE_FLOOR),
    false,
  );
});

test("list chips: awards never get solicitation method chips", () => {
  assert.deepEqual(buildSolicitationListChips(AWARD_NOTICE), []);
});

test("detail view includes default floor when distinctive markers exist", () => {
  const row = solFixture.cases.find((c) => c.request_id === "20251118032").row;
  const view = buildSolicitationMwbeView(row);
  assert.ok(view);
  assert.equal(view.schema, MWBE_GOAL_SURFACE_SCHEMA);
  assert.ok(view.chips.some((c) => c.kind === SOLICITATION_CHIP_KIND.NCSP));
  assert.ok(view.chips.some((c) => c.kind === SOLICITATION_CHIP_KIND.RESPONSE_FLOOR));
  assert.equal(view.floor?.days, 20);
});

test("detail view hidden when only default floor would apply (no markers)", () => {
  const row = solFixture.cases.find((c) => c.request_id === "20260727019").row;
  // Governors Island RFP — no §6-129 / NCSP / accelerated in fixture.
  const view = buildSolicitationMwbeView(row);
  assert.equal(view, null);
});

test("resolveProcurementMethod prefers structured_facts over re-extract", () => {
  const pm = {
    schema: "cityscroll.solicitation_procurement_method.v1",
    section_6_129: { present: true, goal_percent: 12 },
    mwbe_noncompetitive_small_purchase: null,
    accelerated: null,
    response_floor: null,
  };
  const got = resolveProcurementMethod(
    { structured_facts: { procurement_method: pm } },
    null,
  );
  assert.equal(got.section_6_129.goal_percent, 12);
});

test("solicitationMethodChips: accelerated tone is soon", () => {
  const chips = solicitationMethodChips({
    accelerated: { present: true },
    response_floor: {
      kind: "accelerated_3_business_days",
      days: 3,
      day_unit: "business_days",
    },
  });
  assert.ok(chips.some((c) => c.kind === SOLICITATION_CHIP_KIND.ACCELERATED && c.tone === "soon"));
  assert.ok(
    chips.some(
      (c) => c.kind === SOLICITATION_CHIP_KIND.RESPONSE_FLOOR && c.i18n_key === "mwbe_chip_floor_business",
    ),
  );
});

test("sub-outreach view gates on open_candidate and honest-absent goal", () => {
  const lifecycle = {
    timeline: [
      {
        stage: "registered",
        status: "matched",
        detail: {
          vendor: "HNTB Corp",
          mwbe: "Non-M/WBE",
          contract_id: "CT107120248803393",
          current_amount: 4020000,
        },
      },
    ],
    pin: AWARD_NOTICE.pin,
  };
  const apg = buildAwardPrimeGoal(AWARD_NOTICE, lifecycle);
  assert.equal(apg.possible_subcontract_window.status, "open_candidate");
  const view = buildSubOutreachView(apg);
  assert.ok(view);
  assert.equal(view.show, true);
  assert.equal(view.callout, true);
  assert.equal(view.prime.display_name, "HNTB CORPORATION");
  assert.equal(view.dollars.amount, 4020000);
  assert.ok(view.industry_chips.some((c) => /Construction/i.test(c.label)));
  assert.equal(view.subcontract_goal.status, "not_published");
  assert.equal(view.subcontract_goal.goal_percent, null);
  assert.equal(view.subcontract_goal.goal_data, "honest_absent");
});

test("sub-outreach hidden when window is not_applicable", () => {
  const view = buildSubOutreachView({
    eligible: false,
    possible_subcontract_window: { status: "not_applicable" },
    prime: { display_name: "X" },
  });
  assert.equal(view, null);
  assert.equal(shouldShowSubOutreach({ award_prime_goal: { eligible: false } }), false);
});

test("sub-outreach never fabricates remaining_percent from absent goals", () => {
  const view = buildSubOutreachView({
    eligible: true,
    possible_subcontract_window: {
      status: "open_candidate",
      has_prime: true,
      has_dollars: true,
      goal_data: "honest_absent",
    },
    prime: { display_name: "ACME LLC", stem: "ACME" },
    agency: { display_name: "Parks" },
    dollars: { amount: 100000, source: "city-record" },
    industry_chips: [],
    subcontract_goal: {
      status: "not_published",
      class: "not_published",
      goal_percent: null,
      remaining_percent: null,
    },
  });
  assert.equal(view.subcontract_goal.remaining_percent, null);
  assert.equal(view.subcontract_goal.goal_percent, null);
});

test("site modules mount solicitation and sub-outreach slots", () => {
  assert.match(SITE_SOURCE, /id="nmwbe"/);
  assert.match(SITE_SOURCE, /id="nsuboutreach"|id="nsubreach"/);
  assert.match(SITE_SOURCE, /id="dmwbe"/);
  assert.match(SITE_SOURCE, /id="dsuboutreach"|id="dsubreach"/);
  assert.match(SITE_SOURCE, /loadSolicitationMwbe/);
  assert.match(SITE_SOURCE, /data-mwbe-sub-outreach|sub-outreach-detail|sub_outreach/);
  assert.match(SITE_SOURCE, /mwbe_goal_surface\.mjs/);
  assert.match(SITE_SOURCE, /mwbe_sol_heading|mwbe_chip_goal_percent|loadSolicitationMwbe/);
});

test("i18n English dictionary carries surface keys", () => {
  const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  for (const key of [
    "mwbe_chip_goal_percent",
    "mwbe_chip_ncsp",
    "mwbe_sol_heading",
    "mwbe_sub_heading",
    "mwbe_sub_goal_not_published_html",
    "mwbe_sub_lead_html",
  ]) {
    assert.match(i18n, new RegExp(`${key}:\\s*"`), `missing en key ${key}`);
  }
  // Public copy must not invent remaining-goal capacity language.
  assert.doesNotMatch(i18n, /goals remaining|remaining goal capacity/i);
});
