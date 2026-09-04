import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildFetchReceipt } from "../warehouse/lib/seqra_fetch_receipt.mjs";
import {
  buildCeqrAccessDiscoveryReceipt,
  CEQR_ACCESS_NO_BULK_API_ASSERTION,
  CEQR_ACCESS_SOURCE_ID,
  validateDiscoveryProbe,
} from "../warehouse/lib/seqra_ceqr_access_discovery.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeFetch(overrides = {}) {
  return buildFetchReceipt({
    fetchId: "fake-0001",
    sourceId: CEQR_ACCESS_SOURCE_ID,
    requestedAt: "2026-09-04T00:00:00.000Z",
    requestUrlOrQuery: "https://a002-ceqraccess.nyc.gov/CEQR/",
    httpStatus: 200,
    retrievedAt: "2026-09-04T00:00:01.000Z",
    parserVersion: "test.v1",
    ...overrides,
  });
}

describe("seqra_ceqr_access_discovery", () => {
  it("rejects a probe whose observation.type is not one of PROBE_OBSERVATION_TYPES", () => {
    const findings = validateDiscoveryProbe({ purpose: "x", fetch: fakeFetch(), observation: { type: "made_up" } });
    assert.ok(findings.length > 0);
  });

  it("rejects a probe whose fetch is not a real fetch receipt", () => {
    const findings = validateDiscoveryProbe({ purpose: "x", fetch: { not: "a receipt" }, observation: { type: "search_form" } });
    assert.ok(findings.some((f) => f.includes("buildFetchReceipt")));
  });

  it("builds a receipt that always asserts bulk_api_documented: false and carries the negative rule verbatim", () => {
    const receipt = buildCeqrAccessDiscoveryReceipt({
      generatedAt: "2026-09-04T00:00:00.000Z",
      probes: [{ purpose: "search_page", fetch: fakeFetch(), observation: { type: "search_form", method: "post", action: "./" } }],
    });
    assert.equal(receipt.bulk_api_documented, false);
    assert.equal(receipt.negative_rule, CEQR_ACCESS_NO_BULK_API_ASSERTION);
    assert.match(receipt.negative_rule, /does not assume an undocumented bulk API/);
  });

  it("summarizes the search interface only from an actually-observed search_form probe, never a default guess", () => {
    const withoutForm = buildCeqrAccessDiscoveryReceipt({ generatedAt: "2026-09-04T00:00:00.000Z", probes: [] });
    assert.equal(withoutForm.search_interface.status, "not_yet_observed");

    const withForm = buildCeqrAccessDiscoveryReceipt({
      generatedAt: "2026-09-04T00:00:00.000Z",
      probes: [{
        purpose: "search_page",
        fetch: fakeFetch(),
        observation: { type: "search_form", method: "post", action: "./", requires_postback_tokens: true, input_fields: ["txtKeyword"], select_fields: ["ddlBorough"], submit_field: "btnSearch" },
      }],
    });
    assert.equal(withForm.search_interface.status, "observed");
    assert.equal(withForm.search_interface.method, "post");
    assert.deepEqual(withForm.search_interface.input_fields, ["txtKeyword"]);
  });

  it("reports bulk_enumeration_probe.attempted: false when no bulk-shaped probe was run", () => {
    const receipt = buildCeqrAccessDiscoveryReceipt({ generatedAt: "2026-09-04T00:00:00.000Z", probes: [] });
    assert.equal(receipt.bulk_enumeration_probe.attempted, false);
  });

  it("reports document_link_pattern: not_yet_observed when no document_link_sample probe exists", () => {
    const receipt = buildCeqrAccessDiscoveryReceipt({ generatedAt: "2026-09-04T00:00:00.000Z", probes: [] });
    assert.equal(receipt.document_link_pattern.status, "not_yet_observed");
  });

  it("throws on an invalid probe rather than silently building a receipt from bad input", () => {
    assert.throws(() => buildCeqrAccessDiscoveryReceipt({
      generatedAt: "2026-09-04T00:00:00.000Z",
      probes: [{ purpose: "", fetch: null, observation: null }],
    }));
  });
});

describe("seqra_ceqr_access_discovery: committed real-world receipt", () => {
  const receiptPath = path.join(ROOT, "warehouse/receipts/proof/seqra_ceqr_access_discovery_latest.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));

  it("was materialized from at least one live probe against the CEQR Access base URL", () => {
    assert.ok(receipt.probe_count >= 1);
    assert.ok(receipt.probes.some((p) => p.fetch.request_url_or_query.includes("a002-ceqraccess.nyc.gov")));
  });

  it("never asserts a documented bulk API", () => {
    assert.equal(receipt.bulk_api_documented, false);
  });

  it("observed the real search form's stateful-postback shape", () => {
    assert.equal(receipt.search_interface.status, "observed");
    assert.equal(receipt.search_interface.requires_postback_tokens, true);
  });
});
