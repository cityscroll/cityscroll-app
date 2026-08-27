import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "ibo-fiscal-history");
const PYTHON = existsSync(join(ROOT, "warehouse", ".venv", "bin", "python"))
  ? join(ROOT, "warehouse", ".venv", "bin", "python")
  : "python3";
const SCRIPT = join(ROOT, "warehouse", "scripts", "ibo_fiscal_history.py");

function runIngest(manifestName, outputDir) {
  return spawnSync(PYTHON, [
    SCRIPT,
    "--root",
    ROOT,
    "--manifest",
    join(FIXTURE, manifestName),
    "--output-dir",
    outputDir,
  ], { cwd: ROOT, encoding: "utf8" });
}

function fixtureRun() {
  const dir = mkdtempSync(join("/tmp", "cityscroll-ibo-test-"));
  const result = runIngest("manifest.json", dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { dir, result };
}

test("IBO fixture normalizes formatted values, blanks, footnotes, and source identity", () => {
  const { dir } = fixtureRun();
  try {
    const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    const rows = readFileSync(join(dir, "observations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(receipt.schema, "cityscroll.ibo_fiscal_history_receipt.v1");
    assert.deepEqual(
      {
        labels: receipt.coverage.source_label_count,
        exact: receipt.coverage.exact_matched_label_count,
        alias: receipt.coverage.alias_matched_label_count,
        unresolved: receipt.coverage.unresolved_label_count,
        rows: receipt.coverage.row_count,
      },
      { labels: 3, exact: 1, alias: 1, unresolved: 1, rows: 52 },
    );
    assert.deepEqual(receipt.coverage.fiscal_years, [2021, 2022]);
    assert.deepEqual(receipt.reconciliation.expenditures.sum_minus_publisher_total, {
      2021: 0,
      2022: 0,
    });

    const formatted = rows.find((row) => row.source_agency_name === "DEPARTMENT OF PARKS AND RECREATION"
      && row.fiscal_year === 2022 && row.measure === "personal_services");
    assert.equal(formatted.value, 1234.5);
    assert.equal(formatted.unit, "USD_thousands");
    assert.equal(formatted.value_in_usd, 1234500);
    assert.equal(formatted.value_in_usd_status, "derived_explicit_conversion");
    assert.equal(formatted.source_raw_value, "$1,234.500*");
    assert.deepEqual(formatted.source_footnote_markers, ["*"]);

    const blank = rows.find((row) => row.source_agency_name === "Fixture Unresolved Agency"
      && row.fiscal_year === 2022 && row.measure === "personal_services");
    assert.equal(blank.value, null);
    assert.equal(blank.value_status, "blank");
    assert.equal(blank.canonical_agency_id, null);
    assert.equal(blank.agency_identity_status, "unresolved");

    const publisherMissing = rows.find((row) => row.source_agency_name === "Fixture Unresolved Agency"
      && row.fiscal_year === 2022 && row.measure === "prior_year_adjustments");
    assert.equal(publisherMissing.value, null);
    assert.equal(publisherMissing.value_status, "publisher_missing_or_suppressed");

    const changingNames = rows.filter((row) => row.fiscal_year === 2022
      && row.measure === "total_department_expenditures"
      && row.source_agency_name !== "Citywide");
    assert.equal(changingNames.find((row) => row.source_agency_name === "DEPARTMENT OF PARKS AND RECREATION").canonical_agency_id, "parks-and-recreation");
    assert.equal(changingNames.find((row) => row.source_agency_name === "Parks and Recreation").canonical_agency_id, "parks-and-recreation");
    assert.deepEqual(receipt.coverage.source_labels, [
      "DEPARTMENT OF PARKS AND RECREATION",
      "Fixture Unresolved Agency",
      "Parks and Recreation",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IBO fixture ingestion is byte-deterministic on repeat", () => {
  const dir = mkdtempSync(join("/tmp", "cityscroll-ibo-deterministic-"));
  try {
    const first = runIngest("manifest.json", dir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstJsonl = readFileSync(join(dir, "observations.jsonl"));
    const firstCsv = readFileSync(join(dir, "observations.csv"));
    const firstReceipt = readFileSync(join(dir, "receipt.json"));
    const second = runIngest("manifest.json", dir);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(readFileSync(join(dir, "observations.jsonl")), firstJsonl);
    assert.deepEqual(readFileSync(join(dir, "observations.csv")), firstCsv);
    assert.deepEqual(readFileSync(join(dir, "receipt.json")), firstReceipt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IBO structural drift fails before materialization", () => {
  const dir = mkdtempSync(join("/tmp", "cityscroll-ibo-drift-"));
  try {
    const result = runIngest("manifest-structural-drift.json", dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected sheet\(s\) missing|In \$000's/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpointed production receipt records source provenance and reconciliation", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "warehouse", "sources", "ibo-fiscal-history", "source_manifest.json"), "utf8"));
  const receipt = JSON.parse(readFileSync(join(ROOT, "warehouse", "sources", "ibo-fiscal-history", "materialized", "receipt.json"), "utf8"));
  assert.equal(manifest.schema, "cityscroll.ibo_fiscal_history_source_manifest.v1");
  assert.equal(manifest.publisher_vintage, "FY2022");
  assert.equal(receipt.publisher_vintage, "FY2022");
  assert.deepEqual(receipt.coverage.fiscal_years, Array.from({ length: 43 }, (_, index) => 1980 + index));
  assert.equal(receipt.coverage.row_count, 26101);
  assert.equal(receipt.reconciliation.expenditures.sum_minus_publisher_total["2022"], 0);
  assert.equal(receipt.materialization.duckdb.table, "ibo_fiscal_history");
  assert.equal(receipt.materialization.duckdb.catalog, "warehouse/duckdb/cityscroll.duckdb");
});
