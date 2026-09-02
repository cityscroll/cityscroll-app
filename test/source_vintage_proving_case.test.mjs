import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { loadSourceContracts } from "../tools/source_contracts.mjs";
import { loadSourceVintageAlternates } from "../tools/source_vintage_alternates.mjs";
import {
  auditReceiptText,
  auditSourceVintage,
  ROOT,
  SOURCE_VINTAGE_AUDIT_SCHEMA,
} from "../tools/audit_source_vintage.mjs";

const SOURCE_ID = "ibo-fiscal-history";
const SOURCE_ROOT = join(ROOT, "warehouse/sources", SOURCE_ID);
const MANIFEST_PATH = join(SOURCE_ROOT, "source_manifest.json");
const RECEIPT_PATH = join(SOURCE_ROOT, "materialized/receipt.json");
const OBSERVATIONS_PATH = join(SOURCE_ROOT, "materialized/observations.jsonl");
const GOLDEN_PATH = join(SOURCE_ROOT, "audit/source_vintage_audit.json");
const AUDIT_TOOL = join(ROOT, "tools/audit_source_vintage.mjs");

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
const observationsText = readFileSync(OBSERVATIONS_PATH, "utf8");
const alternates = loadSourceVintageAlternates();
const contracts = loadSourceContracts();
const healthObservations = JSON.parse(readFileSync(join(ROOT, "site/data/source_health_observations.json"), "utf8"));
const trackedProjection = JSON.parse(readFileSync(join(ROOT, "site/data/source_vintage_observations.json"), "utf8"));

function audit(overrides = {}) {
  return auditSourceVintage({
    sourceId: SOURCE_ID,
    root: ROOT,
    inputs: {
      manifest,
      receipt,
      observationsText,
      alternates,
      contracts,
      healthObservations,
      trackedProjection,
      ...overrides,
    },
  });
}

function cloneReceipt() {
  return structuredClone(receipt);
}

function cloneAlternates() {
  return structuredClone(alternates);
}

function writeFixture({ receiptText = JSON.stringify(receipt), observations = observationsText } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cityscroll-source-vintage-"));
  const sourceDir = join(root, "warehouse/sources", SOURCE_ID);
  mkdirSync(join(sourceDir, "materialized"), { recursive: true });
  writeFileSync(join(sourceDir, "source_manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(sourceDir, "materialized/receipt.json"), receiptText);
  writeFileSync(join(sourceDir, "materialized/observations.jsonl"), observations);
  return root;
}

function auditTempRoot({ receiptText, observations } = {}) {
  const root = writeFixture({ receiptText, observations });
  try {
    return auditSourceVintage({
      sourceId: SOURCE_ID,
      root,
      inputs: { alternates, contracts, healthObservations, trackedProjection },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("positive proof recomputes the real IBO corpus and matches the deterministic golden receipt", () => {
  const result = audit();
  assert.deepEqual(result.findings, []);
  assert.equal(result.receipt.schema, SOURCE_VINTAGE_AUDIT_SCHEMA);
  assert.deepEqual(result.receipt.source_identity, {
    publisher: "New York City Independent Budget Office",
    source_page_url: "https://ns2.ibo.nyc.ny.us/fiscalhistory.html",
    workbook_ids: ["ibo_agency_expenditures", "ibo_full_time_positions"],
  });
  assert.deepEqual(result.measured, {
    row_count: 26101,
    fiscal_years: Array.from({ length: 43 }, (_, index) => 1980 + index),
    fiscal_year_min: 1980,
    fiscal_year_max: 2022,
    fiscal_year_count: 43,
    fiscal_years_contiguous: true,
    row_count_by_workbook: {
      ibo_agency_expenditures: 21801,
      ibo_full_time_positions: 4300,
    },
    malformed: [],
  });
  assert.equal(result.receipt.materialization_health.retrieval.status, "succeeded");
  assert.equal(result.receipt.materialization_health.retrieval.retrieved_at, "2026-08-27T17:59:48.000Z");
  assert.equal(result.receipt.materialization_health.ingestion_stale, false);
  assert.equal(result.receipt.publisher_vintage.label, "FY2022");
  assert.equal(result.receipt.classification.status, "source-vintage-stale");
  assert.equal(result.receipt.classification.ingestion_stale, false);
  assert.equal(result.receipt.newer_context_alternates[0].alternate_source_id, "comptroller-acfr");
  assert.equal(result.receipt.newer_context_alternates[0].index_url, "https://comptroller.nyc.gov/reports/annual-comprehensive-financial-reports/");
  assert.equal(result.receipt.newer_context_alternates[0].artifact_url, "https://comptroller.nyc.gov/wp-content/uploads/documents/ACFR-2025-7-28-2026.pdf");
  assert.equal(result.receipt.newer_context_alternates[0].observed_coverage.max_fiscal_year, 2025);
  assert.equal(result.receipt.boundary.observations_beyond_publisher_vintage, 0);
  assert.equal(result.receipt.boundary.series_extension, "out-of-scope-follow-on");
  assert.equal(auditReceiptText(result.receipt), readFileSync(GOLDEN_PATH, "utf8"));
});

test("the command is repeatable and never writes the checked-in observations", () => {
  const before = digest(OBSERVATIONS_PATH);
  const first = spawnSync(process.execPath, [AUDIT_TOOL, "--source", SOURCE_ID], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const second = spawnSync(process.execPath, [AUDIT_TOOL, "--source", SOURCE_ID], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(digest(OBSERVATIONS_PATH), before);
});

test("missing and malformed receipts fail closed", () => {
  const missingRoot = writeFixture();
  rmSync(join(missingRoot, "warehouse/sources", SOURCE_ID, "materialized/receipt.json"));
  try {
    const missing = auditSourceVintage({
      sourceId: SOURCE_ID,
      root: missingRoot,
      inputs: { alternates, contracts, healthObservations, trackedProjection },
    });
    assert.deepEqual(missing.findings, ["receipt-missing"]);
    assert.equal(missing.receipt, null);

    const malformed = auditTempRoot({ receiptText: "{not-json" });
    assert.deepEqual(malformed.findings, ["receipt-malformed"]);
    assert.equal(malformed.receipt, null);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test("row-count and fiscal-year frontier drift are reported from the receipt", () => {
  const rowDrift = cloneReceipt();
  rowDrift.coverage.row_count += 1;
  assert.ok(audit({ receipt: rowDrift }).findings.includes("row-count-drift"));

  const yearDrift = cloneReceipt();
  yearDrift.coverage.fiscal_years = yearDrift.coverage.fiscal_years.slice(0, -1);
  assert.ok(audit({ receipt: yearDrift }).findings.includes("fiscal-year-drift"));
});

test("failed retrieval is not reported as healthy and is distinct from publisher vintage", () => {
  const failed = cloneReceipt();
  failed.materialization.duckdb.status = "failed";
  const result = audit({ receipt: failed });
  assert.ok(result.findings.includes("retrieval-not-materialized"));
  assert.ok(result.findings.includes("ingestion-failure-classified"));
  assert.equal(result.receipt.materialization_health.retrieval.status, "not-materialized");
  assert.equal(result.receipt.publisher_vintage.label, "FY2022");
});

test("missing and non-newer alternate evidence cannot prove semantic staleness", () => {
  const missing = audit({ alternates: { schema: alternates.schema, alternates: [] } });
  assert.ok(missing.findings.includes("alternate-missing"));
  assert.deepEqual(missing.receipt.newer_context_alternates, []);

  const notNewerAlternates = cloneAlternates();
  notNewerAlternates.alternates[0].observed_coverage.max_fiscal_year = 2022;
  const notNewer = audit({ alternates: notNewerAlternates });
  assert.ok(notNewer.findings.includes("alternate-not-newer"));
  assert.deepEqual(notNewer.receipt.newer_context_alternates, []);
});

test("an attempted cross-series extension fails without changing the IBO corpus", () => {
  const before = digest(OBSERVATIONS_PATH);
  const firstRow = JSON.parse(observationsText.split("\n").find(Boolean));
  firstRow.fiscal_year = 2023;
  const extension = `${JSON.stringify(firstRow)}\n`;
  const result = audit({ observationsText: `${observationsText}${extension}${extension}` });
  assert.ok(result.findings.includes("cross-series-extension"));
  assert.equal(result.measured.fiscal_year_max, 2023);
  // Two rows share one fiscal year beyond the vintage: the boundary counts
  // observation rows, not distinct fiscal years.
  assert.equal(result.receipt.boundary.observations_beyond_publisher_vintage, 2);
  assert.equal(result.receipt.boundary.series_extension, "out-of-scope-follow-on");
  assert.equal(digest(OBSERVATIONS_PATH), before);
});
