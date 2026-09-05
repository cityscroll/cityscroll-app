import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMPARATIVE_FACT_SCHEMA,
  createComparativeFact,
} from "../site/comparative_receipt.mjs";
import { buildAwardRankComparativeReadModel } from "../site/comparative_award_rank.mjs";
import { buildComparativeAwardRankArtifact } from "../tools/build_comparative_award_rank.mjs";

const MATERIALIZED_AT = "2026-08-05T10:40:50.286Z";

function rows() {
  return Array.from({ length: 10 }, (_, index) => ({
    request_id: `award-${String(index + 1).padStart(2, "0")}`,
    start_date: "2025-01-01",
    agency_name: "Police Department",
    type_of_notice_description: "Award",
    short_title: `Award ${index + 1}`,
    pin: `PIN-${index + 1}`,
    contract_amount: String(1000 - index),
    vendor_name: `Vendor ${index + 1}`,
  }));
}

function inputs(sourceRows) {
  return {
    lookup: {
      schema_version: 1,
      source: "warehouse",
      dataset_id: "qyyg-4tf5",
      table_name: "ocp_recent_contract_awards",
      mode: "bulk_warehouse",
      materialized_at: MATERIALIZED_AT,
      row_count: sourceRows.length,
      rows: sourceRows,
    },
    options: {
      sourceContractsSchemaVersion: 1,
      windowStart: "2024-01-01",
      sourceContract: {
        id: "ocp-recent-contract-awards",
        status: "live",
        dataset_id: "qyyg-4tf5",
        landing_page: "https://data.cityofnewyork.us/d/qyyg-4tf5",
        delivery_tier: "edge-materialized",
        warehouse_snapshot: {
          status: "materialized",
          artifact: "site/data/ocp_awards_warehouse_lookup.json",
          materialized_at: MATERIALIZED_AT,
          row_count: sourceRows.length,
        },
      },
    },
  };
}

test("comparative-fact envelope is frozen and rejects an incomplete contract", () => {
  assert.throws(() => createComparativeFact({}), /subject/);
  const sourceRows = rows();
  const { lookup, options } = inputs(sourceRows);
  const fact = buildAwardRankComparativeReadModel(lookup, options).facts[0];
  assert.equal(fact.schema, COMPARATIVE_FACT_SCHEMA);
  assert.equal(Object.isFrozen(fact), true);
  assert.equal(Object.isFrozen(fact.comparison), true);
});

test("unchanged semantic inputs emit byte-stable output independent of source row order", () => {
  const sourceRows = rows();
  const forward = inputs(sourceRows);
  const reverse = inputs([...sourceRows].reverse());
  const first = JSON.stringify(buildAwardRankComparativeReadModel(forward.lookup, forward.options));
  const second = JSON.stringify(buildAwardRankComparativeReadModel(reverse.lookup, reverse.options));
  assert.equal(first, second);
});

test("comparative receipt machinery stays build-time and request paths read no stores or model services", () => {
  const receiptSource = readFileSync(new URL("../site/comparative_receipt.mjs", import.meta.url), "utf8");
  const pilotSource = readFileSync(new URL("../site/comparative_award_rank.mjs", import.meta.url), "utf8");
  const combined = `${receiptSource}\n${pilotSource}`;
  assert.doesNotMatch(combined, /(?:fetch\s*\(|D1Database|\.prepare\s*\(|worker\/src|openai|anthropic)/i);
  assert.doesNotMatch(combined, /site\/app\//);
});

test("the committed pilot artifact contains only the measured positive observation", () => {
  const artifact = JSON.parse(readFileSync(
    new URL("../site/data/comparative_award_rank_receipts.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(artifact.materialization_scope, {
    kind: "subject_allowlist",
    subject_ids: ["20240119104"],
  });
  assert.equal(artifact.facts.length, 1);
  const [fact] = artifact.facts;
  assert.equal(fact.subject.id, "20240119104");
  assert.equal(fact.value, 53_000_000);
  assert.equal(fact.comparison.rank, 4);
  // The bounded peer group grows with each award snapshot; what must hold is
  // that the eligible and observed denominators agree and stay above the
  // small-n floor that lets a rank publish at all.
  assert.equal(fact.comparison.observed_count, fact.comparison.eligible_count);
  assert.ok(fact.comparison.observed_count >= 10);
  assert.equal(fact.observation.negative_inference, "forbidden");
});

test("the committed pilot artifact is current with its materialized inputs", () => {
  const lookup = JSON.parse(readFileSync(
    new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url),
    "utf8",
  ));
  const sourceContracts = JSON.parse(readFileSync(
    new URL("../site/data/source_contracts.json", import.meta.url),
    "utf8",
  ));
  const committed = JSON.parse(readFileSync(
    new URL("../site/data/comparative_award_rank_receipts.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(buildComparativeAwardRankArtifact(lookup, sourceContracts), committed);
});
