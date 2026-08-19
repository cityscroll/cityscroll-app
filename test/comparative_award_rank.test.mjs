import assert from "node:assert/strict";
import test from "node:test";

import {
  AWARD_RANK_SMALL_N_POLICY,
  buildAwardRankComparativeReadModel,
} from "../site/comparative_award_rank.mjs";

const MATERIALIZED_AT = "2026-08-05T10:40:50.286Z";

function award(requestId, agencyName, amount, startDate = "2025-06-01") {
  return {
    request_id: requestId,
    start_date: startDate,
    agency_name: agencyName,
    type_of_notice_description: "Award",
    short_title: `Award ${requestId}`,
    pin: `PIN-${requestId}`,
    contract_amount: String(amount),
    vendor_name: `Vendor ${requestId}`,
  };
}

function lookup(rows) {
  return {
    schema_version: 1,
    source: "warehouse",
    dataset_id: "qyyg-4tf5",
    table_name: "ocp_recent_contract_awards",
    mode: "bulk_warehouse",
    materialized_at: MATERIALIZED_AT,
    row_count: rows.length,
    rows,
  };
}

function sourceContract(rows) {
  return {
    id: "ocp-recent-contract-awards",
    name: "Recent Contract Awards (OCP)",
    status: "live",
    dataset_id: "qyyg-4tf5",
    landing_page: "https://data.cityofnewyork.us/d/qyyg-4tf5",
    delivery_tier: "edge-materialized",
    warehouse_snapshot: {
      status: "materialized",
      artifact: "site/data/ocp_awards_warehouse_lookup.json",
      materialized_at: MATERIALIZED_AT,
      row_count: rows.length,
    },
  };
}

function pilotRows() {
  const police = Array.from({ length: 40 }, (_, index) => award(
    `police-${String(index + 1).padStart(2, "0")}`,
    "Police Department",
    index === 0 ? 1000 : index <= 2 ? 900 : 800 - index,
  ));
  const hpd = Array.from({ length: 12 }, (_, index) => award(
    `hpd-${String(index + 1).padStart(2, "0")}`,
    "Housing Preservation and Development",
    500 - index,
  ));
  const parks = Array.from({ length: 9 }, (_, index) => award(
    `parks-${String(index + 1).padStart(2, "0")}`,
    "Parks and Recreation",
    300 - index,
  ));
  return [
    ...police,
    ...hpd,
    ...parks,
    award("bad-amount", "Police Department", 10_000_000_000),
    award("unresolved-agency", "Mystery Procurement Bureau", 250),
    award("duplicate-subject", "Police Department", 240),
    award("duplicate-subject", "Police Department", 230),
    { ...award("missing-subject", "Police Department", 220), request_id: "" },
  ];
}

test("award-rank receipts use stable ties and the family-specific small-N policy", () => {
  const rows = pilotRows();
  const model = buildAwardRankComparativeReadModel(lookup(rows), {
    sourceContract: sourceContract(rows),
    sourceContractsSchemaVersion: 1,
    windowStart: "2024-01-01",
  });

  assert.equal(model.schema, "cityscroll.comparative_fact_read_model.v1");
  assert.deepEqual(model.small_n_policies.award_amount_rank, AWARD_RANK_SMALL_N_POLICY);
  assert.equal(model.coverage_receipt.eligible_count, 61);
  assert.equal(model.coverage_receipt.observed_count, 61);
  assert.equal(model.coverage_receipt.exclusions_by_reason.invalid_amount, 1);
  assert.equal(model.coverage_receipt.exclusions_by_reason.unresolved_agency_identity, 1);
  assert.equal(model.coverage_receipt.exclusions_by_reason.duplicate_subject_identity, 2);
  assert.equal(model.coverage_receipt.exclusions_by_reason.missing_subject_identity, 1);

  const tied = model.facts.find((fact) => fact.subject.id === "police-02");
  const tiedPeer = model.facts.find((fact) => fact.subject.id === "police-03");
  assert.equal(tied.comparison.rank, 2);
  assert.equal(tiedPeer.comparison.rank, 2);
  assert.equal(tied.comparison.tie_count, 2);
  assert.equal(tied.comparison.percentile, 97.5);
  assert.equal(tied.comparison.percentile_status, "available");

  const rankOnly = model.facts.find((fact) => fact.subject.id === "hpd-01");
  assert.equal(rankOnly.comparison.rank, 1);
  assert.equal(rankOnly.comparison.percentile, null);
  assert.equal(rankOnly.comparison.percentile_status, "withheld_small_n");
  assert.equal(model.facts.some((fact) => fact.subject.id.startsWith("parks-")), false);
  assert.equal(model.facts.some((fact) => fact.subject.id === "duplicate-subject"), false);
});

test("each award-rank fact carries the comparison, observation, evidence, and provenance contracts", () => {
  const rows = pilotRows();
  const model = buildAwardRankComparativeReadModel(lookup(rows), {
    sourceContract: sourceContract(rows),
    sourceContractsSchemaVersion: 1,
    windowStart: "2024-01-01",
  });
  const fact = model.facts.find((candidate) => candidate.subject.id === "police-01");

  assert.equal(fact.schema, "cityscroll.comparative_fact.v1");
  assert.deepEqual(fact.metric, {
    id: "award_amount_rank",
    family: "distributional_position",
    unit: "USD",
    method: "source_bounded_award_amount_rank_v1",
  });
  assert.equal(fact.value, 1000);
  assert.equal(fact.peer_class.peer_dimensions.agency_id, "police-department");
  assert.equal(fact.peer_class.observability_equivalence.basis, "bounded_complete");
  assert.deepEqual(fact.comparison.population, {
    object_type: "award",
    source_family: "ocp-recent-contract-awards",
    agency_id: "police-department",
    agency_name: "Police Department",
  });
  assert.equal(fact.comparison.eligible_count, 40);
  assert.equal(fact.comparison.observed_count, 40);
  assert.deepEqual(fact.comparison.window, {
    start: "2024-01-01",
    end: "2026-08-05",
    end_inclusive: true,
  });
  assert.equal(fact.observation.basis, "bounded_complete");
  assert.equal(fact.observation.negative_inference, "forbidden");
  assert.equal(fact.observation.eligible_count, 40);
  assert.equal(fact.observation.observed_count, 40);
  assert.equal(fact.observation.source_vintages[0].materialized_at, MATERIALIZED_AT);
  assert.equal(fact.evidence[0].source_row_id, "police-01");
  assert.equal(fact.provenance.source_contract.id, "ocp-recent-contract-awards");
  assert.equal(fact.generated_at, MATERIALIZED_AT);
});

test("invalid or incomplete source receipts fail closed before producing facts", () => {
  const rows = Array.from({ length: 10 }, (_, index) => award(`police-${index}`, "Police Department", 100 - index));
  const complete = sourceContract(rows);
  const incomplete = { ...complete, warehouse_snapshot: { ...complete.warehouse_snapshot, status: "missing" } };
  const badCount = { ...lookup(rows), row_count: rows.length + 1 };

  for (const model of [
    buildAwardRankComparativeReadModel(lookup(rows), { sourceContract: incomplete }),
    buildAwardRankComparativeReadModel(badCount, { sourceContract: complete }),
    buildAwardRankComparativeReadModel(lookup(rows), { sourceContract: null }),
  ]) {
    assert.deepEqual(model.facts, []);
    assert.equal(model.coverage_receipt.state, "unavailable");
    assert.ok(model.coverage_receipt.reasons.length >= 1);
  }
});
