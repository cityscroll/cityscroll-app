#!/usr/bin/env node
/**
 * Capture a retained production read for the procurement detail parity canary.
 *
 * Read-only against the live origins named by the card's proof-in-product
 * section. Records live URL, served build vintage, assertion, and result for
 * every production read so a later reader can re-check independently.
 *
 * Usage:
 *   node tools/capture_served_procurement_route_production_read.mjs
 *   node tools/capture_served_procurement_route_production_read.mjs --check
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url);
const OUT = new URL("../docs/evidence/served-procurement-route/production-read.json", import.meta.url);
const PROCUREMENT_ID = "procurement:contract:CT107120258801626";
const ROUTE = `/procurements/${encodeURIComponent(PROCUREMENT_ID)}`;
const PAGE_URL = `https://cityscroll.org${ROUTE}`;
const SEARCH_URLS = [
  "https://api.cityscroll.org/search?q=CT107120258801626",
  "https://api.cityscroll.org/search?q=07124E0044001",
];
const USER_AGENT = "CityScrollEvidence/1.0 (+https://cityscroll.org)";
const EXPECTED_HREFS = [
  "/agencies/homeless-services/",
  "/vendors/BHRAGS%20HOME%20CARE/",
  "/search/?q=CT107120258801626",
  "/search/?q=07124E0044001",
  "/notices/20240829105",
  "https://a0333-passportpublic.nyc.gov/contracts.html",
  "https://www.checkbooknyc.com/smart_search/citywide?search_term=CT107120258801626",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function matchingRecords(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) matchingRecords(item, output);
  } else if (value && typeof value === "object") {
    if (value.object_ref === PROCUREMENT_ID || value.procurement_id === PROCUREMENT_ID) {
      output.push(value);
    } else {
      for (const child of Object.values(value)) matchingRecords(child, output);
    }
  }
  return output;
}

function distinctMatchingObjectRefs(value) {
  return new Set(matchingRecords(value).map((record) => record.object_ref || record.procurement_id)).size;
}

async function fetchText(url, accept) {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": USER_AGENT },
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body, text: body.toString("utf8") };
}

async function fetchJson(url) {
  const { response, body, text } = await fetchText(url, "application/json");
  return { response, body, payload: JSON.parse(text) };
}

function groundedAt() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT.pathname, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git rev-parse failed");
  return result.stdout.trim();
}

async function capture() {
  const observedAt = new Date().toISOString();
  const grounded = groundedAt();
  const health = await fetchJson("https://api.cityscroll.org/health");
  assert.equal(health.response.status, 200, "worker health");

  const page = await fetchText(PAGE_URL, "text/html");
  const pageAssertions = [];
  let pagePass = page.response.status === 200;
  pageAssertions.push({
    name: "http_status_200",
    expected: 200,
    actual: page.response.status,
    result: page.response.status === 200 ? "pass" : "fail",
  });
  for (const href of EXPECTED_HREFS) {
    const ok = page.text.includes(`href="${href}"`);
    pagePass = pagePass && ok;
    pageAssertions.push({
      name: "destination_anchor",
      href,
      result: ok ? "pass" : "fail",
    });
  }
  for (const copy of ["2023-10-11", "2026-06-30", "2024-08-28", "2024-09-05", "Homeless Services", "BHRAGS HOME CARE CORP"]) {
    const ok = page.text.includes(copy);
    pagePass = pagePass && ok;
    pageAssertions.push({ name: "semantic_copy", copy, result: ok ? "pass" : "fail" });
  }
  const absenceOk = !/Lookup not run|NYS ABO|procurement-opportunity-window|procurement-opportunity-month/.test(page.text);
  pagePass = pagePass && absenceOk;
  pageAssertions.push({
    name: "no_misleading_absence_chrome",
    result: absenceOk ? "pass" : "fail",
  });

  const searchReads = [];
  for (const url of SEARCH_URLS) {
    const { response, body, payload } = await fetchJson(url);
    const resultsLength = Array.isArray(payload.results) ? payload.results.length : -1;
    const distinct = distinctMatchingObjectRefs(payload);
    const federatedLength = Array.isArray(payload?.federated?.results) ? payload.federated.results.length : null;
    const recursiveMatchCount = matchingRecords(payload).length;
    const pass = response.status === 200 && resultsLength === 1 && distinct === 1;
    searchReads.push({
      url,
      kind: "exact_identifier_search",
      status: response.status,
      served_build_vintage: {
        worker_commit: health.payload.commit ?? null,
        worker_environment: health.payload.environment ?? null,
      },
      assertion:
        "Top-level results contain exactly one card for the canonical specimen, and the number of distinct object references across the complete envelope is one.",
      results_length: resultsLength,
      distinct_object_refs: distinct,
      federated_results_length: federatedLength,
      recursive_projection_match_count: recursiveMatchCount,
      result_object_refs: (payload.results || []).map((row) => row.object_ref || row.procurement_id),
      response_sha256: sha256(body),
      result: pass ? "pass" : "fail",
    });
  }

  const receipt = {
    schema: "cityscroll.served_procurement_route_production_read.v1",
    observed_at: observedAt,
    grounded_at: grounded,
    live_origin: "https://cityscroll.org",
    api_origin: "https://api.cityscroll.org",
    served_build_vintage: {
      worker_commit: health.payload.commit ?? null,
      worker_environment: health.payload.environment ?? null,
      worker_health_status: health.payload.status ?? null,
      note: "Worker /health reports the commit currently serving api.cityscroll.org. Pages HTML is read from cityscroll.org in the same capture.",
    },
    contract: {
      canary_half:
        "LIVE_PROCUREMENT_CANARY=1 node --test test/live_procurement_detail_canary.test.mjs asserts results.length === 1 and distinct object refs === 1 for each exact identifier.",
      parity_fixture_half:
        "test/procurement_detail_search_parity.test.mjs asserts the same two halves against the served Worker search envelope, including present federated results and lane cards.",
    },
    reads: [
      {
        url: PAGE_URL,
        kind: "html_route",
        status: page.response.status,
        served_build_vintage: {
          worker_commit: health.payload.commit ?? null,
          worker_environment: health.payload.environment ?? null,
        },
        assertion:
          "The live procurement route returns HTTP 200 with every named destination as an anchor, the specimen's contract dates and entity names, and no optional-lookup apology, state-authority row, or opportunity chrome.",
        body_sha256: sha256(page.body),
        assertions: pageAssertions,
        result: pagePass ? "pass" : "fail",
      },
      ...searchReads,
    ],
    summary: {
      result: pagePass && searchReads.every((read) => read.result === "pass") ? "pass" : "fail",
      searches_returning_specimen_once: searchReads.filter((read) => read.result === "pass").length,
      searches_measured: searchReads.length,
    },
  };

  writeFileSync(OUT, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function check() {
  const receipt = JSON.parse(readFileSync(OUT, "utf8"));
  assert.equal(receipt.schema, "cityscroll.served_procurement_route_production_read.v1");
  assert.equal(receipt.summary.result, "pass");
  assert.equal(receipt.reads.length, 3);
  for (const read of receipt.reads) {
    assert.equal(read.result, "pass", read.url);
    assert.ok(read.url.startsWith("https://"));
    assert.ok(read.assertion.length > 0);
    assert.ok(read.served_build_vintage.worker_commit);
  }
  const searches = receipt.reads.filter((read) => read.kind === "exact_identifier_search");
  assert.equal(searches.length, 2);
  for (const search of searches) {
    assert.equal(search.results_length, 1);
    assert.equal(search.distinct_object_refs, 1);
  }
  process.stdout.write("production-read receipt check passed\n");
}

const mode = process.argv.includes("--check") ? "check" : "capture";
if (mode === "check") {
  check();
} else {
  const receipt = await capture();
  process.stdout.write(
    `wrote docs/evidence/served-procurement-route/production-read.json summary=${receipt.summary.result}\n`,
  );
  if (receipt.summary.result !== "pass") process.exitCode = 1;
}
