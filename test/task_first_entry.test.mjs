import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Characterization tests for the bounded task-first entry experiment:
// five real procurement notices ("Can I bid?") and five real ZAP projects
// ("What will change here?"). Official fields must stay intact; payment-lag
// copy must not claim unmeasured bid-count causality.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const TaskFirst = require(join(ROOT, "site/task_first.js"));
const bundle = JSON.parse(readFileSync(join(ROOT, "site/data/task_first_examples.json"), "utf8"));
const html = SITE_SOURCE;
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");

// Verbatim field cases captured 2026-07-29 from NYC Open Data (dg92-zbpx / hgx4-8ukb).
const PROC_CASE = {
  request_id: "20260624023",
  agency_name: "Citywide Administrative Services",
  type_of_notice_description: "Solicitation",
  selection_method_description: "Competitive Sealed Bids",
  pin: "85726B0060",
  due_date: "2026-08-05T10:00:00.000",
  short_title: "85726B0060-2600042 - Tub Grinder - Parks",
};

const ZAP_CASE = {
  project_id: "2026X0362",
  project_name: "351 Powers Avenue (HPD ELURP)",
  borough: "Bronx",
  community_district: "X01",
  public_status: "In Public Review",
  current_milestone: "PP - City Council Review",
  actions: "PP",
};

test("bundle ships exactly five procurement and five ZAP examples", () => {
  assert.equal(bundle.schema_version, 1);
  assert.equal(bundle.delivery_tier, "inline-at-build");
  assert.equal(TaskFirst.listTaskIds(bundle, "can-i-bid").length, 5);
  assert.equal(TaskFirst.listTaskIds(bundle, "what-will-change").length, 5);
  assert.equal(bundle.payment_lag_policy.bid_count_causality_measured, false);
});

test("real procurement field case is present verbatim and presents task-first", () => {
  const example = TaskFirst.findExample(bundle, "can-i-bid", PROC_CASE.request_id);
  assert.ok(example, "tub grinder solicitation must be in the bundle");
  for (const [key, value] of Object.entries(PROC_CASE)) {
    assert.equal(example.official[key], value, key);
  }
  const presentation = TaskFirst.presentCanIBid(example, { now: "2026-07-29T12:00:00.000Z" });
  assert.equal(presentation.task, "can-i-bid");
  assert.equal(presentation.bid_status.open, true);
  assert.equal(presentation.lead.stage, "Solicitation");
  assert.equal(presentation.lead.method, "Competitive Sealed Bids");
  assert.equal(presentation.lead.pin, "85726B0060");
  assert.equal(presentation.notice_hash, "#notice/20260624023");
  assert.ok(TaskFirst.officialFieldsIntact(example, presentation));
});

test("real ZAP field case is present verbatim and leads with place/boundary/stage", () => {
  const example = TaskFirst.findExample(bundle, "what-will-change", ZAP_CASE.project_id);
  assert.ok(example, "Powers Avenue ZAP project must be in the bundle");
  for (const [key, value] of Object.entries(ZAP_CASE)) {
    assert.equal(example.official[key], value, key);
  }
  const presentation = TaskFirst.presentWhatWillChange(example);
  assert.equal(presentation.task, "what-will-change");
  assert.equal(presentation.lead.place, "Bronx · X01");
  assert.equal(presentation.lead.boundary, "PP");
  assert.equal(presentation.lead.stage, "In Public Review");
  assert.ok(presentation.facts.brief && presentation.facts.brief.length > 40);
  assert.equal(presentation.land_hash, "#land/2026X0362");
  assert.ok(TaskFirst.officialFieldsIntact(example, presentation));
});

test("every bundled example keeps every official field after presentation", () => {
  for (const task of ["can-i-bid", "what-will-change"]) {
    for (const example of bundle.tasks[task].examples) {
      const presentation = TaskFirst.presentExample(example, { now: "2026-07-29T12:00:00.000Z" });
      assert.ok(presentation, example.id);
      assert.ok(TaskFirst.officialFieldsIntact(example, presentation), example.id);
      // Source link and id always required for verifiability.
      assert.ok(example.source?.url, example.id);
      assert.ok(example.source?.dataset_id, example.id);
    }
  }
});

test("bid status variants: open, closed, rolling, unknown", () => {
  const base = {
    task: "can-i-bid",
    official: {
      request_id: "fixture-1",
      type_of_notice_description: "Solicitation",
      selection_method_description: "Request for Proposals",
      due_date: "2026-08-10T15:00:00.000",
      agency_name: "Test Agency",
      pin: "TEST1",
      short_title: "Fixture open",
    },
  };
  assert.equal(TaskFirst.bidStatus(base.official, "2026-08-01").key, "open");
  assert.equal(TaskFirst.bidStatus({ due_date: "2026-07-01T10:00:00.000" }, "2026-07-29").key, "closed");
  assert.equal(TaskFirst.bidStatus({ due_date: "Rolling until expended" }).key, "rolling");
  assert.equal(TaskFirst.bidStatus({}).key, "unknown");
});

test("payment lag may cite observed figures only and never claims bid-count causality", () => {
  const lag = TaskFirst.presentPaymentLag({
    days: 15,
    source: "NYC Comptroller Late Contracts Dashboard",
    source_url: "https://comptroller.nyc.gov/reports/nyc-contracts/",
    subject: "CT1-841-20258800411",
    measured_as: "registration_lag_days",
  });
  assert.equal(lag.days, 15);
  assert.equal(lag.bid_count_causality_claimed, false);

  assert.equal(TaskFirst.presentPaymentLag(null), null);
  assert.equal(TaskFirst.presentPaymentLag({ days: 10 }), null); // source required

  assert.ok(TaskFirst.paymentLagCopyIsSafe(
    "Observed payment registration lag: 15 days for a related recorded contract. This is a recorded lag figure only; it is not a measure of how many bids the city received.",
  ));
  assert.ok(!TaskFirst.paymentLagCopyIsSafe("Payment lag causes fewer bids from vendors."));
  assert.ok(!TaskFirst.paymentLagCopyIsSafe("Bids fell because of payment lag."));

  // Bundled open solicitations must not invent lag or causality.
  for (const example of bundle.tasks["can-i-bid"].examples) {
    assert.equal(example.observed_payment_lag, null, example.id);
    const presentation = TaskFirst.presentCanIBid(example);
    assert.equal(presentation.observed_payment_lag, null, example.id);
  }
});

test("hash parser recognizes collection and item task routes", () => {
  assert.deepEqual(TaskFirst.parseTaskHash("task/can-i-bid"), {
    task: "can-i-bid",
    id: null,
    collection: true,
  });
  assert.deepEqual(TaskFirst.parseTaskHash("#task/what-will-change/2026X0362"), {
    task: "what-will-change",
    id: "2026X0362",
    collection: false,
  });
  assert.equal(TaskFirst.parseTaskHash("money"), null);
  assert.equal(TaskFirst.taskItemHash("can-i-bid", "20260624023"), "#task/can-i-bid/20260624023");
});

test("task pane is additive — civic-object tabs stay in place", () => {
  // Homepage scenario entry links were removed (owner noise cut); task-first remains a
  // deep-link hash route (#task/…) with its own pane, not a replacement for category tabs.
  assert.match(html, /id="tab-task"/);
  assert.match(html, /src="task_first\.js"/);
  assert.match(html, /function showTaskFirst\(/);
  assert.match(html, /"task\/can-i-bid"/);
  assert.match(html, /"task\/what-will-change"/);
  for (const group of ["money", "people", "land", "rules", "meetings"]) {
    assert.match(html, new RegExp(`data-tab="${group}"`));
  }
  assert.match(html, /Civic objects/);
  assert.doesNotMatch(html, /class="tabbtn"[^>]+data-tab="alerts"/);
  assert.match(html, /href="\/following\/"/);
});

test("English catalog ships task-first visitor strings", () => {
  for (const key of [
    "task_can_i_bid_title",
    "task_what_will_change_title",
    "task_bid_yes_until",
    "task_payment_lag_observed_html",
    "task_example_not_found",
  ]) {
    assert.match(i18n, new RegExp(`${key}:`));
  }
  // Payment lag copy must keep the non-causal clause in English.
  assert.match(i18n, /not a measure of how many bids the city received/);
});
