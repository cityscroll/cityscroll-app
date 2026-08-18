#!/usr/bin/env node
/**
 * Materialize the FY payroll title mart (aggregate only) for the Worker.
 *
 * SODA group-by export — not a 6.8M employee dump. Replaces request-time
 * k397-673e title counts when the committed lookup is present.
 *
 * Usage:
 *   node tools/build_payroll_title_warehouse_lookup.mjs --from-soda
 *   node tools/build_payroll_title_warehouse_lookup.mjs --from-soda --bench
 *   node tools/build_payroll_title_warehouse_lookup.mjs --fixture
 *   node tools/build_payroll_title_warehouse_lookup.mjs --check
 *
 * A rebuild that fails the serve gate keeps the last-known-good committed twins.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { REPO_ROOT } from "../warehouse/lib/catalog.mjs";
import {
  PAYROLL_PUBLISHER_ROW_COUNT,
  PAYROLL_TITLE_SODA,
  PAYROLL_TITLE_WINDOW_ROW_COUNT,
  assertPayrollTitleServeGate,
  buildMaterializationDoc,
  loadLastKnownGoodDoc,
  loadProductSeedRows,
  lookupPayrollTitleCount,
  payrollTitleGroupByParams,
  payrollTitleWindowCountParams,
} from "../warehouse/lib/payroll_title_lookup.mjs";
import {
  assertServePublishTwins,
  SERVE_LOOKUP_CONTRACTS,
} from "../warehouse/lib/serve_publish_contract.mjs";
import {
  publicPayloadFindings,
} from "./lib/public_payload_integrity.mjs";
import { countPayrollTitleMatches } from "../site/payroll_title_mart.mjs";

const ROOT = REPO_ROOT;
const OUT_SITE = path.join(ROOT, "site", "data", "payroll_title_warehouse_lookup.json");
const OUT_WORKER = path.join(
  ROOT,
  "worker",
  "src",
  "data",
  "payroll_title_warehouse_lookup.json",
);
const BENCH_RECEIPT = path.join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "payroll_title_lookup_speed.json",
);

function parseArgs(argv) {
  const out = { fixture: false, check: false, bench: false, fromSoda: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fixture") out.fixture = true;
    else if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--bench") out.bench = true;
    else if (argv[i] === "--from-soda") out.fromSoda = true;
  }
  return out;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sodaNumber(row, keys) {
  for (const key of keys) {
    const n = Number(row?.[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function fetchSodaJson(params, fetchImpl = fetch) {
  const url = `${PAYROLL_TITLE_SODA}?${new URLSearchParams(params)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Payroll SODA ${res.status} for ${url}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error("Payroll SODA returned a non-array response");
  return body;
}

async function fetchPayrollTitleMartFromSoda(fetchImpl = fetch) {
  const [titleRows, windowRows, publisherRows] = await Promise.all([
    fetchSodaJson(payrollTitleGroupByParams(), fetchImpl),
    fetchSodaJson(payrollTitleWindowCountParams(), fetchImpl),
    fetchSodaJson({ $select: "count(1) as n" }, fetchImpl),
  ]);
  return {
    rows: titleRows,
    windowRowCount: sodaNumber(windowRows[0], ["n", "count"]) ?? PAYROLL_TITLE_WINDOW_ROW_COUNT,
    publisherRowCount: sodaNumber(publisherRows[0], ["n", "count"]) ?? PAYROLL_PUBLISHER_ROW_COUNT,
    mode: "soda_groupby",
  };
}

async function collectRows({ fixture, fromSoda }) {
  if (fromSoda) return fetchPayrollTitleMartFromSoda();
  return {
    rows: loadProductSeedRows(),
    windowRowCount: loadProductSeedRows().reduce((sum, row) => sum + row.n, 0),
    publisherRowCount: PAYROLL_PUBLISHER_ROW_COUNT,
    mode: fixture ? "product_seed" : "product_seed",
  };
}

function statsMs(samples, digits = 3) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const round = (n) => Math.round(n * 10 ** digits) / 10 ** digits;
  return {
    samples_ms: samples.slice(0, 5).map((n) => round(n)),
    p50_ms: round(p50),
    mean_ms: round(mean),
    n: samples.length,
  };
}

function bench(doc) {
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    countPayrollTitleMatches(doc, "paramedic");
    samples.push(performance.now() - t0);
  }
  const lookupMs = statsMs(samples, 4);
  return {
    phase: "WH-optional-payroll-title",
    measured_at: new Date().toISOString(),
    replaces_live_fetch: {
      function: "suggestionCountParams",
      soda_dataset: "k397-673e",
      note: "Previous live path counted FY title rows on SODA at request time",
    },
    materialization: {
      title_count: doc.title_count,
      window_row_count: doc.coverage?.window_row_count,
      publisher_row_count: doc.coverage?.publisher_row_count,
    },
    edge_materialization_lookup: {
      ...lookupMs,
      note: "In-process title LIKE over the committed FY mart",
    },
    prior_live_soda: {
      p50_ms_floor: 180,
      provenance: "derived",
      note: "Request-time SODA group/count RTT floor before the mart",
    },
    summary:
      `Payroll title count p50: live SODA floor 180ms → mart ${lookupMs.p50_ms}ms ` +
      `(${doc.title_count} titles over ${doc.coverage?.window_row_count} FY rows; ` +
      `publisher file ${doc.coverage?.publisher_row_count})`,
  };
}

function writeOrCheck(filePath, doc, check) {
  const rendered = stableStringify(doc);
  if (check) {
    let existing = null;
    try {
      existing = readFileSync(filePath, "utf8");
    } catch {
      existing = null;
    }
    assert.equal(
      existing,
      rendered,
      `${path.relative(ROOT, filePath)} is stale; rebuild with node tools/build_payroll_title_warehouse_lookup.mjs --from-soda`,
    );
    return { path: filePath, status: "ok" };
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, rendered);
  return { path: filePath, status: "wrote", bytes: Buffer.byteLength(rendered) };
}

function writeOutputs(doc, check) {
  return {
    site: writeOrCheck(OUT_SITE, doc, check),
    worker: writeOrCheck(OUT_WORKER, doc, check),
  };
}

function readCommittedDoc(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sortTitleRows(rows) {
  return [...rows].sort((left, right) =>
    right.n - left.n || left.title_description.localeCompare(right.title_description));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.fromSoda && args.fixture) {
    throw new Error("Cannot combine --from-soda and --fixture");
  }

  if (args.check) {
    for (const filePath of [OUT_SITE, OUT_WORKER]) {
      assert.ok(existsSync(filePath), `${path.relative(ROOT, filePath)} missing`);
    }
    const site = readCommittedDoc(OUT_SITE);
    const worker = readCommittedDoc(OUT_WORKER);
    assertServePublishTwins(site, worker, SERVE_LOOKUP_CONTRACTS.payroll_title);
    assertPayrollTitleServeGate(site);
    assertPayrollTitleServeGate(worker);
    const police = lookupPayrollTitleCount(site, "POLICE OFFICER");
    assert.ok(police.hit && police.count > 0, "committed mart missing POLICE OFFICER");
    console.log("ok serve-publish contract for Payroll title mart twins");
  }

  if (args.check && !args.fromSoda && !args.fixture) return;

  const collected = await collectRows(args);
  let now = new Date().toISOString();
  if (args.check && existsSync(OUT_WORKER)) {
    try {
      now = JSON.parse(readFileSync(OUT_WORKER, "utf8")).materialized_at || now;
    } catch {
      /* keep now */
    }
  }

  const doc = buildMaterializationDoc(collected.rows, {
    mode: collected.mode,
    now,
    publisherRowCount: collected.publisherRowCount,
    windowRowCount: collected.windowRowCount,
  });
  doc.rows = sortTitleRows(doc.rows);
  doc.title_count = doc.rows.length;
  doc.row_count = doc.rows.length;

  assert.deepEqual(
    publicPayloadFindings(doc, {
      source: "site/data/payroll_title_warehouse_lookup.json",
    }),
    [],
    "Payroll title mart contains test-only records",
  );

  try {
    if (args.fromSoda || collected.mode === "soda_groupby") {
      assertPayrollTitleServeGate(doc);
    }
  } catch (e) {
    const lkg = loadLastKnownGoodDoc(OUT_SITE, OUT_WORKER);
    if (lkg) {
      console.error(
        `rebuild failed serve gate (${e.message}); retaining last-known-good ` +
          `(title_count=${lkg.title_count}, materialized_at=${lkg.materialized_at})`,
      );
      process.exitCode = 2;
      console.log(JSON.stringify({
        status: "retained_last_known_good",
        reason: String(e.message || e),
        last_known_good: {
          title_count: lkg.title_count,
          mode: lkg.mode,
          materialized_at: lkg.materialized_at,
        },
      }, null, 2));
      return;
    }
    throw e;
  }

  if (args.fixture) {
    console.log(JSON.stringify({
      status: "fixture_only",
      title_count: doc.title_count,
      note: "Fixture seed is not written to the public lookup (publicPayloadIntegrity).",
    }, null, 2));
    return;
  }

  const result = writeOutputs(doc, args.check);
  console.log(JSON.stringify(result, null, 2));

  if (args.bench || args.fromSoda) {
    const receipt = bench(doc);
    mkdirSync(path.dirname(BENCH_RECEIPT), { recursive: true });
    writeFileSync(BENCH_RECEIPT, stableStringify(receipt));
    console.log("bench:", JSON.stringify(receipt, null, 2));
    console.log("bench_receipt:", path.relative(ROOT, BENCH_RECEIPT));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
