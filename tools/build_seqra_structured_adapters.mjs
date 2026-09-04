#!/usr/bin/env node
/**
 * SEQRA-03: build/check the six structured-source adapter receipts this
 * card's `verify` field names (`npm run warehouse:seqra:ingest`).
 *
 * Default mode rebuilds every adapter's vintage receipt purely from the
 * committed fixtures under warehouse/fixtures/seqra-adapters/ -- no network
 * access, so two consecutive runs (and `--check` against a committed copy)
 * are byte-identical, and this gate never depends on any of the six live
 * publisher endpoints. `--check` reruns and diffs against the committed
 * receipt, matching every other warehouse builder's `--check` convention
 * (see tools/build_seqra_source_inventory.mjs, tools/check_seqra_ontology.mjs).
 *
 * The committed fixture for each source is a small, honestly-labeled
 * "sample_scope" vintage: real bytes from one bounded, polite discovery
 * fetch per source (see each source's observation.json under
 * warehouse/fixtures/seqra-adapters/), never a full-population pull --
 * pagination_complete is derived from the actual row count and is correctly
 * false for every sample vintage. The mechanism this card delivers
 * (pagination-to-completion, schema-drift detection, vintage immutability)
 * is proven below both against those real fixtures and against small
 * synthetic cases built to exercise each success and failure path. A real
 * live capture for a new named vintage would call the same
 * warehouse/lib/seqra_structured_adapter.mjs primitives against `fetch()`;
 * that capture is a deliberate operator action, not part of this gate.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SeqraPaginationIncompleteError,
  SeqraSchemaDriftError,
  SeqraVintageImmutableError,
  assertNoSchemaDrift,
  buildFetchReceipt,
  contentHashOf,
  paginateToCompletion,
  retainRawSnapshot,
  stableJson,
} from "../warehouse/lib/seqra_structured_adapter.mjs";
import {
  SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS,
  getStructuredAdapterSource,
} from "../warehouse/lib/seqra_structured_adapter_sources.mjs";
import { parseEnbListingPage } from "../warehouse/lib/seqra_dec_enb_notice_parser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_ROOT = path.join(ROOT, "warehouse/fixtures/seqra-adapters");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_structured_adapters_latest.json");
const CEQR_RECONCILIATION_RECEIPT = path.join(ROOT, "warehouse/receipts/proof/ceqr_project_milestone_reconciliation_latest.json");
const RESIDENT_INGESTION_NOTE =
  "Research/backtest raw retention only in this card; resident-facing ingestion is not wired and stays disabled until a later owner decision.";

/**
 * Deterministic, not a counter: rebuilding the same vintage must describe
 * the same historical fetch events with the same ids, or A1's "identical
 * hash on re-run" would fail on fetch_id alone even though nothing about
 * the actual fetch changed.
 */
function fetchIdFor(sourceId, vintage, slug) {
  return `seqra03-fetch-${sourceId}-${vintage}-${slug}`;
}

function fixtureVintageDir(sourceId, vintage) {
  return path.join(FIXTURES_ROOT, sourceId, vintage);
}
function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8"));
}
function loadRawText(sourceId, vintage, slug, extension = "json") {
  return readFileSync(path.join(fixtureVintageDir(sourceId, vintage), "raw", `${slug}.${extension}`), "utf8");
}

/** Build one fetch receipt from a committed fixture's observation entry + its raw bytes. */
function fetchReceiptFromFixture({ sourceId, vintage, entry, rawText, rowOrDocumentCount, paginationComplete }) {
  const contentHash = contentHashOf(rawText);
  const byteCount = Buffer.byteLength(rawText, "utf8");
  return buildFetchReceipt({
    fetchId: fetchIdFor(sourceId, vintage, entry.raw_slug),
    sourceId,
    requestedAt: entry.requested_at,
    requestUrlOrQuery: entry.request_url_or_query,
    httpStatus: entry.http_status,
    retrievedAt: entry.retrieved_at,
    sourceVintage: vintage,
    contentType: entry.content_type,
    byteCount,
    contentHash,
    rawObjectPath: path.posix.join(
      "warehouse/fixtures/seqra-adapters", sourceId, vintage, "raw",
      `${entry.raw_slug}.${entry.raw_extension || "json"}`,
    ),
    rowOrDocumentCount,
    paginationComplete,
    warnings: [],
  });
}

/** Build one SODA source's vintage receipt from its committed fixture. `columnsOverride` exists only to drive the schema-drift check below. */
function buildSodaSourceReceipt(sourceId, { columnsOverride = null } = {}) {
  const source = getStructuredAdapterSource(sourceId);
  const vintage = "2026-09-04-sample";
  const observation = readJson(path.join(fixtureVintageDir(sourceId, vintage), "observation.json"));

  const metaText = loadRawText(sourceId, vintage, "dataset_metadata");
  const columns = columnsOverride ?? JSON.parse(metaText).columns.map((c) => c.fieldName);
  assertNoSchemaDrift({ sourceId, requiredFields: source.required_fields, observedFields: columns });

  const pagesText = observation.page_fetches.map((entry) => loadRawText(sourceId, vintage, entry.raw_slug));
  const pagesRows = pagesText.map((text) => JSON.parse(text));
  const rowCount = pagesRows.reduce((sum, rows) => sum + rows.length, 0);
  const paginationComplete = pagesRows[pagesRows.length - 1].length < observation.page_size;

  const fetches = [
    fetchReceiptFromFixture({
      sourceId, vintage, entry: observation.dataset_metadata_fetch, rawText: metaText,
      rowOrDocumentCount: 1, paginationComplete: true, // the metadata call is a single, always-complete request
    }),
    ...observation.page_fetches.map((entry, i) => fetchReceiptFromFixture({
      sourceId, vintage, entry, rawText: pagesText[i], rowOrDocumentCount: pagesRows[i].length, paginationComplete,
    })),
  ];

  return {
    schema: "cityscroll.seqra_adapter_vintage_receipt.v1",
    source_id: sourceId,
    source_name: source.source_name,
    kind: source.kind,
    dataset_id: source.dataset_id,
    vintage,
    captured_at: observation.page_fetches[0].retrieved_at,
    sample_scope: Boolean(observation.sample_scope),
    sample_scope_note: observation.sample_scope_note ?? null,
    schema_check: { required_fields: source.required_fields, observed_fields: [...columns].sort(), drift: false },
    row_count: rowCount,
    pagination_complete: paginationComplete,
    fetches,
    resident_ingestion: { committed: false, note: RESIDENT_INGESTION_NOTE },
  };
}

/** Build the ENB notice-metadata receipt. Schema-drift detection lives inside parseEnbListingPage itself. */
function buildEnbSourceReceipt() {
  const sourceId = "nys_dec_enb_notice_metadata";
  const source = getStructuredAdapterSource(sourceId);
  const vintage = "2026-09-04-sample";
  const observation = readJson(path.join(fixtureVintageDir(sourceId, vintage), "observation.json"));
  const entry = observation.page_fetches[0];
  const html = loadRawText(sourceId, vintage, entry.raw_slug, entry.raw_extension || "html");
  const parsed = parseEnbListingPage(html, { sourceId });
  const paginationComplete = parsed.range_end >= parsed.total_results;

  return {
    schema: "cityscroll.seqra_adapter_vintage_receipt.v1",
    source_id: sourceId,
    source_name: source.source_name,
    kind: source.kind,
    base_url: source.base_url,
    vintage,
    captured_at: entry.retrieved_at,
    sample_scope: Boolean(observation.sample_scope),
    sample_scope_note: observation.sample_scope_note ?? null,
    schema_check: { required_fields: source.required_fields, observed_fields: source.required_fields, drift: false },
    discovery: {
      total_results: parsed.total_results,
      range_start: parsed.range_start,
      range_end: parsed.range_end,
      row_block_count: parsed.row_block_count,
      malformed_row_count: parsed.malformed.length,
      not_a_stable_api: true,
      note:
        "Public search page, not a documented API. Per the commission's negative rule this adapter " +
        "never treats it as one: every page's notice count is checked against its own declared results " +
        "range, and a mismatch fails visibly (SeqraSchemaDriftError) instead of silently parsing fewer notices.",
    },
    row_count: parsed.notices.length,
    pagination_complete: paginationComplete,
    fetches: [
      fetchReceiptFromFixture({
        sourceId, vintage, entry, rawText: html, rowOrDocumentCount: parsed.notices.length, paginationComplete,
      }),
    ],
    resident_ingestion: { committed: false, note: RESIDENT_INGESTION_NOTE },
  };
}

function buildSourceReceipt(sourceId) {
  return getStructuredAdapterSource(sourceId).kind === "html_discovery"
    ? buildEnbSourceReceipt()
    : buildSodaSourceReceipt(sourceId);
}

// ---------------------------------------------------------------------------
// Gate checks
// ---------------------------------------------------------------------------
const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, result: "pass" });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let sourceReceipts = {};
await check("every registered source builds a vintage receipt from its committed fixture", () => {
  for (const sourceId of SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS) sourceReceipts[sourceId] = buildSourceReceipt(sourceId);
  assertEqual(Object.keys(sourceReceipts).length, 6, "adapter source count");
});

await check("re-running a named vintage produces an identical content hash for every adapter (A1)", () => {
  for (const sourceId of SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS) {
    const first = stableJson(buildSourceReceipt(sourceId));
    const second = stableJson(buildSourceReceipt(sourceId));
    assertEqual(first, second, `${sourceId}: rebuilding the same vintage twice`);
  }
});

await check("every fetch carries the full required receipt shape (A2)", () => {
  const REQUIRED_KEYS = [
    "fetch_id", "source_id", "requested_at", "request_url_or_query", "http_status",
    "retrieved_at", "source_vintage", "content_type", "byte_count", "content_hash",
    "raw_object_path", "row_or_document_count", "pagination_complete", "parser_version", "warnings",
  ];
  for (const [sourceId, receipt] of Object.entries(sourceReceipts)) {
    assertTrue(receipt.fetches.length > 0, `${sourceId}: at least one fetch receipt`);
    for (const fetchReceipt of receipt.fetches) {
      for (const key of REQUIRED_KEYS) {
        assertTrue(Object.prototype.hasOwnProperty.call(fetchReceipt, key), `${sourceId}: fetch receipt missing ${key}`);
      }
    }
  }
});

await check("a missing required SODA field fails the adapter visibly instead of silently parsing (A3)", () => {
  let threw = false;
  try {
    buildSodaSourceReceipt("ceqr_projects", { columnsOverride: ["project_name", "borough"] });
  } catch (error) {
    threw = error instanceof SeqraSchemaDriftError;
    assertTrue(threw, `expected SeqraSchemaDriftError, got ${error}`);
    assertTrue(error.missingFields.includes("ceqr"), "the missing-field list must name the dropped field");
  }
  assertTrue(threw, "dropping a required column must throw, not silently build a receipt");
});

await check("a truncated live paginated walk fails rather than reporting a smaller population (A3/G2)", async () => {
  let threw = false;
  try {
    await paginateToCompletion({
      sourceId: "ceqr_projects",
      pageSize: 2,
      maxPages: 3,
      fetchPage: async () => ({ rows: [{}, {}] }), // always a full page; the publisher never confirms an end
    });
  } catch (error) {
    threw = error instanceof SeqraPaginationIncompleteError;
    assertTrue(threw, `expected SeqraPaginationIncompleteError, got ${error}`);
  }
  assertTrue(threw, "hitting the page cap on a still-full page must throw, not return a receipt");
});

await check("a complete live paginated walk reports pagination_complete on the natural short final page", async () => {
  const pages = [[{}, {}], [{}]];
  let i = 0;
  const result = await paginateToCompletion({
    sourceId: "ceqr_projects", pageSize: 2, maxPages: 10,
    fetchPage: async () => ({ rows: pages[i++] }),
  });
  assertEqual(result.paginationComplete, true, "paginationComplete");
  assertEqual(result.rows.length, 3, "row count");
});

await check("re-fetching an already-captured vintage under different bytes is refused, never silently overwritten", () => {
  const scratchAbs = path.join(process.env.TMPDIR || "/tmp", `seqra03-vintage-immutability-${process.pid}`);
  mkdirSync(scratchAbs, { recursive: true });
  retainRawSnapshot({ rootAbs: scratchAbs, rootRel: "scratch", sourceId: "ceqr_projects", vintage: "v1", slug: "page-0000", text: "AAA" });
  let threw = false;
  try {
    retainRawSnapshot({ rootAbs: scratchAbs, rootRel: "scratch", sourceId: "ceqr_projects", vintage: "v1", slug: "page-0000", text: "BBB" });
  } catch (error) {
    threw = error instanceof SeqraVintageImmutableError;
  }
  assertTrue(threw, "writing different bytes under an already-captured vintage label must throw");
  const again = retainRawSnapshot({ rootAbs: scratchAbs, rootRel: "scratch", sourceId: "ceqr_projects", vintage: "v1", slug: "page-0000", text: "AAA" });
  assertEqual(again.contentHash, contentHashOf("AAA"), "re-retaining identical bytes stays a no-op with the same hash");
});

await check("a renamed ENB structural marker fails the adapter visibly instead of parsing zero notices (A3)", () => {
  const html = loadRawText("nys_dec_enb_notice_metadata", "2026-09-04-sample", "page-0000", "html");
  const drifted = html.replace(/c-view__row/g, "c-view__renamed-row");
  let threw = false;
  try {
    parseEnbListingPage(drifted, { sourceId: "nys_dec_enb_notice_metadata" });
  } catch (error) {
    threw = error instanceof SeqraSchemaDriftError;
    assertTrue(threw, `expected SeqraSchemaDriftError, got ${error}`);
  }
  assertTrue(threw, "a renamed row marker must throw, not return zero notices as if the page were empty");
});

await check("resident ingestion remains disabled and every receipt records it as not committed (A5)", () => {
  for (const [sourceId, receipt] of Object.entries(sourceReceipts)) {
    assertEqual(receipt.resident_ingestion.committed, false, `${sourceId}: resident_ingestion.committed`);
  }
});

await check("existing ZAP/CEQR reconciliation output does not regress (A4)", () => {
  const receipt = readJson(CEQR_RECONCILIATION_RECEIPT);
  assertEqual(receipt.reconciliation.exact_project_matches, 197, "exact_project_matches");
  assertEqual(receipt.reconciliation.exact_match_rate, 0.942584, "exact_match_rate");
  assertEqual(receipt.reconciliation.joined_milestone_rows, 502, "joined_milestone_rows");
  assertEqual(receipt.reconciliation.projects_with_incremental_milestones, 182, "projects_with_incremental_milestones");
  assertEqual(receipt.gate.resident_ingestion_committed, false, "resident_ingestion_committed");

  // Re-run the existing tool's own --check gate and both modules' unit
  // suites, so a change to a field-list constant this card reuses (or to
  // either builder) is caught here, not only by an unrelated CI job.
  execFileSync(process.execPath, ["tools/build_ceqr_project_milestone_reconciliation.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
  execFileSync(process.execPath, ["--test", "test/ceqr_project_milestone_reconciliation.test.mjs"], { cwd: ROOT, stdio: "pipe" });
  execFileSync(process.execPath, ["--test", "test/zap_environmental_projection.test.mjs"], { cwd: ROOT, stdio: "pipe" });
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.seqra_structured_adapters_receipt.v1",
  source_count: SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS.length,
  sources: sourceReceipts,
  checks,
  gate: { result: gateResult, failed_check_count: failed.length, resident_ingestion_committed: false },
};

const next = stableJson(receipt);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--check") throw new Error("Usage: node tools/build_seqra_structured_adapters.mjs [--check]");
}

if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/build_seqra_structured_adapters.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`SEQRA-03 structured-adapters gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`SEQRA structured-adapters gate OK (${checks.length} checks, ${SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS.length} sources)`);
