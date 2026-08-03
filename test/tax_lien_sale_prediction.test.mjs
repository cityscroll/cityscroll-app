import { SITE_SOURCE } from "./helpers/site_source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EVENT_KIND_REGISTRY } from "../worker/src/lib/civic_time.mjs";
import {
  buildTaxLienSaleModel,
  normalizeTaxLienStage,
  taxLienBbl,
} from "../worker/src/lib/tax_lien_sale_model.mjs";
import { emitTaxLienSalePrediction } from "../worker/src/lib/tax_lien_sale_prediction.mjs";

const ROWS = [
  // Three training cycles. The 2020 program stopped after its 10-day publication.
  ...cycle("2019", ["90 Day Notice", "60 Day Notice", "30 Day Notice", "10 Day Notice", "Final Sale"], [
    [1, 100, 1], [1, 100, 2], [2, 200, 1],
  ], { final: [[1, 100, 1]] }),
  ...cycle("2020", ["90 Days Notice", "60 Days Notice", "30 Days Notice", "10 Days Notice"], [
    [1, 110, 1], [2, 210, 1],
  ]),
  ...cycle("2021", ["90 Day Notice", "60 Day Notice", "30 Day Notice", "10 Day Notice", "Final Sale"], [
    [1, 120, 1], [1, 120, 2], [2, 220, 1],
  ], { final: [[1, 120, 2], [2, 220, 1]] }),
  // Held-out cycle: one sold lien and one property that left the list.
  ...cycle("2025", ["90 Day Notice", "60 Day Notice", "30 Day Notice", "10 Day Notice", "Final Sale"], [
    [1, 130, 1], [1, 130, 2],
  ], { final: [[1, 130, 2]] }),
];

function cycle(year, stages, bblParts, options = {}) {
  const finalSet = new Set((options.final || []).map((parts) => parts.join("-")));
  return stages.flatMap((stage, index) => {
    const rows = normalizeTaxLienStage(stage) === "sold"
      ? bblParts.filter((parts) => finalSet.has(parts.join("-")))
      : bblParts;
    return rows.map(([borough, block, lot]) => ({
      month: `${year}-${String(index + 2).padStart(2, "0")}-01T00:00:00.000`,
      cycle: stage,
      borough: String(borough),
      block: String(block),
      lot: String(lot),
      community_board: `${borough}01`,
      house_number: "1",
      street_name: "TEST STREET",
    }));
  });
}

test("normalizes publisher stage variants and constructs canonical BBLs", () => {
  assert.equal(normalizeTaxLienStage("90 Days Notice"), "notice_90");
  assert.equal(normalizeTaxLienStage("Final Sale"), "sold");
  assert.equal(taxLienBbl({ borough: "3", block: "2518", lot: "36" }), "3025180036");
});

test("models per-cycle and borough conversions with a three-cycle training floor", () => {
  const model = buildTaxLienSaleModel(ROWS, {
    holdout_cycle: "2025-02-01",
    generated_at: "2026-08-03T12:00:00.000Z",
    schedules: {
      "2025-02-01": { sale_date: "2025-06-03", action_deadline: "2025-06-02" },
    },
  });
  assert.equal(model.training.cycle_count, 3);
  assert.deepEqual(model.training.cycle_ids, ["2019-02-01", "2020-02-01", "2021-02-01"]);
  assert.equal(model.training.cycles[1].program_outcome, "no_final_sale_publication");
  assert.equal(model.training.citywide.notice_90.denominator, 8);
  assert.equal(model.training.citywide.notice_90.reached_sale, 3);
  assert.equal(model.training.citywide.notice_60.probability_reach_sale, 0.375);
  assert.equal(model.training.boroughs["1"].notice_30.denominator, 5);
  assert.equal(model.holdout.cycle_id, "2025-02-01");
  assert.equal(model.holdout.status, "expired");
  assert.equal(model.holdout.by_bbl["1001300001"].outcome, "left_before_sale");
  assert.equal(model.holdout.by_bbl["1001300002"].outcome, "sold_lien");
});

test("emits occurrence assertions through the prediction contract", () => {
  const model = buildTaxLienSaleModel(ROWS, {
    holdout_cycle: "2025-02-01",
    generated_at: "2025-02-01T12:00:00.000Z",
    schedules: {
      "2025-02-01": { sale_date: "2025-06-03", action_deadline: "2025-06-02" },
    },
  });
  const prediction = emitTaxLienSalePrediction(model, "1001300001");
  assert.equal(prediction.subject_ref, "property-bbl:1001300001");
  assert.equal(prediction.predicted_event_kind, "property.tax_lien_sold");
  assert.equal(prediction.claim, "occurrence");
  assert.equal(prediction.basis.method, "base_rate");
  assert.equal(prediction.basis.statute_ref, null);
});

test("registers lien-sale event vocabulary alongside the landed property kinds", () => {
  assert.ok(EVENT_KIND_REGISTRY["property.tax_lien_notice_90"]);
  assert.ok(EVENT_KIND_REGISTRY["property.tax_lien_sold"]);
  assert.ok(EVENT_KIND_REGISTRY["property.disposition_hearing"]);
});

test("warehouse and source-contract registries include the DOF list", () => {
  const warehouse = JSON.parse(readFileSync(new URL("../warehouse/datasets.v0.json", import.meta.url)));
  const dataset = warehouse.datasets["dof-tax-lien-sale-lists"];
  assert.equal(dataset.dataset_id, "9rz4-mjek");
  assert.equal(dataset.table_name, "dof_tax_lien_sale_lists");
  assert.equal(dataset.bulk_paging.page_size, 50000);

  const sources = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url)));
  const contract = sources.contracts.find((row) => row.id === "dof-tax-lien-sale-lists");
  assert.equal(contract.status, "live");
  assert.deepEqual(contract.required_fields.slice(0, 5), ["month", "cycle", "borough", "block", "lot"]);
});

test("public read models stay action-first and degrade to cohort statistics", () => {
  const summary = JSON.parse(readFileSync(new URL("../site/data/tax_lien_sale_summary.json", import.meta.url)));
  const scorecard = JSON.parse(readFileSync(new URL(
    "../warehouse/receipts/proof/tax_lien_sale_calibration_latest.json",
    import.meta.url,
  )));
  const index = SITE_SOURCE;
  const copy = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");

  assert.equal(summary.training.cycle_count, 3);
  assert.equal(summary.latest_cycle.status, "expired");
  assert.equal(summary.schedule.action_deadline, "2025-06-02");
  assert.equal(summary.public_projection, "cohort_statistic_only");
  assert.equal(scorecard.ship_bar.status, "fail");
  assert.ok(summary.latest_cycle.nta_coverage.rate > 0.8);
  assert.match(summary.action_channels.exemption_url, /nyc\.gov/);
  assert.match(summary.action_channels.payment_plan_url, /nyc\.gov/);
  assert.match(index, /id="tax-lien-sale-panel"/);
  assert.match(copy, /Properties on the 90-day list historically left the list before sale/);
  assert.match(copy, /A lien sale sells the <b>lien<\/b>, not the property/);
  assert.match(index, /tax_lien_action_deadline/);
  assert.match(about, /does not mean the property was sold, foreclosed, or transferred/);
});
