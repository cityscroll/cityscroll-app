// Characterization: prime-win sub-outreach surface on award notices.
// Renders only allowlisted facts from award_prime_goal; empty-state axe for
// not_published goal slots (no apology / data-unavailable copy on the card).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUB_OUTREACH_SCHEMA,
  buildSubOutreachView,
  detectSubOutreachApologyCopy,
  hasSubOutreachSignals,
  isSubOutreachNoticeType,
  subOutreachHTML,
} from "../site/sub_outreach.mjs";
import { buildAwardPrimeGoal } from "../worker/src/lib/award_prime_goal.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(
  readFileSync(join(ROOT, "site", "data", "gap_taxonomy.json"), "utf8"),
);
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US")}`;
}

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

const FULL_PAYLOAD = buildAwardPrimeGoal(AWARD_NOTICE, null);

test("isSubOutreachNoticeType accepts awards and rejects wrong universes", () => {
  assert.equal(isSubOutreachNoticeType(AWARD_NOTICE), true);
  assert.equal(
    isSubOutreachNoticeType({
      section_name: "Property Disposition",
      type_of_notice_description: "Notice",
    }),
    false,
  );
  assert.equal(
    isSubOutreachNoticeType({
      type_of_notice_description: "Intent to Award",
    }),
    true,
  );
});

test("buildSubOutreachView surfaces prime / agency / dollars / industry / window only", () => {
  assert.equal(FULL_PAYLOAD.subcontract_goal.status, "not_published");
  assert.equal(FULL_PAYLOAD.possible_subcontract_window.status, "open_candidate");

  const view = buildSubOutreachView(FULL_PAYLOAD);
  assert.equal(view.schema, SUB_OUTREACH_SCHEMA);
  assert.equal(view.show, true);
  assert.equal(view.prime.display_name, "HNTB CORPORATION");
  assert.equal(view.agency.display_name, "Design and Construction");
  assert.equal(view.dollars.amount, 4020000);
  assert.equal(view.industry_chips.length, 1);
  assert.match(view.industry_chips[0].label, /Construction/i);
  assert.equal(view.window_callout.status, "open_candidate");
  // HARD RULE: goal_block is always null on this surface.
  assert.equal(view.goal_block, null);
});

test("hasSubOutreachSignals is false when nothing allowlisted exists", () => {
  assert.equal(hasSubOutreachSignals(null), false);
  assert.equal(
    hasSubOutreachSignals({
      eligible: true,
      prime: {},
      agency: {},
      dollars: {},
      industry_chips: [],
      possible_subcontract_window: { status: "unknown" },
      subcontract_goal: { status: "not_published", goal_percent: null },
    }),
    false,
  );
  assert.equal(hasSubOutreachSignals(FULL_PAYLOAD), true);
});

test("subOutreachHTML paints allowlisted facts and omits goal gap copy", () => {
  const html = subOutreachHTML(FULL_PAYLOAD, { t, esc, money });
  assert.match(html, /data-sub-outreach="1"/);
  assert.match(html, /HNTB CORPORATION/);
  assert.match(html, /Design and Construction/);
  assert.match(html, /4,020,000|\$4\.02M|\$4020000|4\.02/);
  assert.match(html, /Construction/);
  assert.match(html, /data-window-status="open_candidate"/);
  assert.match(html, /Possible subcontract window/i);

  // Empty-state axe: no apology / not-published / unavailable copy.
  assert.equal(detectSubOutreachApologyCopy(html).length, 0, html);
  assert.doesNotMatch(html, /data unavailable/i);
  assert.doesNotMatch(html, /not published/i);
  assert.doesNotMatch(html, /city does not publish/i);
  assert.doesNotMatch(html, /not yet shown here/i);
  assert.doesNotMatch(html, /goal_percent|goal percent|remaining goal/i);
  assert.doesNotMatch(html, /data-field="goal"/);
});

test("subOutreachHTML returns empty string when goal gap is the only 'fact'", () => {
  // Side-car with only not_published goal and no prime/agency/dollars/chips/window.
  const html = subOutreachHTML(
    {
      eligible: true,
      prime: { display_name: null },
      agency: {},
      dollars: { amount: null },
      industry_chips: [],
      subcontract_goal: {
        status: "not_published",
        class: "not_published",
        goal_percent: null,
        would_appear_in: "agency reports",
      },
      possible_subcontract_window: {
        status: "unknown",
        goal_data: "honest_absent",
      },
    },
    { t, esc, money },
  );
  assert.equal(html, "");
});

test("subOutreachHTML still paints when goal is not_published but prime exists", () => {
  const payload = {
    ...FULL_PAYLOAD,
    subcontract_goal: {
      status: "not_published",
      class: "not_published",
      goal_percent: null,
      would_appear_in: "should never appear on card",
      evidence: "should never appear on card",
    },
  };
  const html = subOutreachHTML(payload, { t, esc, money });
  assert.match(html, /HNTB/);
  assert.doesNotMatch(html, /should never appear on card/);
  assert.equal(detectSubOutreachApologyCopy(html).length, 0);
});

test("window callout only when open_candidate", () => {
  const noWin = buildSubOutreachView({
    ...FULL_PAYLOAD,
    possible_subcontract_window: {
      status: "unknown",
      basis: "prime_vendor_not_resolved",
      has_prime: false,
    },
    prime: { display_name: null },
  });
  // No prime → no window; may still show agency/dollars/chips from FULL_PAYLOAD.
  const view = buildSubOutreachView({
    eligible: true,
    prime: { display_name: "ACME LLC" },
    agency: null,
    dollars: null,
    industry_chips: [],
    possible_subcontract_window: { status: "not_applicable" },
    subcontract_goal: { status: "not_published", goal_percent: null },
  });
  assert.equal(view.window_callout, null);
  assert.equal(view.prime.display_name, "ACME LLC");
  assert.equal(view.show, true);

  const withWin = buildSubOutreachView({
    eligible: true,
    prime: { display_name: "ACME LLC" },
    agency: null,
    dollars: null,
    industry_chips: [],
    possible_subcontract_window: { status: "open_candidate", basis: "award_or_registration_with_prime" },
    subcontract_goal: { status: "not_published", goal_percent: null },
  });
  assert.equal(withWin.window_callout.status, "open_candidate");
  void noWin;
});

test("data-wishlist gap inventory carries subcontract goal not_published (not notice cards)", () => {
  const gap = registry.gaps.find((g) => g.id === "procurement-subcontract-goal-percent");
  assert.ok(gap, "wishlist gap must exist");
  assert.equal(gap.class, "not_published");
  assert.equal(gap.i18n_key, null, "no notice-card i18n key — gap is inventory-only");
  assert.match(gap.would_appear_in || "", /Comptroller|goal|M\/WBE/i);
  assert.match(gap.evidence || "", /not_published|goal_percent|apology/i);
});

test("i18n ships sub_outreach keys (English fallback)", () => {
  assert.equal(t("sub_outreach_heading"), "Prime award snapshot");
  assert.equal(t("sub_outreach_prime_lbl"), "Prime vendor");
  assert.match(t("sub_outreach_window_callout"), /subcontract window/i);
  // Provenance must not trip apology detector when rendered.
  const how = t("sub_outreach_provenance_html");
  assert.equal(detectSubOutreachApologyCopy(how).length, 0, how);
});
