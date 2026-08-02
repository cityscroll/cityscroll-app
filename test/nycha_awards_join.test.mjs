// Checkbook NYCHA exact-PIN join recon characterization.
//
//   node --test test/nycha_awards_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyNychaPinJoin,
  measureNychaTemporalJoinRate,
} from "../worker/src/lib/nycha_awards_join.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/nycha_awards/join_cases.json"), "utf8"),
);
const receipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/nycha_award_sources/verification_receipts/nycha_awards_2026-08-01.json",
    ),
    "utf8",
  ),
);

test("field-case fixtures classify temporal matches, PIN reuse, and misses", () => {
  for (const c of cases.cases) {
    const r = classifyNychaPinJoin(c.notice, c.agreements);
    assert.equal(r.status, c.expect, c.id);
    if (c.expect === "matched") assert.equal(r.matches.length, 1, c.id);
    else assert.equal(r.matches.length, 0, c.id);
  }
});

test("measureNychaTemporalJoinRate reports fixture temporal rate", () => {
  const m = measureNychaTemporalJoinRate(cases.cases);
  assert.equal(m.matched, 1);
  assert.equal(m.eligible, 3); // ineligible-no-pin excluded
  assert.equal(m.reuse_only, 1);
  assert.equal(m.no_agreement, 1);
  // One synthetic true-positive control among three eligible field cases (1/3).
  assert.equal(m.temporal_exact_rate, 1 / 3);
});

test("verification receipt records modern temporal rate at 0%", () => {
  const jm = receipt.join_measurement;
  assert.equal(jm.usefulness_threshold, 0.3);
  assert.equal(jm.rates.modern_d1_temporal_exact.rate, 0);
  assert.equal(jm.rates.modern_d1_temporal_exact.total, 23);
  assert.equal(jm.rates.historical_sample_temporal_exact.rate, 0);
  assert.match(jm.verdict, /Below usefulness threshold/i);
  assert.equal(receipt.product_inventory_2026_08_01.d1_external_award_matches_nonempty, 0);
  assert.equal(receipt.curl_verified.api_post_http, 200);
  assert.equal(receipt.curl_verified.api_result, "success");
});

test("source contract is registered as disabled with join_measurement", () => {
  const registry = loadSourceContracts();
  const contract = registry.contracts.find((c) => c.id === "checkbook-nycha-contracts");
  assert.ok(contract, "checkbook-nycha-contracts contract missing");
  assert.equal(contract.status, "disabled");
  assert.equal(contract.kind, "checkbook");
  assert.equal(contract.data_type, "Contracts_NYCHA");
  assert.ok(contract.gap);
  assert.match(contract.gap, /not-yet-ingested|below/i);
  assert.ok(contract.join_measurement);
  assert.equal(contract.join_measurement.rates.modern_d1_temporal_exact.rate, 0);
  assert.ok(contract.join_measurement.rates.modern_d1_temporal_exact.rate < 0.3);
  assert.match(contract.join_measurement.verdict, /Below usefulness threshold/i);
});
