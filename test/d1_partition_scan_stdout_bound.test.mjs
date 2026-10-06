/**
 * Regression for Deploy worker 37399462266: post-publish reconcile called
 * scanTableForPartition with one unpaged SELECT; wrangler d1 execute --json
 * returned ~68 MiB and tools/lib/wrangler_exec.mjs refused the stdout
 * (32 MiB bound). Fix pages the scan; the bound stays 32 MiB; every observed
 * row is still compared.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PARTITION_SCAN_PAGE_ROWS,
  classifyPartitionFindings,
  scanTableForPartition,
} from "../tools/d1_canary.mjs";
import { loadManifest } from "../tools/d1_manifest.mjs";
import { TABLE_COLUMNS, keyColumns } from "../tools/d1_stable_keys.mjs";
import { WRANGLER_STDIO_MAX_BYTES } from "../tools/lib/wrangler_exec.mjs";

const manifest = loadManifest();
const ocpEntry = manifest.models.find((model) => model.model_id === "ocp_awards");
assert.ok(ocpEntry, "ocp_awards model is required for this regression");

const OCP_TABLE = "ocp_awards_warehouse";
const OCP_COLUMNS = TABLE_COLUMNS[OCP_TABLE];
const OCP_KEYS = keyColumns(ocpEntry, OCP_TABLE);

/** Build N warehouse-shaped rows whose JSON dump exceeds the wrangler stdout bound when returned in one shot. */
function oversizedOcpRows(rowCount) {
  const pad = "p".repeat(2048);
  return Array.from({ length: rowCount }, (_, index) => {
    const id = `req-${String(index).padStart(6, "0")}`;
    return {
      row_key: `rk-${id}`,
      request_id: id,
      start_date: "2026-01-01",
      agency_name: `Agency ${pad}`,
      type_of_notice_description: `Notice ${pad}`,
      short_title: `Title ${pad}`,
      pin: `pin-${id}`,
      contract_amount: String(index),
      vendor_name: `Vendor ${pad}`,
    };
  });
}

function parseLimitOffset(sql) {
  const match = String(sql).match(/\bLIMIT\s+(\d+)\s+OFFSET\s+(\d+)\s*$/i);
  if (!match) return null;
  return { limit: Number(match[1]), offset: Number(match[2]) };
}

/**
 * Adapter that serves an in-memory row set and refuses any single response
 * whose JSON encoding would exceed the retained wrangler stdout bound — the
 * same fail-closed check runWrangler applies after streaming.
 */
function boundedStdoutAdapter(allRows) {
  const calls = [];
  return {
    calls,
    async select(sql, params = []) {
      assert.equal(params.length, 0, "ocp __model__ partition uses an unbound WHERE 1 = 1");
      const page = parseLimitOffset(sql);
      const slice = page ? allRows.slice(page.offset, page.offset + page.limit) : allRows;
      const encodedBytes = Buffer.byteLength(JSON.stringify(slice), "utf8");
      calls.push({
        sql,
        rowCount: slice.length,
        encodedBytes,
        paged: Boolean(page),
        limit: page?.limit ?? null,
        offset: page?.offset ?? null,
      });
      if (encodedBytes > WRANGLER_STDIO_MAX_BYTES) {
        throw new Error(
          `wrangler stdout exceeded bound: size=${encodedBytes} bytes `
          + `(${(encodedBytes / 1024 / 1024).toFixed(6)} MiB) limit=${WRANGLER_STDIO_MAX_BYTES} bytes `
          + `(${(WRANGLER_STDIO_MAX_BYTES / 1024 / 1024).toFixed(6)} MiB)`,
        );
      }
      return slice;
    },
  };
}

test("the wrangler stdout retain bound stays 32 MiB", () => {
  assert.equal(WRANGLER_STDIO_MAX_BYTES, 32 * 1024 * 1024);
  assert.ok(DEFAULT_PARTITION_SCAN_PAGE_ROWS > 0);
  assert.ok(DEFAULT_PARTITION_SCAN_PAGE_ROWS < 5000);
});

test("an unpaged partition SELECT of a production-sized table exceeds the stdout bound (fail-before)", async () => {
  // ~54k ocp rows produced ~68 MiB on Deploy 37399462266; fewer padded rows
  // still cross 32 MiB and prove the unpaged shape is what tripped the gate.
  let rowCount = 4_000;
  let rows = oversizedOcpRows(rowCount);
  while (Buffer.byteLength(JSON.stringify(rows), "utf8") <= WRANGLER_STDIO_MAX_BYTES && rowCount < 20_000) {
    rowCount += 1_000;
    rows = oversizedOcpRows(rowCount);
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(rows), "utf8") > WRANGLER_STDIO_MAX_BYTES,
    "fixture must exceed the retain bound so the unpaged path is a real failure",
  );

  const adapter = boundedStdoutAdapter(rows);
  await assert.rejects(
    () => adapter.select(`SELECT ${OCP_COLUMNS.join(", ")} FROM ${OCP_TABLE} WHERE 1 = 1`),
    /wrangler stdout exceeded bound/,
  );
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].paged, false);
});

test("paged scanTableForPartition stays under the stdout bound and still sees every row (pass-after)", async () => {
  let rowCount = 4_000;
  let rows = oversizedOcpRows(rowCount);
  while (Buffer.byteLength(JSON.stringify(rows), "utf8") <= WRANGLER_STDIO_MAX_BYTES && rowCount < 20_000) {
    rowCount += 1_000;
    rows = oversizedOcpRows(rowCount);
  }
  const totalBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
  assert.ok(totalBytes > WRANGLER_STDIO_MAX_BYTES);

  const adapter = boundedStdoutAdapter(rows);
  const pageRows = DEFAULT_PARTITION_SCAN_PAGE_ROWS;
  const observedByKey = await scanTableForPartition({
    entry: ocpEntry,
    table: OCP_TABLE,
    partition: "__model__",
    adapter,
    pageRows,
  });

  assert.ok(adapter.calls.length >= 2, "oversized partition must take more than one page");
  assert.ok(adapter.calls.every((call) => call.paged), "every select must carry LIMIT/OFFSET");
  assert.ok(adapter.calls.every((call) => call.limit === pageRows));
  assert.ok(adapter.calls.every((call) => call.encodedBytes <= WRANGLER_STDIO_MAX_BYTES));
  assert.equal(
    adapter.calls.reduce((sum, call) => sum + call.rowCount, 0),
    rows.length,
  );
  assert.equal(observedByKey.size, rows.length);

  const expectedRows = rows.map((row) => ({
    key: OCP_KEYS.map((column) => row[column]).join("|"),
    columns: Object.fromEntries(OCP_COLUMNS.map((column) => [column, row[column]])),
  }));
  assert.deepEqual(
    classifyPartitionFindings({
      entry: ocpEntry,
      table: OCP_TABLE,
      partition: "__model__",
      expectedRows,
      observedByKey,
    }),
    [],
  );
});

test("paged scan still reports missing and unexpected findings", async () => {
  const rows = oversizedOcpRows(20).slice(0, 20);
  const adapter = boundedStdoutAdapter(rows);
  const observedByKey = await scanTableForPartition({
    entry: ocpEntry,
    table: OCP_TABLE,
    partition: "__model__",
    adapter,
    pageRows: 7,
  });
  assert.equal(adapter.calls.length, 3);

  const expectedRows = [
    {
      key: OCP_KEYS.map((column) => rows[0][column]).join("|"),
      columns: Object.fromEntries(OCP_COLUMNS.map((column) => [column, rows[0][column]])),
    },
    {
      key: "missing-key",
      columns: { row_key: "missing-key" },
    },
  ];
  const findings = classifyPartitionFindings({
    entry: ocpEntry,
    table: OCP_TABLE,
    partition: "__model__",
    expectedRows,
    observedByKey,
  });
  assert.ok(findings.some((finding) => finding.classification === "missing" && finding.key === "missing-key"));
  assert.ok(findings.some((finding) => finding.classification === "unexpected"));
  assert.equal(findings.filter((finding) => finding.classification === "unexpected").length, rows.length - 1);
});
