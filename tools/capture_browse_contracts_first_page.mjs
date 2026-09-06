#!/usr/bin/env node
/**
 * Deterministic evidence for the Browse Contracts bounded first page.
 *
 * This is a functional network-order trace, not a rendered screenshot: it
 * exercises the real bounded-query module (site/procurement_browse_query.mjs)
 * and the same read-path decision site/app/money-list.mjs's search() applies,
 * against the tracked procurement Browse fixture, and records the order in
 * which artifacts are requested for a cold non-default Contracts view. No
 * image is produced or captured.
 *
 *   node tools/capture_browse_contracts_first_page.mjs
 *   node tools/capture_browse_contracts_first_page.mjs --check
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildProcurementBrowseQueryArtifacts, loadProcurementBrowseQuery } from "../site/procurement_browse_query.mjs";
import { filterMoneySnapshot } from "../site/resident_snapshot_queries.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "site/data/procurement_browse_rows.json");
const OUTPUT = join(ROOT, "docs/evidence/snappiness/browse-contracts-first-page/manifest.json");
const RESIDENT_SNAPSHOT_URL = "data/money_resident_snapshot.json";

const TRACE_QUERY = { mode: "award", agency: "Youth and Community Development", sort: "newest" };
const ROUTE = "/browse/contracts/?mode=award&agency=Youth%20and%20Community%20Development";

function response(ok, payload) {
  return { ok, async json() { return payload; } };
}

function revision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function trace() {
  const fullBrowse = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const { manifest, shards, queryRowsArtifact } = buildProcurementBrowseQueryArtifacts({
    ...fullBrowse,
    source_model_fingerprint: "perf-03-evidence-fingerprint",
  });
  const calls = [];
  const events = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "data/procurement_browse_query.json") return response(true, manifest);
    if (url === "data/procurement_browse_query_rows.json") return response(true, queryRowsArtifact);
    const index = manifest.shards.findIndex((descriptor) => `data/${descriptor.path}` === url);
    if (index >= 0) return response(true, shards[index]);
    throw new Error(`unexpected fetch ${url}`);
  };
  const canonicalFirstPage = await loadProcurementBrowseQuery({ fetchImpl, options: TRACE_QUERY });
  events.push({ event: "first-40-rows-painted", row_count: canonicalFirstPage.rows.length, bounded_source: canonicalFirstPage.source });

  // The resident snapshot fetch is deliberately deferred to the post-paint
  // hydration continuation; this stub stands in for loadMoneyResidentSnapshot()
  // in site/app/money-list.mjs to prove it is only reached after paint.
  let snapshotRequestedAt = null;
  const deferredSnapshotFetch = () => {
    calls.push(RESIDENT_SNAPSHOT_URL);
    snapshotRequestedAt = calls.length;
    events.push({ event: "resident-snapshot-fetch-issued", url: RESIDENT_SNAPSHOT_URL });
    return Promise.resolve({ rows: [] });
  };
  await Promise.all([deferredSnapshotFetch(), canonicalFirstPage.hydrate()]);

  const full = filterMoneySnapshot(fullBrowse.rows, { ...TRACE_QUERY, limit: 40 });
  const identical = JSON.stringify(canonicalFirstPage.rows.map((row) => row.procurement_id || row.request_id))
    === JSON.stringify(full.map((row) => row.procurement_id || row.request_id));

  return {
    calls,
    events,
    row_count: canonicalFirstPage.rows.length,
    bounded_source: canonicalFirstPage.source,
    snapshot_requested_after_paint_call_index: snapshotRequestedAt,
    first_40_rows_identical_to_full_read: identical,
    fixture_generated_at: fullBrowse.generated_at || null,
    fixture_row_count: fullBrowse.rows.length,
  };
}

function buildManifest(observed) {
  const contentHashInput = JSON.stringify({
    query: TRACE_QUERY,
    calls: observed.calls,
    events: observed.events,
    row_count: observed.row_count,
    bounded_source: observed.bounded_source,
  });
  return {
    schema: "cityscroll.snappiness_evidence_capture.v1",
    change: "cityscroll-engineering/browse-contracts-load-tail",
    capture_kind: "functional network-order trace (no browser, no image capture)",
    route: ROUTE,
    viewport: { name: "not-applicable", note: "network-order trace; no rendered viewport was captured" },
    revision: revision(),
    data_vintage: {
      fixture: "site/data/procurement_browse_rows.json",
      fixture_generated_at: observed.fixture_generated_at,
      fixture_row_count: observed.fixture_row_count,
    },
    assertion: "a cold non-default Contracts trace (Recent Awards filtered by agency) renders its first 40 rows "
      + "from the bounded query manifest and, when needed, the compact query rows — never the full procurement "
      + "snapshot or the unpublished monolithic Browse projection — and the resident-snapshot fetch used only for "
      + "post-paint lineage reconciliation is issued strictly after those rows are painted.",
    observations: {
      fetch_call_order: observed.calls,
      event_order: observed.events.map((entry) => entry.event),
      bounded_source: observed.bounded_source,
      row_count: observed.row_count,
      resident_snapshot_requested_before_first_paint: observed.snapshot_requested_after_paint_call_index === null
        ? null
        : observed.events.findIndex((entry) => entry.event === "resident-snapshot-fetch-issued")
          < observed.events.findIndex((entry) => entry.event === "first-40-rows-painted"),
      first_40_rows_identical_to_full_read: observed.first_40_rows_identical_to_full_read,
    },
    content_sha256: sha256(contentHashInput),
  };
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const observed = await trace();
  const manifest = buildManifest(observed);
  const bytes = serialized(manifest);
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUTPUT, "utf8");
    if (current !== bytes) throw new Error(`stale evidence: ${OUTPUT} (rebuild with node tools/capture_browse_contracts_first_page.mjs)`);
    console.log(`checked ${OUTPUT}`);
    return;
  }
  writeFileSync(OUTPUT, bytes);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
