// Bid Tabulations Historical (9k82-ys7w) join recon characterization.
//
//   node --test test/bid_tabulations_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBidNumberIndex,
  joinPinToBidNumber,
  summarizeBidTabulation,
  normId,
} from "../worker/src/lib/bid_tabulations_join.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/bid_tabulations/join_cases.json"), "utf8"),
);
const receipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/bid_tabulation_sources/verification_receipts/bid_tabulations_historical_2026-07-30.json",
    ),
    "utf8",
  ),
);

const bidNumbers = cases.cases
  .filter((c) => c.bid?.bid_number)
  .map((c) => c.bid.bid_number);
// Include the weak false-positive bid number so rejection is explicit.
bidNumbers.push("2000141");
const index = buildBidNumberIndex(bidNumbers);

test("normId strips punctuation and uppercases", () => {
  assert.equal(normId("857-1600131"), "8571600131");
  assert.equal(normId(" 1600265 "), "1600265");
});

test("strict join accepts exact and agency-prefix suffixes only", () => {
  assert.deepEqual(joinPinToBidNumber("1600265", index), {
    method: "exact",
    bid_number: "1600265",
  });
  assert.deepEqual(joinPinToBidNumber("8571600131", index), {
    method: "agency_prefix_bid_suffix",
    bid_number: "1600131",
  });
  assert.deepEqual(joinPinToBidNumber("8571500664", index), {
    method: "agency_prefix_bid_suffix",
    bid_number: "1500664",
  });
});

test("strict join rejects modern EPIN-shaped PINs and weak false positives", () => {
  assert.equal(joinPinToBidNumber("81626W0043001", index), null);
  // Digit containment of 2000141 inside a longer modern-style id must not join.
  assert.equal(joinPinToBidNumber("8571500516", index), null);
  // Shared prefix without exact 7-digit bid suffix structure.
  assert.equal(joinPinToBidNumber("26026N0011044", index), null);
});

test("field-case fixtures match the accepted/rejected strategy table", () => {
  for (const c of cases.cases) {
    const hit = joinPinToBidNumber(c.notice.pin, index);
    if (c.expect === "joined") {
      assert.ok(hit, c.id);
      assert.equal(hit.method, c.method, c.id);
      assert.equal(hit.bid_number, c.bid.bid_number, c.id);
    } else {
      assert.equal(hit, null, c.id);
    }
  }
});

test("summarizeBidTabulation counts distinct bidders", () => {
  const summary = summarizeBidTabulation([
    { bidder_name: "A CO", bid_price: "1" },
    { bidder_name: "A CO", bid_price: "2" },
    { bidder_name: "B CO", bid_price: "3" },
    { bidder_name: "  ", bid_price: "0" },
  ]);
  assert.equal(summary.bidder_count, 2);
  assert.equal(summary.bidders[0].line_items, 2);
});

test("verification receipt records measured rates below usefulness threshold", () => {
  const jm = receipt.join_measurement;
  assert.equal(jm.usefulness_threshold, 0.3);
  assert.equal(jm.rates.modern_notices_strict.rate, 0);
  assert.ok(jm.rates.historical_notices_strict.rate < 0.3);
  assert.match(jm.verdict, /Below usefulness threshold/i);
  assert.equal(receipt.dataset.pin_or_epin_column, false);
  assert.equal(receipt.dataset.row_count, 57704);
  assert.equal(receipt.dataset.unique_bid_numbers, 945);
  assert.equal(receipt.curl_verified.metadata_http, 200);
  assert.equal(receipt.curl_verified.resource_sample_http, 200);
  assert.match(receipt.curl_verified.metadata_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.curl_verified.sample_sha256, /^[a-f0-9]{64}$/);
});

test("source contract is registered as disabled with join_measurement", () => {
  const registry = loadSourceContracts();
  const contract = registry.contracts.find((c) => c.id === "bid-tabulations-historical");
  assert.ok(contract, "bid-tabulations-historical contract missing");
  assert.equal(contract.status, "disabled");
  assert.equal(contract.kind, "socrata");
  assert.equal(contract.dataset_id, "9k82-ys7w");
  assert.ok(contract.gap);
  assert.ok(contract.join_measurement);
  assert.ok(contract.join_measurement.rates.modern_notices_strict.rate < 0.3);
  assert.ok(contract.join_measurement.rates.historical_notices_strict.rate < 0.3);
  assert.match(contract.join_measurement.verdict, /Below usefulness threshold/i);
});

test("annotated recon screenshots are present and sha-pinned in the manifest", () => {
  const dir = join(ROOT, "docs/screenshots/bid-tabulations-recon");
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
