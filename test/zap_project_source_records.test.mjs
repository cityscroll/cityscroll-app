import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  retainZapProjectSourceRecords,
  USEFULNESS_FLOOR,
  PRECISION_FLOOR,
} from "../warehouse/lib/zap_project_source_records.mjs";

const lookup = JSON.parse(
  readFileSync(new URL("../site/data/zap_projects_warehouse_lookup.json", import.meta.url), "utf8"),
);

test("the real committed ZAP corpus retains exact source records and standable edges", () => {
  const result = retainZapProjectSourceRecords(lookup.rows, {
    observedAt: lookup.materialized_at,
  });
  assert.equal(result.counts.input_rows, lookup.row_count);
  assert.equal(result.counts.retained, lookup.row_count);
  assert.equal(result.source_records.length, lookup.row_count);
  assert.equal(result.measurement.usefulness.rate, 1);
  assert.equal(result.measurement.precision.rate, 1);
  assert.ok(result.measurement.usefulness.rate >= USEFULNESS_FLOOR);
  assert.ok(result.measurement.precision.rate >= PRECISION_FLOOR);
  assert.equal(result.gates.materialize, true);

  const sourceIds = new Set(result.source_records.map(
    (row) => `${row.source_system}:${row.source_system_id}`,
  ));
  assert.ok(result.edges.length > 0);
  for (const edge of result.edges) {
    assert.ok(sourceIds.has(edge.provenance.source_record_id));
    assert.equal(edge.provenance.source_system, "zap-projects");
    assert.ok(edge.provenance.observed_at);
    assert.ok(edge.method);
    assert.ok(edge.method_version);
    assert.ok(edge.confidence);
  }
});

test("source retention rejects missing or synthetic identity evidence", () => {
  const result = retainZapProjectSourceRecords([
    { project_id: "2022M0258" },
    { project_name: "Synthetic title without publisher id" },
  ], { observedAt: lookup.materialized_at });
  assert.equal(result.counts.retained, 0);
  assert.equal(result.blocked.missing_identity_or_evidence, 2);
  assert.equal(result.source_records.length, 0);
  assert.equal(result.edges.length, 0);
  assert.equal(result.gates.materialize, false);
});
