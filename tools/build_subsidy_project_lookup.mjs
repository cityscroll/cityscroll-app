#!/usr/bin/env node
/**
 * Materialize receipt-backed NYCEDC/NYCIDA/Build NYC projects for the Worker.
 *
 * The public artifact is emitted only when the committed RC-2 receipt is accepted,
 * clears its measured threshold, and has no reviewed false positives or unreviewed
 * candidates. The warehouse view already contains accepted edges only.
 *
 * Usage:
 *   node tools/build_subsidy_project_lookup.mjs
 *   node tools/build_subsidy_project_lookup.mjs --check
 *   node tools/build_subsidy_project_lookup.mjs --bench
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, catalogExists } from "../warehouse/lib/catalog.mjs";
import { queryWarehouse } from "../warehouse/lib/query.mjs";

const ROOT = REPO_ROOT;
const RECEIPT_PATH = path.join(
  ROOT,
  "site/data/nycedc_sources/verification_receipts/nycedc_project_documents_2026-08-04.json",
);
const OUT_SITE = path.join(ROOT, "site/data/subsidy_project_lookup.json");
const OUT_WORKER = path.join(ROOT, "worker/src/data/subsidy_project_lookup.json");
const BENCH_RECEIPT = path.join(
  ROOT,
  "warehouse/receipts/proof/rc2_subsidy_project_lookup_speed.json",
);

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    bench: argv.includes("--bench"),
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function receiptSummary(receipt) {
  return {
    schema: receipt.schema,
    observed_at: receipt.observed_at,
    bridge_status: receipt.bridge_status,
    join_rate: receipt.sample?.join_rate ?? null,
    threshold: receipt.threshold,
    false_positives: receipt.false_positive_review?.false_positives ?? null,
    unreviewed_candidates: receipt.false_positive_review?.unreviewed_candidates ?? null,
  };
}

function assertReceiptAccepted(receipt) {
  assert.equal(receipt.bridge_status, "accepted", "RC-2 bridge must be accepted");
  assert.ok(
    Number(receipt.sample?.join_rate) >= Number(receipt.threshold),
    "RC-2 join rate must clear its measured threshold",
  );
  assert.equal(receipt.false_positive_review?.false_positives, 0);
  assert.equal(receipt.false_positive_review?.unreviewed_candidates, 0);
}

function lifecycleDates(milestones) {
  const out = [];
  for (const stage of ["application", "board_decision", "closing", "compliance"]) {
    const milestone = milestones?.[stage];
    if (!milestone?.date) continue;
    out.push({
      stage,
      date: milestone.date,
      ...(milestone.outcome ? { outcome: milestone.outcome } : {}),
      ...(milestone.status ? { status: milestone.status } : {}),
    });
  }
  return out;
}

export function buildSubsidyProjectLookup(rows, receipt) {
  assertReceiptAccepted(receipt);
  const by_notice = {};
  for (const row of rows || []) {
    if (!row.joined_request_id || Number(row.join_confidence) < 1) continue;
    const milestones = typeof row.milestones === "string"
      ? JSON.parse(row.milestones)
      : row.milestones;
    const provenance = typeof row.provenance === "string"
      ? JSON.parse(row.provenance)
      : row.provenance;
    const project = {
      receipt_backed: true,
      join_method: row.join_method,
      join_confidence: Number(row.join_confidence),
      authority: row.authority,
      project_id: row.project_id,
      project_name: row.project_name,
      company: row.company,
      address: row.address ?? null,
      requested_benefit: row.requested_benefit ?? null,
      estimated_public_cost: row.estimated_public_cost ?? null,
      project_cost: row.project_cost ?? null,
      milestones,
      lifecycle_dates: lifecycleDates(milestones),
      official_documents_url: provenance?.source_url ?? null,
      provenance: provenance ? { ...provenance, observed_at: receipt.observed_at } : null,
    };
    (by_notice[row.joined_request_id] ||= []).push(project);
  }
  for (const projects of Object.values(by_notice)) {
    projects.sort((a, b) => a.project_name.localeCompare(b.project_name));
  }
  const row_count = Object.values(by_notice).reduce((sum, rowsForNotice) => sum + rowsForNotice.length, 0);
  return {
    schema: "cityscroll.subsidy_project_lookup.v1",
    materialized_at: receipt.observed_at,
    receipt: receiptSummary(receipt),
    row_count,
    notice_count: Object.keys(by_notice).length,
    by_notice,
  };
}

function warehouseRows() {
  return queryWarehouse(`
    SELECT joined_request_id, authority, project_id, project_name, company, address,
           requested_benefit, estimated_public_cost, project_cost, milestones,
           provenance, join_method, join_confidence
      FROM nycedc_project_feed
     WHERE joined_request_id IS NOT NULL
     ORDER BY joined_request_id, project_name
  `);
}

function validateArtifact(doc, receipt) {
  assert.equal(doc.schema, "cityscroll.subsidy_project_lookup.v1");
  assert.deepEqual(doc.receipt, receiptSummary(receipt));
  assertReceiptAccepted(receipt);
  const noticeIds = Object.keys(doc.by_notice || {});
  const rows = noticeIds.flatMap((id) => doc.by_notice[id] || []);
  assert.equal(doc.notice_count, noticeIds.length);
  assert.equal(doc.row_count, rows.length);
  for (const project of rows) {
    assert.equal(project.receipt_backed, true);
    assert.ok(project.join_confidence >= 1);
    assert.match(project.official_documents_url || "", /^https:\/\/edc\.nyc\//);
    assert.ok(project.project_name);
    assert.ok(project.company);
    assert.equal(project.lifecycle_dates.length, project.lifecycle_dates.filter((item) => item.date).length);
  }
}

function writeOrCheck(doc, check) {
  const rendered = stable(doc);
  if (check) {
    assert.equal(readFileSync(OUT_SITE, "utf8"), rendered, "site lookup is stale");
    assert.equal(readFileSync(OUT_WORKER, "utf8"), rendered, "worker lookup is stale");
    return;
  }
  for (const filePath of [OUT_SITE, OUT_WORKER]) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, rendered);
  }
}

async function bench(doc) {
  const { lookupSubsidyProjects } = await import("../worker/src/lib/subsidy_project_lookup.mjs");
  const id = Object.keys(doc.by_notice)[0];
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    lookupSubsidyProjects(id, doc);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const result = {
    schema: "cityscroll.subsidy_project_lookup_speed.v1",
    measured_at: new Date().toISOString(),
    samples: samples.length,
    lookup_p50_ms: Number(samples[Math.floor(samples.length * 0.5)].toFixed(4)),
    lookup_p95_ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(4)),
    payload_bytes: Buffer.byteLength(stable(doc)),
    rows: doc.row_count,
    notices: doc.notice_count,
    path: "Worker in-process receipt-backed materialization; no publisher request on hit",
  };
  mkdirSync(path.dirname(BENCH_RECEIPT), { recursive: true });
  writeFileSync(BENCH_RECEIPT, stable(result));
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const receipt = readJson(RECEIPT_PATH);
  let doc;
  if (args.check && !catalogExists()) {
    doc = readJson(OUT_SITE);
  } else {
    assert.ok(catalogExists(), "warehouse catalog missing; run the RC-2 collector first");
    doc = buildSubsidyProjectLookup(warehouseRows(), receipt);
  }
  validateArtifact(doc, receipt);
  writeOrCheck(doc, args.check);
  const result = { status: args.check ? "ok" : "wrote", rows: doc.row_count, notices: doc.notice_count };
  if (args.bench) result.bench = await bench(doc);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
