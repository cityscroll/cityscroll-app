import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ABO_FUZZY_PRECISION_FLOOR,
  ABO_USEFULNESS_THRESHOLD,
  buildAboResidualPayload,
  classifyAboAwardCandidate,
  measureAboResidualJoin,
  rankAboAwardCandidates,
} from "../worker/src/lib/abo_awards_join.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(
  join(ROOT, "warehouse/fixtures/abo-awards-residual/labeled_sample.json"),
  "utf8",
));
const receipt = JSON.parse(readFileSync(
  join(ROOT, "site/data/abo_award_sources/verification_receipts/abo_residual_2026-08-04.json"),
  "utf8",
));

test("strong ABO candidate paths require identifiers or vendor+amount evidence", () => {
  const notice = {
    request_id: "N-1",
    start_date: "2024-01-01",
    pin: "SCA-24-001",
    vendor_name: "Acme Builders LLC",
    contract_amount: "125000",
    short_title: "Roof replacement",
  };
  const exact = classifyAboAwardCandidate(notice, {
    transaction_number: "SCA 24 001",
    vendor_name: "Different Vendor",
    contract_amount: 1,
    procurement_description: "Unrelated work",
    award_date: "2024-02-01",
  });
  assert.equal(exact.classification, "strong");
  assert.equal(exact.method, "exact_identifier_date");

  const composite = classifyAboAwardCandidate(notice, {
    vendor_name: "ACME BUILDERS, INC.",
    contract_amount: "$125,000.00",
    procurement_description: "Roof replacement services",
    award_date: "2024-02-15",
  });
  assert.equal(composite.classification, "strong");
  assert.equal(composite.method, "vendor_amount_date");
});

test("broad title similarity and ambiguous candidates never become edges", () => {
  const notice = {
    request_id: "N-2",
    start_date: "2024-04-05",
    short_title: "HVAC installation for Building 309",
  };
  const awards = [
    { vendor_name: "Vendor A", procurement_description: "HVAC installation services", award_date: "2024-05-06", contract_amount: 11367 },
    { vendor_name: "Vendor B", procurement_description: "HVAC installation services", award_date: "2024-05-31", contract_amount: 214500 },
  ];
  const ranked = rankAboAwardCandidates(notice, awards);
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((row) => row.classification === "fuzzy_candidate"));
  assert.equal(ranked[0].title_similarity, ranked[1].title_similarity);
  assert.ok(ranked.every((row) => row.materializable === false));
});

test("fixed residual sample reproduces the measured kill", () => {
  const measured = measureAboResidualJoin(fixture);
  assert.equal(fixture.notices.length, 50);
  assert.equal(measured.sample.total, 50);
  assert.equal(measured.signal_availability.vendor, 0);
  assert.equal(measured.signal_availability.amount, 0);
  assert.equal(measured.signal_availability.shared_exact_identifier, 0);
  assert.equal(measured.review.true_match, 1);
  assert.equal(measured.review.false_positive, 5);
  assert.equal(measured.review.ambiguous, 4);
  assert.equal(measured.fuzzy_precision, 0.5);
  assert.equal(measured.joined, 1);
  assert.equal(measured.join_rate, 0.02);
  assert.equal(measured.gate.status, "stopped_below_threshold");
  assert.equal(measured.gate.materialize, false);
  assert.deepEqual(measured.edges, []);
});

test("published receipt and payload contract preserve the honest-absent result", () => {
  assert.equal(receipt.join_measurement.usefulness_threshold, ABO_USEFULNESS_THRESHOLD);
  assert.equal(receipt.join_measurement.fuzzy_precision_floor, ABO_FUZZY_PRECISION_FLOOR);
  assert.equal(receipt.join_measurement.joined, 1);
  assert.equal(receipt.join_measurement.total, 50);
  assert.equal(receipt.join_measurement.rate, 0.02);
  assert.equal(receipt.join_measurement.false_positive_review.false_positive, 5);
  assert.equal(receipt.join_measurement.false_positive_review.ambiguous, 4);
  assert.match(receipt.join_measurement.verdict, /STOP/i);

  const payload = buildAboResidualPayload(measureAboResidualJoin(fixture), {
    observedAt: receipt.observed_at_utc,
    sourceContracts: receipt.source_contracts,
  });
  assert.equal(payload.schema, "cityscroll.abo_award_residual.v1");
  assert.equal(payload.bridge.status, "stopped_below_threshold");
  assert.deepEqual(payload.matches_by_request_id, {});
  assert.equal(payload.unresolved.sample_count, 50);
  assert.match(payload.unresolved.semantics, /no speculative/i);
});

test("collector, warehouse registry, and source contracts expose the infrastructure contract", () => {
  const collector = readFileSync(join(ROOT, "warehouse/scripts/abo_awards.mjs"), "utf8");
  assert.match(collector, /CityScrollWarehouse\/0\.3/);
  assert.match(collector, /checkpoint\.json/);
  assert.match(collector, /delayMs < 250/);
  assert.match(collector, /HTTP 403\); stopped without retry/);

  const datasets = JSON.parse(readFileSync(join(ROOT, "warehouse/datasets.v0.json"), "utf8"));
  for (const id of ["abo-local-authorities", "abo-local-development-corporations", "abo-state-authorities"]) {
    assert.ok(datasets.datasets[id], `${id} is missing from warehouse registry`);
  }
  assert.equal(datasets.datasets["abo-state-authorities"].required_fields.includes("transaction_number"), true);

  const contracts = loadSourceContracts().contracts.filter((contract) =>
    contract.id.startsWith("abo-")
  );
  assert.equal(contracts.length, 3);
  assert.ok(contracts.every((contract) => contract.join_measurement?.rates?.labeled_residual?.rate === 0.02));
  assert.ok(contracts.every((contract) => /do not materialize/i.test(contract.join_measurement.verdict)));

  const tables = new Map(receipt.warehouse.tables.map((table) => [table.table, table.row_count]));
  assert.equal(tables.get("abo_residual_notice"), 50);
  assert.equal(tables.get("abo_residual_candidate"), 47);
  assert.equal(tables.get("abo_residual_match"), 0);
  assert.equal(tables.get("abo_residual_measurement"), 1);

  const sitePayload = readFileSync(join(ROOT, "site/data/abo_award_residual_lookup.json"), "utf8");
  const workerPayload = readFileSync(join(ROOT, "worker/src/data/abo_award_residual_lookup.json"), "utf8");
  assert.equal(workerPayload, sitePayload);
});
