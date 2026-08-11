// ULURP Recommendations join recon characterization (measured-negative).
//
//   node --test test/ulurp_recommendations_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractUlurpKeys,
  buildUlurpRecommendationIndex,
  joinZapUlurpToRecommendations,
  summarizeUlurpRecommendation,
  cleanUrl,
} from "../worker/src/lib/ulurp_recommendations_join.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/ulurp_recommendations/join_cases.json"), "utf8"),
);
const receipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-07-30.json",
    ),
    "utf8",
  ),
);

function buildIndexFromCases() {
  const rows = [];
  for (const c of cases.cases) {
    if (c.recommendation) {
      rows.push({ ulurp_field: c.recommendation.ulurp_number_s, row: c.recommendation });
    }
    if (c.pdf) {
      rows.push({ ulurp_field: c.pdf.ulurp_application_number, row: c.pdf });
    }
  }
  return buildUlurpRecommendationIndex(rows);
}

const index = buildIndexFromCases();

test("extractUlurpKeys normalizes spaced, typed, and multi-number fields", () => {
  assert.deepEqual(
    [...extractUlurpKeys("C 210033 ZMK; M210034LDK")].sort(),
    ["210033ZMK", "210034LDK", "C210033ZMK", "M210034LDK"].sort(),
  );
  assert.deepEqual([...extractUlurpKeys("260302ZCM")], ["260302ZCM"]);
  assert.equal(extractUlurpKeys("no numbers here").size, 0);
  assert.equal(extractUlurpKeys("210033").size, 0); // bare body rejected
});

test("extractUlurpKeys rejects Zoom meeting-id false positive (302621MEET)", () => {
  const keys = extractUlurpKeys("zoom.us/j/91467302621 Meeting ID: 914 6730 2621");
  assert.equal(keys.size, 0);
  assert.equal(keys.has("302621MEET"), false);
});

test("strict join accepts exact ULURP tokens only", () => {
  const hit = joinZapUlurpToRecommendations("C210033ZMK; M210034LDK", index);
  assert.ok(hit);
  assert.equal(hit.method, "exact_ulurp_token");
  assert.ok(hit.keys.includes("210033ZMK") || hit.keys.includes("C210033ZMK"));
  assert.ok(hit.rows.some((r) => r.borough_president === "Approved"));

  const pdfHit = joinZapUlurpToRecommendations("C180066ZSM", index);
  assert.ok(pdfHit);
  assert.ok(pdfHit.rows.some((r) => r.pdf_download));
});

test("strict join rejects bare-body collisions and null fields", () => {
  // Same 6-digit body, different suffix must not join the ZMK recommendation.
  assert.equal(joinZapUlurpToRecommendations("210033ZCM", index), null);
  assert.equal(joinZapUlurpToRecommendations(null, index), null);
  assert.equal(joinZapUlurpToRecommendations("260302ZCM", index), null);
});

test("field-case fixtures match the accepted/rejected strategy table", () => {
  for (const c of cases.cases) {
    if (c.id === "unjoined-property-disposition-wrong-universe") {
      assert.equal(c.expect, "unjoined");
      assert.equal(c.zap.ulurp_numbers, null);
      continue;
    }
    const hit = joinZapUlurpToRecommendations(c.zap?.ulurp_numbers, index);
    if (c.expect === "joined") {
      assert.ok(hit, c.id);
      assert.equal(hit.method, c.method, c.id);
    } else {
      assert.equal(hit, null, c.id);
    }
  }
});

test("summarizeUlurpRecommendation and cleanUrl keep PDF deep-links", () => {
  const rec = summarizeUlurpRecommendation({
    ulurp_number_s: "210033 ZMK",
    borough_president: "Approved",
    recommendation_date: "2021-03-15T00:00:00.000",
    ulurp_application_name: "Sample",
    community_board_s: "1",
  });
  assert.equal(rec.position, "Approved");
  assert.equal(rec.date, "2021-03-15");
  assert.equal(rec.pdf_url, null);

  const pdf = summarizeUlurpRecommendation({
    ulurp_application_number: "C 180066 ZSM",
    pdf_download: "http://manhattanbp.nyc.gov/downloads/pdf/example.pdf",
    date: "2017-11-20T00:00:00.000",
    project: "East 73rd",
  }, { kind: "pdf" });
  assert.equal(pdf.kind, "pdf");
  assert.match(pdf.pdf_url, /^http:\/\/manhattanbp\.nyc\.gov\//);
  assert.equal(cleanUrl("https://data.cityofnewyork.us/d/gt5i-dmde"), "https://data.cityofnewyork.us/d/gt5i-dmde");
  assert.equal(cleanUrl("javascript:alert(1)"), null);
});

test("historical 2026-07-30 receipt recorded ZAP-universe catalog coverage below threshold", () => {
  const jm = receipt.join_measurement;
  assert.equal(jm.usefulness_threshold, 0.3);
  assert.ok(jm.rates.zap_ulurp_numbered_either.rate < 0.3);
  assert.equal(jm.rates.zap_ulurp_numbered_either.joined, 152);
  assert.equal(jm.rates.zap_ulurp_numbered_either.total, 27971);
  assert.equal(jm.rates.zap_ulurp_numbered_either.rate, 0.0054);
  assert.ok(jm.rates.zap_ulurp_numbered_recommendations.rate < 0.3);
  assert.ok(jm.rates.zap_ulurp_numbered_pdfs.rate < 0.3);
  // Recommendation-row denominator was already high on the historical receipt.
  assert.ok(jm.rates.recommendation_rows_hit_zap.rate >= 0.3);
  assert.match(jm.verdict, /Below usefulness threshold/i);
  assert.match(jm.wrong_universe_note, /Property Disposition/i);
  assert.equal(receipt.datasets.recommendations.row_count, 91);
  assert.equal(receipt.datasets.pdfs.row_count, 88);
  assert.equal(receipt.curl_verified.recommendations.metadata_http, 200);
  assert.equal(receipt.curl_verified.pdfs.resource_sample_http, 200);
  assert.match(receipt.curl_verified.recommendations.metadata_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.curl_verified.pdfs.sample_sha256, /^[a-f0-9]{64}$/);
});

test("source contracts are live after recommendation-row re-gate", () => {
  const registry = loadSourceContracts();
  for (const id of ["ulurp-recommendations", "ulurp-recommendation-pdfs"]) {
    const contract = registry.contracts.find((c) => c.id === id);
    assert.ok(contract, `${id} contract missing`);
    assert.equal(contract.status, "live");
    assert.equal(contract.kind, "socrata");
    assert.ok(contract.join_measurement);
    assert.ok(contract.join_measurement.rates.recommendation_rows_hit_zap.rate >= 0.3);
    assert.match(contract.join_measurement.verdict, /recommendation-row|Above usefulness/i);
  }
  const recs = registry.contracts.find((c) => c.id === "ulurp-recommendations");
  assert.equal(recs.dataset_id, "4j6i-9rmr");
  const pdfs = registry.contracts.find((c) => c.id === "ulurp-recommendation-pdfs");
  assert.equal(pdfs.dataset_id, "gt5i-dmde");
});

test("annotated recon screenshots are present and sha-pinned in the manifest", () => {
  const dir = join(ROOT, "docs/screenshots/ulurp-recommendations-recon");
  const manifestPath = join(dir, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 4);
  for (const file of manifest.files) {
    const path = join(dir, file.name);
    assert.ok(existsSync(path), file.name);
    const buf = readFileSync(path);
    const sha = createHash("sha256").update(buf).digest("hex");
    assert.equal(sha, file.sha256, file.name);
    assert.equal(buf.length, file.bytes, file.name);
  }
});

test("join_cases topline keeps ZAP-universe catalog contrast below threshold", () => {
  assert.equal(cases.join_measurement_topline.zap_ulurp_numbered_either_rate, 0.0054);
  assert.ok(cases.join_measurement_topline.zap_ulurp_numbered_either_rate < 0.3);
});
