/**
 * Regression for Deploy worker 37399462266: post-publish reconcile called
 * scanTableForPartition with one unpaged SELECT; wrangler d1 execute --json
 * returned ~68 MiB and tools/lib/wrangler_exec.mjs refused the stdout
 * (32 MiB bound). Fix pages with keyset ORDER BY / WHERE key > last (no
 * OFFSET) and sizes pages from measured bytes-per-row toward ~8 MiB; the
 * retain bound stays 32 MiB; every observed row is still compared.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PARTITION_SCAN_PAGE_ROWS,
  MAX_PARTITION_SCAN_PAGE_ROWS,
  MIN_PARTITION_SCAN_PAGE_ROWS,
  PARTITION_SCAN_TARGET_PAGE_BYTES,
  classifyPartitionFindings,
  keysetAfterPredicate,
  partitionScanPageRowsFromBytes,
  scanTableForPartition,
} from "../tools/d1_canary.mjs";
import { loadManifest } from "../tools/d1_manifest.mjs";
import { TABLE_COLUMNS, keyColumns } from "../tools/d1_stable_keys.mjs";
import { WRANGLER_STDIO_MAX_BYTES } from "../tools/lib/wrangler_exec.mjs";

const manifest = loadManifest();
const ocpEntry = manifest.models.find((model) => model.model_id === "ocp_awards");
assert.ok(ocpEntry, "ocp_awards model is required for this regression");
const entityEntry = manifest.models.find((model) => model.model_id === "entity_intelligence");
assert.ok(entityEntry, "entity_intelligence model is required for multi-column key coverage");

const OCP_TABLE = "ocp_awards_warehouse";
const OCP_COLUMNS = TABLE_COLUMNS[OCP_TABLE];
const OCP_KEYS = keyColumns(ocpEntry, OCP_TABLE);

const SUBJECT_REFS_TABLE = "entity_intelligence_subject_refs";
const SUBJECT_REFS_COLUMNS = TABLE_COLUMNS[SUBJECT_REFS_TABLE];
const SUBJECT_REFS_KEYS = keyColumns(entityEntry, SUBJECT_REFS_TABLE);
assert.ok(SUBJECT_REFS_KEYS.length > 1, "subject_refs must stay a multi-column key");

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

function subjectRefRows(rowCount) {
  return Array.from({ length: rowCount }, (_, index) => {
    const a = String(Math.floor(index / 25)).padStart(3, "0");
    const b = String(Math.floor((index % 25) / 5)).padStart(3, "0");
    const c = String(index % 5).padStart(3, "0");
    return {
      subject_ref: `sub-${a}`,
      entity_ref: `ent-${b}`,
      relation: `rel-${c}`,
      confidence: String((index % 7) / 10),
      link_json: JSON.stringify({ i: index }),
    };
  }).sort((left, right) => {
    for (const column of SUBJECT_REFS_KEYS) {
      if (left[column] < right[column]) return -1;
      if (left[column] > right[column]) return 1;
    }
    return 0;
  });
}

function compareKey(leftValues, rightValues) {
  for (let index = 0; index < leftValues.length; index += 1) {
    const left = leftValues[index];
    const right = rightValues[index];
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

function keyValuesOf(row, keyCols) {
  return keyCols.map((column) => row[column]);
}

function parseKeysetLimit(sql) {
  const text = String(sql);
  assert.doesNotMatch(text, /\bOFFSET\b/i, "partition scan must not use OFFSET");
  const limitMatch = text.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (!limitMatch) return null;
  return { limit: Number(limitMatch[1]), sql: text };
}

/**
 * Adapter that serves an in-memory row set ordered by keyCols and refuses any
 * single response whose JSON encoding would exceed the retained wrangler
 * stdout bound — the same fail-closed check runWrangler applies after streaming.
 */
function boundedStdoutAdapter(allRows, keyCols) {
  const ordered = [...allRows].sort((left, right) => (
    compareKey(keyValuesOf(left, keyCols), keyValuesOf(right, keyCols))
  ));
  const calls = [];
  return {
    calls,
    async select(sql, params = []) {
      const page = parseKeysetLimit(sql);
      assert.ok(page, "select must end with LIMIT n");
      let start = 0;
      if (params.length > 0) {
        // Unbound partitions pass only keyset params; family partitions pass
        // the partition value first. Tests for ocp/entity use unbound scope.
        const keyParams = params.length === keyCols.length
          ? params
          : params.slice(params.length - keyCols.length);
        assert.equal(keyParams.length, keyCols.length);
        start = ordered.findIndex((row) => compareKey(keyValuesOf(row, keyCols), keyParams) > 0);
        if (start < 0) start = ordered.length;
      }
      const slice = ordered.slice(start, start + page.limit);
      const encodedBytes = Buffer.byteLength(JSON.stringify(slice), "utf8");
      calls.push({
        sql,
        params: [...params],
        rowCount: slice.length,
        encodedBytes,
        paged: true,
        limit: page.limit,
        keyset: params.length > 0,
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

test("the wrangler stdout retain bound stays 32 MiB and the page target stays at 8 MiB", () => {
  assert.equal(WRANGLER_STDIO_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(PARTITION_SCAN_TARGET_PAGE_BYTES, 8 * 1024 * 1024);
  assert.ok(PARTITION_SCAN_TARGET_PAGE_BYTES < WRANGLER_STDIO_MAX_BYTES);
  assert.ok(DEFAULT_PARTITION_SCAN_PAGE_ROWS > 0);
  assert.ok(DEFAULT_PARTITION_SCAN_PAGE_ROWS < 5000);
  assert.ok(MAX_PARTITION_SCAN_PAGE_ROWS >= DEFAULT_PARTITION_SCAN_PAGE_ROWS);
  assert.equal(MIN_PARTITION_SCAN_PAGE_ROWS, 1);
});

test("partitionScanPageRowsFromBytes sizes toward the target and respects the ceiling", () => {
  assert.equal(
    partitionScanPageRowsFromBytes({
      encodedBytes: 1_000_000,
      rowCount: 500,
      targetBytes: 8_000_000,
      maxRows: 8_000,
    }),
    4_000,
  );
  assert.equal(
    partitionScanPageRowsFromBytes({
      encodedBytes: 4_000_000,
      rowCount: 100,
      targetBytes: 8_000_000,
      maxRows: 50,
    }),
    50,
  );
  assert.equal(
    partitionScanPageRowsFromBytes({
      encodedBytes: 8_000_000,
      rowCount: 1,
      targetBytes: 8_000_000,
      maxRows: 8_000,
      minRows: 1,
    }),
    1,
  );
});

test("keysetAfterPredicate covers single- and multi-column keys", () => {
  assert.deepEqual(
    keysetAfterPredicate(["row_key"], ["rk-1"]),
    { clause: "row_key > ?", params: ["rk-1"] },
  );
  assert.deepEqual(
    keysetAfterPredicate(["subject_ref", "entity_ref", "relation"], ["a", "b", "c"]),
    {
      clause: "(subject_ref, entity_ref, relation) > (?, ?, ?)",
      params: ["a", "b", "c"],
    },
  );
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

  const adapter = {
    calls: [],
    async select(sql) {
      const encodedBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
      this.calls.push({ sql, encodedBytes, paged: /\bLIMIT\b/i.test(sql) });
      if (encodedBytes > WRANGLER_STDIO_MAX_BYTES) {
        throw new Error(
          `wrangler stdout exceeded bound: size=${encodedBytes} bytes `
          + `(${(encodedBytes / 1024 / 1024).toFixed(6)} MiB) limit=${WRANGLER_STDIO_MAX_BYTES} bytes `
          + `(${(WRANGLER_STDIO_MAX_BYTES / 1024 / 1024).toFixed(6)} MiB)`,
        );
      }
      return rows;
    },
  };
  await assert.rejects(
    () => adapter.select(`SELECT ${OCP_COLUMNS.join(", ")} FROM ${OCP_TABLE} WHERE 1 = 1`),
    /wrangler stdout exceeded bound/,
  );
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].paged, false);
});

test("keyset scanTableForPartition stays under the stdout bound and still sees every row (pass-after)", async () => {
  let rowCount = 4_000;
  let rows = oversizedOcpRows(rowCount);
  while (Buffer.byteLength(JSON.stringify(rows), "utf8") <= WRANGLER_STDIO_MAX_BYTES && rowCount < 20_000) {
    rowCount += 1_000;
    rows = oversizedOcpRows(rowCount);
  }
  const totalBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
  assert.ok(totalBytes > WRANGLER_STDIO_MAX_BYTES);

  const adapter = boundedStdoutAdapter(rows, OCP_KEYS);
  const pageRows = DEFAULT_PARTITION_SCAN_PAGE_ROWS;
  const observedByKey = await scanTableForPartition({
    entry: ocpEntry,
    table: OCP_TABLE,
    partition: "__model__",
    adapter,
    pageRows,
  });

  assert.ok(adapter.calls.length >= 2, "oversized partition must take more than one page");
  assert.ok(adapter.calls.every((call) => call.paged), "every select must carry LIMIT");
  assert.ok(adapter.calls.every((call) => !/\bOFFSET\b/i.test(call.sql)), "keyset paging must not use OFFSET");
  assert.ok(adapter.calls.every((call) => call.limit === pageRows));
  assert.equal(adapter.calls[0].keyset, false, "first page has no keyset cursor");
  assert.ok(adapter.calls.slice(1).every((call) => call.keyset), "later pages must advance by keyset");
  assert.ok(adapter.calls.every((call) => call.encodedBytes <= WRANGLER_STDIO_MAX_BYTES));
  assert.ok(adapter.calls.every((call) => call.encodedBytes <= PARTITION_SCAN_TARGET_PAGE_BYTES || call.limit === pageRows));
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

test("adaptive keyset paging resizes from measured bytes-per-row toward the 8 MiB target", async () => {
  // Compact rows so the first DEFAULT page measures small bytes/row and the
  // next page grows, still staying under the retain bound and the 8 MiB target.
  const rows = Array.from({ length: 2_500 }, (_, index) => {
    const id = `req-${String(index).padStart(6, "0")}`;
    return {
      row_key: `rk-${id}`,
      request_id: id,
      start_date: "2026-01-01",
      agency_name: "Agency",
      type_of_notice_description: "Notice",
      short_title: "Title",
      pin: `pin-${id}`,
      contract_amount: String(index),
      vendor_name: "Vendor",
    };
  });
  const adapter = boundedStdoutAdapter(rows, OCP_KEYS);
  const observedByKey = await scanTableForPartition({
    entry: ocpEntry,
    table: OCP_TABLE,
    partition: "__model__",
    adapter,
  });
  assert.ok(adapter.calls.length >= 2);
  assert.equal(adapter.calls[0].limit, DEFAULT_PARTITION_SCAN_PAGE_ROWS);
  assert.ok(
    adapter.calls.slice(1).some((call) => call.limit > DEFAULT_PARTITION_SCAN_PAGE_ROWS),
    "later pages should grow once bytes-per-row is measured",
  );
  assert.ok(adapter.calls.every((call) => call.limit <= MAX_PARTITION_SCAN_PAGE_ROWS));
  assert.ok(adapter.calls.every((call) => call.encodedBytes <= PARTITION_SCAN_TARGET_PAGE_BYTES
    || call.limit === MIN_PARTITION_SCAN_PAGE_ROWS));
  assert.ok(adapter.calls.every((call) => !/\bOFFSET\b/i.test(call.sql)));
  assert.equal(observedByKey.size, rows.length);
});

test("an oversized fixed page is still refused by the stdout bound (positive control)", async () => {
  let rowCount = 4_000;
  let rows = oversizedOcpRows(rowCount);
  while (Buffer.byteLength(JSON.stringify(rows), "utf8") <= WRANGLER_STDIO_MAX_BYTES && rowCount < 20_000) {
    rowCount += 1_000;
    rows = oversizedOcpRows(rowCount);
  }
  const adapter = boundedStdoutAdapter(rows, OCP_KEYS);
  await assert.rejects(
    () => scanTableForPartition({
      entry: ocpEntry,
      table: OCP_TABLE,
      partition: "__model__",
      adapter,
      pageRows: rows.length,
    }),
    /wrangler stdout exceeded bound/,
  );
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].limit, rows.length);
  assert.ok(adapter.calls[0].encodedBytes > WRANGLER_STDIO_MAX_BYTES);
});

test("keyset paging walks a multi-column key and still reports missing/unexpected findings", async () => {
  const rows = subjectRefRows(40);
  const adapter = boundedStdoutAdapter(rows, SUBJECT_REFS_KEYS);
  const observedByKey = await scanTableForPartition({
    entry: entityEntry,
    table: SUBJECT_REFS_TABLE,
    partition: "__model__",
    adapter,
    pageRows: 7,
  });
  assert.ok(adapter.calls.length >= 6);
  assert.ok(adapter.calls.every((call) => !/\bOFFSET\b/i.test(call.sql)));
  assert.equal(adapter.calls[0].keyset, false);
  assert.ok(adapter.calls.slice(1).every((call) => call.keyset));
  for (const call of adapter.calls.slice(1)) {
    assert.match(
      call.sql,
      /\(subject_ref, entity_ref, relation, confidence\)\s*>\s*\(\?, \?, \?, \?\)/,
    );
    assert.equal(call.params.length, SUBJECT_REFS_KEYS.length);
  }
  assert.equal(observedByKey.size, rows.length);

  const expectedRows = [
    {
      key: SUBJECT_REFS_KEYS.map((column) => rows[0][column]).join("|"),
      columns: Object.fromEntries(SUBJECT_REFS_COLUMNS.map((column) => [column, rows[0][column]])),
    },
    {
      key: "missing|key|rel|0",
      columns: { subject_ref: "missing" },
    },
  ];
  const findings = classifyPartitionFindings({
    entry: entityEntry,
    table: SUBJECT_REFS_TABLE,
    partition: "__model__",
    expectedRows,
    observedByKey,
  });
  assert.ok(findings.some((finding) => finding.classification === "missing" && finding.key === "missing|key|rel|0"));
  assert.ok(findings.some((finding) => finding.classification === "unexpected"));
  assert.equal(findings.filter((finding) => finding.classification === "unexpected").length, rows.length - 1);
});
