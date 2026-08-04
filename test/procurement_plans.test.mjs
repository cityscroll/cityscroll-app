/**
 * RC-1 detector suite: MOCS FY2027 plans + Capital Projects Dashboard.
 *
 * The reader surface is deliberately outside this suite. These tests stop at
 * collection, normalization, measured bridge gating, warehouse tables, and the
 * versioned payload contract.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WAREHOUSE = join(ROOT, "warehouse");
const PYTHON = existsSync(join(WAREHOUSE, ".venv", "bin", "python"))
  ? join(WAREHOUSE, ".venv", "bin", "python")
  : "python3";

function python(code) {
  return spawnSync(PYTHON, ["-c", code], { cwd: ROOT, encoding: "utf8" });
}

test("RC-1 normalizes LL63, LL1, and capital rows without inventing absent values", () => {
  const result = python(`
import json, sys
sys.path.insert(0, "warehouse/lib")
from procurement_plans import normalize_capital_row, normalize_plan_rows

fixture = json.load(open("warehouse/fixtures/procurement-plans/collector.json"))
ll63 = normalize_plan_rows(fixture["ll63_rows"], source="mocs_ll63", source_url="https://example.test/ll63.xlsx", agency_hint="ACS", fiscal_year=2027)
ll1 = normalize_plan_rows(fixture["ll1_rows"], source="mocs_ll1", source_url="https://example.test/ll1.xlsx", agency_hint="ACS", fiscal_year=2027)
capital = normalize_capital_row(fixture["capital_rows"][0])

assert ll63[0]["plan_id"] == "FY27NACS1"
assert ll63[0]["description"] == "Detention Vendor Management and Building Engineering Consulting"
assert ll63[0]["term_start"] == "2027-04-01"
assert ll63[0]["quarter"] == 3
assert ll63[0]["industry"] is None
assert ll63[0]["budget"] is None

assert ll1[0]["industry"] == "Professional Services"
assert ll1[0]["budget"] == {"amount": 750000.0, "currency": "USD", "basis": "estimated_amount"}
assert ll1[0]["published_identifiers"] == ["06827P1234"]

assert capital["source"] == "capital_projects_dashboard"
assert capital["fms_id"] == "HL82ZERGA"
assert capital["budget"]["amount"] == 4510560.10
assert capital["procurement_method"] is None
print("OK")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK/);
});

test("RC-1 gates every source-target bridge independently at 30 percent", () => {
  const result = python(`
import json, sys
sys.path.insert(0, "warehouse/lib")
from procurement_plans import build_bridge_measurement

fixture = json.load(open("warehouse/fixtures/procurement-plans/collector.json"))
measurement, edges = build_bridge_measurement(
    fixture["bridge_plans"], fixture["bridge_targets"],
    sample_size=4, usefulness_threshold=0.30,
    review_labels=fixture["review_labels"],
)
ll1_city = measurement["paths"]["mocs_ll1_to_city_record"]
ll1_passport = measurement["paths"]["mocs_ll1_to_passport"]
assert ll1_city["joined"] == 1 and ll1_city["total"] == 4
assert ll1_city["rate"] == 0.25 and ll1_city["materialize"] is False
assert ll1_passport["joined"] == 2 and ll1_passport["rate"] == 0.5
assert ll1_passport["materialize"] is True
assert measurement["paths"]["mocs_ll63_to_city_record"]["total"] == 4
assert measurement["paths"]["mocs_ll63_to_city_record"]["rate"] == 0.25
assert measurement["paths"]["mocs_ll63_to_city_record"]["materialize"] is False
assert measurement["paths"]["capital_projects_dashboard_to_city_record"]["total"] == 4
assert measurement["paths"]["capital_projects_dashboard_to_city_record"]["rate"] == 0.25
assert measurement["paths"]["capital_projects_dashboard_to_passport"]["rate"] == 0.25
assert measurement["paths"]["capital_projects_dashboard_to_passport"]["materialize"] is False
assert all(edge["target_source"].startswith("passport") for edge in edges)
assert measurement["false_positive_review"]["reviewed"] >= 1
assert measurement["false_positive_review"]["false_positives"] >= 1
print("OK")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK/);
});

test("RC-1 collector is checkpointed, polite, host-side, and creates the warehouse contract", () => {
  const runner = readFileSync(
    join(WAREHOUSE, "scripts", "procurement_plans_run.py"),
    "utf8",
  );
  assert.match(runner, /IngestLock/);
  assert.match(runner, /check_headroom/);
  assert.match(runner, /checkpoint/i);
  assert.match(runner, /If-None-Match|If-Modified-Since/);
  assert.match(runner, /minimum.*1\.2|1_200|1200/i);
  assert.match(runner, /User-Agent/);
  assert.match(runner, /mocs_procurement_plans/);
  assert.match(runner, /capital_projects_dashboard/);
  assert.match(runner, /procurement_plan_bridge_edges/);
  assert.match(runner, /procurement_planning_thread_lookup\.json/);
  assert.match(runner, /build_thread_lookup\(payload\)/);
  assert.doesNotMatch(runner, /wrangler|document\.querySelector|innerHTML/);
});

test("RC-1 PASSPort input keeps valid rows and counts publisher-invalid escapes", () => {
  const result = python(`
import sys
sys.path.insert(0, "warehouse/scripts")
from procurement_plans_run import parse_js_dump
stats = {}
bad_row = '["bad", "slash ' + chr(92) + ' value"]'
text = chr(10).join(['var public_ctr_data = [', '["ok", "value"],', bad_row, '];'])
rows = parse_js_dump(text, "public_ctr_data", stats)
assert rows == [["ok", "value"]]
assert stats == {"malformed_rows_skipped": 1}
print("OK")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK/);
});

test("RC-1 fixture run writes versioned payload and measurement receipts", () => {
  if (!existsSync(join(WAREHOUSE, ".venv", "bin", "python"))) return;
  const out = join(WAREHOUSE, "raw", "test-procurement-plans");
  const result = spawnSync(
    PYTHON,
    [
      join(WAREHOUSE, "scripts", "procurement_plans_run.py"),
      "--from-fixture",
      "--force-headroom",
      "--output-dir", out,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(readFileSync(join(out, "procurement_planning_payload.json"), "utf8"));
  const receipt = JSON.parse(readFileSync(join(out, "procurement_plans_receipt.json"), "utf8"));
  assert.equal(payload.schema, "cityscroll.procurement_planning.v1");
  assert.equal(payload.fiscal_year, 2027);
  assert.ok(payload.plans.length >= 2);
  assert.ok(Array.isArray(payload.bridge_edges));
  assert.equal(receipt.schema, "cityscroll.procurement_plans.receipt.v1");
  assert.equal(receipt.collection.checkpointed, true);
  assert.equal(receipt.collection.polite_min_delay_seconds, 1.2);
  assert.ok(receipt.join_measurement.paths.mocs_ll1_to_city_record);
  assert.deepEqual(receipt.warehouse.tables.sort(), [
    "capital_projects_dashboard",
    "mocs_procurement_plan_files",
    "mocs_procurement_plans",
    "procurement_plan_bridge_edges",
  ]);
});

test("RC-1 public materialization uses receipt-backed Pages-safe shards", () => {
  const manifest = JSON.parse(readFileSync(
    join(ROOT, "site/data/procurement_planning_payload.json"),
    "utf8",
  ));
  const receipt = JSON.parse(readFileSync(
    join(ROOT, "site/data/procurement_plan_sources/verification_receipts/procurement_plans_2026-08-04.json"),
    "utf8",
  ));
  assert.equal(manifest.schema, "cityscroll.procurement_planning.manifest.v1");
  assert.equal(receipt.payload_contract.schema, manifest.schema);
  assert.deepEqual(receipt.payload_contract.collections, manifest.collections);
  const lookup = JSON.parse(readFileSync(
    join(ROOT, "site/data/procurement_planning_thread_lookup.json"),
    "utf8",
  ));
  assert.equal(lookup.schema, "cityscroll.procurement_planning.thread-lookup.v1");
  assert.equal(receipt.payload_contract.production_bridge_edges, lookup.rows.length);
  assert.ok(manifest.shard_contract.max_bytes < 25 * 1024 * 1024);

  for (const [collection, descriptor] of Object.entries(manifest.collections)) {
    let rows = 0;
    for (const shard of descriptor.shards) {
      const path = join(ROOT, shard.path.replace(/^site\//, "site/"));
      const bytes = readFileSync(path);
      const payload = JSON.parse(bytes.toString("utf8"));
      assert.equal(payload.schema, manifest.shard_contract.schema);
      assert.equal(payload.collection, collection);
      assert.ok(payload.rows.length <= manifest.shard_contract.max_rows);
      assert.equal(statSync(path).size, shard.bytes);
      assert.ok(shard.bytes <= manifest.shard_contract.max_bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), shard.sha256);
      rows += payload.rows.length;
    }
    assert.equal(rows, descriptor.rows);
  }
});

test("RC-1 stage one publishes a fixture proof and schema without claiming production edges", () => {
  const receiptPath = join(
    ROOT,
    "warehouse/receipts/proof/rc1_procurement_plans_framework_latest.json",
  );
  const payloadPath = join(ROOT, "site/data/procurement_planning_payload.schema.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const schema = JSON.parse(readFileSync(payloadPath, "utf8"));
  assert.equal(receipt.proof_scope, "fixture_framework");
  assert.equal(receipt.production_data_claimed, false);
  assert.equal(receipt.join_measurement.sample.method, "fixed_sorted_modern_sample");
  assert.equal(receipt.join_measurement.usefulness_threshold, 0.3);
  assert.ok(receipt.join_measurement.false_positive_review);
  for (const path of Object.values(receipt.join_measurement.paths)) {
    assert.equal(path.total, 4);
    assert.equal(path.rate, path.total ? path.joined / path.total : 0);
    assert.equal(path.materialize, path.rate >= 0.3 && path.review_complete);
  }
  assert.equal(receipt.payload_contract.production_materialized, false);
  assert.equal(receipt.payload_contract.production_bridge_edges, 0);
  assert.equal(schema.properties.schema.const, "cityscroll.procurement_planning.v1");
  assert.equal(schema.properties.contract.properties.unmatched_rows_remain_unmatched.const, true);
  assert.equal(schema.properties.contract.properties.infer_budget_from_agency_total.const, false);
  assert.equal(schema.properties.contract.properties.reader_surface_included.const, false);
});
