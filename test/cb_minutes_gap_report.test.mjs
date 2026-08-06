import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const receipt = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json", import.meta.url)));
const report = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/cb_minutes_gap_report.json", import.meta.url)));

test("CB minutes report is a complete deterministic expected-set projection", () => {
  assert.equal(registry.sources.filter((row) => row.body_type === "community_board").length, 59);
  assert.equal(receipt.schema, "cityscroll.cb_minutes_publication_probe_receipt.v1");
  assert.equal(receipt.probes.length, 59);
  assert.equal(report.schema, "cityscroll.cb_minutes_gap_report.v1");
  assert.equal(report.rows.length, 59);
  assert.equal(report.expected_set.trailing_months, 12);
  assert.match(report.expected_set.mandate_source, /^https:\/\/comptroller\.nyc\.gov\//);
  assert.ok(report.rows.every((row) => row.body_id && ["a", "b"].includes(row.gap_class)));
});

test("missing registry URLs remain honest class-b empty probes", () => {
  const byId = new Map(receipt.probes.map((probe) => [probe.body_id, probe]));
  const rows = registry.sources.filter((row) => row.body_type === "community_board" && !row.source_url);
  assert.ok(rows.length > 0);
  for (const source of rows) {
    const probe = byId.get(source.body_id);
    assert.deepEqual(probe.observations, []);
    assert.equal(probe.url, null);
    assert.equal(report.rows.find((row) => row.body_id === source.body_id).gap_class, "b");
  }
});

test("collect rows have receipt-backed URL evidence", () => {
  const byId = new Map(receipt.probes.map((probe) => [probe.body_id, probe]));
  for (const source of registry.sources.filter((row) => row.body_type === "community_board" && row.status === "collect")) {
    const probe = byId.get(source.body_id);
    assert.equal(probe.url, source.source_url);
    assert.match(probe.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(probe.content_sha256, /^[a-f0-9]{64}$/);
  }
});
