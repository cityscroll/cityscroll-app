import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  countPayrollTitleMatches,
  payrollTitleMartReady,
  payrollTitlePiiFindings,
  rowToPayrollTitleShape,
  searchPayrollTitles,
} from "../site/payroll_title_mart.mjs";
import {
  PAYROLL_PUBLISHER_ROW_COUNT,
  PAYROLL_TITLE_CANARIES,
  PAYROLL_TITLE_PUBLISHER_TITLE_COUNT,
  assertPayrollTitleServeGate,
  buildMaterializationDoc,
  loadProductSeedRows,
  lookupPayrollTitleCount,
  payrollTitleServeGateFindings,
} from "../warehouse/lib/payroll_title_lookup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = join(ROOT, "warehouse/fixtures/citywide-payroll/product_seed.json");

describe("payroll title mart (aggregate, no PII)", () => {
  it("shapes only title/count/band fields and drops employee columns", () => {
    const shaped = rowToPayrollTitleShape({
      title_description: "  POLICE OFFICER ",
      n: "24153",
      mn: "43456.00",
      mx: "109352.00",
      avg: "85299.0068",
      last_name: "DOE",
      first_name: "JANE",
      employee_id: "12345",
    });
    assert.deepEqual(Object.keys(shaped).sort(), ["avg", "mn", "mx", "n", "title_description"]);
    assert.equal(shaped.title_description, "POLICE OFFICER");
    assert.equal(shaped.n, 24153);
    assert.equal(shaped.avg, 85299.01);
    assert.equal(payrollTitlePiiFindings(shaped).length, 0);
    assert.ok(
      payrollTitlePiiFindings({
        title_description: "POLICE OFFICER",
        n: 1,
        last_name: "DOE",
      }).some((finding) => /PII field "last_name"/.test(finding)),
    );
  });

  it("counts title search by summed headcount, not distinct titles", () => {
    const seed = loadProductSeedRows();
    assert.ok(seed.length >= 5);
    assert.ok(seed.every((row) => row.title_description && row.n > 0));

    const paramedic = countPayrollTitleMatches(seed, "paramedic");
    assert.equal(paramedic.hit, true);
    assert.equal(paramedic.title_count, 1);
    assert.equal(paramedic.count, 1017);
    assert.equal(searchPayrollTitles(seed, "PARAMEDIC")[0].title_description,
      "EMERGENCY MEDICAL SPECIALIST-PARAMEDIc");

    const police = countPayrollTitleMatches(seed, "police officer");
    assert.equal(police.count, 24153);
  });

  it("rejects an empty or PII-bearing serve document", () => {
    const seed = JSON.parse(readFileSync(SEED, "utf8"));
    const empty = payrollTitleServeGateFindings({
      schema_version: 1,
      fiscal_year: 2025,
      mode: "live_fallback",
      materialized_at: "2026-08-18T00:00:00.000Z",
      rows: [],
    });
    assert.ok(empty.some((finding) => /empty|live_fallback/i.test(finding)));

    const piiDoc = buildMaterializationDoc(seed.rows, {
      mode: "soda_groupby",
      now: "2026-08-18T00:00:00.000Z",
    });
    piiDoc.rows[0].last_name = "DOE";
    assert.ok(payrollTitlePiiFindings(piiDoc).some((finding) => /last_name/.test(finding)));
  });

  it("accepts a full-catalog mart with named canaries and coverage vs the 6.8M file", () => {
    const titles = Array.from({ length: PAYROLL_TITLE_PUBLISHER_TITLE_COUNT }, (_, i) => ({
      title_description: i === 0 ? "POLICE OFFICER" : i === 1 ? "FIREFIGHTER" : `TITLE ${i}`,
      n: 400 + i,
      mn: 40000,
      mx: 80000,
      avg: 60000,
    }));
    const doc = buildMaterializationDoc(titles, {
      mode: "soda_groupby",
      now: "2026-08-18T00:00:00.000Z",
      publisherRowCount: PAYROLL_PUBLISHER_ROW_COUNT,
      windowRowCount: 550219,
    });
    assert.equal(doc.coverage.publisher_row_count, PAYROLL_PUBLISHER_ROW_COUNT);
    assert.ok(doc.coverage.window_row_count < PAYROLL_PUBLISHER_ROW_COUNT);
    assert.equal(doc.pii.employee_rows, false);
    for (const canary of PAYROLL_TITLE_CANARIES) {
      assert.ok(doc.rows.some((row) => row.title_description === canary), canary);
    }
    assertPayrollTitleServeGate(doc, { now: "2026-08-18T12:00:00.000Z" });
    assert.equal(payrollTitleMartReady(doc), true);
    assert.equal(lookupPayrollTitleCount(doc, "firefighter").hit, true);
  });

  it("committed twins are aggregate-only and cover the FY title-search window", () => {
    const site = JSON.parse(readFileSync(
      join(ROOT, "site/data/payroll_title_warehouse_lookup.json"),
      "utf8",
    ));
    const worker = JSON.parse(readFileSync(
      join(ROOT, "worker/src/data/payroll_title_warehouse_lookup.json"),
      "utf8",
    ));
    assertPayrollTitleServeGate(site, { now: site.materialized_at });
    assert.equal(JSON.stringify(site.rows), JSON.stringify(worker.rows));
    assert.equal(site.title_count, 1557);
    assert.equal(site.coverage.window_row_count, 550219);
    assert.equal(site.coverage.publisher_row_count, PAYROLL_PUBLISHER_ROW_COUNT);
    assert.ok(site.coverage.window_row_count < site.coverage.publisher_row_count);
    assert.equal(site.pii.employee_rows, false);
    assert.equal(payrollTitlePiiFindings(site).length, 0);
    assert.ok(site.rows.every((row) => !("last_name" in row) && !("first_name" in row)));
    assert.equal(countPayrollTitleMatches(site, "paramedic").count, 1017);
  });
});
